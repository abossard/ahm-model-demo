import json
import random
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import activity  # noqa: E402
import config  # noqa: E402


def run(events):
    state, drafts = activity.new_state(), []
    for name, data in events:
        state, produced = activity.reduce_event(state, name, data)
        drafts += produced
    state, produced = activity.finish(state)
    return state, drafts + produced


def message(item_id, text, deltas=None):
    item = {"id": item_id, "type": "message", "content": [{"type": "output_text", "text": text}]}
    events = [("response.output_item.added", {"item": {**item, "content": []}})]
    events += [("response.output_text.delta", {"item_id": item_id, "delta": d}) for d in (deltas or [text])]
    return events + [("response.output_item.done", {"item": item})]


def call(call_id, name, arguments, output=None, added_output=True):
    function = {"id": f"fc-{call_id}", "type": "function_call", "call_id": call_id, "name": name}
    text = arguments if isinstance(arguments, str) else json.dumps(arguments)
    events = [
        ("response.output_item.added", {"item": {**function, "arguments": ""}}),
        ("response.function_call_arguments.delta", {"item_id": function["id"], "delta": text[:5]}),
        ("response.output_item.done", {"item": {**function, "arguments": text}}),
    ]
    if output is not None:
        result = {"id": f"fco-{call_id}", "type": "function_call_output", "call_id": call_id, "output": output}
        if added_output:
            events.append(("response.output_item.added", {"item": result}))
        events.append(("response.output_item.done", {"item": result}))
    return events


def diff(*ids):
    return {
        "kind": "diff",
        "summary": "s",
        "changes": [{"id": i, "op": "add", "kind": "entity", "name": f"name-{i}", "after": {}, "reason": "r"} for i in ids],
        "verification": [],
        "findings": [],
    }


ACCEPTED = json.dumps({"status": "accepted"})
REJECTED = json.dumps({"status": "rejected", "problems": ["changes[0].name: too short", "changes: duplicate"]})


def kinds(drafts):
    return [draft["kind"] for draft in drafts]


class MappingTests(unittest.TestCase):
    def test_each_event_type_becomes_the_expected_timeline_event(self):
        cases = [
            ("created", [("response.created", {"response": {"id": "r1"}})], [("status", "Agent started")]),
            ("completed", [("response.completed", {"response": {"id": "r1"}})], [("status", "Agent finished")]),
            (
                "incomplete",
                [("response.incomplete", {"response": {"incomplete_details": {"reason": "max_output_tokens"}}})],
                [("status", "Agent stopped early (max_output_tokens)")],
            ),
            ("message", message("m1", "Looking at the model."), [("text", "Looking at the model.")]),
            (
                "tool call and result",
                call("c1", "monitor_healthmodels_get", {"health-model": "hm-x"}, "{}"),
                [("tool_call", "Get health model hm-x"), ("tool_result", "Get health model hm-x: ok, 2 B")],
            ),
            (
                "tool failure text",
                call("c1", "run_shell", {"command": "ls"}, "Error: not found"),
                [("tool_call", "Run shell: ls"), ("tool_result", "Run shell: ls: failed, 16 B")],
            ),
            (
                "tool failure json",
                call("c1", "monitor_metrics_query", {}, json.dumps({"error": "denied"})),
                [("tool_call", "Query metrics"), ("tool_result", "Query metrics: failed, 19 B")],
            ),
            (
                "failed response",
                [("response.failed", {"response": {"error": {"code": "tool_start_failed", "message": "The MCP child exited."}}})],
                [("error", "The MCP child exited.")],
            ),
            ("error event", [("error", {"code": "invalid_prompt", "message": "Boom."})], [("error", "Boom.")]),
            ("unknown event", [("response.something.new", {"x": 1})], []),
            ("reasoning item", [("response.output_item.done", {"item": {"type": "reasoning", "id": "r"}})], []),
            ("empty message", message("m1", "   "), []),
            ("bad payloads", [("response.output_item.done", "text"), ("response.output_item.done", {"item": 3}), ("error", None)], []),
        ]
        for label, events, expected in cases:
            with self.subTest(label=label):
                _, drafts = run(events)

                self.assertEqual([(d["kind"], d["summary"]) for d in drafts], expected)

    def test_text_deltas_are_coalesced_into_one_event_per_message(self):
        events = message("m1", "Hello world, this is long.", deltas=["Hello ", "world, ", "this is ", "long."])
        events += message("m2", "Second message.", deltas=["Second ", "message."])

        _, drafts = run(events)

        self.assertEqual(kinds(drafts), ["text", "text"])
        self.assertEqual(drafts[0]["payload"], {"text": "Hello world, this is long."})
        self.assertEqual(drafts[1]["payload"], {"text": "Second message."})

    def test_unfinished_text_is_flushed_when_the_stream_ends(self):
        events = [
            ("response.output_text.delta", {"item_id": "m1", "delta": "Partial "}),
            ("response.output_text.delta", {"item_id": "m1", "delta": "text"}),
        ]

        state, drafts = run(events)

        self.assertEqual([(d["kind"], d["payload"]["text"]) for d in drafts], [("text", "Partial text")])
        self.assertEqual(run(events + message("m1", "Partial text"))[1][0]["payload"]["text"], "Partial text")
        self.assertEqual(len(run(events + message("m1", "Partial text"))[1]), 1)
        self.assertIsNone(activity.accepted_result(state))

    def test_added_and_done_items_never_double_count(self):
        events = call("c1", "load_skill", {"name": "healthmodel-analyze"}, "ok")
        events += call("c1", "load_skill", {"name": "healthmodel-analyze"}, "ok", added_output=False)

        _, drafts = run(events)

        self.assertEqual(kinds(drafts), ["tool_call", "tool_result"])

    def test_large_arguments_and_text_are_truncated(self):
        long_text = "word " * 4000
        events = message("m1", long_text) + call("c1", "run_shell", {"command": "x" * 5000}, "y" * 100)

        _, drafts = run(events)

        text, tool_call, tool_result = drafts
        self.assertLessEqual(len(text["summary"]), 160 + 40)
        self.assertLess(len(text["payload"]["text"]), 8100)
        self.assertIn("more characters", text["payload"]["text"])
        self.assertLess(len(tool_call["payload"]["arguments"]), 2100)
        self.assertLessEqual(len(tool_call["summary"]), 200)
        self.assertEqual(tool_result["payload"]["size"], 100)
        self.assertNotIn("y" * 100, json.dumps(tool_result))

    def test_failures_are_recorded_for_the_runner(self):
        state, drafts = run([("response.failed", {"response": {"error": {"code": "x", "message": "No tools."}}})])
        self.assertEqual(activity.failure(state), {"code": "x", "message": "No tools.", "detail": "No tools."})
        self.assertEqual(drafts[0]["payload"], {"code": "x", "message": "No tools."})

        state, _ = run([("error", {})])
        self.assertEqual(
            activity.failure(state),
            {"code": "agent_failed", "message": "The agent failed.", "detail": "The agent failed."},
        )
        self.assertIsNone(activity.failure(run(message("m", "fine"))[0]))

    def test_reducing_never_mutates_the_previous_state(self):
        state = activity.new_state()
        before = json.dumps(state, default=sorted, sort_keys=True)

        activity.reduce_event(state, "response.output_text.delta", {"item_id": "m", "delta": "x"})
        activity.reduce_event(state, "response.output_item.done", {"item": {"type": "function_call", "call_id": "c", "name": "n", "arguments": "{}"}})

        self.assertEqual(json.dumps(state, default=sorted, sort_keys=True), before)


TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQuYXp1cmUuY29tIiwiaXNzIjoieCJ9.c2lnbmF0dXJlLXBhcnQ_-x"


class RedactionTests(unittest.TestCase):
    def assert_clean(self, drafts):
        text = json.dumps(drafts)

        self.assertNotIn("eyJ", text)
        self.assertIn("[redacted token]", text)

    def test_tokens_are_replaced_everywhere_the_agent_can_put_text(self):
        long_line = f"{'x' * 7980} {TOKEN}"
        cases = [
            ("message text", message("m1", f"Here is the token {TOKEN} for you.")),
            ("message text built from deltas", message("m1", f"a {TOKEN} b", deltas=["a eyJhbGciOiJSUzI1NiJ9.", "eyJhdWQiOiJ4In0.c2ln", " b"])),
            ("message text cut by the limit", message("m1", long_line)),
            ("tool arguments", call("c1", "monitor_metrics_query", {"resourceId": "x", "header": f"Bearer {TOKEN}"}, "ok")),
            ("a shell command in the title", call("c1", "run_shell", {"command": f"curl -H 'Authorization: Bearer {TOKEN}' https://example"}, "ok")),
            ("the first argument of a long command", call("c1", "run_shell", {"command": f"{'x' * 70} {TOKEN}"}, "ok")),
            ("rejection problems", call("c1", "submit_result", {"result": diff("a")}, json.dumps({"status": "rejected", "problems": [f"name {TOKEN} is wrong"]}))),
            ("a rejection problem cut by the limit", call("c1", "submit_result", {"result": diff("a")}, json.dumps({"status": "rejected", "problems": [f"{'x' * 180} {TOKEN}"]}))),
            ("identifiers and tool names", [("response.created", {"response": {"id": TOKEN}})] + call(TOKEN, f"tool-{TOKEN}", {"a": 1}, "ok")),
            ("a failed response", [("response.failed", {"response": {"error": {"code": "denied", "message": f"Token {TOKEN} was refused."}}})]),
            ("an error event", [("error", {"code": "bad", "message": f"Header {TOKEN}"})]),
            ("a response that stopped early", [("response.incomplete", {"response": {"incomplete_details": {"reason": TOKEN}}})]),
        ]
        for label, events in cases:
            with self.subTest(label=label):
                _, drafts = run(events)

                self.assert_clean(drafts)

    def test_the_accepted_result_never_carries_a_token(self):
        result = {**diff("a"), "summary": f"Use {TOKEN} to read it."}

        state, drafts = run(call("c1", "submit_result", {"result": result}, ACCEPTED))

        self.assertEqual(activity.accepted_result(state)["summary"], "Use [redacted token] to read it.")
        self.assertNotIn("eyJ", json.dumps(drafts))

    def test_only_token_shaped_text_is_replaced(self):
        cases = [
            ("two parts only", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0", False),
            ("no prefix", "abc.def.ghi", False),
            ("a path", "/subscriptions/x/resourceGroups/y", False),
            ("three parts", "eyJa.eyJb.sig", True),
            ("with hyphens and underscores", "eyJ-a_b.c-d_e.f-g_h", True),
        ]
        for label, text, replaced in cases:
            with self.subTest(label=label):
                self.assertEqual(activity.redact(f"x {text} y"), "x [redacted token] y" if replaced else f"x {text} y")

    def test_redaction_agrees_with_the_token_pattern_on_every_small_input(self):
        pieces = ["eyJ", "eyJ", "e", "y", "J", "a", "Z", "-", "_", ".", ".", " ", "'", "\u00e9"]
        generator = random.Random(20261110)
        for _ in range(20000):
            text = "".join(generator.choice(pieces) for _ in range(generator.randint(0, 24)))

            self.assertEqual(activity.redact(text), config.TOKEN_PATTERN.sub(config.REDACTED_TOKEN, text), repr(text))

    def test_redaction_stays_fast_on_hostile_text(self):
        count = 30_000
        cases = [
            ("the marker over and over", "eyJ" * count, 0),
            ("the marker over and over, then dots", "eyJ" * count + "..", 0),
            ("the marker over and over, then one part", "eyJ" * count + ".a", 0),
            ("a second part full of markers", "eyJa." + "eyJ" * count, 0),
            ("a third part full of markers", "eyJa.b." + "eyJ" * count, 1),
            ("many short near misses", "eyJa.b " * count, 0),
            ("many complete tokens", "eyJa.b.c " * count, count),
            ("one very long run", "eyJ" + "a" * 1_000_000, 0),
            ("a long run of dots", "eyJa" + "." * 1_000_000, 0),
        ]
        for label, text, replaced in cases:
            with self.subTest(label=label):
                started = time.perf_counter()

                redacted = activity.redact(text)

                self.assertLess(time.perf_counter() - started, 1.0)
                self.assertEqual(redacted.count("[redacted token]"), replaced)

    def test_error_messages_are_clipped_to_300_characters_and_the_full_text_is_kept_for_the_log(self):
        cases = [
            ("short", "No tools.", "No tools."),
            ("exactly 300", "m" * 300, "m" * 300),
            ("301", "m" * 301, "m" * 297 + "..."),
            ("very long", "m" * 5000, "m" * 297 + "..."),
            ("a token that straddles the limit", "m" * 290 + " " + TOKEN, "m" * 290 + " [redac..."),
        ]
        for label, full, shown in cases:
            with self.subTest(label=label):
                state, drafts = run([("response.failed", {"response": {"error": {"code": "c" * 400, "message": full}}})])

                failure = activity.failure(state)

                self.assertEqual(failure["message"], shown)
                self.assertLessEqual(len(failure["message"]), 300)
                self.assertLessEqual(len(failure["code"]), 300)
                self.assertEqual(drafts[0]["payload"], {"code": failure["code"], "message": shown})
                self.assertEqual(failure["detail"], activity.redact(full))
                self.assertNotIn("eyJ", json.dumps([failure, drafts]))

    def test_the_reason_a_response_stopped_is_clipped_too(self):
        _, drafts = run([("response.incomplete", {"response": {"incomplete_details": {"reason": "r" * 1000}}})])

        self.assertLessEqual(len(drafts[0]["payload"]["reason"]), 300)


class DoubledArgumentTests(unittest.TestCase):
    def test_arguments_are_read_from_the_first_complete_document(self):
        one = json.dumps({"result": {"kind": "diff", "summary": "a } { b"}}, separators=(",", ":"))
        cases = [
            ("one document", one, {"result": {"kind": "diff", "summary": "a } { b"}}),
            ("the same document twice", one + one, {"result": {"kind": "diff", "summary": "a } { b"}}),
            ("two different documents", one + '{"other":1}', {"result": {"kind": "diff", "summary": "a } { b"}}),
            ("separated by a newline", one + "\n" + one, {"result": {"kind": "diff", "summary": "a } { b"}}),
            ("leading blanks", "  \n" + one, {"result": {"kind": "diff", "summary": "a } { b"}}),
            ("trailing text", one + " and then some text", {"result": {"kind": "diff", "summary": "a } { b"}}),
            ("an empty object twice", "{}{}", {}),
            ("a document that is cut", one[:-3], {}),
            ("a document that is cut, then another", one[:-3] + one, {}),
            ("a list first", "[1]" + one, {}),
            ("a number first", "5" + one, {}),
            ("no document", "not json", {}),
            ("nothing", "", {}),
            ("blanks only", "  ", {}),
            ("already parsed", {"a": 1}, {"a": 1}),
            ("not text and not a mapping", None, {}),
            ("a list that is already parsed", [1], {}),
        ]
        for label, text, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(activity.parse_arguments(text), expected)

    def test_a_doubled_submission_is_accepted_with_its_result_and_titles_stay_readable(self):
        doubled_arguments = json.dumps({"result": diff("a", "b")}) * 2

        state, drafts = run(call("c1", "submit_result", doubled_arguments, ACCEPTED))

        self.assertEqual(activity.accepted_result(state), diff("a", "b"))
        self.assertEqual(drafts[0]["summary"], "Submit result (diff, 2 changes)")
        self.assertEqual(drafts[2]["summary"], "Result accepted (diff, 2 changes)")

    def test_doubled_arguments_of_other_tools_still_give_their_title(self):
        doubled_arguments = json.dumps({"skill_name": "healthmodel-analyze"}) * 2

        _, drafts = run(call("c1", "load_skill", doubled_arguments, "ok"))

        self.assertEqual(drafts[0]["summary"], "Load skill healthmodel-analyze")


class ServerErrorTests(unittest.TestCase):
    def test_a_server_error_is_explained_and_every_other_error_keeps_its_own_words(self):
        cases = [
            ("server_error", "An internal server error occurred.", activity.SERVER_ERROR_MESSAGE),
            ("server_error", "Too many requests", activity.SERVER_ERROR_MESSAGE),
            ("server_error", "", activity.SERVER_ERROR_MESSAGE),
            ("rate_limit_exceeded", "Slow down.", "Slow down."),
            ("Server_Error", "Other case.", "Other case."),
            ("invalid_prompt", "Bad prompt.", "Bad prompt."),
        ]
        for code, message, shown in cases:
            for name, event in (("response.failed", {"response": {"error": {"code": code, "message": message}}}), ("error", {"code": code, "message": message})):
                with self.subTest(code=code, message=message, event=name):
                    state, drafts = run([(name, event)])

                    self.assertEqual(activity.failure(state)["message"], shown)
                    self.assertEqual(activity.failure(state)["code"], code)
                    self.assertEqual(activity.failure(state)["detail"], message or "The agent failed.")
                    self.assertEqual((drafts[0]["kind"], drafts[0]["summary"]), ("error", shown))
                    self.assertEqual(drafts[0]["payload"], {"code": code, "message": shown})

    def test_the_explanation_names_the_usual_cause_and_fits_the_error_limit(self):
        self.assertIn("internal error", activity.SERVER_ERROR_MESSAGE)
        self.assertIn("busy model deployment", activity.SERVER_ERROR_MESSAGE)
        self.assertLessEqual(len(activity.SERVER_ERROR_MESSAGE), 300)


class LateFailureTests(unittest.TestCase):
    def test_a_failure_after_the_accepted_result_is_a_status_and_before_it_an_error(self):
        accepted = call("c1", "submit_result", {"result": diff("a")}, ACCEPTED)
        rejected = call("c1", "submit_result", {"result": diff("a")}, REJECTED)
        failure = ("response.failed", {"response": {"error": {"code": "server_error", "message": "boom"}}})
        cases = [
            ("after an accepted result", accepted + [failure], "status", True),
            ("after an accepted result, as an error event", accepted + [("error", {"code": "server_error", "message": "boom"})], "status", True),
            ("before any result", [failure] + accepted, "error", False),
            ("after a rejected submission", rejected + [failure], "error", False),
            ("with no submission at all", [failure], "error", False),
        ]
        for label, events, kind, late in cases:
            with self.subTest(label=label):
                state, drafts = run(events)
                reported = [d for d in drafts if "failure" in d["summary"] or d["kind"] == "error"]

                self.assertEqual([d["kind"] for d in reported], [kind])
                if late:
                    self.assertEqual(reported[0]["summary"], "Agent reported a failure after the result was accepted (server_error)")
                    self.assertEqual(reported[0]["payload"]["code"], "server_error")
                self.assertEqual(activity.failure(state)["code"], "server_error")


class ToolTitleTests(unittest.TestCase):
    def test_titles_are_readable_and_unknown_tools_fall_back_to_their_name(self):
        cases = [
            ("load_skill", {"name": "healthmodel-analyze"}, "Load skill healthmodel-analyze"),
            ("load_skill", {}, "Load skill"),
            ("read_skill_resource", {"skill": "healthmodel-build", "resource": "templates/main.bicep"}, "Read skill resource healthmodel-build/templates/main.bicep"),
            ("run_shell", {"command": "git clone --depth 1 https://github.com/o/r"}, "Run shell: git clone --depth 1 https://github.com/o/r"),
            ("submit_result", {"result": diff("a", "b")}, "Submit result (diff, 2 changes)"),
            ("submit_result", {"result": {"kind": "explain", "causes": [1, 2, 3]}}, "Submit result (explain, 3 causes)"),
            ("monitor_healthmodels_list", {}, "List health models"),
            ("monitor_healthmodels_get", {"health-model": "hm-x", "resource-group": "rg"}, "Get health model hm-x"),
            ("monitor_healthmodels_inspect", {"health-model": "hm-x", "walk": "Causes"}, "Inspect health model hm-x (walk Causes)"),
            ("monitor_healthmodels_inspect", {"health-model": "hm-x", "entity": "api", "walk": "Causes"}, "Inspect health model hm-x (entity api, walk Causes)"),
            ("monitor_healthmodels_inspect", {"health-model": "hm-x"}, "Inspect health model hm-x"),
            ("monitor_healthmodels_inspect", {}, "Inspect health model"),
            ("monitor_healthmodels_inspect", {"healthModel": "camel"}, "Inspect health model camel"),
            ("monitor_metrics_definitions", {}, "List metric definitions"),
            ("monitor_metrics_query", {"metric-names": "Requests"}, "Query metrics Requests"),
            ("monitor_workspace_log_query", {"query": "secret", "table": "AppRequests"}, "Run log query on AppRequests"),
            ("monitor_workspace_log_query", {}, "Run log query"),
            ("group_resource_list", {"resource-group": "rg-x"}, "List resources in rg-x"),
            ("some_new_tool", {"a": 1}, "some_new_tool"),
            (None, {}, "tool"),
        ]
        for name, arguments, expected in cases:
            with self.subTest(name=name, arguments=arguments):
                self.assertEqual(activity.tool_title(name, arguments), expected)

    def test_log_queries_are_never_echoed_into_the_timeline(self):
        _, drafts = run(call("c1", "monitor_workspace_log_query", {"query": "AppRequests | where secret == 1", "table": "AppRequests"}, "{}"))

        self.assertNotIn("secret", drafts[0]["summary"])


class SubmittedResultTests(unittest.TestCase):
    def test_an_accepted_submission_yields_the_result_and_a_result_event(self):
        state, drafts = run(call("c1", "submit_result", {"result": diff("a", "b")}, ACCEPTED))

        self.assertEqual(kinds(drafts), ["tool_call", "tool_result", "result"])
        self.assertEqual(activity.accepted_result(state), diff("a", "b"))
        self.assertEqual(drafts[1]["summary"], "Submit result (diff, 2 changes): accepted")
        self.assertTrue(drafts[1]["payload"]["ok"])
        self.assertEqual(drafts[2]["summary"], "Result accepted (diff, 2 changes)")
        self.assertEqual(drafts[2]["payload"], {"resultKind": "diff"})

    def test_a_rejected_submission_is_a_failed_tool_result_without_a_result(self):
        state, drafts = run(call("c1", "submit_result", {"result": diff("a")}, REJECTED))

        self.assertEqual(kinds(drafts), ["tool_call", "tool_result"])
        self.assertIsNone(activity.accepted_result(state))
        self.assertFalse(drafts[1]["payload"]["ok"])
        self.assertEqual(drafts[1]["payload"]["problems"], ["changes[0].name: too short", "changes: duplicate"])
        self.assertIn("rejected (2 problems)", drafts[1]["summary"])

    def test_the_last_accepted_submission_wins(self):
        cases = [
            ("one accepted", [("a", diff("1"), ACCEPTED)], diff("1")),
            ("rejected then accepted", [("a", diff("1"), REJECTED), ("b", diff("2"), ACCEPTED)], diff("2")),
            ("accepted then rejected", [("a", diff("1"), ACCEPTED), ("b", diff("2"), REJECTED)], diff("1")),
            ("accepted twice", [("a", diff("1"), ACCEPTED), ("b", diff("2"), ACCEPTED)], diff("2")),
            ("accepted, rejected, accepted", [("a", diff("1"), ACCEPTED), ("b", diff("2"), REJECTED), ("c", diff("3"), ACCEPTED)], diff("3")),
            ("never accepted", [("a", diff("1"), REJECTED)], None),
        ]
        for label, submissions, expected in cases:
            with self.subTest(label=label):
                events = []
                for call_id, result, output in submissions:
                    events += call(call_id, "submit_result", {"result": result}, output)

                state, _ = run(events)

                self.assertEqual(activity.accepted_result(state), expected)

    def test_unusable_submissions_never_become_results(self):
        cases = [
            ("output without a call", [("response.output_item.done", {"item": {"type": "function_call_output", "call_id": "x", "name": "submit_result", "output": ACCEPTED}})]),
            ("arguments that are not json", call("c1", "submit_result", "not json", ACCEPTED)),
            ("arguments without a result", call("c1", "submit_result", {"other": 1}, ACCEPTED)),
            ("another tool answering accepted", call("c1", "run_shell", {"result": diff("a")}, ACCEPTED)),
            ("output that is not json", call("c1", "submit_result", {"result": diff("a")}, "accepted")),
        ]
        for label, events in cases:
            with self.subTest(label=label):
                state, _ = run(events)

                self.assertIsNone(activity.accepted_result(state))

    def test_the_result_can_arrive_as_the_arguments_themselves(self):
        state, _ = run(call("c1", "submit_result", diff("a"), ACCEPTED))

        self.assertEqual(activity.accepted_result(state), diff("a"))

    def test_outputs_may_be_content_lists_and_use_the_output_items_own_tool_name(self):
        result = {"id": "o", "type": "function_call_output", "call_id": "c9", "name": "load_skill", "output": [{"type": "output_text", "text": "skill body"}]}

        _, drafts = run([("response.output_item.done", {"item": result})])

        self.assertEqual(drafts[0]["summary"], "Load skill: ok, 10 B")


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from contracts import validate_task_result
from grounding import INFERRED, INFERRED_SENTENCE
from plain import summary_faults
from reduction import (
    LEAD_CHARS,
    QUOTE_CHARS,
    REPEATED_REJECTION,
    SUMMARY_CHARS,
    attributed,
    decision_lines,
    dropped_finding,
    empty_diff,
    empty_explanation,
    partial_summary,
    plain,
    quote,
    reduce_result,
    reduction_notice,
)
from tools import RunRecord

RESOURCE = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.Web/sites/web-app"


def change(number, name=None, op="add", kind="entity"):
    return {"id": f"c{number}", "op": op, "kind": kind, "name": name or f"entity-{number}", "after": None if op == "remove" else {"displayName": "x"}, "reason": "Because."}


def row(signal):
    return {"entity": "web-app", "signal": signal, "status": "not_run", "query": None, "value": None, "error": "No query."}


def diff(changes=(), rows=(), findings=(), summary="Proposes the model."):
    return {"kind": "diff", "summary": summary, "changes": list(changes), "verification": list(rows), "findings": list(findings)}


def flagging(*bad):
    """A stand-in for the checks of a run: a change or a row is a problem when its id or signal is in `bad`."""

    def problems_of(result):
        found = [f"changes[{index}]: {item['name']} breaks a rule" for index, item in enumerate(result["changes"]) if item["id"] in bad]
        found += [f"verification[{index}]: {item['signal']} has no query" for index, item in enumerate(result["verification"]) if item["signal"] in bad]
        return found

    return problems_of


class AttributionTests(unittest.TestCase):
    def test_a_problem_is_attributed_to_the_change_or_row_it_names(self):
        problems = [
            "changes[0]: entity 'a' is the same as in the model",
            "changes[2]: entity 'c' repeats changes[0]",
            "verification[1]: a row needs a value",
            "summary: no repository was read",
        ]

        changes, rows, loose = attributed(problems)

        self.assertEqual(changes, {0: [problems[0], problems[1]], 2: [problems[1]]})
        self.assertEqual(rows, {1: [problems[2]]})
        self.assertEqual(loose, [problems[3]])

    def test_a_finding_states_the_problem_without_its_place_and_without_what_the_model_is_told_to_do(self):
        cases = [
            ("a change", "changes[0]: entity 'a' is the same as in the model; leave this change out and state the problem as a finding", "entity 'a' is the same as in the model"),
            ("a part of a change", "changes[3].after.signalGroups[0]: leaves out icon, which the model has. A change keeps everything", "leaves out icon, which the model has"),
            ("a row", "verification[1]: a `verified` row needs `value`", "a `verified` row needs `value`"),
            ("a problem of the result", "summary: it is 412 characters long, at most 360. Write it for the person", "summary: it is 412 characters long, at most 360"),
            ("no end of sentence", "changes[2] names a thing", "names a thing"),
            ("a dot inside a name", "web.app is wrong", "web.app is wrong"),
            ("a resource", f"changes[0]: resource {RESOURCE} is outside; leave it", "resource web-app is outside"),
            ("nothing left", "changes[0]:", "changes[0]:"),
        ]
        for label, problem, expected in cases:
            with self.subTest(label):
                self.assertEqual(plain(problem), expected)

    def test_a_quote_names_a_resource_by_its_last_segment_and_is_cut(self):
        self.assertEqual(quote(f"changes[0]: resource {RESOURCE} is outside"), "changes[0]: resource web-app is outside")
        long = quote("x" * 1000)
        self.assertEqual((len(long), long[-3:]), (QUOTE_CHARS, "..."))
        self.assertEqual(len(quote("x" * 1000, LEAD_CHARS)), LEAD_CHARS)


class DecisionTests(unittest.TestCase):
    def test_a_repeated_rejection_names_what_to_drop_and_what_is_always_valid(self):
        result = diff([change(1), change(2), change(3, op="remove", kind="relationship")], [row("cpu")])
        problems = ["changes[0]: a breaks", "changes[2]: c breaks", "verification[0]: cpu has no query", "summary: say it"]

        lines = decision_lines(result, problems, left=1)

        self.assertEqual(lines[0], REPEATED_REJECTION)
        self.assertIn("The problems sit in c1 (add entity 'entity-1'), c3 (remove relationship 'entity-3').", lines[1])
        self.assertEqual(lines[2], "Take out verification row(s) 0: their signal is not proposed.")
        self.assertEqual(lines[3], "Also: summary: say it")
        self.assertTrue(lines[4].startswith("Always valid: the diff without those changes"))
        self.assertTrue(lines[5].startswith("1 more unchanged submit(s) and the agent submits a reduced result for you"))

    def test_without_a_change_to_name_only_the_fallbacks_and_the_count_are_left(self):
        lines = decision_lines(diff(), ["summary: say it"], left=2)

        self.assertEqual([line.split(":")[0] for line in lines], ["Same problems as your previous submit", "Also", "Always valid", "2 more unchanged submit(s) and the agent submits a reduced result for you"])

    def test_the_notice_names_what_was_left_out(self):
        result = diff([change(1), change(2), change(3)])
        reduced = diff([change(2)])

        self.assertEqual(
            reduction_notice(result, reduced),
            ["Rejected again: the agent now submits a reduced result for you. Do not submit again.", "Left out, with the problem quoted in `findings`: c1, c3."],
        )
        self.assertEqual(len(reduction_notice(result, result)), 1)


class ReduceTests(unittest.TestCase):
    def reduce(self, result, bad, **extra):
        return reduce_result(result, flagging(*bad), kind="diff", asked="", why="the proposal was rejected 3 times", **extra)

    def test_what_passes_stays_and_what_does_not_becomes_a_finding_that_quotes_its_problem(self):
        findings = [{"severity": "low", "entity": None, "text": "Both.", "changeIds": ["c1", "c2"]}]
        result = diff([change(1), change(2), change(3)], [row("cpu"), row("memory")], findings)

        reduced = self.reduce(result, ["c2", "memory"])

        self.assertEqual([item["id"] for item in reduced["changes"]], ["c1", "c3"])
        self.assertEqual([item["signal"] for item in reduced["verification"]], ["cpu"])
        self.assertEqual(reduced["findings"][0]["changeIds"], ["c1"])
        self.assertEqual(reduced["findings"][1], {"severity": "medium", "entity": "entity-2", "text": "Not proposed (add entity 'entity-2'): entity-2 breaks a rule", "changeIds": []})
        self.assertTrue(reduced["summary"].startswith("Partial result: the proposal was rejected 3 times, so only what passes every check is kept; the 1 change(s) left out are quoted in the findings. Proposes the model."))
        self.assertEqual(validate_task_result(reduced), [])

    def test_a_result_that_passes_every_check_is_returned_with_the_partial_label_only(self):
        reduced = self.reduce(diff([change(1)]), [])

        self.assertEqual([item["id"] for item in reduced["changes"]], ["c1"])
        self.assertEqual(reduced["summary"], "Partial result: the proposal was rejected 3 times, so only what passes every check is kept. Proposes the model.")

    def test_when_every_change_is_taken_out_what_is_left_is_the_findings(self):
        reduced = self.reduce(diff([change(1), change(2)]), ["c1", "c2"])

        self.assertEqual((reduced["changes"], reduced["verification"]), ([], []))
        self.assertEqual([finding["entity"] for finding in reduced["findings"]], ["entity-1", "entity-2"])
        self.assertEqual(
            reduced["summary"],
            "Partial result: the proposal was rejected 3 times, so only what passes every check is kept; the 2 change(s) left out are quoted in the findings. Proposes the model.",
        )
        self.assertEqual(validate_task_result(reduced), [])

    def test_a_problem_that_names_no_change_is_quoted_when_taking_parts_out_cannot_repair_it(self):
        def problems_of(result):
            return ["design: the model has only its root"]

        reduced = reduce_result(diff([change(1)]), problems_of, kind="diff", asked="", why="the proposal was rejected 3 times")

        self.assertEqual(reduced["changes"], [])
        self.assertEqual([finding["text"] for finding in reduced["findings"]], ["Not accepted: design: the model has only its root"])
        self.assertEqual(reduced["summary"], "Partial result: the proposal was rejected 3 times, and nothing in the proposal passes every check, so nothing is proposed.")
        self.assertEqual(validate_task_result(reduced), [])

    def test_a_summary_problem_is_repaired_with_the_sentence_that_says_the_flows_are_inferred(self):
        def problems_of(result):
            return [] if INFERRED_SENTENCE in result["summary"] else ["summary: no repository was read"]

        reduced = reduce_result(diff([change(1)], summary="Proposes the model."), problems_of, kind="diff", asked="", why="the proposal was rejected 3 times")

        self.assertEqual([item["id"] for item in reduced["changes"]], ["c1"])
        self.assertTrue(reduced["summary"].endswith(INFERRED_SENTENCE))

    def test_a_summary_repair_shortens_the_model_summary_first_so_the_sentence_survives(self):
        def problems_of(result):
            plain = INFERRED.search(result["summary"]) and not summary_faults(result["summary"], RunRecord())
            return [] if plain else ["summary: no repository was read, or it is not plain"]

        cases = [
            ("a long summary", "A long summary of the model. " * 30, []),
            ("a long summary and a change taken out", "A long summary of the model. " * 30, ["c2"]),
            ("a summary that fills the room", "x" * 330, []),
            ("a short summary", "Proposes the model.", []),
            ("no summary", "", []),
        ]
        for label, summary, bad in cases:
            with self.subTest(label):
                result = diff([change(number) for number in range(1, 5)], summary=summary)

                reduced = reduce_result(result, lambda candidate: problems_of(candidate) + flagging(*bad)(candidate), kind="diff", asked="", why="the proposal was rejected 3 times")

                self.assertEqual([item["id"] for item in reduced["changes"]], [f"c{number}" for number in range(1, 5) if f"c{number}" not in bad])
                self.assertLessEqual(len(reduced["summary"]), SUMMARY_CHARS)
                self.assertTrue(reduced["summary"].endswith(INFERRED_SENTENCE))
                self.assertEqual(summary_faults(reduced["summary"], RunRecord()), [])
                self.assertEqual(validate_task_result(reduced), [])

    def test_the_summary_stays_within_its_limit_whatever_the_model_wrote(self):
        reduced = self.reduce(diff([change(1)], summary="Long. " * 200), [])

        self.assertLessEqual(len(reduced["summary"]), SUMMARY_CHARS)
        self.assertTrue(reduced["summary"].endswith("..."))

    def test_a_result_that_is_not_a_diff_in_shape_leaves_an_empty_one(self):
        for label, result in [("no lists", {"kind": "diff"}), ("changes that are no objects", {"kind": "diff", "changes": ["x"], "verification": [], "findings": []})]:
            with self.subTest(label):
                reduced = reduce_result(result, lambda candidate: ["result: it is malformed"], kind="diff", asked="", why="the proposal was rejected 3 times")

                self.assertEqual(reduced["changes"], [])
                self.assertEqual([finding["text"] for finding in reduced["findings"]], ["Not accepted: result: it is malformed"])
                self.assertEqual(validate_task_result(reduced), [])
        self.assertEqual([finding["text"] for finding in self.reduce({}, [])["findings"]], ["The Task ended early: the proposal was rejected 3 times."])

    def test_an_explanation_keeps_the_state_the_run_read_and_names_why(self):
        cases = [
            ("the asked entity", {"kind": "explain", "entity": "Checkout"}, "checkout", "Checkout"),
            ("another entity", {"kind": "explain", "entity": "orders-db"}, "checkout", "checkout"),
            ("none", {}, "checkout", "checkout"),
            ("none asked", {}, "", "unknown"),
        ]
        for label, result, asked, entity in cases:
            with self.subTest(label):
                reduced = reduce_result(result, lambda candidate: ["summary: it is long"] if result else [], kind="explain", asked=asked, why="the Task used all 12 model calls", state="Degraded")

                self.assertEqual((reduced["kind"], reduced["entity"], reduced["state"], reduced["causes"]), ("explain", entity, "Degraded", []))
                self.assertLessEqual(len(reduced["summary"]), SUMMARY_CHARS)
        self.assertEqual(
            empty_explanation("checkout", [], "the Task used all 12 model calls")["summary"], "Partial result: the Task used all 12 model calls, so no explanation could be completed."
        )

    def test_the_findings_of_an_empty_result_are_the_first_three_problems_or_the_reason(self):
        problems = [f"problem {number}" for number in range(5)]

        self.assertEqual([item["text"] for item in empty_diff(problems, [], "why")["findings"]], ["Not accepted: problem 0", "Not accepted: problem 1", "Not accepted: problem 2"])
        self.assertEqual([item["text"] for item in empty_diff([], [], "why")["findings"]], ["The Task ended early: why."])
        dropped = dropped_finding(change(1, kind="relationship"), "relationship is wrong")
        self.assertEqual((dropped["entity"], dropped["changeIds"]), (None, []))

    def test_the_partial_summary_leaves_room_for_the_lead(self):
        for left_out in (0, 3):
            with self.subTest(left_out):
                text = partial_summary("why", left_out, "word " * 200)

                self.assertLessEqual(len(text), SUMMARY_CHARS)
                self.assertTrue(text.startswith("Partial result: why, so only what passes every check is kept"))


if __name__ == "__main__":
    unittest.main()

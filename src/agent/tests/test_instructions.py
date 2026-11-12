import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from agent import visible_tools
from contracts import RESOURCE_SCHEMA_PATH, SCHEMA_PATH
from grounding import EXAMPLE_WORDS, INFERRED, INFERRED_SENTENCE
from instructions import COMMON, TYPE_INSTRUCTIONS, full_instructions, instructions_for
from skillset import DESCRIPTIONS, TASK_SKILLS
from tools import TYPE_TOOLS

SKILLS_DIR = Path(__file__).parents[1] / "skills"
TYPES = ("explain", "review", "design")
DIFF_TYPES = ("review", "design")
WORD_LIMITS = {"explain": 800, "review": 1000, "design": 1050}
TOOL_NAME = re.compile(r"`((?:monitor|group)_[a-z_]+|submit_result|load_skill|run_shell|clone_repository)`")


def schema_words(node):
    """Property names and enum values anywhere in the schema."""
    if isinstance(node, dict):
        yield from node.get("properties", {})
        for value in node.get("enum", []):
            yield value
        for value in node.values():
            yield from schema_words(value)
    elif isinstance(node, list):
        for value in node:
            yield from schema_words(value)


def result_words(*definitions):
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return sorted({word for name in definitions for word in schema_words(schema["$defs"][name])} | {"kind"})


def named(text, word):
    return re.search(rf"(?<![A-Za-z0-9_]){re.escape(word)}(?![A-Za-z0-9_])", text) is not None


class InstructionsTests(unittest.TestCase):
    def test_a_task_type_gets_the_shared_part_and_its_own(self):
        self.assertEqual(instructions_for(""), "")
        self.assertEqual(instructions_for("unknown"), "")
        for task_type in TYPES:
            with self.subTest(task_type):
                self.assertEqual(instructions_for(task_type), TYPE_INSTRUCTIONS[task_type])
                self.assertEqual(full_instructions(task_type), f"{COMMON}\n\n{TYPE_INSTRUCTIONS[task_type]}")
        self.assertEqual(full_instructions(""), COMMON)

    def test_each_prompt_stays_short(self):
        for task_type, limit in WORD_LIMITS.items():
            with self.subTest(task_type):
                words = len(full_instructions(task_type).split())
                self.assertLessEqual(words, limit, f"the {task_type} prompt has {words} words")
        words = len(full_instructions("explain", moment=True).split())
        self.assertLessEqual(words, WORD_LIMITS["explain"], f"the explain prompt for a past moment has {words} words")

    def test_the_tools_a_prompt_names_are_tools_its_type_is_offered(self):
        for task_type in TYPES:
            offered = visible_tools(task_type)
            for name in sorted(set(TOOL_NAME.findall(full_instructions(task_type)))):
                with self.subTest(task_type=task_type, name=name):
                    self.assertIn(name, offered)

    def test_every_tool_a_type_has_beyond_the_azure_tools_is_named_in_its_prompt(self):
        for task_type in TYPES:
            for name in (*TYPE_TOOLS[task_type], "load_skill"):
                with self.subTest(task_type=task_type, name=name):
                    self.assertIn(f"`{name}`", full_instructions(task_type))

    def test_each_task_type_loads_the_skills_it_is_offered_in_order(self):
        expected = {
            "explain": "Load `healthmodel-analyze`.",
            "review": "Load `healthmodel-analyze`, then `healthmodel-design-rules`.",
            "design": "Load `healthmodel-plan`, then `healthmodel-design-rules`.",
        }
        for task_type, sentence in expected.items():
            with self.subTest(task_type):
                self.assertIn(sentence, full_instructions(task_type))
                loaded = re.findall(r"`(healthmodel-[a-z-]+)`", sentence)
                self.assertEqual(tuple(loaded), TASK_SKILLS[task_type])

    def test_every_skill_a_type_is_offered_exists_and_the_others_are_not_named(self):
        skills = {path.name for path in SKILLS_DIR.iterdir() if path.is_dir()}
        self.assertEqual(skills, {"healthmodel-analyze", "healthmodel-build", "healthmodel-design-rules", "healthmodel-plan"})
        for task_type in TYPES:
            for skill in skills:
                with self.subTest(task_type=task_type, skill=skill):
                    self.assertEqual(f"`{skill}`" in full_instructions(task_type), skill in TASK_SKILLS[task_type])
        for skill in DESCRIPTIONS:
            self.assertIn(skill, skills)

    def test_runtime_rules_are_stated(self):
        for expected in [
            "only that call reaches the UI, and the run ends when it is accepted",
            "A rejection that repeats is a decision, not a list",
            "Nobody answers questions",
            "`{\"task\": {\"id\", \"type\", \"target\", \"workload\", \"instruction\"}, \"relationships\": [{\"name\", \"parent\", \"child\"}]}`",
            "`nonce` reads `[hidden]`: ignore it",
            "Work on the latest Task and read the model again for it",
            "Call independent tools together in one turn",
            "always pass `interval`",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, COMMON)
        for expected in ["api-version 2026-11-01", "a rename deletes history", "`verified`", "`failing`", "`not_run`"]:
            for task_type in DIFF_TYPES:
                with self.subTest(expected, task_type=task_type):
                    self.assertIn(expected, full_instructions(task_type))

    def test_relationships_come_from_the_task_and_keep_their_names(self):
        self.assertIn("`relationships` are the model's current ones, which `monitor_healthmodels_inspect` does not return: the list is complete", COMMON)
        for expected in [
            "a new one named `<parent>-<child>`",
            "both ends exist: in the model, the root too, or added by you",
            "Removing an entity needs a `remove` for every relationship that names it",
        ]:
            for task_type in DIFF_TYPES:
                with self.subTest(expected, task_type=task_type):
                    self.assertIn(expected, full_instructions(task_type))
        for outdated in ["take parent and child from the `path`", "and the `Dependencies` walk from the root"]:
            with self.subTest(outdated):
                self.assertFalse(any(outdated in full_instructions(task_type) for task_type in TYPES))

    def test_a_review_reads_the_whole_model_and_judges_evidence(self):
        for expected in [
            "Read the whole model",
            "no reads per entity, no `walk`",
            "is no data yet, not a defect",
            "Call a resource missing or its id wrong only when `group_resource_list` lacks it",
            "Every defect the model's own settings can fix gets a `change`",
            "No change is a valid answer",
            "copies the whole entity from `monitor_healthmodels_inspect` and edits only what the fix needs",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, instructions_for("review"))

    def test_every_read_is_the_signed_in_users_and_a_refusal_is_reported_not_worked_around(self):
        for expected in [
            "Azure reads run with the signed-in user's permissions",
            "Access denied on a resource (403, `AuthorizationFailed`): say so in a finding",
            "Do not retry or look for another route",
            "go on with what you can read",
            "A signal you could not query is `not_run` with the reason",
            "Azure cannot be read for this Task",
            "reading the model or entity fails twice",
            "(`causes`, `changes` and `verification` empty; explain: `state` `Unknown`)",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, COMMON)

    def test_an_explain_reads_history_only_for_a_bounded_window_and_says_which(self):
        for expected in [
            "History is not part of the default answer",
            "`include` `History`, `entity` the asked entity, no `walk`",
            "Leave out `start-at` and `end-at` (you have no clock) unless a time in the data gives them",
            "reads the last 24 hours, or the period the instruction names (30 days at most)",
            "refuses `SignalHistory` and `Annotations` unless the instruction asks about the past",
            "replaces the analyze skill's 30 days",
            "`window` is `{\"from\", \"to\"}` of the period read",
            "otherwise leave `window` out",
            "`monitor_activitylog_list` shows what changed on a resource",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, instructions_for("explain"))
        self.assertNotIn("window", instructions_for("review") + instructions_for("design"))

    def test_an_explain_about_a_past_moment_reads_that_moment_in_place_of_the_rule_for_history(self):
        at_moment, now = instructions_for("explain", moment=True), instructions_for("explain")
        for expected in [
            "The Task has `asOf`: the question is about that instant, and the state now may differ",
            "The tool sets `timestamp` on every `monitor_healthmodels_inspect`",
            "`include` `History`, `entity` the asked entity, no `walk`",
            "the tool reads the 24 hours that end at `asOf`, or the period the instruction names",
            "`monitor_metrics_query` is set to that window",
            "a log query counts `now()` and `ago()` from `asOf` and must bound `TimeGenerated` above",
            "what `monitor_activitylog_list` lists after `asOf` does not count",
            "`window` is `{\"from\", \"to\"}` of the period read",
            "`state` its state at `asOf`",
            "Write in the past tense, without a clock time",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, at_moment)
        self.assertNotIn("asOf", now)
        for left_out in ["History is not part of the default answer", "you have no clock", "its current state"]:
            with self.subTest(left_out):
                self.assertNotIn(left_out, at_moment)
                self.assertIn(left_out, now)
        self.assertEqual(at_moment.split("\n2. ")[0], now.split("\n2. ")[0])
        for task_type in DIFF_TYPES:
            with self.subTest(task_type):
                self.assertEqual(instructions_for(task_type, moment=True), instructions_for(task_type))
        for name in sorted(set(TOOL_NAME.findall(at_moment))):
            with self.subTest(name):
                self.assertIn(name, visible_tools("explain"))
        for word in result_words("explain", "cause", "healthState", "confidence", "window"):
            with self.subTest(word):
                self.assertTrue(named(full_instructions("explain", moment=True), word), f"{word} is not in the instructions for a past moment")

    def test_the_answers_are_written_for_the_person_who_runs_the_application(self):
        for expected in [
            "display names, never ids",
            "one plain sentence of at most 30 words",
            "No signal ids, GUIDs, resource ids, API property names or rollup terms",
            "what it means for the user, then the fix, in plain words",
            "`confidence`: `high`, `medium` or `low`",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, COMMON)

    def test_a_design_against_a_model_that_is_not_empty_keeps_removes_or_adds(self):
        for expected in [
            "It is often not empty (an earlier design, a manual edit)",
            "keep what follows these rules, `remove` what does not",
            "with every relationship that names it",
            "never again what exists under any spelling",
            "A name cannot change: to replace an entity, `remove` it and `add` the replacement under another name",
            "A model that already covers the workload gets a diff without changes and a `summary` that says so",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, instructions_for("design"))

    def test_the_grounding_rules_are_stated(self):
        design = full_instructions("design")
        for expected in [
            "`submit_result` enforces",
            "lower-case kebab-case, never copied from the skills' examples",
            "`azureResourceId` is an id exactly as `group_resource_list` returned it",
            "resource entity below it",
            "names the listed resource or the repository file it rests on",
            "`clone_repository` it and read its code and infrastructure files with `run_shell`",
            "derive the flows from what the resources are",
            "getschema",
            "`AppRoleName`",
            "`cloud_RoleName`",
            "A new signal whose query did not run and return is rejected",
            "`failing` only for a signal the model already has",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, design)

    def test_the_instructions_name_every_word_the_examples_are_refused_for(self):
        for word in EXAMPLE_WORDS:
            with self.subTest(word):
                self.assertIn(word, instructions_for("design").lower())

    def test_the_sentence_the_instructions_ask_for_is_one_the_rule_accepts(self):
        self.assertIn(f'"{INFERRED_SENTENCE}"', instructions_for("design"))
        self.assertTrue(INFERRED.search(INFERRED_SENTENCE))

    def test_nothing_says_the_agent_has_an_azure_identity_of_its_own_or_runs_azmcp(self):
        for outdated in ["azmcp", "read-only identity", "managed identity", "Reader", "AZURE_TOKEN_CREDENTIALS", "access denied", "There is no `az` CLI"]:
            for task_type in TYPES:
                with self.subTest(outdated, task_type=task_type):
                    self.assertNotIn(outdated, full_instructions(task_type))

    def test_the_shapes_use_the_property_names_of_the_resource_schema(self):
        schema = json.loads(RESOURCE_SCHEMA_PATH.read_text(encoding="utf-8"))
        known = set(schema_words(schema))
        for word in [
            "displayName", "icon", "iconName", "alerts", "signalGroups", "dependencies", "aggregationType", "azureResource",
            "azureResourceId", "authenticationSetting", "azureLogAnalytics", "logAnalyticsWorkspaceResourceId", "signals",
            "signalKind", "metricNamespace", "metricName", "timeGrain", "refreshInterval", "dataUnit", "evaluationRules",
            "degradedRule", "unhealthyRule", "operator", "threshold", "queryText", "valueColumnName", "parentEntityName",
            "childEntityName", "WorstOf", "AzureResourceMetric", "LogAnalyticsQuery", "GreaterThan",
        ]:
            with self.subTest(word):
                self.assertTrue(word in known or f'"{word}"' in json.dumps(schema), f"{word} is not in the resource schema")
                for task_type in DIFF_TYPES:
                    if word != "alerts" or task_type:
                        self.assertTrue(named(full_instructions(task_type), word), f"{word} is not in the {task_type} instructions")

    def test_the_result_shapes_name_every_property_and_enum_value_of_the_schema(self):
        cases = {
            "explain": result_words("explain", "cause", "healthState", "confidence", "window"),
            "review": result_words("diff", "change", "verification", "finding", "confidence"),
            "design": result_words("diff", "change", "verification", "finding", "confidence"),
        }
        for task_type, words in cases.items():
            for word in words:
                with self.subTest(task_type=task_type, word=word):
                    self.assertTrue(named(full_instructions(task_type), word), f"{word} is not in the {task_type} instructions")


class ReadmeTests(unittest.TestCase):
    TEXT = (Path(__file__).parents[1] / "README.md").read_text(encoding="utf-8")

    def test_it_describes_the_remote_azure_access_and_the_local_override(self):
        for expected in [
            "holds no Azure role",
            "`MCP_URL`",
            "`WEB_APP_URL`",
            "`WEB_API_AUDIENCE`",
            "POST {WEB_APP_URL}/api/agent/token",
            "`MCP_BEARER_COMMAND`",
            "`AUTH_MODE=local`",
            "refuses to start with it",
            "`FOUNDRY_AGENT_NAME` is set",
            "`FOUNDRY_AGENT_PRINCIPAL_ID`",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, self.TEXT)

    def test_it_describes_what_ends_a_task_and_what_a_type_sees(self):
        for expected in [
            "`RunPolicy`",
            "`partial: true`",
            "`clone_repository`",
            "`AzureScope`",
            "`InspectWindow`",
            "`protect_process`",
            "`healthmodel-design-rules`",
            "A run can still end without a result",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, self.TEXT)

    def test_it_no_longer_describes_azmcp_or_an_identity_of_its_own(self):
        for outdated in ["azmcp", "AZMCP", "dotnet", "read access", "holds read roles", "The identity holds read roles only", "RequireCallAfterRejection"]:
            with self.subTest(outdated):
                self.assertNotIn(outdated, self.TEXT)


if __name__ == "__main__":
    unittest.main()

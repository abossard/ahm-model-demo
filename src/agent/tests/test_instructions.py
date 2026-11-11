import json
import sys
import unittest
from pathlib import Path

from agent_framework import SkillsProvider

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from azure_mcp import AZURE_MCP_TOOLS
from contracts import RESOURCE_SCHEMA_PATH, SCHEMA_PATH
from instructions import INSTRUCTIONS
from tools import RunRecord, task_tools

SKILLS_DIR = Path(__file__).parents[1] / "skills"


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


class InstructionsTests(unittest.TestCase):
    def test_every_skill_and_tool_is_named_as_it_is_registered(self):
        skills = sorted(path.name for path in SKILLS_DIR.iterdir() if path.is_dir())
        names = {
            "skills": skills,
            "skill tools": [SkillsProvider.LOAD_SKILL_TOOL_NAME, SkillsProvider.READ_SKILL_RESOURCE_TOOL_NAME],
            "task tools": [tool.name for tool in task_tools(Path("."), RunRecord())],
            "azure tools": list(AZURE_MCP_TOOLS),
        }
        self.assertEqual(skills, ["healthmodel-analyze", "healthmodel-build", "healthmodel-plan"])
        for group, group_names in names.items():
            for name in group_names:
                with self.subTest(group=group, name=name):
                    self.assertTrue(f"`{name}`" in INSTRUCTIONS, f"`{name}` is not in the instructions")

    def test_each_task_type_loads_its_skills_in_order(self):
        for expected in [
            "**review** (result `diff`)",
            "Load `healthmodel-analyze`, then `healthmodel-plan`",
            "**explain** (result `explain`)",
            "1. Load `healthmodel-analyze`.",
            "**design** (result `diff`)",
            "Load `healthmodel-plan`, then `healthmodel-build`",
        ]:
            with self.subTest(expected):
                self.assertTrue(expected in INSTRUCTIONS, f"{expected!r} is not in the instructions")

    def test_runtime_rules_are_stated(self):
        for expected in [
            "There is no `az` CLI",
            "Never deploy or write to Azure",
            "not files or Bicep but the `submit_result` call",
            "never as text in an answer",
            "The run ends when the result is accepted",
            "one short sentence",
            "working folder of its own",
            "api-version 2026-11-01",
            "`{\"task\": {\"id\", \"type\", \"target\", \"workload\", \"instruction\"}, \"relationships\": [{\"name\", \"parent\", \"child\"}]}`",
            "a rename deletes the entity's history",
            "`verified`",
            "`failing`",
            "`not_run`",
        ]:
            with self.subTest(expected):
                self.assertTrue(expected in INSTRUCTIONS, f"{expected!r} is not in the instructions")

    def test_relationships_come_from_the_task_and_keep_their_names(self):
        for expected in [
            "`relationships` (review and design) are the model's current relationships",
            "treat this list as complete",
            "use its `name` from the Task's `relationships`",
            "a new one is named `<parent>-<child>`",
            "Never `add` a parent and child pair that is already listed, under any name",
            "A new entity needs `add` changes for its relationships",
            "removing an entity needs a `remove` for every listed relationship that names it",
        ]:
            with self.subTest(expected):
                self.assertTrue(expected in INSTRUCTIONS, f"{expected!r} is not in the instructions")
        for outdated in ["take parent and child from the `path`", "and the `Dependencies` walk from the root"]:
            with self.subTest(outdated):
                self.assertFalse(outdated in INSTRUCTIONS, f"{outdated!r} is still in the instructions")

    def test_every_task_reads_again_and_judges_evidence(self):
        for expected in [
            "read the model again for every Task",
            "A review reads every entity and relationship of the model, whatever earlier Tasks looked at, and proposes changes only for defects",
            "A change that leaves its resource as it is does not belong in the result",
            "Every defect the model's own settings can fix gets a `change`",
            "is no data yet",
            "Call a resource missing or its id wrong only when",
            "Run a signal's `queryText` unchanged",
            "Never write a row for a query you did not run in this Task",
            "always pass `interval`",
            "Call independent tools together in one turn",
            "check it once (`group_resource_list`, or the signal's query) and say whether the data exists now",
            "Both ends of a relationship must exist: an entity of the model (the root too) or one you `add` in the same result",
        ]:
            with self.subTest(expected):
                self.assertTrue(expected in INSTRUCTIONS, f"{expected!r} is not in the instructions")

    def test_every_read_is_the_signed_in_users_and_a_refusal_is_reported_not_worked_around(self):
        for expected in [
            "Every Azure read runs with the permissions of the signed-in user who started the Task. You have no identity of your own.",
            "the user has no access to it",
            "do not look for another route",
            "you have no access to <resource>",
            "continue with what you can read",
            "A review or design of what is readable is a valid result",
            "the user must sign in again, an administrator must grant consent, the Task ended",
            "explain: `state` `Unknown`, `causes` `[]`; review and design: `changes` `[]`, `verification` `[]`",
            "`nonce` belongs to the web app and reads `[hidden]`: ignore it",
        ]:
            with self.subTest(expected):
                self.assertTrue(expected in INSTRUCTIONS, f"{expected!r} is not in the instructions")

    def test_nothing_says_the_agent_has_an_azure_identity_of_its_own_or_runs_azmcp(self):
        for outdated in ["azmcp", "read-only identity", "managed identity", "Reader", "AZURE_TOKEN_CREDENTIALS", "access denied"]:
            with self.subTest(outdated):
                self.assertFalse(outdated in INSTRUCTIONS, f"{outdated!r} is still in the instructions")

    def test_the_shapes_use_the_property_names_of_the_resource_schema(self):
        schema = json.loads(RESOURCE_SCHEMA_PATH.read_text(encoding="utf-8"))
        known = set(schema_words(schema))
        for word in [
            "displayName", "icon", "iconName", "healthObjective", "impact", "alerts", "signalGroups", "dependencies",
            "aggregationType", "ignoreUnknown", "azureResource", "azureResourceId", "authenticationSetting",
            "azureLogAnalytics", "logAnalyticsWorkspaceResourceId", "signals", "signalKind", "metricNamespace",
            "metricName", "timeGrain", "refreshInterval", "dataUnit", "evaluationRules", "degradedRule",
            "unhealthyRule", "operator", "threshold", "queryText", "valueColumnName", "signalDefinitionName",
            "parentEntityName", "childEntityName", "Standard", "Limited", "Suppressed",
            "WorstOf", "BestOf", "MinHealthy", "MaxNotHealthy", "AzureResourceMetric", "LogAnalyticsQuery",
            "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual", "Equal", "NotEqual",
            "Sev0", "Sev4", "actionGroupIds", "severity", "description",
        ]:
            with self.subTest(word):
                self.assertTrue(word in known or f'"{word}"' in json.dumps(schema), f"{word} is not in the resource schema")
                self.assertTrue(f'"{word}"' in INSTRUCTIONS or f"`{word}`" in INSTRUCTIONS, f"{word} is not in the instructions")

    def test_the_result_shapes_name_every_property_and_enum_value_of_the_schema(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

        for word in sorted(set(schema_words(schema))):
            with self.subTest(word):
                self.assertTrue(f'"{word}"' in INSTRUCTIONS or f"`{word}`" in INSTRUCTIONS, f"{word} is not in the instructions")


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
                self.assertTrue(expected in self.TEXT, f"{expected!r} is not in the README")

    def test_it_no_longer_describes_azmcp_or_an_identity_of_its_own(self):
        for outdated in ["azmcp", "AZMCP", "dotnet", "read access", "holds read roles", "The identity holds read roles only"]:
            with self.subTest(outdated):
                self.assertFalse(outdated in self.TEXT, f"{outdated!r} is still in the README")


if __name__ == "__main__":
    unittest.main()

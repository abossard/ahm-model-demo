import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[3]


class DeploymentContracts(unittest.TestCase):
    def test_standalone_service_and_output_image_contract(self):
        yaml = (ROOT / "azure.yaml").read_text()
        self.assertIn("  survey:\n    project: ./src/survey", yaml)
        params = json.loads((ROOT / "infra/main.parameters.json").read_text())
        self.assertEqual(params["parameters"]["surveyImage"]["value"], "${SERVICE_SURVEY_IMAGE_NAME}")
        main = (ROOT / "infra/main.bicep").read_text()
        for output in ("SERVICE_SURVEY_NAME", "SERVICE_SURVEY_ID", "SERVICE_SURVEY_FQDN",
                       "SURVEY_HEALTH_MODEL_ID", "SURVEY_HEALTH_MODEL_NAME"):
            with self.subTest(output=output):
                self.assertIn(f"output {output} string", main)
        platform = (ROOT / "infra/modules/survey-platform.bicep").read_text()
        self.assertIn("'container-app.bicep'", platform)
        self.assertNotIn("Microsoft.ManagedIdentity", platform)
        self.assertNotIn("Microsoft.Insights/components", platform)
        self.assertNotIn("Microsoft.OperationalInsights/workspaces", platform)

    def test_legacy_role_exclusions_preserve_unverified_roles(self):
        source = (ROOT / "infra/modules/health-model-entities.bicep").read_text()
        queries = re.findall(r"queryText: '(App(?:Requests|Dependencies|Exceptions)[^']*)'", source)
        self.assertEqual(len(queries), 4)
        for query in queries:
            with self.subTest(table=query.split()[0]):
                self.assertIn('where AppRoleName != "ahm-survey"', query)
                self.assertNotIn("AppRoleName ==", query)
        for role in ("", "legacy", "ahm-health-copilot", "unknown", "ahm-survey"):
            with self.subTest(role=role):
                self.assertEqual(role != "ahm-survey", role in ("", "legacy", "ahm-health-copilot", "unknown"))

    def test_survey_health_has_evidence_gated_flows(self):
        source = (ROOT / "infra/modules/survey-health-entities.bicep").read_text()
        for name in ("Author Survey", "Join and Answer", "View Results"):
            self.assertIn(name, source)
        self.assertIn("ignoreUnknown: false", source)
        self.assertIn("where Samples > 0", source)
        self.assertIn('AppRoleName == "ahm-survey"', source)
        self.assertNotIn("print Value = 100", source)
        self.assertNotIn("discoveryrules", source.lower())
        self.assertNotIn("webtests", source.lower())
        for samples, failures, expected in ((0, 0, None), (5, 0, 100), (5, 1, 80)):
            with self.subTest(samples=samples, failures=failures):
                value = 100 * (samples - failures) / samples if samples else None
                self.assertEqual(value, expected)

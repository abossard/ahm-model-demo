import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from plain import HOW, SUMMARY_CHARS, ids_named, plain_problems, summary_faults
from tools import RunRecord

GUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
RESOURCE = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/web"


def record():
    return RunRecord(entities={"container-app": {}, "orders-db": {}, "hm": {}, "api": {}})


def explain(summary="Checkout is unhealthy because the orders database is overloaded.", notes=("The database is too busy.",)):
    causes = [{"entity": "orders-db", "signal": None, "state": "Unhealthy", "threshold": None, "value": None, "rollup": None, "note": note} for note in notes]
    return {"kind": "explain", "entity": "checkout", "state": "Unhealthy", "summary": summary, "causes": causes}


def diff(summary="The model covers the workload.", texts=("The flow has no signal.",)):
    findings = [{"severity": "low", "entity": None, "text": text, "changeIds": []} for text in texts]
    return {"kind": "diff", "summary": summary, "changes": [], "verification": [], "findings": findings}


class SummaryTests(unittest.TestCase):
    def test_a_summary_is_short_and_has_no_ids_or_technical_terms(self):
        cases = [
            ("plain", "Checkout is unhealthy because the orders database is overloaded.", []),
            ("at the limit", "x" * SUMMARY_CHARS, []),
            ("too long", "x" * (SUMMARY_CHARS + 1), [f"it is {SUMMARY_CHARS + 1} characters long, at most {SUMMARY_CHARS}"]),
            ("a guid", f"Checkout {GUID} is down.", ["it holds a GUID"]),
            ("a resource id", f"The site {RESOURCE} is down.", ["it holds a resource id"]),
            ("rollup terms", "The WorstOf rollup turns it red.", ["it uses technical terms (rollup, worstof)"]),
            ("property names", "Its evaluationRules and signalGroups are wrong.", ["it uses technical terms (evaluationrules, signalgroups)"]),
            ("an entity id", "The container-app is down.", ["it names entities by id (container-app)"]),
            ("an entity id in a longer word", "The container-apps are down.", []),
            ("a short id", "The api is down and hm too.", []),
            ("several", f"The container-app {GUID} rollup.", ["it holds a GUID", "it uses technical terms (rollup)", "it names entities by id (container-app)"]),
        ]
        for label, summary, expected in cases:
            with self.subTest(label):
                self.assertEqual(summary_faults(summary, record()), expected)

    def test_the_entities_a_text_calls_by_id(self):
        cases = [
            ("a whole word", "Check container-app now", ["container-app"]),
            ("in another case", "CONTAINER-APP is down", ["container-app"]),
            ("inside a longer name", "my-container-app-2 is down", []),
            ("none", "The app is down", []),
        ]
        for label, text, expected in cases:
            with self.subTest(label):
                self.assertEqual(ids_named(text, record()), expected)


class PlainProblemsTests(unittest.TestCase):
    def test_a_result_is_written_for_the_person_who_runs_the_application(self):
        cases = [
            ("an explain in plain words", explain(), []),
            ("a diff in plain words", diff(), []),
            ("a long summary", explain(summary="x" * 400), [f"summary: it is 400 characters long, at most {SUMMARY_CHARS}. {HOW}"]),
            ("a guid in a note", explain(notes=(f"Resource {GUID} is busy.",)), ["causes[0].note: holds a GUID or a resource id. Say it in plain words: ids belong in `entity`, `signal` and the changes"]),
            ("a resource id in the second note", explain(notes=("Fine.", f"Look at {RESOURCE}")), ["causes[1].note: holds a GUID or a resource id. Say it in plain words: ids belong in `entity`, `signal` and the changes"]),
            ("a guid in a finding", diff(texts=("Fine.", f"The id {GUID} is wrong.")), ["findings[1].text: holds a GUID or a resource id. Say it in plain words: ids belong in `entity`, `signal` and the changes"]),
            ("both", explain(summary=f"{GUID} is down", notes=(RESOURCE,)), [f"summary: it holds a GUID. {HOW}", "causes[0].note: holds a GUID or a resource id. Say it in plain words: ids belong in `entity`, `signal` and the changes"]),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                self.assertEqual(plain_problems(result, record()), expected)

    def test_the_hint_says_how_to_write_it(self):
        for text in ("one plain sentence of at most 30 words", "then at most one sentence of evidence", "without ids or technical terms"):
            with self.subTest(text):
                self.assertIn(text, HOW)


if __name__ == "__main__":
    unittest.main()

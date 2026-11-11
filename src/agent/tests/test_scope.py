import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from scope import scope_refusal, used_groups

SUBSCRIPTION = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"
GROUPS = frozenset({"rg-app", "rg-workload"})
ID = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-app/providers/Microsoft.Web/sites/web"


def refusal(**arguments):
    return scope_refusal(arguments, subscription=SUBSCRIPTION, groups=GROUPS, model="hm-app")


class ScopeTests(unittest.TestCase):
    def test_a_call_inside_the_task_is_left_alone(self):
        cases = [
            ("nothing named", {}),
            ("the subscription in another case", {"subscription": SUBSCRIPTION.upper()}),
            ("the target's group", {"subscription": SUBSCRIPTION, "resourcegroup": "RG-APP"}),
            ("the workload's group", {"resourcegroup": "rg-workload"}),
            ("the model in another case", {"healthmodel": "HM-App"}),
            ("a resource of the task", {"resource": ID, "resourcetype": "Microsoft.Web/sites"}),
            ("a resource name", {"resource": "web", "workspace": "law-app"}),
            ("a query that names an id", {"query": f"AppRequests | where _ResourceId == '{ID}'"}),
            ("values that are no text", {"top": 500, "include": ["Signals"], "resourcegroup": None}),
            ("blank names", {"subscription": "  ", "resourcegroup": ""}),
        ]
        for label, arguments in cases:
            with self.subTest(label):
                self.assertIsNone(refusal(**arguments))

    def test_a_call_outside_the_task_is_refused_and_says_what_the_task_is_about(self):
        cases = [
            ("another subscription", {"subscription": OTHER}, f"This Task works in subscription {SUBSCRIPTION}, not {OTHER}. Call again with that `subscription`."),
            ("another group", {"subscription": SUBSCRIPTION, "resourcegroup": "rg-other"}, "This Task reads the resource group rg-app, rg-workload, not rg-other."),
            ("another model", {"healthmodel": "hm-other"}, "This Task is about the health model hm-app, not hm-other."),
            ("a resource of another subscription", {"resource": f"/subscriptions/{OTHER}/resourceGroups/rg-app/providers/x/y/z"}, "is outside this Task's subscription and resource groups."),
            ("a resource of another group", {"resource": ID.replace("rg-app", "rg-other")}, "is outside this Task's subscription and resource groups."),
            ("an id without a group", {"workspace": f"/subscriptions/{SUBSCRIPTION}"}, "is outside this Task's subscription and resource groups."),
        ]
        for label, arguments, expected in cases:
            with self.subTest(label):
                text = refusal(**arguments)

                self.assertIsNotNone(text)
                self.assertIn(expected, text)

    def test_a_long_id_is_cut_in_the_refusal(self):
        text = refusal(resource=f"/subscriptions/{OTHER}/resourceGroups/rg/providers/" + "x" * 200)

        self.assertTrue(text.startswith("The resource /subscriptions/"))
        self.assertIn("...", text)
        self.assertLess(len(text), 250)

    def test_the_groups_of_the_resources_the_model_uses_are_part_of_the_task(self):
        other = ID.replace("rg-app", "rg-Shared")
        elsewhere = ID.replace(SUBSCRIPTION, OTHER).replace("rg-app", "rg-foreign")
        entities = {
            "web-app": {"signalGroups": {"azureResource": {"azureResourceId": other, "signals": []}}},
            "orders-db": {"signalGroups": {"azureLogAnalytics": {"logAnalyticsWorkspaceResourceId": elsewhere}}, "note": "no id here"},
            "api": {"queryText": f"X | where _ResourceId == '{ID}'"},
        }

        found = used_groups(entities, SUBSCRIPTION)

        self.assertEqual(found, frozenset({"rg-shared", "rg-app"}))
        self.assertIsNone(scope_refusal({"resourcegroup": "rg-SHARED", "resource": other}, subscription=SUBSCRIPTION, groups=GROUPS | found, model="hm-app"))
        self.assertIsNotNone(scope_refusal({"resourcegroup": "rg-foreign"}, subscription=SUBSCRIPTION, groups=GROUPS | found, model="hm-app"))
        self.assertEqual(used_groups({}, SUBSCRIPTION), frozenset())

    def test_without_a_model_any_model_may_be_read(self):
        self.assertIsNone(scope_refusal({"healthmodel": "hm-other"}, subscription=SUBSCRIPTION, groups=GROUPS, model=""))


if __name__ == "__main__":
    unittest.main()

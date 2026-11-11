import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from tools import RunRecord
from webchecks import MAX_AFTER_BYTES, MAX_CHANGES, action_group_problems, discovered_problems, present_in, removal_problems, scope_problems, size_problems, web_problems

SCOPE = ("sub-1", "rg-app")
INSIDE = "/subscriptions/sub-1/resourceGroups/rg-app/providers/Microsoft.Web/sites/web"
OUTSIDE = "/subscriptions/sub-2/resourceGroups/rg-app/providers/Microsoft.Web/sites/web"
GROUP = "/subscriptions/sub-1/resourceGroups/rg-ops/providers/microsoft.insights/actionGroups/oncall"


def change(op="add", kind="entity", name="web-app", after=None, number=1):
    return {"id": f"c{number}", "op": op, "kind": kind, "name": name, "after": {} if after is None and op != "remove" else after, "reason": "Because."}


def diff(*changes):
    return {"kind": "diff", "summary": "s", "changes": list(changes), "verification": [], "findings": []}


def resource(rid):
    return {"signalGroups": {"azureResource": {"azureResourceId": rid, "signals": []}}}


def record(**fields):
    entities = {"hm-app": {}, "web-app": {"discoveredBy": "rule"}, "orders-db": {"alerts": {"actionGroupIds": [GROUP]}, **resource(OUTSIDE)}}
    edges = {"hm-app-web-app": ("hm-app", "web-app"), "web-app-orders-db": ("web-app", "orders-db")}
    return RunRecord(entities=entities, edges=edges, root="hm-app", scope=SCOPE, **fields)


class WebChecksTests(unittest.TestCase):
    def test_a_result_the_web_app_would_refuse_is_corrected_in_the_run(self):
        cases = [
            ("a clean diff", diff(change(after=resource(INSIDE))), []),
            ("a resource of another subscription", diff(change(after=resource(OUTSIDE.replace("web", "other")))), [f"changes[0]: entity 'web-app': resource id '{OUTSIDE.replace('web', 'other')}' is outside the target's subscription and resource group and is not used in the model"]),
            ("a resource the model already uses", diff(change(op="change", name="orders-db", after=resource(OUTSIDE))), []),
            ("an action group the model does not use", diff(change(after={"alerts": {"actionGroupIds": [GROUP.replace("oncall", "new")]}})), ["changes[0]: entity 'web-app': action group '/subscriptions/sub-1/resourceGroups/rg-ops/providers/microsoft.insights/actionGr...' is not already used in the model"]),
            ("an action group the model uses", diff(change(after={"alerts": {"actionGroupIds": [GROUP]}})), []),
            ("a change of a discovered entity", diff(change(op="change", name="web-app", after={"displayName": "Web"})), ["changes[0]: entity 'web-app' was discovered automatically and cannot be changed"]),
            ("a removal of a discovered entity", diff(change(op="remove", name="Web-App")), ["changes[0]: entity 'Web-App' was discovered automatically and cannot be removed"]),
            ("an explain", {"kind": "explain"}, []),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                problems = web_problems(result, record())

                self.assertEqual(len(problems), len(expected))
                for text, wanted in zip(problems, expected, strict=True):
                    self.assertEqual(text, wanted)

    def test_too_many_changes_are_the_only_problem(self):
        result = diff(*[change(name=f"entity-{number}", number=number, after=resource(OUTSIDE)) for number in range(MAX_CHANGES + 1)])

        self.assertEqual(web_problems(result, record()), [f"changes: {MAX_CHANGES + 1} changes is more than the {MAX_CHANGES} allowed"])

    def test_an_after_above_the_size_limit(self):
        big = change(after={"displayName": "x" * MAX_AFTER_BYTES})

        problems = size_problems([big, change(number=2)])

        self.assertEqual(len(problems), 1)
        self.assertIn("changes[0]: entity 'web-app': after is", problems[0])
        self.assertIn(f"at most {MAX_AFTER_BYTES} are allowed", problems[0])
        self.assertEqual(size_problems([change(op="remove", after=None)]), [])

    def test_resource_ids_are_matched_in_any_case_and_only_inside_the_target(self):
        cases = [
            ("inside, in another case", INSIDE.upper(), True),
            ("another group", INSIDE.replace("rg-app", "rg-other"), False),
            ("another subscription", OUTSIDE, False),
            ("a path with dots", INSIDE + "/../../x", False),
            ("no id", "web", True),
        ]
        for label, rid, inside in cases:
            with self.subTest(label):
                self.assertEqual(scope_problems([change(after={"displayName": rid})], SCOPE, set()) == [], inside or not rid.startswith("/subscriptions/"))

    def test_without_a_scope_nothing_is_outside_it(self):
        self.assertEqual(scope_problems([change(after=resource(OUTSIDE))], None, set()), [])

    def test_the_text_of_the_model_vouches_for_what_it_holds(self):
        held = present_in(record())

        self.assertIn(OUTSIDE.lower(), held)
        self.assertIn(GROUP.lower(), held)
        self.assertIn("orders-db", held)
        self.assertEqual(action_group_problems([change(after={"alerts": {"actionGroupIds": [GROUP.upper()]}})], held), [])

    def test_a_removal_needs_what_exists_and_nothing_left_that_names_it(self):
        gone = change(op="remove", name="orders-db", after=None)
        edge = change(op="remove", kind="relationship", name="web-app-orders-db", after=None, number=2)
        cases = [
            ("the root", diff(change(op="remove", name="hm-app", after=None)), ["is the root of the model and cannot be removed", "relationship hm-app-web-app still names it"]),
            ("an entity the model does not have", diff(change(op="remove", name="ghost-db", after=None)), ["does not exist in the model: leave this change out"]),
            ("a relationship the task does not have", diff(change(op="remove", kind="relationship", name="ghost-edge", after=None)), ["does not exist in the Task's relationships: leave this change out"]),
            ("an entity whose relationship stays", diff(gone), ["changes[0]: entity 'orders-db' is removed, but relationship web-app-orders-db still names it: add a `remove` change for every relationship that names a removed entity"]),
            ("an entity with its relationship", diff(gone, edge), []),
            ("an addition", diff(change(name="new-db")), []),
            ("an explain", {"kind": "explain"}, []),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                problems = removal_problems(result, record())

                self.assertEqual(len(problems), len(expected), problems)
                for text, wanted in zip(problems, expected, strict=True):
                    self.assertIn(wanted, text)

    def test_discovered_entities_are_found_by_name_in_any_case(self):
        self.assertEqual(discovered_problems([change(op="add", name="Web-App")], record()), [])
        self.assertEqual(len(discovered_problems([change(op="change", name="WEB-APP", after={})], record())), 1)
        self.assertEqual(discovered_problems([change(op="change", kind="relationship", name="web-app", after={})], record()), [])


if __name__ == "__main__":
    unittest.main()

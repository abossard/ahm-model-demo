import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import inventory  # noqa: E402
from obo import ConsentRequired, InteractionRequired  # noqa: E402

HOME = ("11111111-1111-1111-1111-111111111111", "rg-home", "hm-home")
ELSEWHERE = "22222222-2222-2222-2222-222222222222"


def row(subscription, group, name):
    return {"id": f"/subscriptions/{subscription}/resourceGroups/{group}/providers/Microsoft.CloudHealth/healthmodels/{name}", "name": name, "location": "westeurope", "provisioningState": "Succeeded"}


class Health:
    def __init__(self, rows=(), error=None):
        self.rows = list(rows)
        self.error = error

    def query_models(self):
        if self.error:
            raise self.error
        return self.rows


class CatalogTests(unittest.TestCase):
    def test_a_user_sees_every_model_of_every_subscription_they_can_read_and_nothing_else(self):
        health = Health([row(ELSEWHERE, "rg-b", "hm-b"), row(HOME[0], "rg-a", "hm-a")])

        for label, default in (("a user of the home directory", HOME), ("a user of another directory", None)):
            with self.subTest(label=label):
                models = inventory.list_models(health, default)

                self.assertEqual([(m["subscriptionId"], m["name"]) for m in models], [(HOME[0], "hm-a"), (ELSEWHERE, "hm-b")])

    def test_only_the_home_directory_falls_back_to_the_apps_own_model(self):
        cases = [
            ("the home directory, nothing found", Health(), HOME, [HOME]),
            ("the home directory, a failed query", Health(error=RuntimeError("down")), HOME, [HOME]),
            ("another directory, nothing found", Health(), None, []),
            ("another directory, only unusable rows", Health([{"name": "hm-orphan"}]), None, []),
        ]
        for label, health, default, expected in cases:
            with self.subTest(label=label):
                models = inventory.list_models(health, default)

                self.assertEqual([(m["subscriptionId"], m["resourceGroup"], m["name"]) for m in models], expected)

    def test_a_failed_query_of_another_directory_is_an_error_and_not_an_empty_list(self):
        for error in (RuntimeError("down"), ValueError("bad")):
            with self.subTest(error=type(error).__name__):
                with self.assertLogs("ahm-demo", level="WARNING"), self.assertRaises(type(error)):
                    inventory.list_models(Health(error=error), None)

    def test_a_missing_consent_or_a_step_up_is_never_hidden_behind_the_fallback(self):
        for error in (ConsentRequired(), InteractionRequired(None)):
            with self.subTest(error=type(error).__name__):
                for default in (HOME, None):
                    with self.assertRaises(type(error)):
                        inventory.list_models(Health(error=error), default)


class DefaultTests(unittest.TestCase):
    def test_the_default_is_the_apps_model_when_it_is_listed_else_the_first_listed_else_none(self):
        listed = [inventory.model_ref(row(ELSEWHERE, "rg-b", "hm-b")), inventory.model_ref(row(HOME[0].upper(), "RG-HOME", "HM-HOME"))]
        cases = [
            ("the apps model is listed, in any letter case", listed, HOME, {"name": "HM-HOME", "resourceGroup": "RG-HOME", "subscriptionId": HOME[0].upper()}),
            ("the apps model is not listed", listed[:1], HOME, {"name": "hm-b", "resourceGroup": "rg-b", "subscriptionId": ELSEWHERE}),
            ("another directory has no default of the app", listed, None, {"name": "hm-b", "resourceGroup": "rg-b", "subscriptionId": ELSEWHERE}),
            ("nothing is listed", [], HOME, None),
            ("nothing is listed for another directory", [], None, None),
        ]
        for label, models, default, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(inventory.default_model(models, default), expected)


class SelectionTests(unittest.TestCase):
    def test_a_request_without_a_selector_opens_the_apps_model_for_a_home_directory_user_who_can_read_it(self):
        cases = [
            ("the home directory, with a role", HOME, True, (HOME, None)),
            ("the home directory, without a role", HOME, False, (None, "unknown_model")),
            ("another directory", None, True, (None, "unknown_model")),
        ]
        for label, default, readable, expected in cases:
            with self.subTest(label=label):
                asked = []

                def model_exists(*selection):
                    asked.append(selection)
                    return readable

                self.assertEqual(inventory.resolve_selection({}, model_exists, default), expected)
                self.assertEqual(asked, [HOME] if default else [])

    def test_a_partial_selector_borrows_the_apps_subscription_for_the_home_directory_only(self):
        params = {"model": "hm-a", "resourceGroup": "rg-a"}
        cases = [
            ("the home directory", HOME, ((HOME[0], "rg-a", "hm-a"), None)),
            ("another directory", None, (None, "unknown_model")),
        ]
        for label, default, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(inventory.resolve_selection(params, lambda *_: True, default), expected)

    def test_a_named_model_must_exist_for_the_caller_in_every_directory(self):
        params = {"model": "hm-b", "resourceGroup": "rg-b", "subscription": ELSEWHERE}
        for default in (HOME, None):
            with self.subTest(default=bool(default)):
                self.assertEqual(inventory.resolve_selection(params, lambda *_: True, default), ((ELSEWHERE, "rg-b", "hm-b"), None))
                self.assertEqual(inventory.resolve_selection(params, lambda *_: False, default), (None, "unknown_model"))


if __name__ == "__main__":
    unittest.main()

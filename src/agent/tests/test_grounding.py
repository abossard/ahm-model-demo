import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

logging.getLogger("asyncio").setLevel(logging.ERROR)

import grounding
from agent import arguments_of
from grounding import (
    EXAMPLE_WORDS,
    GENERIC_WORDS,
    SKILLS_DIR,
    MetricRun,
    RepoScan,
    example_problems,
    example_words,
    grounded_problems,
    grounding_problems,
    kebab_problems,
    load_templates,
    repository_roots,
    scan_repository,
    scan_signature,
    signal_problems,
    template_labels,
    words_of,
)
from tools import RunRecord

ROOT = "hm-demo"
WEB = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-web"
STORE = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/stsessions"
WORKSPACE = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law-demo"
LISTED = {WEB.lower(): "ca-web", STORE.lower(): "stsessions", WORKSPACE.lower(): "law-demo"}
QUERY = "AppRequests | where Success == false | summarize failedRequests = count()"


def entity(name, display=None, flow=False, resource=None, workspace=None, signals=(), reason="Users reach it through ca-web.", op="add"):
    groups = {}
    if resource:
        groups["azureResource"] = {"authenticationSetting": "auth-system", "azureResourceId": resource, "signals": list(signals)}
    if workspace:
        groups["azureLogAnalytics"] = {"authenticationSetting": "auth-system", "logAnalyticsWorkspaceResourceId": workspace, "signals": list(signals)}
    after = {"displayName": display or name, **({"icon": {"iconName": "UserFlow"}} if flow else {}), **({"signalGroups": groups} if groups else {})}
    return {"id": f"e-{name}", "op": op, "kind": "entity", "name": name, "after": after, "reason": reason}


def edge(parent, child, name=None, op="add"):
    after = None if op == "remove" else {"parentEntityName": parent, "childEntityName": child}
    return {"id": f"r-{parent}-{child}", "op": op, "kind": "relationship", "name": name or f"{parent}-{child}", "after": after, "reason": "Health flows up."}


def definition(name, op="add", **properties):
    return {"id": f"d-{name}", "op": op, "kind": "signalDefinition", "name": name, "after": None if op == "remove" else properties, "reason": "Reused."}


def log_signal(name="failed-requests", query=QUERY, column="failedRequests", **extra):
    return {"name": name, "signalKind": "LogAnalyticsQuery", "queryText": query, "valueColumnName": column, **extra}


def metric_signal(name="cpu", metric="CpuPercentage", namespace="Microsoft.App/containerApps", aggregation="Average"):
    return {"name": name, "signalKind": "AzureResourceMetric", "metricName": metric, "metricNamespace": namespace, "aggregationType": aggregation}


def diff(*changes, summary="Flows are inferred from infrastructure only.", verification=()):
    return {"kind": "diff", "summary": summary, "changes": list(changes), "verification": list(verification), "findings": []}


def row(entity_name, signal, status):
    return {"entity": entity_name, "signal": signal, "status": status, "query": "q", "value": 1 if status == "verified" else None, "error": "boom" if status != "verified" else None}


def record(**fields):
    base = {"root": ROOT, "design": True, "listed": dict(LISTED), "task_type": "design"}
    return RunRecord(**{**base, **fields})


def vocabulary(*texts):
    return {word for text in texts for word in words_of(text)}


class WordsTests(unittest.TestCase):
    def test_a_name_is_its_words_in_lower_case_without_small_words_and_plurals(self):
        cases = [
            ("kebab with a plural", "Browse-products", ["browse", "product"]),
            ("small words", "Complete a purchase", ["complete", "purchase"]),
            ("camel case", "ContainerApps", ["container", "app"]),
            ("digits stay with their letters", "http-5xx", ["http", "5xx"]),
            ("no stem for double s or short words", "address bus", ["address", "bus"]),
            ("underscores", "cloud_RoleName", ["cloud", "role", "name"]),
            ("empty", "", []),
        ]
        for label, text, expected in cases:
            with self.subTest(label):
                self.assertEqual(words_of(text), expected)


class ExampleWordsTests(unittest.TestCase):
    def test_the_labels_of_a_bicep_file_and_a_diagram_are_the_examples_names(self):
        bicep = "resource a 'x' = {\n  name: 'checkout'\n  properties: {\n    displayName: 'Complete a purchase'\n    displayName: 'App Service: ${last(split(id, '\n    description: 'Customers cannot pay'\n  }\n}\n"
        diagram = 'XX_A["XX_A: storefront root<br/>Health: 99%"]\n    B["Browse products"]\n    C["---"]'
        self.assertEqual(template_labels(bicep), ["checkout", "Complete a purchase", "App Service: "])
        self.assertEqual(template_labels(diagram), ["storefront root", "Browse products"])

    def test_only_the_words_of_the_fictional_workload_are_examples(self):
        texts = ["  name: 'order-queue'\n  displayName: 'Order processing'\n  displayName: 'Web errors (HTTP 5xx)'\n"]

        self.assertEqual(example_words(texts), {"order": "order-queue", "queue": "order-queue"})

    def test_the_vendored_templates_give_exactly_the_shops_words(self):
        self.assertEqual(sorted(EXAMPLE_WORDS), ["catalog", "checkout", "order", "product", "purchase", "storefront"])
        for word, label in EXAMPLE_WORDS.items():
            with self.subTest(word):
                self.assertIn(word, words_of(label))

    def test_words_that_name_infrastructure_are_not_examples(self):
        for word in ("api", "app", "web", "cache", "redis", "sql", "database", "service", "azure", "failed", "request", "browse", "http", "5xx"):
            with self.subTest(word):
                self.assertIn(grounding.stem(word), GENERIC_WORDS)
                self.assertNotIn(grounding.stem(word), EXAMPLE_WORDS)

    def test_the_templates_come_from_the_vendored_skills(self):
        names = sorted(path.name for path in SKILLS_DIR.glob("*/templates/*"))

        self.assertEqual(names, ["main.bicep", "modelspec.md", "plan.md"])
        self.assertEqual(len(load_templates(SKILLS_DIR)), 3)
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(load_templates(Path(empty)), [])
            self.assertEqual(example_words(load_templates(Path(empty))), {})


class KebabTests(unittest.TestCase):
    def test_new_names_are_lower_case_kebab_case(self):
        cases = [
            ("kebab entity", [entity("web-app")], None),
            ("digits", [entity("api-2")], None),
            ("capital", [entity("Web-app")], "changes[0] 'Web-app'"),
            ("underscore", [entity("web_app")], "changes[0] 'web_app'"),
            ("double hyphen", [entity("web--app")], "changes[0] 'web--app'"),
            ("leading hyphen", [entity("-web")], "changes[0] '-web'"),
            ("a signal definition", [definition("Http-5xx", signalKind="AzureResourceMetric")], "changes[0] 'Http-5xx'"),
            ("a relationship derived from its ends", [edge("Hm-Demo", "web-app")], None),
            ("a relationship named freely", [edge("hm-demo", "web-app", name="Link")], "changes[0] 'Link'"),
            ("a new signal", [entity("web-app", resource=WEB, signals=[log_signal(name="Failed-Requests")])], "signal 'Failed-Requests'"),
            ("a kebab signal", [entity("web-app", resource=WEB, signals=[log_signal()])], None),
            ("an existing name is not renamed by a change", [entity("Web-App", op="change")], None),
        ]
        for label, changes, expected in cases:
            with self.subTest(label):
                problems = kebab_problems(diff(*changes), record(entities={"web-app": {"displayName": "Web"}}))

                if expected is None:
                    self.assertEqual(problems, [])
                else:
                    self.assertTrue(problems and expected in problems[0], problems)
                    self.assertIn("lower-case kebab-case", problems[0])

    def test_another_spelling_of_an_existing_entity_is_refused(self):
        for label, name in [("no hyphen", "containerapp"), ("underscore", "container_app"), ("hyphens elsewhere", "con-tainer-app")]:
            with self.subTest(label):
                problems = kebab_problems(diff(entity(name)), record(entities={"container-app": {}}))

                self.assertTrue(any("repeats the existing entity 'container-app'" in problem for problem in problems), problems)
        self.assertEqual(kebab_problems(diff(entity("container-app")), record(entities={"container-app": {}})), [])

    def test_an_entity_the_result_removes_is_no_twin_of_its_replacement(self):
        removal = {"id": "c9", "op": "remove", "kind": "entity", "name": "container_app", "after": None, "reason": "Misnamed."}

        cases = [
            ("replaced", diff(removal, entity("container-app")), []),
            ("kept", diff(entity("container-app")), ["repeats the existing entity 'container_app'"]),
            ("another entity removed", diff({**removal, "name": "other-app"}, entity("container-app")), ["repeats the existing entity 'container_app'"]),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                problems = kebab_problems(result, record(entities={"container_app": {}, "other-app": {}}))

                self.assertEqual(len(problems), len(expected), problems)
                for text in expected:
                    self.assertIn(text, problems[0])

    def test_many_offenders_are_listed_once_and_shortened(self):
        problems = kebab_problems(diff(*(entity(f"Bad-{index}") for index in range(9))), record())

        self.assertEqual(len(problems), 1)
        self.assertIn("and 3 more", problems[0])


class ExampleReuseTests(unittest.TestCase):
    def test_the_names_the_live_design_took_from_the_templates_are_refused(self):
        names = ["Browse-products", "Browse-products-api", "Product-catalog", "Complete-a-purchase", "Complete-a-purchase-api", "Order-processing"]
        for name in names:
            with self.subTest(name):
                problems = example_problems(diff(entity(name)), record(), RepoScan())

                self.assertEqual(len(problems), 1)
                self.assertIn(f"changes[0] name {name!r}", problems[0])
                self.assertIn("examples of the skill templates", problems[0])

    def test_names_that_come_from_this_workload_pass(self):
        for name in ["web-app", "use-web-app", "run-agent-work", "keep-session-state", "container-app-web", "session-storage", "azure-mcp"]:
            with self.subTest(name):
                self.assertEqual(example_problems(diff(entity(name)), record(), RepoScan()), [])

    def test_display_names_and_signals_are_checked_too(self):
        cases = [
            ("display name", entity("web-app", display="Complete a purchase"), "displayName 'Complete a purchase'"),
            ("signal name", entity("web-app", resource=WEB, signals=[log_signal(name="failed-checkout-requests")]), "signal name 'failed-checkout-requests'"),
            ("signal display name", entity("web-app", resource=WEB, signals=[log_signal(displayName="Failed catalog requests")]), "signal displayName 'Failed catalog requests'"),
        ]
        for label, change, expected in cases:
            with self.subTest(label):
                problems = example_problems(diff(change), record(), RepoScan())

                self.assertTrue(problems and expected in problems[0], problems)

    def test_a_word_is_allowed_where_the_workload_uses_it(self):
        cases = [
            ("a resource name", record(vocabulary=vocabulary("product-api")), RepoScan(), True),
            ("the instruction", record(vocabulary=vocabulary("Model the product flow")), RepoScan(), True),
            ("the repository", record(), RepoScan(words=frozenset({"product"})), True),
            ("an existing entity of the model does not vouch", record(entities={"product-search": {"displayName": "Product search"}}), RepoScan(), False),
            ("nowhere", record(), RepoScan(words=frozenset({"album"})), False),
        ]
        for label, run, repo, allowed in cases:
            with self.subTest(label):
                problems = example_problems(diff(entity("product-search")), run, repo)

                self.assertEqual(problems == [], allowed)

    def test_a_change_is_checked_for_what_it_sets_not_for_what_the_entity_already_has(self):
        held = {"checkout-flow": {"displayName": "Checkout"}}
        new_signal = log_signal(name="failed-checkout-requests")
        cases = [
            ("the name and display name stay", entity("checkout-flow", display="Checkout", op="change"), True),
            ("the display name changes to an example", entity("checkout-flow", display="Complete a purchase", op="change"), False),
            ("a new signal with an example name", entity("checkout-flow", display="Checkout", workspace=WORKSPACE, signals=[new_signal], op="change"), False),
        ]
        for label, change, allowed in cases:
            with self.subTest(label):
                problems = example_problems(diff(change), record(entities=held), RepoScan())

                self.assertEqual(problems == [], allowed)

    def test_removals_and_relationships_name_nothing_new(self):
        changes = [entity("checkout-flow", op="remove"), edge("hm-demo", "checkout-flow")]

        self.assertEqual(example_problems(diff(*changes), record(), RepoScan()), [])

    def test_the_message_says_what_to_name_things_from(self):
        problem = example_problems(diff(entity("Browse-products")), record(), RepoScan())[0]

        self.assertIn("(product from '", problem)
        self.assertIn("the resources the run listed (ca-web, stsessions, law-demo)", problem)


class GraphTests(unittest.TestCase):
    """Resources, flows and components: every added resource entity points at a listed resource, every flow or
    component has a resource entity below it, and says what it rests on."""

    def problems(self, changes, run=None, repo=RepoScan(), summary="Flows are inferred from infrastructure only."):
        return grounding_problems(diff(*changes, summary=summary), run or record(), repo)

    def test_an_added_resource_entity_points_at_a_resource_the_run_listed(self):
        elsewhere = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Cache/redis/made-up"
        used = record(entities={"cache": {"signalGroups": {"azureResource": {"azureResourceId": elsewhere}}}})
        cases = [
            ("listed", [entity("web-app", resource=WEB)], record(), None),
            ("listed in other case", [entity("web-app", resource=WEB.upper())], record(), None),
            ("not listed", [entity("web-app", resource=elsewhere)], record(), "changes[0] 'web-app' azureResourceId " + elsewhere),
            ("nothing listed", [entity("web-app", resource=WEB)], record(listed={}), "none yet: call group_resource_list"),
            ("used by an entity of the model", [entity("web-app", resource=elsewhere)], used, None),
            ("a log signal's workspace", [entity("web-app", workspace=WORKSPACE)], record(), None),
            ("a workspace that is not listed", [entity("web-app", workspace=elsewhere)], record(), "logAnalyticsWorkspaceResourceId " + elsewhere),
            ("a change to another id", [entity("web-app", resource=elsewhere, op="change")], record(entities={"web-app": {}}), "azureResourceId " + elsewhere),
            ("a change that keeps its id", [entity("web-app", resource=elsewhere, op="change")], record(entities={"web-app": {"signalGroups": {"azureResource": {"azureResourceId": elsewhere}}}}), None),
        ]
        for label, changes, run, expected in cases:
            with self.subTest(label):
                found = [p for p in self.problems(changes, run) if "no group_resource_list call" in p]

                if expected is None:
                    self.assertEqual(found, [])
                else:
                    self.assertTrue(found and expected in found[0], found)

    def test_a_flow_or_component_has_a_resource_entity_below_it(self):
        existing = record(
            entities={"stored": {"signalGroups": {"azureResource": {"azureResourceId": STORE}}}, "plain": {}},
            edges={"hm-demo-stored": (ROOT, "stored"), "hm-demo-plain": (ROOT, "plain")},
        )
        flow = entity("use-web-app", flow=True)
        web = entity("web-app", resource=WEB)
        cases = [
            ("a resource below", [flow, web, edge("use-web-app", "web-app")], record(), None),
            ("through a component", [flow, entity("serve-ui"), web, edge("use-web-app", "serve-ui"), edge("serve-ui", "web-app")], record(), None),
            ("nothing below", [flow], record(), "changes[0] 'use-web-app'"),
            ("a component without a resource", [flow, entity("serve-ui"), edge("use-web-app", "serve-ui")], record(), "changes[0] 'use-web-app', changes[1] 'serve-ui'"),
            ("a resource that is not below it", [flow, web, edge(ROOT, "web-app")], record(), "changes[0] 'use-web-app'"),
            ("an existing resource entity below it", [flow, edge("use-web-app", "stored")], existing, None),
            ("an existing entity that is no resource", [flow, edge("use-web-app", "plain")], existing, "changes[0] 'use-web-app'"),
            ("a relationship that goes in a loop", [flow, entity("serve-ui"), edge("use-web-app", "serve-ui"), edge("serve-ui", "use-web-app")], record(), "changes[0] 'use-web-app'"),
        ]
        for label, changes, run, expected in cases:
            with self.subTest(label):
                found = [p for p in self.problems(changes, run) if "needs at least one resource entity below it" in p]

                if expected is None:
                    self.assertEqual(found, [])
                else:
                    self.assertTrue(found and found[0].startswith(expected), found)
                    self.assertIn("(listed: ca-web, stsessions, law-demo)", found[0])

    def test_removing_the_relationship_to_the_resource_leaves_the_flow_bare(self):
        run = record(
            entities={"flow": {"icon": {"iconName": "UserFlow"}}, "web-app": {"signalGroups": {"azureResource": {"azureResourceId": WEB}}}},
            edges={"flow-web-app": ("flow", "web-app")},
        )
        changes = [entity("use-more", flow=True), edge("use-more", "flow"), edge("flow", "web-app", name="flow-web-app", op="remove")]

        found = [p for p in self.problems(changes, run) if "needs at least one resource entity below it" in p]

        self.assertTrue(found and "'use-more'" in found[0], found)

    def test_a_flow_or_component_names_its_evidence_in_the_reason(self):
        repo = RepoScan(cloned=True, paths=frozenset({"src/server.js", "server.js", "readme.md"}))
        cases = [
            ("a listed resource", "Users reach it through ca-web.", RepoScan(), True),
            ("in capitals", "Users reach it through CA-WEB.", RepoScan(), True),
            ("no evidence", "Users want to use the app.", RepoScan(), False),
            ("a resource that is not listed", "It runs on ca-other.", RepoScan(), False),
            ("a repository file", "The route in src/server.js serves it.", repo, True),
            ("a repository file by name", "See server.js for the route.", repo, True),
            ("a file the repository does not have", "See main.py for the route.", repo, False),
            ("the evidence is too short to count", "It uses a.", RepoScan(), False),
        ]
        for label, reason, repo_scan, grounded in cases:
            with self.subTest(label):
                changes = [entity("use-web-app", flow=True, reason=reason), entity("web-app", resource=WEB), edge("use-web-app", "web-app")]

                found = [p for p in self.problems(changes, repo=repo_scan) if "names no evidence" in p]

                self.assertEqual(found == [], grounded)
                if not grounded:
                    self.assertIn("changes[0] 'use-web-app'", found[0])

    def test_without_a_repository_the_summary_says_the_flows_are_inferred(self):
        flow = [entity("use-web-app", flow=True), entity("web-app", resource=WEB), edge("use-web-app", "web-app")]
        component = [entity("serve-ui"), entity("web-app", resource=WEB), edge("serve-ui", "web-app")]
        cloned = RepoScan(cloned=True, paths=frozenset({"ca-web"}))
        cases = [
            ("flows, no repository, no words", flow, "A design.", RepoScan(), False),
            ("flows, the sentence", flow, "A design. Flows are inferred from infrastructure only.", RepoScan(), True),
            ("flows, inferred from the infrastructure", flow, "Flows are inferred from the infrastructure.", RepoScan(), True),
            ("flows, a repository was read", flow, "A design.", cloned, True),
            ("components only", component, "A design.", RepoScan(), True),
        ]
        for label, changes, summary, repo, allowed in cases:
            with self.subTest(label):
                found = [p for p in self.problems(changes, summary=summary, repo=repo) if p.startswith("summary:")]

                self.assertEqual(found == [], allowed)
                if not allowed:
                    self.assertIn("Flows are inferred from infrastructure only.", found[0])

    def test_a_workload_with_a_repository_url_is_designed_from_the_clone(self):
        url = "https://github.com/example/albums"
        cases = [
            ("not cloned, not tried", record(repository=url), RepoScan(), "no repository was cloned in this Task"),
            ("tried, failed: the summary rule applies", record(repository=url, clone_attempted=True), RepoScan(), "summary:"),
            ("cloned", record(repository=url), RepoScan(cloned=True), None),
            ("no url, no clone: the summary rule applies", record(), RepoScan(), "summary:"),
        ]
        for label, run, repo, expected in cases:
            with self.subTest(label):
                changes = [entity("use-web-app", flow=True), entity("web-app", resource=WEB), edge("use-web-app", "web-app")]

                found = self.problems(changes, run, repo, summary="A design.")

                if expected is None:
                    self.assertEqual(found, [])
                else:
                    self.assertTrue(any(expected in p for p in found), found)
        self.assertIn(url, self.problems([entity("x-y")], record(repository=url), RepoScan(), summary="A design.")[-1])

    def test_a_review_that_adds_nothing_needs_no_grounding(self):
        change = entity("web-app", resource=WEB, op="change")

        self.assertEqual(grounded_problems(diff(change), record(task_type="review", design=False, entities={"web-app": {"signalGroups": {"azureResource": {"azureResourceId": WEB}}}}), Path(".")), [])


class SignalRunTests(unittest.TestCase):
    """A new or changed signal rests on a query that ran in this Task and returned; `failing` is for signals the model has."""

    def log_run(self, status="ok", query=QUERY, columns=("failedRequests",)):
        return {grounding.squash(query): (status, frozenset(columns))}

    def test_a_new_log_signal_needs_its_exact_query_to_have_returned_a_row(self):
        spaced = "AppRequests\n  | where Success == false\n  | summarize failedRequests = count();"
        cases = [
            ("ran and returned", [log_signal()], self.log_run(), None),
            ("line breaks and a semicolon do not matter", [log_signal(query=spaced)], self.log_run(), None),
            ("not run", [log_signal()], {}, "that exact query was not run in this Task"),
            ("another query ran", [log_signal()], self.log_run(query="AppRequests | take 5"), "that exact query was not run in this Task"),
            ("failed", [log_signal()], self.log_run("error", columns=()), "that exact query failed when it ran: check the table's columns first"),
            ("no row", [log_signal()], self.log_run("empty", columns=()), "returned no row: it must return one row with a number"),
            ("the value column is not one of its columns", [log_signal(column="count_")], self.log_run(), "`valueColumnName` 'count_' is not a column of the row it returned (columns: failedRequests)"),
            ("no value column named", [log_signal(column=None)], self.log_run(), None),
        ]
        for label, signals, runs, expected in cases:
            with self.subTest(label):
                problems = signal_problems(diff(entity("web-app", workspace=WORKSPACE, signals=signals)), record(log_runs=runs))

                if expected is None:
                    self.assertEqual(problems, [])
                else:
                    self.assertTrue(problems and expected in problems[0], problems)
                    self.assertTrue(problems[0].startswith("changes[0] signal 'failed-requests' of 'web-app': "))

    def test_only_new_or_changed_signals_need_a_run(self):
        held = {"name": "failed-requests", "signalKind": "LogAnalyticsQuery", "queryText": QUERY, "valueColumnName": "failedRequests"}
        current = {"web-app": {"signalGroups": {"azureLogAnalytics": {"signals": [held]}}}}
        cases = [
            ("unchanged", log_signal(), None),
            ("unchanged but for the threshold", log_signal(evaluationRules={"unhealthyRule": {"operator": "GreaterThan", "threshold": 9}}), None),
            ("another query", log_signal(query="AppRequests | summarize failedRequests = count() by 1"), "was not run"),
            ("another value column", log_signal(column="other"), "was not run"),
            ("a new signal", log_signal(name="slow-requests", query="AppRequests | summarize x = avg(DurationMs)"), "was not run"),
        ]
        for label, signal, expected in cases:
            with self.subTest(label):
                change = entity("web-app", workspace=WORKSPACE, signals=[signal], op="change")

                problems = signal_problems(diff(change), record(entities=current))

                if expected is None:
                    self.assertEqual(problems, [])
                else:
                    self.assertTrue(problems and expected in problems[0], problems)

    def test_a_signal_definition_is_new_too_and_other_kinds_cannot_be_run(self):
        cases = [
            ("a definition that was not run", definition("failed-requests", signalKind="LogAnalyticsQuery", queryText=QUERY), "that exact query was not run"),
            ("a metric definition that was not run", definition("cpu", signalKind="AzureResourceMetric", metricName="CpuPercentage"), "no monitor_metrics_query"),
            ("a removed definition", definition("cpu", op="remove"), None),
            ("a PromQL signal", entity("web-app", resource=WEB, signals=[{"name": "up", "signalKind": "PrometheusMetricsQuery", "queryText": "up"}]), None),
            ("a signal that reuses a definition", entity("web-app", resource=WEB, signals=[{"name": "cpu", "signalKind": "AzureResourceMetric", "signalDefinitionName": "cpu"}]), None),
        ]
        for label, change, expected in cases:
            with self.subTest(label):
                problems = signal_problems(diff(change), record())

                if expected is None:
                    self.assertEqual(problems, [])
                else:
                    self.assertTrue(problems and expected in problems[0], problems)

    def test_a_new_metric_signal_needs_that_metric_to_have_returned_for_that_resource(self):
        run = MetricRun("ca-web", frozenset({"cpupercentage", "memorypercentage"}), "microsoft.app/containerapps", "average")
        cases = [
            ("the same metric, resource, namespace and aggregation", metric_signal(), [run], True),
            ("the metric was one of several", metric_signal(metric="MemoryPercentage"), [run], True),
            ("metric names in another case", metric_signal(metric="cpupercentage"), [run], True),
            ("another metric", metric_signal(metric="Requests"), [run], False),
            ("another resource", metric_signal(), [MetricRun("ca-other", run.names, run.namespace, run.aggregation)], False),
            ("the parent of the resource the entity is bound to", metric_signal(), [MetricRun("ca-web", run.names, run.namespace, run.aggregation)], True),
            ("another namespace", metric_signal(namespace="Microsoft.Web/sites"), [run], False),
            ("another aggregation", metric_signal(aggregation="Total"), [run], False),
            ("the call named no resource, namespace or aggregation", metric_signal(), [MetricRun("", run.names, "", "")], True),
            ("no metrics query", metric_signal(), [], False),
        ]
        for label, signal, runs, ran in cases:
            with self.subTest(label):
                problems = signal_problems(diff(entity("web-app", resource=WEB, signals=[signal])), record(metric_runs=runs))

                self.assertEqual(problems == [], ran)
                if not ran:
                    self.assertIn("no monitor_metrics_query of this Task returned that metric for that resource", problems[0])

    def test_a_metric_on_a_child_resource_stands_on_a_query_of_its_parent(self):
        blob = STORE + "/blobServices/default"
        run = record(listed={blob.lower(): "default"}, metric_runs=[MetricRun("stsessions", frozenset({"availability"}), "microsoft.storage/storageaccounts", "average")])
        signal = metric_signal(name="availability", metric="Availability", namespace="Microsoft.Storage/storageAccounts")

        self.assertEqual(signal_problems(diff(entity("session-storage", resource=blob, signals=[signal])), run), [])
        self.assertNotEqual(signal_problems(diff(entity("session-storage", resource=WEB, signals=[signal])), run), [])

    def test_a_failing_row_belongs_to_a_signal_the_model_already_has(self):
        held = {"name": "failed-requests", "signalKind": "LogAnalyticsQuery", "queryText": QUERY, "valueColumnName": "failedRequests"}
        current = {"web-app": {"signalGroups": {"azureLogAnalytics": {"signals": [held]}}}}
        run = record(entities=current, log_runs=self.log_run())
        new = entity("api-app", workspace=WORKSPACE, signals=[log_signal(name="slow", query="Q2", column="v")])
        run.log_runs[grounding.squash("Q2")] = ("ok", frozenset({"v"}))
        cases = [
            ("a failing row for a new signal", new, row("api-app", "slow", "failing"), "signal 'slow' of 'api-app' is new and its query failed"),
            ("by name in another case", new, row("API-app", "Slow", "failing"), "signal 'Slow' of 'API-app' is new"),
            ("by display name", entity("api-app", workspace=WORKSPACE, signals=[log_signal(name="slow", query="Q2", column="v", displayName="Slow requests")]), row("api-app", "Slow requests", "failing"), "is new and its query failed"),
            ("a verified row for a new signal", new, row("api-app", "slow", "verified"), None),
            ("a not_run row for a new signal", new, row("api-app", "slow", "not_run"), None),
            ("a failing row for an existing signal", entity("web-app", workspace=WORKSPACE, signals=[held], op="change"), row("web-app", "failed-requests", "failing"), None),
            ("a failing row for no change", new, row("elsewhere", "slow", "failing"), None),
        ]
        for label, change, verification, expected in cases:
            with self.subTest(label):
                problems = signal_problems(diff(change, verification=[verification]), run)

                if expected is None:
                    self.assertEqual(problems, [])
                else:
                    self.assertTrue(problems and expected in problems[0] and problems[0].startswith("verification[0]"), problems)

    def test_the_live_failure_is_refused_with_the_columns_to_check(self):
        broken = "AppRequests | where tostring(cloud_RoleName) == 'ca-web' | summarize failedRequests = count()"
        run = record(log_runs={grounding.squash(broken): ("error", frozenset())})

        problems = signal_problems(diff(entity("web-app", workspace=WORKSPACE, signals=[log_signal(query=broken)])), run)

        self.assertIn("getschema", problems[0])


class RecordTests(unittest.TestCase):
    LISTING = json.dumps(
        {
            "status": 200,
            "message": "Success",
            "results": {"resources": [{"name": "ca-web", "id": WEB, "type": "Microsoft.App/containerApps", "location": "x"}, {"name": "law-demo", "id": WORKSPACE, "type": "t", "location": "x"}]},
        }
    )

    def test_a_listing_records_the_resources_and_the_words_of_their_names(self):
        run = RunRecord()

        run.call_returned("group_resource_list", {}, self.LISTING)

        self.assertEqual(run.listed, {WEB.lower(): "ca-web", WORKSPACE.lower(): "law-demo"})
        self.assertLessEqual({"ca", "web", "law", "demo"}, run.vocabulary)
        run.call_returned("group_resource_list", {}, "not json")
        self.assertEqual(len(run.listed), 2)

    def test_a_log_query_is_a_failure_no_row_or_a_row_with_columns(self):
        rows = json.dumps({"status": 200, "results": {"results": [{"failedRequests": "7"}]}})
        none = json.dumps({"status": 200, "results": {"results": []}})
        cases = [
            ("a row", rows, ("ok", frozenset({"failedRequests"}))),
            ("no row", none, ("empty", frozenset())),
            ("not the shape", "plain text", ("empty", frozenset())),
        ]
        for label, text, expected in cases:
            with self.subTest(label):
                run = RunRecord()

                run.call_returned("monitor_workspace_log_query", {"query": f"  {QUERY}\n"}, text)

                self.assertEqual(run.log_runs, {QUERY: expected})
                self.assertEqual(run.queries, [True])
        run = RunRecord()
        run.call_failed("monitor_workspace_log_query", {"query": QUERY})
        self.assertEqual((run.log_runs, run.queries), ({QUERY: ("error", frozenset())}, [False]))

    def test_a_run_that_returned_stays_on_record_when_the_same_query_fails_later(self):
        rows = json.dumps({"results": {"results": [{"v": 1}]}})
        run = RunRecord()
        run.call_returned("monitor_workspace_log_query", {"query": "Q"}, rows)

        run.call_failed("monitor_workspace_log_query", {"query": "Q"})

        self.assertEqual(run.log_runs["Q"][0], "ok")
        run.call_failed("monitor_workspace_log_query", {"query": "R"})
        run.call_returned("monitor_workspace_log_query", {"query": "R"}, rows)
        self.assertEqual(run.log_runs["R"][0], "ok")

    def test_a_metrics_query_records_what_it_asked_for(self):
        run = RunRecord()

        run.call_returned("monitor_metrics_query", {"resource": "CA-Web", "metricnames": "CpuPercentage, MemoryPercentage", "metricnamespace": "Microsoft.App/containerApps", "aggregation": "Average"}, "{}")

        self.assertEqual(run.metric_runs, [MetricRun("ca-web", frozenset({"cpupercentage", "memorypercentage"}), "microsoft.app/containerapps", "average")])
        run.call_failed("monitor_metrics_query", {"resource": "x"})
        self.assertEqual((len(run.metric_runs), run.queries), (1, [True, False]))

    def test_a_clone_is_noticed_when_it_is_tried_whether_it_works_or_not(self):
        cases = [
            ("a clone", "git clone --depth 1 https://github.com/example/albums", True),
            ("a clone after a cd", "cd x && git  clone y", True),
            ("another git command", "git log", False),
            ("a file named clone", "cat git-clone.md", False),
        ]
        for label, command, tried in cases:
            with self.subTest(label):
                for outcome in ("returned", "failed"):
                    run = RunRecord()

                    getattr(run, f"call_{outcome}")(*(("run_shell", {"command": command}) + (("exit code 0",) if outcome == "returned" else ())))

                    self.assertEqual(run.clone_attempted, tried)

    def test_the_entities_the_model_has_do_not_vouch_for_example_words(self):
        run = RunRecord()

        run.call_returned("monitor_healthmodels_inspect", {}, json.dumps({"results": {"entities": [{"entity": {"name": "checkout-flow", "properties": {"displayName": "Checkout"}}}]}}))

        self.assertEqual(list(run.entities), ["checkout-flow"])
        self.assertEqual(run.vocabulary, set())

    def test_the_arguments_of_a_call_are_named_without_separators(self):
        class Model:
            def model_dump(self):
                return {"Metric_Names": "a"}

        cases = [
            ("a mapping", {"metric-names": "a", "resource-group": "rg"}, {"metricnames": "a", "resourcegroup": "rg"}),
            ("a model", Model(), {"metricnames": "a"}),
            ("nothing", None, {}),
        ]
        for label, arguments, expected in cases:
            with self.subTest(label):
                self.assertEqual(arguments_of(arguments), expected)


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)

    def clone(self, name="albums", files=None):
        root = self.folder / name
        (root / ".git").mkdir(parents=True)
        for relative, text in (files or {"src/server.js": "const albums = require('./albums');", "README.md": "Album API"}).items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        return root

    def test_no_clone_is_no_repository(self):
        (self.folder / "notes.txt").write_text("checkout", encoding="utf-8")

        self.assertEqual(scan_repository(self.folder), RepoScan())
        self.assertEqual(scan_signature(self.folder), ())

    def test_a_clone_gives_its_words_and_paths(self):
        self.clone()

        scan = scan_repository(self.folder)

        self.assertTrue(scan.cloned)
        self.assertLessEqual({"album", "server", "require"}, scan.words)
        self.assertLessEqual({"src/server.js", "server.js", "readme.md"}, scan.paths)

    def test_what_a_clone_does_not_say_stays_out_and_so_do_dependencies_binaries_and_links(self):
        root = self.clone(files={"src/a.js": "plain", "node_modules/x/index.js": "storefront", "bin/tool.js": "storefront", "logo.png": "storefront"})
        (root / "link.md").symlink_to(self.folder / "outside.md")
        (self.folder / "outside.md").write_text("storefront", encoding="utf-8")
        (root / "big.md").write_text("x" * 300_000 + " storefront", encoding="utf-8")

        scan = scan_repository(self.folder)

        self.assertNotIn("storefront", scan.words)

    def test_clones_are_found_in_the_folder_and_up_to_two_levels_below(self):
        (self.folder / ".git").mkdir()
        self.clone("one")
        deep = self.folder / "a" / "b"
        (deep / ".git").mkdir(parents=True)
        (self.folder / "x" / "y" / "z" / ".git").mkdir(parents=True)

        roots = repository_roots(self.folder)

        self.assertEqual({path.relative_to(self.folder).as_posix() for path in roots}, {".", "one", "a/b"})

    def test_the_signature_changes_when_a_clone_appears_and_the_record_scans_again(self):
        run = RunRecord()
        self.assertFalse(run.repository_scan(self.folder).cloned)
        before = scan_signature(self.folder)

        self.clone()

        self.assertNotEqual(scan_signature(self.folder), before)
        self.assertTrue(run.repository_scan(self.folder).cloned)
        scan = run.scan
        self.assertIs(run.repository_scan(self.folder), scan[1])


class GroundedDesignTests(unittest.TestCase):
    """The design the live check produced: shop flows nobody has, capitals, a log query that failed."""

    def live_design(self):
        names = ["Browse-products", "Complete-a-purchase", "Browse-products-api", "Product-catalog", "Complete-a-purchase-api", "Order-processing"]
        flows = [entity(name, flow=name in ("Browse-products", "Complete-a-purchase"), reason="Customers browse and buy.") for name in names]
        resources = [
            entity("Container-app-web", resource=WEB, signals=[log_signal(query="AppRequests | where tostring(cloud_RoleName) == 'x' | summarize v = count()", column="v")], workspace=None),
            entity("Storage-account", resource=STORE),
        ]
        links = [edge(ROOT, "Browse-products"), edge("Browse-products", "Browse-products-api"), edge("Browse-products-api", "Container-app-web")]
        return diff(*flows, *resources, *links, summary="Assumed the container app is the main path.")

    def test_every_rule_refuses_it_and_says_what_to_do(self):
        run = record(log_runs={grounding.squash("AppRequests | where tostring(cloud_RoleName) == 'x' | summarize v = count()"): ("error", frozenset())})

        problems = grounded_problems(self.live_design(), run, Path("/nonexistent"))

        text = "\n".join(problems)
        for expected in (
            "names must be lower-case kebab-case",
            "'Browse-products'",
            "examples of the skill templates",
            "needs at least one resource entity below it",
            "'Complete-a-purchase'",
            "the `reason` names no evidence",
            "Flows are inferred from infrastructure only.",
            "getschema",
        ):
            with self.subTest(expected):
                self.assertIn(expected, text)

    def test_a_design_that_rests_on_the_resources_passes(self):
        changes = [
            entity("use-web-app", display="Use the web app", flow=True, reason="Users reach the service through the container app ca-web."),
            entity("web-app", display="Web app", resource=WEB, signals=[metric_signal()]),
            entity("run-agent-work", flow=True, reason="Agent work runs on ca-web and keeps its sessions in stsessions."),
            entity("session-storage", resource=STORE),
            edge(ROOT, "use-web-app"),
            edge("use-web-app", "web-app"),
            edge(ROOT, "run-agent-work"),
            edge("run-agent-work", "web-app", name="run-agent-work-web-app"),
            edge("run-agent-work", "session-storage"),
        ]
        run = record(metric_runs=[MetricRun("ca-web", frozenset({"cpupercentage"}), "microsoft.app/containerapps", "average")])

        self.assertEqual(grounded_problems(diff(*changes), run, Path("/nonexistent")), [])

    def test_an_explain_result_has_nothing_to_ground(self):
        explained = {"kind": "explain", "entity": "x", "state": "Healthy", "summary": "Fine.", "causes": []}

        self.assertEqual(grounded_problems(explained, record(), Path("/nonexistent")), [])


if __name__ == "__main__":
    unittest.main()

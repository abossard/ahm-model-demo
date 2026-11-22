import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone

from contracts.show_me import action_problem
from fixture_models import fixture_model, metric_definition, scope_of
from foundry_agent import StreamEvent
from model_diff import strip_system


def message(n, text):
    item = {"id": f"msg_{n}", "type": "message", "content": [{"type": "output_text", "text": text}]}
    return [
        ("response.output_item.added", {"item": {**item, "content": []}}),
        ("response.output_text.delta", {"item_id": item["id"], "delta": text}),
        ("response.output_item.done", {"item": item}),
    ]


def call(n, name, arguments, output):
    call_id = f"call_{n}"
    function = {"id": f"fc_{n}", "type": "function_call", "call_id": call_id, "name": name}
    result = {"id": f"fco_{n}", "type": "function_call_output", "call_id": call_id, "output": output}
    return [
        ("response.output_item.added", {"item": {**function, "arguments": ""}}),
        ("response.output_item.done", {"item": {**function, "arguments": json.dumps(arguments)}}),
        ("response.output_item.added", {"item": result}),
        ("response.output_item.done", {"item": result}),
    ]


def watching(properties, signal, definition, scope):
    group = {
        "authenticationSetting": "system-assigned",
        "azureResourceId": scope,
        "signals": [{"name": signal, "signalDefinitionName": definition, "signalKind": "AzureResourceMetric"}],
    }
    return {**properties, "signalGroups": {**properties["signalGroups"], "azureResource": group}}


HISTORY_WINDOW = timedelta(hours=24)


def instant(text):
    return datetime.fromisoformat(text).astimezone(timezone.utc)


def iso(value):
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def moment_window(task):
    """What an Explain about a moment reads, as the hosted agent does: the day of history that ends at the moment."""
    end = instant(task["asOf"])
    return {"from": iso(end - HISTORY_WINDOW), "to": iso(end)}


def explain_at(task, state_at):
    """The answer for a Task with `asOf`: the state the entity had then, which `state_at` knows for the fixture models."""
    entity = task["target"].get("entity") or task["target"]["name"]
    state = (state_at(entity, instant(task["asOf"])) if state_at else None) or "Degraded"
    quiet = state == "Healthy"
    why = "every signal it depends on was inside its thresholds" if quiet else "a signal it depends on was outside its thresholds"
    return {
        "kind": "explain",
        "entity": entity,
        "state": state,
        "summary": f"{entity} was {state.lower()} at that moment because {why}.",
        "window": moment_window(task),
        "causes": []
        if quiet
        else [{"entity": entity, "signal": None, "state": state, "threshold": None, "value": None, "rollup": "WorstOf", "note": "Took the worst state of its dependencies at that moment."}],
    }


def explain_result(task, state_at=None):
    if task.get("asOf"):
        return explain_at(task, state_at)
    entity = task["target"].get("entity") or task["target"]["name"]
    return {
        "kind": "explain",
        "entity": entity,
        "state": "Degraded",
        "summary": f"{entity} is degraded because orders-api reports order errors above its threshold.",
        "causes": [
            {"entity": entity, "signal": None, "state": "Degraded", "threshold": None, "value": None, "rollup": "WorstOf", "note": "Takes the worst state of its dependencies."},
            {"entity": "orders-api", "signal": "order-errors", "state": "Degraded", "threshold": "> 1 Degraded", "value": 3, "rollup": "impact Standard", "note": "Three failed orders in the last hour."},
        ],
    }


def target_scope(task):
    return scope_of(task["target"]["subscriptionId"], task["target"]["resourceGroup"])


def review_result(task, relationships):
    if not any("orders-api" in (link["parent"], link["child"]) for link in relationships):
        return design_result(task)
    model = fixture_model(task["target"]["subscriptionId"], task["target"]["resourceGroup"], "model")
    api = strip_system(copy.deepcopy(next(e for e in model["entities"] if e["name"] == "orders-api")["properties"]))
    api["displayName"] = "Orders API (reviewed)"
    queue = watching(
        {"displayName": "Order queue", "impact": "Limited", "canvasPosition": {"x": 700, "y": 400},
         "signalGroups": {"dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": True}}},
        "queue-depth", "sd-queue-depth", target_scope(task),
    )
    return {
        "kind": "diff",
        "summary": "Name the API clearly, and watch the order queue that sits behind it.",
        "changes": [
            {"id": "c1", "op": "change", "kind": "entity", "name": "orders-api", "after": api, "reason": "A clearer display name for operators."},
            {"id": "c2", "op": "add", "kind": "signalDefinition", "name": "sd-queue-depth", "after": metric_definition("Queue depth", "ApproximateMessageCount", 100, 500), "reason": "Queue depth shows backlog before orders fail."},
            {"id": "c3", "op": "add", "kind": "entity", "name": "order-queue", "after": queue, "reason": "Orders wait in a queue that has no health today."},
            {"id": "c4", "op": "add", "kind": "relationship", "name": "orders-api-order-queue", "after": {"parentEntityName": "orders-api", "childEntityName": "order-queue"}, "reason": "The API depends on the queue."},
        ],
        "verification": [{"entity": "order-queue", "signal": "queue-depth", "status": "verified", "query": "Microsoft.Storage queueServices ApproximateMessageCount (Average)", "value": 4, "error": None}],
        "findings": [{"severity": "medium", "entity": "orders-api", "text": "Order errors are degraded and nothing shows the backlog.", "changeIds": ["c2", "c3", "c4"]}],
    }


def design_result(task):
    root = task["target"]["name"]
    leaf = {"impact": "Standard", "signalGroups": {"dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": True}}}
    return {
        "kind": "diff",
        "summary": "Model the catalog flow: an API on top of its database.",
        "changes": [
            {"id": "c1", "op": "add", "kind": "signalDefinition", "name": "sd-db-latency", "after": metric_definition("Database latency", "Latency", 50, 200), "reason": "Slow queries are the first sign of trouble."},
            {"id": "c2", "op": "add", "kind": "entity", "name": "catalog-api", "after": {**leaf, "displayName": "Catalog API"}, "reason": "Users browse the catalog."},
            {"id": "c3", "op": "add", "kind": "entity", "name": "catalog-db", "after": watching({**leaf, "displayName": "Catalog database"}, "latency", "sd-db-latency", target_scope(task)), "reason": "The catalog API reads from it."},
            {"id": "c4", "op": "add", "kind": "relationship", "name": f"{root}-catalog-api", "after": {"parentEntityName": root, "childEntityName": "catalog-api"}, "reason": "The catalog flow is part of the workload."},
            {"id": "c5", "op": "add", "kind": "relationship", "name": "catalog-api-catalog-db", "after": {"parentEntityName": "catalog-api", "childEntityName": "catalog-db"}, "reason": "The API depends on its database."},
        ],
        "verification": [{"entity": "catalog-db", "signal": "latency", "status": "failing", "query": "Microsoft.Sql latency (Average)", "value": None, "error": "No data returned for the last day."}],
        "findings": [{"severity": "low", "entity": None, "text": "No repository was read; the flow is assumed.", "changeIds": []}],
    }


def inspect_arguments(task):
    """What the read of the model asks for. A Task about a moment reads the entity as it was then and the history that ends
    there: the arguments the hosted agent sends (`InspectWindow`, src/agent/src/history.py)."""
    model = task["target"]["name"]
    if not task.get("asOf"):
        return {"health-model": model, "include": "Signals"}
    window = moment_window(task)
    return {
        "health-model": model,
        "entity": task["target"].get("entity") or model,
        "include": "Signals,History",
        "timestamp": window["to"],
        "start-at": window["from"],
        "end-at": window["to"],
    }

def builder_result(builder):
    if builder["phase"] == "analyze":
        rows = [
            {"resourceId": r["id"], "displayName": r["name"],
             "purpose": f"Provides {r['type'].split('/')[-1]} for the selected workload.", "impact": "Standard"}
            for r in builder["resources"]
        ]
        plan = {"objective": "Customers can submit and retrieve orders.",
                "flows": [{"name": "Complete an order", "objective": "The order request succeeds and is saved.",
                           "components": [{"name": "Order processing", "resourceIds": [r["resourceId"] for r in rows],
                                           "signal": "Monitor availability and request failures."}],
                           "failureScenario": "A required dependency failure makes order processing and the order flow unhealthy."}],
                "gaps": ["Order completion has no confirmed end-to-end signal."],
                "decisions": [{"choice": "Group the selected resources under order processing",
                               "reason": "The workload inventory identifies the services that support order processing. An end-to-end order event would establish whether an individual request finished.",
                               "basis": "assumption", "resourceIds": [r["resourceId"] for r in rows]}]}
        metrics = [{**{key: observation[key] for key in ("resourceId", "metricName", "metricNamespace", "aggregation", "sample")},
                    "operator": "GreaterThan", "threshold": 80} for observation in builder.get("observedMetrics", [])]
        if metrics:
            plan["decisions"].append({
                "choice": "Use the measured platform signal",
                "reason": "Azure Monitor returned readings for these resources. They show platform load. Order completion still needs application telemetry.",
                "basis": "measurement", "resourceIds": [m["resourceId"] for m in metrics]})
        summary = "Review what each selected resource contributes to the workload."
        if revision := builder.get("revision"):
            rows = builder["rows"]
            plan = {**builder["previousPlan"], "objective": "Orders reach fulfillment successfully.",
                    "decisions": [*builder["previousPlan"].get("decisions", [])[:11],
                                  {"choice": "Prioritize order fulfillment", "reason": revision["prompt"][:800],
                                   "basis": "userInput", "resourceIds": [r["resourceId"] for r in rows]}]}
            metrics = builder["previousMetrics"]
            summary = "The revised plan follows the order through fulfillment."
        return {"kind": "builderAnalysis", "summary": summary, "plan": plan, "metrics": metrics, "rows": rows,
                "omittedMetrics": builder.get("previousOmittedMetrics", [])}
    ids = [r["resourceId"] for r in builder["rows"]]
    groups = [{"name": "Workload operation", "purpose": "Monitor the confirmed components of the workload.", "resourceIds": ids}]
    if builder.get("plan"):
        return {"kind": "builderProposals", "proposals": [
            {"id": "planned-workload", "title": "Workload operation", "summary": builder["plan"]["objective"],
             "tradeoff": "Connects operating symptoms with customer impact.", "structure": "planned", "groups": groups},
            {"id": "resource-health", "title": "Resource availability", "summary": "See each resource directly.",
             "tradeoff": "Fewer levels to inspect, with less operational context.", "structure": "direct", "groups": groups},
        ]}
    return {
        "kind": "builderProposals", "metrics": [],
        "proposals": [
            {"id": "resource-health", "title": "Resource availability", "summary": "See the state of each selected resource directly.",
             "tradeoff": "This view is fast to scan. It leaves the purpose of each dependency to the operator.",
             "structure": "direct", "groups": groups},
            {"id": "workload-flow", "title": "Workload operation", "summary": "Track the workload and then inspect the resources behind it.",
             "tradeoff": "The extra level explains the workload impact and takes one more step to reach a resource.",
             "structure": "grouped", "groups": groups},
        ],
    }


def pointing_calls(task, result, relationships=()):
    handles = task.get("showMeHandles", [])
    actions, calls, choices = {}, [], []
    if not handles:
        return calls, actions

    def point(field, key, handle, id_, color, label, *, legacy=None, next_label=None):
        # A previously installed client can still request its original destinations.
        if legacy and not any(h["name"] == handle for h in handles):
            handle, id_ = legacy
        action = {"handle": handle, "highlight": {"color": color, "label": label}}
        if id_ is not None:
            action["id"] = id_
        if action_problem(action, handles):
            return
        number = str(len(actions) + 1)
        actions[number] = action
        marker = f"[[show:{number}]]"
        field[key] += " " + marker
        calls.extend(call(f"show_{number}", "show_me", action, marker))
        if next_label and len(choices) < 3 and all(c["label"] != next_label for c in choices):
            choices.append({"id": number, "label": next_label})

    if result["kind"] == "builderAnalysis":
        inventory = task["builder"]["resources"]
        refs = {r["id"].casefold(): r["ref"] for r in inventory}
        if inventory:
            point(result, "summary", "builder", "resource/" + inventory[0]["ref"], "blue", "Reviewed resource",
                  next_label="Inspect the resource")
        for decision in result["plan"].get("decisions", []):
            if decision["basis"] == "measurement" and decision["resourceIds"]:
                ref = refs[decision["resourceIds"][0].casefold()]
                point(decision, "reason", "builder", "signal/" + ref, "amber", "Observed signal", next_label="See the measured signal")
                break
    elif result["kind"] == "builderProposals":
        for proposal in result["proposals"]:
            point(proposal, "tradeoff", "builder", "design/" + proposal["id"], "violet", "Design preview",
                  next_label="Explore " + proposal["title"])
    elif result["kind"] == "explain":
        cause = next(iter(result["causes"]), None)
        point(cause or result, "note" if cause else "summary", "panel", "entity/" + result["entity"],
              "violet", "Explained entity", legacy=("node-detail", result["entity"]), next_label="Explore the entity")
        for row in result["causes"]:
            if row["signal"]:
                point(row, "note", "timeline", f"signal/{row['entity']}/{row['signal']}", "amber", "Order errors over time",
                      legacy=("health-timeline", None), next_label="Follow the signal")
        if task.get("asOf"):
            point(result, "summary", "timeline", "entity/" + result["entity"], "blue", "Historical state",
                  legacy=("health-timeline", None))
    else:
        point(result, "summary", "graph", "view/coverage", "blue", "Signal coverage", legacy=("model-view", "coverage"),
              next_label="See signal coverage")
        for finding in result["findings"]:
            if finding.get("entity"):
                point(finding, "text", "panel", "entity/" + finding["entity"], "amber", "Entity in this finding",
                      legacy=("node-detail", finding["entity"]), next_label="Inspect the entity")
        edge = next((r for r in relationships if r["parent"] == "orders-api" and r["child"] == "orders-db"), None)
        if task["type"] == "review" and edge:
            changes = {change["id"]: change for change in result["changes"]}
            point(changes["c1"], "reason", "graph", "node/orders-api", "blue", "Orders API on the graph")
            point(changes["c2"], "reason", "panel", "change/c3", "amber", "Proposed queue entity")
            if any(h["name"] == "graph" for h in handles):
                changes["c4"]["reason"] += " Its existing database dependency follows the same direction."
            point(changes["c4"], "reason", "graph", "connection/" + edge["name"], "violet", "Existing database dependency",
                  next_label="Trace the database connection")
        elif result["changes"]:
            point(result["changes"][0], "reason", "panel", "comparison", "violet", "Compare proposed design",
                  next_label="Compare the proposed design")
    if len(choices) >= 2:
        result["nextSteps"] = choices
    return calls, actions


def script(envelope, state_at=None):
    task = envelope["task"]
    if task.get("builder"):
        result = builder_result(task["builder"])
        buttons, actions = pointing_calls(task, result)
        return [
            ("response.created", {"response": {"id": "resp_fake"}}),
            *call(1, "load_skill", {"skill_name": "healthmodel-plan"}, "# Health model plan\n## Workload flows"),
            *call(2, "load_skill", {"skill_name": "healthmodel-build"}, "# Health model build\n## Signal verification"),
            *buttons,
            *call(3, "submit_result", {"result": result}, json.dumps({"status": "accepted", **({"showMe": actions} if actions else {})})),
            ("response.completed", {"response": {"id": "resp_fake"}}),
        ]
    model = task["target"]["name"]
    results = {
        "explain": lambda: explain_result(task, state_at),
        "review": lambda: review_result(task, envelope.get("relationships") or []),
        "design": lambda: design_result(task),
    }
    result = results[task["type"]]()
    buttons, actions = pointing_calls(task, result, envelope.get("relationships", []))
    return [
        ("response.created", {"response": {"id": "resp_fake"}}),
        *message(1, f"I will start with the model {model}."),
        *call(1, "load_skill", {"name": "healthmodel-analyze"}, "Skill loaded."),
        *call(2, "monitor_healthmodels_inspect", inspect_arguments(task), json.dumps({"entities": 5})),
        *message(2, "I have what I need and will submit the result."),
        *buttons,
        *call(3, "submit_result", {"result": result}, json.dumps({"status": "accepted", **({"showMe": actions} if actions else {})})),
        *message(3, "Done."),
        ("response.completed", {"response": {"id": "resp_fake"}}),
    ]


class FakeAgent:
    def __init__(self, delay=0.05, state_at=None):
        """`state_at(entity, moment)` is the state an entity had at a moment: what an Explain about a past moment answers."""
        self._delay = delay
        self._state_at = state_at
        self._conversations = 0

    async def create_conversation(self):
        self._conversations += 1
        return f"conv_fake_{self._conversations}"

    async def stream_response(self, conversation_id, text):
        for name, data in script(json.loads(text.split("\n", 1)[1]), self._state_at):
            await asyncio.sleep(self._delay)
            yield StreamEvent(name, data)

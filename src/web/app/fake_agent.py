import asyncio
import copy
import json

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


def explain_result(task):
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


def script(envelope):
    task = envelope["task"]
    model = task["target"]["name"]
    results = {
        "explain": lambda: explain_result(task),
        "review": lambda: review_result(task, envelope.get("relationships") or []),
        "design": lambda: design_result(task),
    }
    result = results[task["type"]]()
    return [
        ("response.created", {"response": {"id": "resp_fake"}}),
        *message(1, f"I will start with the model {model}."),
        *call(1, "load_skill", {"name": "healthmodel-analyze"}, "Skill loaded."),
        *call(2, "monitor_healthmodels_inspect", {"health-model": model, "include": "Signals"}, json.dumps({"entities": 5})),
        *message(2, "I have what I need and will submit the result."),
        *call(3, "submit_result", {"result": result}, json.dumps({"status": "accepted"})),
        *message(3, "Done."),
        ("response.completed", {"response": {"id": "resp_fake"}}),
    ]


class FakeAgent:
    def __init__(self, delay=0.05):
        self._delay = delay
        self._conversations = 0

    async def create_conversation(self):
        self._conversations += 1
        return f"conv_fake_{self._conversations}"

    async def stream_response(self, conversation_id, text):
        for name, data in script(json.loads(text.split("\n", 1)[1])):
            await asyncio.sleep(self._delay)
            yield StreamEvent(name, data)

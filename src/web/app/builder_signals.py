"""Measure a signal from the selected resource's Azure Monitor metric catalog."""

from datetime import datetime, timedelta, timezone
from itertools import batched, groupby
from math import isfinite
from urllib.parse import quote

from azure.core.exceptions import AzureError
from azure.core.rest import HttpRequest


# Prefer direct signs of failure, then latency or saturation. Every eligible
# definition Azure publishes is still a candidate, including service-specific metrics.
PREFERENCE = [name.casefold() for name in (
    "Availability", "HealthCheckStatus", "Http5xx", "ServerErrors", "FailedRequests", "ThrottledRequests",
    "CpuPercentage", "Percentage CPU", "cpu_percent", "IngressCpuPercentage", "ResponseTime",
    "SuccessE2ELatency", "DiscoveryRuleExecutionDuration", "Requests", "Transactions",
)]
AGGREGATIONS = {"Average", "Maximum", "Minimum", "Total", "Count"}


def _rank(definition):
    name = definition["name"]["value"].casefold()
    return PREFERENCE.index(name) if name in PREFERENCE else len(PREFERENCE)


def _observation(arm, namespace, aggregation, metric, definition):
    for stream in metric.get("timeseries") or []:
        if stream.get("metadatavalues"):
            continue
        readings = []
        for point in stream.get("data") or []:
            value = point.get(aggregation.lower())
            if point.get("timeStamp") and type(value) in (int, float) and isfinite(value):
                readings.append((point["timeStamp"], value))
        if readings:
            at, sample = max(readings)
            values = [value for _, value in readings]
            return {"resourceId": arm, "metricName": definition["name"]["value"], "metricNamespace": namespace,
                    "aggregation": aggregation, "sample": sample, "unit": metric.get("unit") or definition.get("unit"),
                    "observedAt": at, "minimum": min(values), "maximum": max(values), "count": len(values)}


def _query_metrics(read, params, names):
    """A provider can reject a whole batch because one metric disallows the requested grain."""
    try:
        body = read("metrics", {**params, "metricnames": ",".join(names), "api-version": "2023-10-01"})
    except AzureError as error:
        if getattr(error, "status_code", None) != 400:
            raise
        if len(names) == 1:
            return {names[0].casefold(): {"errorCode": "BadRequest"}}
        results = {}
        for name in names:
            results.update(_query_metrics(read, params, [name]))
        return results
    if body.get("interval") != params["interval"]:
        return {name.casefold(): {"errorCode": "UnexpectedInterval"} for name in names}
    return {metric["name"]["value"].casefold(): metric for metric in body.get("value") or []}


def observe(client, resource):
    arm = resource["id"]
    path = quote(arm, safe="/") + "/providers/Microsoft.Insights/"

    def read(collection, params):
        response = client.send_request(HttpRequest("GET", path + collection, params=params))
        response.raise_for_status()
        return response.json()

    def result(status, detail):
        return {"resourceId": arm, "status": status, "detail": detail}

    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    period = f"{now - timedelta(hours=24):%Y-%m-%dT%H:%M:%SZ}/{now:%Y-%m-%dT%H:%M:%SZ}"
    try:
        definitions = read("metricDefinitions", {"api-version": "2018-01-01"}).get("value") or []
        if not definitions:
            return result("no_data", "Azure Monitor returned no platform metric definitions for this resource.")
        candidates = sorted((d for d in definitions if not d.get("isDimensionRequired")
                             and d.get("primaryAggregationType") in AGGREGATIONS), key=_rank)
        catalog = f"Azure lists {len(definitions)} platform metric{'s' if len(definitions) != 1 else ''}."
        if not candidates:
            return result("unsupported", f"{catalog} None supports this model’s dimension-free numeric check.")
        attempted, rejected = [], []

        def query_key(d):
            return d.get("namespace") or resource["type"], d["primaryAggregationType"]

        for (namespace, aggregation), group in groupby(candidates, key=query_key):
            for batch in batched(group, 20):  # Azure Monitor accepts up to 20 names per metrics request.
                names = [d["name"]["value"] for d in batch]
                metrics = _query_metrics(read, {"timespan": period, "interval": "PT5M",
                                                "metricnamespace": namespace, "aggregation": aggregation}, names)
                attempted.extend(names)
                for definition, name in zip(batch, names):
                    metric = metrics.get(name.casefold())
                    if metric is None or metric.get("errorCode", "Success") != "Success":
                        rejected.append(name)
                        continue
                    observation = _observation(arm, namespace, aggregation, metric, definition)
                    if observation:
                        unit = observation["unit"] or ""
                        value = f"{observation['sample']} {unit}".strip()
                        detail = f"{catalog} {name} returned {observation['count']} five-minute readings. Latest value {value}."
                        return {**result("verified", detail), "observation": observation}
        if rejected:
            examples = ", ".join(rejected[:3])
            return result("unavailable", f"{catalog} No usable reading. Azure did not return the requested "
                          f"five-minute series for {len(rejected)} of {len(attempted)} checked metrics ({examples}).")
        examples = ", ".join(attempted[:3])
        return result("no_data", f"{catalog} Checked {len(attempted)} for five-minute readings, including {examples}. "
                      "None returned a dimension-free numeric reading in the past 24 hours.")
    except AzureError as error:
        status = getattr(error, "status_code", None)
        if status == 403:
            return result("unavailable", "Azure Monitor denied access to read metrics on this resource (HTTP 403).")
        return result("unavailable", f"Azure Monitor could not complete the check (HTTP {status})."
                      if status else "Azure Monitor was unavailable.")

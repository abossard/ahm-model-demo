"""The builder works from the user's resource selection and measurements of those resources."""

import json
from math import isfinite

METRIC_TOOLS = frozenset({"monitor_metrics_definitions", "monitor_metrics_query"})
BUILDER_SKILLS = ("healthmodel-plan", "healthmodel-build")


def selected_resource(builder, arguments):
    """Resolve an Azure MCP metric read to a single inventory resource in the selected scope."""
    resource = str(arguments.get("resource", "")).strip().casefold()
    group = str(arguments.get("resourcegroup", "")).casefold()
    subscription = str(arguments.get("subscription", "")).casefold()
    resource_type = str(arguments.get("resourcetype", "")).casefold()
    selected = {row["resourceId"].casefold() for row in builder.get("rows", [])}
    for item in builder["resources"]:
        arm = item["id"].casefold()
        parts = arm.split("/")
        if len(parts) < 9 or (selected and arm not in selected):
            continue
        if (subscription, group) != (parts[2], parts[4]):
            continue
        if resource_type and resource_type != item["type"].casefold():
            continue
        if resource == arm or (resource == item["name"].casefold() and resource_type == item["type"].casefold()):
            return arm
    return None


BUCKETS = {"average": "avgBuckets", "maximum": "maxBuckets", "minimum": "minBuckets", "total": "totalBuckets", "count": "countBuckets"}


def sample_values(data, metric, aggregation):
    """Read the Azure MCP Monitor tool's compact, dimension-free, five-minute metric buckets."""
    bucket = BUCKETS.get(aggregation)
    results = data.get("results", {}) if isinstance(data, dict) else {}
    rows = results.get("results", []) if isinstance(results, dict) else []
    for row in rows:
        if not isinstance(row, dict) or str(row.get("name", "")).casefold() != metric:
            continue
        for series in row.get("timeSeries", []):
            if not isinstance(series, dict) or series.get("interval") != "PT5M" or series.get("metadata"):
                continue
            for value in series.get(bucket) or []:
                if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value):
                    yield value


def note_samples(samples, builder, arguments, text):
    resource = selected_resource(builder, arguments)
    metric = str(arguments.get("metricnames", "")).strip().casefold()
    aggregation = str(arguments.get("aggregation", "")).casefold()
    namespace = str(arguments.get("metricnamespace", "")).casefold()
    if not resource or not metric or "," in metric or arguments.get("filter") or str(arguments.get("interval", "")).upper() != "PT5M":
        return
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return
    if isinstance(data, dict) and data.get("status", 200) != 200:
        return
    values = set(sample_values(data, metric, aggregation))
    samples.setdefault((resource, metric, namespace, aggregation), set()).update(values)


def measurement_problems(result, samples, observed=()):
    problems = []
    for metric in result.get("metrics", []):
        key = tuple(metric[k].casefold() for k in ("resourceId", "metricName", "metricNamespace", "aggregation"))
        trusted = {r["sample"] for r in observed
                   if tuple(r[k].casefold() for k in ("resourceId", "metricName", "metricNamespace", "aggregation")) == key}
        if metric["sample"] not in trusted and metric["sample"] not in samples.get(key, ()):
            problems.append(f"{metric['metricName']}: use an observed numeric sample from one successful PT5M query for this exact resource, metric, namespace and aggregation, or omit this metric.")
    return problems

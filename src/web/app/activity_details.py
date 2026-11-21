"""The parts of a provider response that are safe and useful in a saved Activity."""

import math
import re


def response_metadata(response):
    metadata = {"responseId": response["id"]} if response.get("id") else {}
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return metadata
    input_details = usage.get("input_tokens_details") or {}
    output_details = usage.get("output_tokens_details") or {}
    counts = {
        "inputTokens": usage.get("input_tokens"),
        "outputTokens": usage.get("output_tokens"),
        "totalTokens": usage.get("total_tokens"),
        "cachedInputTokens": input_details.get("cached_tokens") if isinstance(input_details, dict) else None,
        "reasoningTokens": output_details.get("reasoning_tokens") if isinstance(output_details, dict) else None,
    }
    counts = {name: count for name, count in counts.items() if type(count) is int and count >= 0}
    if counts:
        metadata["usage"] = counts
    return metadata


def metric_reading(row):
    """One numeric reading and its aggregation. Keep dimension values and raw time series out of the log."""
    buckets = {"avgBuckets": "average", "maxBuckets": "maximum", "minBuckets": "minimum",
               "totalBuckets": "total", "countBuckets": "count"}
    name = row.get("name")
    if not isinstance(name, str):
        return None
    series = row.get("timeSeries")
    for item in series if isinstance(series, list) else []:
        if not isinstance(item, dict):
            continue
        for key, label in buckets.items():
            values = item.get(key)
            if not isinstance(values, list):
                continue
            for value in reversed(values):
                if type(value) is int or (type(value) is float and math.isfinite(value)):
                    return f"{name[:100]} · {label} {value}"
    return f"{name[:100]} · no numeric reading"


def tool_detail(name, text, data, ok):
    """Project actual outputs by tool type. Never persist arbitrary tool output or log records."""
    if name == "load_skill" and ok:
        # The provider returns the bundled SKILL.md, including its Markdown headings.
        headings = re.findall(r"^#{1,2} ([^\n\r]+)", text, re.MULTILINE)
        return "Sections returned · " + " · ".join(title[:100] for title in headings[:4]) if headings else None
    if not isinstance(data, dict):
        return None
    if not ok:
        status = data.get("status")
        error = data.get("error")
        code = error.get("code") if isinstance(error, dict) else data.get("code")
        details = []
        if type(status) is int:
            details.append(f"HTTP {status}")
        if isinstance(code, str) and re.fullmatch(r"[A-Za-z][\w.-]{0,80}", code):
            details.append(code)
        return " · ".join(details) or None
    if name not in ("monitor_metrics_query", "monitor_metrics_definitions"):
        return None
    result = data.get("results")
    if result is None and "results" in data:
        return "Azure Monitor returned no metrics."
    rows = result.get("results") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        return None
    if name == "monitor_metrics_definitions":
        names = [row["name"][:100] for row in rows[:10] if isinstance(row, dict) and isinstance(row.get("name"), str)]
        return f"{len(rows)} metric definitions returned" + (" · " + ", ".join(names) if names else "")
    readings = [metric_reading(row) for row in rows[:5] if isinstance(row, dict)]
    return "\n".join(reading for reading in readings if reading) or "Azure Monitor returned no metric series."

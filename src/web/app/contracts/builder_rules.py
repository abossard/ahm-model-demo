"""Validate a schema-checked builder result against the specific resources of its Task.

Both the agent's correction loop and the web app's write boundary use this module.
Their Docker build contexts are independent. The contract parity test checks both copies.
"""

from collections import Counter
from math import isfinite


def referenced_resources(resources):
    """Short references belong to one Task's ordered inventory."""
    return [{**row, "ref": f"R{index}"} for index, row in enumerate(resources, 1)]


def expand_resource_refs(result, resources):
    """Resolve references only in schema fields that bind Azure resources, before validation."""
    refs = {row["ref"]: row["id"] for row in referenced_resources(resources)}

    def expand(value, key=None):
        if isinstance(value, dict):
            return {k: expand(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [expand(item, key) for item in value]
        if isinstance(value, str) and key in ("resourceId", "resourceIds"):
            return refs.get(value.upper(), value)
        return value

    return expand(result)


def resource_coverage(ids, expected):
    supplied = Counter(value.casefold() for value in ids)
    required = {value.casefold() for value in expected}
    return [
        f"{message}: {', '.join(sorted(names))}"
        for message, names in (
            ("Missing resources", required - supplied.keys()),
            ("Resources outside the selection", supplied.keys() - required),
            ("Resources included more than once", {key for key, count in supplied.items() if count > 1}),
        )
        if names
    ]


def analysis_coverage(resources, sections):
    """Group correction paths by resource, so overlapping omissions repeat neither names nor ARM IDs."""
    labels = {row["id"].casefold(): row.get("name") or row["id"] for row in resources}
    names = Counter(label.casefold() for label in labels.values())
    paths = {}
    for path, submitted, required in sections:
        counts = Counter(submitted)
        for issue, affected in (
            ("Missing from", required - counts.keys()),
            ("Outside the selection in", counts.keys() - labels.keys()),
            ("Repeated in", {arm for arm, n in counts.items() if n > 1}),
        ):
            for arm in sorted(affected):
                paths.setdefault((issue, arm), []).append(path)
    grouped = {}
    for (issue, arm), fields in paths.items():
        label = labels.get(arm)
        display = label if label and names[label.casefold()] == 1 else arm
        grouped.setdefault((issue, tuple(fields)), []).append(display)
    return [f"{issue} {' and '.join(fields)} ({len(items)}): {', '.join(sorted(items))}"
            for (issue, fields), items in grouped.items()]


def builder_problems(result, builder):
    phase = builder["phase"]
    expected_kind = {"analyze": "builderAnalysis", "propose": "builderProposals"}.get(phase)
    if expected_kind != result["kind"]:
        return [f"The builder {phase} step requires kind {expected_kind}."]
    if phase == "analyze":
        ids = {r["id"].casefold() for r in builder["resources"]}
        rows = (r["resourceId"].casefold() for r in result["rows"])
        bindings = (arm.casefold() for flow in result["plan"]["flows"] for part in flow["components"] for arm in part["resourceIds"])
        metrics = [m["resourceId"].casefold() for m in result.get("metrics", [])]
        omitted = [m["resourceId"].casefold() for m in result.get("omittedMetrics", [])]
        observed = {r["resourceId"].casefold() for r in builder.get("observedMetrics", [])}
        problems = analysis_coverage(builder["resources"], [
            ("rows", rows, ids), ("component resourceIds", bindings, ids),
            ("metrics or omittedMetrics", metrics + omitted, observed),
        ])
        evidence = observed | set(metrics) | {r["id"].casefold() for r in builder["resources"] if r.get("availabilityState")}
        decisions = result["plan"].get("decisions", [])
        if builder.get("planVersion", 1) >= 2 and not decisions:
            problems.append("Explain at least one concrete plan decision and name the resources that support it.")
        for decision in decisions:
            refs = {arm.casefold() for arm in decision["resourceIds"]}
            if refs - ids:
                problems.append("A plan decision refers to a resource outside the selected workload.")
            if decision["basis"] == "measurement" and refs - evidence:
                problems.append("Cite only resources with measured signals for a measurement-based decision.")
            if decision["basis"] == "userInput" and not builder.get("revision"):
                problems.append("Use userInput only for an explicit adjustment to the workload plan.")
        return problems

    selected = {r["resourceId"].casefold() for r in builder["rows"]}
    problems, ids, titles, structures = [], set(), set(), set()
    has_plan = bool(builder.get("plan"))
    if has_plan and result["proposals"][0]["structure"] != "planned":
        problems.append("Make the confirmed workload plan the first design, with structure planned.")
    if has_plan and result.get("metrics") and result["metrics"] != builder["metrics"]:
        problems.append("The metric choices and thresholds are already reviewed. Omit metrics from the alternatives.")
    for proposal in result["proposals"]:
        name = proposal["id"]
        if name in ids or proposal["title"].strip().casefold() in titles:
            problems.append(f"{name}: give each alternative a unique ID and title.")
        ids.add(name)
        titles.add(proposal["title"].strip().casefold())
        groups = proposal["groups"]
        problems.extend(f"{name}: {p}" for p in resource_coverage((arm for g in groups for arm in g["resourceIds"]), selected))
        partition = sorted(tuple(sorted(arm.casefold() for arm in g["resourceIds"])) for g in groups)
        structure = proposal["structure"]
        if structure == "planned" and not has_plan:
            problems.append("A planned design needs a reviewed workload plan.")
        shape = (structure,) if structure != "grouped" else (structure, *partition)
        if shape in structures:
            problems.append(f"{name}: two alternatives produce the same topology. Offer a direct resource view or a different grouping.")
        structures.add(shape)
    measured = set()
    for metric in result.get("metrics", []):
        arm = metric["resourceId"].casefold()
        if arm not in selected or arm in measured:
            problems.append("Include at most one measured signal per confirmed resource.")
        if not all(isfinite(value) for value in (metric["sample"], metric["threshold"])):
            problems.append("Signal samples and thresholds must be finite numbers.")
        measured.add(arm)
    return problems

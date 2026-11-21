"""Compile a confirmed resource selection and a proposed topology into one inspectable model."""

import html
import re

import model_diff
from contracts.builder_rules import builder_problems
from contracts.show_me import plain_result

DEPENDENCIES = {"aggregationType": "WorstOf", "ignoreUnknown": False}
DECISION_SOURCES = {"inventory": "Azure inventory", "measurement": "Signal check",
                    "assumption": "Planning assumption", "userInput": "Your adjustment"}


def metric_binding(metric):
    return {
        "name": "workload-metric", "displayName": metric["metricName"], "signalKind": "AzureResourceMetric",
        "metricName": metric["metricName"], "metricNamespace": metric["metricNamespace"],
        "aggregationType": metric["aggregation"], "timeGrain": "PT5M", "refreshInterval": "PT5M",
        "evaluationRules": {"unhealthyRule": {"operator": metric["operator"], "threshold": metric["threshold"]}},
    }


def md(value):
    """Make a single text cell safe in a Markdown table, heading or list."""
    return re.sub(r"([\\|\x60*_\[\]#!~])", r"\\\1", html.escape(" ".join(str(value).split()), quote=False))


def confirmed_plan(plan, selected):
    selected = {arm.casefold(): arm for arm in selected}
    flows = []
    for flow in plan["flows"]:
        components = []
        for component in flow["components"]:
            ids = [selected[arm.casefold()] for arm in component["resourceIds"] if arm.casefold() in selected]
            if ids:
                components.append({**component, "resourceIds": ids})
        if components:
            flows.append({**flow, "components": components})
    scoped = {**plan, "flows": flows}
    if "decisions" in plan:
        scoped["decisions"] = [d for d in plan["decisions"] if all(arm.casefold() in selected for arm in d["resourceIds"])]
    return scoped


def metrics_for(task):
    return task["builder"].get("metrics", task["result"].get("metrics", []))


def plan_sections(plan, labels):
    lines = ["## Workload objective", "", md(plan["objective"]), "", "## Flows and components", ""]
    for flow in plan["flows"]:
        lines += [f"### {md(flow['name'])}", "", md(flow["objective"]), "",
                  f"**Failure scenario.** {md(flow['failureScenario'])}", "",
                  "| Component | Azure resources | Candidate signal to investigate |", "| --- | --- | --- |"]
        for component in flow["components"]:
            names = ", ".join(labels[r.casefold()] for r in component["resourceIds"])
            lines.append(f"| {md(component['name'])} | {names} | {md(component['signal'])} |")
        lines.append("")
    if plan.get("decisions"):
        lines += ["## Why these choices were made", ""]
        for decision in plan["decisions"]:
            sources = ", ".join(labels[arm.casefold()] for arm in decision["resourceIds"])
            lines += [f"**{md(decision['choice'])}**", "", md(decision["reason"]), "",
                      f"{DECISION_SOURCES[decision['basis']]} · {sources}", ""]
    if plan["gaps"]:
        lines += ["### Evidence gaps", "", *(f"- {md(gap)}" for gap in plan["gaps"]), ""]
    return lines


def documents(task, proposal, entities, relationships, verification):
    builder = task["builder"]
    model = task["target"]["name"]
    labels = {e["name"]: md(e["displayName"]) for e in entities}
    parent_of = {r["child"]: r["parent"] for r in relationships}
    children = [e for e in entities if e.get("resourceId")]
    plan = [
        f"# Health model for {md(model)}", "", "## What does health mean for this workload?", "",
        md(proposal["summary"]), "", f"**Design choice.** {md(proposal['title'])}. {md(proposal['tradeoff'])}", "",
    ]
    row_names = {e["resourceId"].casefold(): labels[e["name"]] for e in children}
    planning = []
    if "plan" in builder:
        topology = {"planned": "Workload → user flow → component → Azure resource",
                    "grouped": "Workload → group → Azure resource", "direct": "Workload → Azure resource"}
        planning = [f"**Selected model structure.** {topology[proposal['structure']]}.", ""]
        if revision := builder.get("revision"):
            planning += ["## Requested adjustment", "", md(revision["prompt"]), ""]
        planning.extend(plan_sections(builder["plan"], row_names))
        plan.extend(planning)
    if proposal["structure"] != "planned":
        plan += ["## Workload coverage", "", "| Area | What it supports | Resources |", "| --- | --- | --- |"]
        for group in proposal["groups"]:
            names = ", ".join(row_names[r.casefold()] for r in group["resourceIds"])
            plan.append(f"| {md(group['name'])} | {md(group['purpose'])} | {names} |")
    plan += ["", "## Model structure", "", "| Entity | Depends on |", "| --- | --- |"]
    plan.extend(f"| {labels[parent]} | {labels[child]} |" for child, parent in parent_of.items())
    plan += [
        "", "## Reading health", "",
        "The model takes the worst contributing state of its dependencies. Unknown readings are included. "
        "A Limited dependency can degrade its parent. A Suppressed dependency is visible but does not contribute to its parent.",
        "", "Platform availability comes from Azure Resource Health where the service supplies it. "
        "A verified metric compares the observed five-minute measure with the proposed threshold. "
        "The model identity needs permission to read each data source.", "",
    ]
    if verification:
        plan += ["| Resource | Signal | Signal test | Observation |", "| --- | --- | --- | --- |"]
        for test in verification:
            reading = test["value"] if test["value"] is not None else test["error"]
            plan.append(f"| {labels[test['entity']]} | {md(test['signal'])} | {md(test['status'])} | {md(reading)} |")
    spec = [
        f"# Model specification for {md(model)}", "", "## Model intent", "",
        md(proposal["title"]), "", md(proposal["summary"]), "", "## Source material and decisions", "",
        f"- Resource Graph supplied the IDs and types of the {len(children)} resources retained in the review.",
        f"- Analysis Task {md(builder.get('analysisSeq', 'unknown'))}. The proposal Task was started {md(task.get('createdAt', 'at an unrecorded time'))}.",
        "- Display names, purposes and impact below come from the confirmed review table. Groups and dependency links represent the proposed monitoring design.",
        f"- The selected design is {md(proposal['title'])}. {md(proposal['tradeoff'])}", "",
        *planning, "## Entity plan and Designer layout", "",
        "| Azure entity name | Display name | Parent | Impact | Position (x, y) | Purpose | Source resource |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for entity in entities:
        name = entity["name"]
        spec.append(f"| {md(name)} | {labels[name]} | {md(parent_of.get(name, 'Root'))} | {md(entity['impact'])} | "
                    f"{entity['x']}, {entity['y']} | {md(entity['purpose'])} | {md(entity.get('resourceId', 'Model structure'))} |")
    spec += ["", "## Signals and verification", "", "| Entity | Signal | Query or source | Result | Observation or gap |",
             "| --- | --- | --- | --- | --- |"]
    for test in verification:
        detail = test["value"] if test["value"] is not None else test["error"]
        spec.append(f"| {md(test['entity'])} | {md(test['signal'])} | {md(test['query'])} | {md(test['status'])} | {md(detail)} |")
    spec += ["", "## Thresholds and rollup", "", "All dependency groups use WorstOf and include Unknown. "
             "Azure Resource Health supplies platform availability without a custom threshold."]
    for metric in metrics_for(task):
        spec.append(f"- {md(metric['metricName'])} on {row_names[metric['resourceId'].casefold()]} uses a five-minute "
                    f"{md(metric['aggregation'])}. The reviewed unhealthy rule is {md(metric['operator'])} {metric['threshold']}.")
    spec += ["", "## Gaps and open decisions", "", "- Platform availability coverage varies by Azure service. "
             "The model identity needs Monitoring Reader access to the resources supplying signals. Review missing readings after provisioning.",
             "- No alert recipients or service level objectives were specified. No alert rules or targets are proposed.",
             "", "## Intent acceptance", "", "The resource review was confirmed before these alternatives were generated. "
             "Provisioning approval and its outcome are recorded separately on the Session Task.", ""]
    return "\n".join(plan) + "\n", "\n".join(spec)


def monitoring_scopes(changes):
    """Only resource bindings with an enabled signal require access."""
    scopes = {}
    for change in changes:
        source = change["after"].get("signalGroups", {}).get("azureResource", {})
        if source.get("signals") or source.get("resourceHealth", {}).get("enabled") == "Enabled":
            scope = source["azureResourceId"]
            scopes.setdefault(scope.casefold(), scope)
    return list(scopes.values())


def preview(task, proposal_id):
    """Only the stored, schema-checked proposal and confirmed rows determine what can be written."""
    proposal = next((p for p in plain_result(task["result"])["proposals"] if p["id"] == proposal_id), None)
    if proposal is None:
        raise ValueError("Select a design from this Task.")
    root = task["target"]["name"]
    rows = {row["resourceId"].casefold(): row for row in task["builder"]["rows"]}
    inventory = {r["id"].casefold(): r for r in task["builder"]["resources"]}
    metrics = {m["resourceId"].casefold(): m for m in metrics_for(task)}
    entities, relationships, changes, verification, findings = [], [], [], [], []

    def add_entity(name, label, purpose, x, y, *, parent=None, row=None):
        impact = row["impact"] if row else "Standard"
        entity = {"name": name, "displayName": label, "purpose": purpose, "impact": impact, "x": x, "y": y}
        props = {"canvasPosition": {"x": x, "y": y}, "signalGroups": {"dependencies": DEPENDENCIES}}
        if parent:
            props.update(displayName=label, impact=impact)
        if row:
            arm = row["resourceId"]
            entity["resourceId"] = arm
            metric = metrics.get(arm.casefold())
            availability = inventory[arm.casefold()].get("availabilityState")
            props["signalGroups"]["azureResource"] = {
                "authenticationSetting": "auth-system", "azureResourceId": arm,
                "resourceHealth": {"enabled": "Enabled" if availability else "Disabled"},
            }
            if metric:
                props["signalGroups"]["azureResource"]["signals"] = [metric_binding(metric)]
            verification.append({"entity": name, "signal": "Azure Resource Health", "query": arm,
                                 "status": "verified" if availability else "not_run", "value": availability or None,
                                 "error": None if availability else "Resource Graph returned no availability reading. Platform availability is disabled."})
            if not availability and not metric:
                findings.append({"severity": "medium", "entity": name, "text": "No measured signal was available for this resource. Its health will be Unknown until a signal reports.", "changeIds": []})
            if metric:
                verification.append({"entity": name, "signal": metric["metricName"], "status": "verified",
                                     "query": f"{metric['metricNamespace']} / {metric['metricName']} ({metric['aggregation']}, PT5M)",
                                     "value": metric["sample"], "error": None})
        entities.append(entity)
        changes.append({"id": f"entity-{name}", "op": "add" if parent else "change", "kind": "entity",
                        "name": name, "after": props, "reason": purpose})
        if parent:
            relationships.append({"parent": parent, "child": name})
            changes.append({"id": f"link-{name}", "op": "add", "kind": "relationship", "name": f"link-{name}",
                            "after": {"parentEntityName": parent, "childEntityName": name}, "reason": purpose})

    def center(first, count):
        return 40 + 240 * first + 120 * (count - 1)

    add_entity(root, root, proposal["summary"], center(0, len(rows)), 40)
    leaf = 0
    def add_resources(resource_ids, parent, y):
        nonlocal leaf
        for arm in resource_ids:
            row = rows[arm.casefold()]
            # Resuming an older approved proposal keeps its original display names.
            label = inventory[arm.casefold()]["name"] if "plan" in task["builder"] else row["displayName"]
            add_entity(f"{root}-resource-{leaf + 1}", label, row["purpose"], center(leaf, 1), y, parent=parent, row=row)
            leaf += 1

    if proposal["structure"] == "planned":
        for i, flow in enumerate(task["builder"]["plan"]["flows"], 1):
            flow_id = f"{root}-flow-{i}"
            count = sum(len(component["resourceIds"]) for component in flow["components"])
            add_entity(flow_id, flow["name"], flow["objective"], center(leaf, count), 210, parent=root)
            for j, component in enumerate(flow["components"], 1):
                component_id = f"{root}-component-{i}-{j}"
                ids = component["resourceIds"]
                add_entity(component_id, component["name"], f"Supports {flow['name']}.", center(leaf, len(ids)), 380, parent=flow_id)
                add_resources(ids, component_id, 550)
    else:
        for i, group in enumerate(proposal["groups"], 1):
            ids = group["resourceIds"]
            if proposal["structure"] == "grouped":
                group_id = f"{root}-area-{i}"
                add_entity(group_id, group["name"], group["purpose"], center(leaf, len(ids)), 210, parent=root)
                add_resources(ids, group_id, 380)
            else:
                add_resources(ids, root, 210)
    diff = {"kind": "diff", "summary": proposal["summary"], "changes": changes, "verification": verification, "findings": findings}
    plan, spec = documents(task, proposal, entities, relationships, verification)
    return {**proposal, "entities": entities, "relationships": relationships, "diff": diff,
            "monitoringScopes": monitoring_scopes(changes), "plan": plan, "modelspec": spec}


def validate(task, result):
    problems = builder_problems(result, task["builder"])
    if problems or result["kind"] != "builderProposals":
        return problems
    # Validate the graph exactly as it will be written, including Azure's automatically created root.
    base = {"entities": [{"name": task["target"]["name"], "properties": {}}], "relationships": [], "signalDefinitions": []}
    selected = [r["resourceId"] for r in task["builder"]["rows"]]
    for proposal in result["proposals"]:
        previewed = preview({**task, "result": result}, proposal["id"])
        problems.extend(model_diff.validate_result(previewed["diff"], base, task["target"], allowed_ids=selected))
    return problems

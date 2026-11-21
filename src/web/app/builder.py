"""Turn deliberate builder actions into owner-scoped Tasks. Only creation writes to Azure."""

import asyncio
import json
import weakref

from azure.core.exceptions import AzureError

import activity
import builder_apply
import builder_design
from config import INSTRUCTION_MAX_CHARS, MAX_BUILDER_RESOURCES
from contracts.show_me import catalog_problem, plain_result
from sessions_store import utc_now


class BuilderInput(ValueError):
    """A correction the person can make in the builder."""


def group_of(resource_id):
    parts = resource_id.split("/")
    if len(parts) < 9 or parts[0] or parts[1].lower() != "subscriptions" or parts[3].lower() != "resourcegroups" or parts[5].lower() != "providers":
        raise BuilderInput("Choose resources from the Azure resource list.")
    return "/".join(parts[:5]).lower()


def reviewed_workload(state, analysis_seq, rows):
    analysis = state.get("analysis", {})
    if analysis.get("seq") != analysis_seq or analysis.get("status") != "done" or state.get("creation"):
        raise BuilderInput("Reopen the completed workload analysis before changing the plan.")
    original = {r["resourceId"] for r in analysis["result"]["rows"]}
    selected = {r["resourceId"] for r in rows}
    if not selected or len(selected) != len(rows) or not selected <= original:
        raise BuilderInput("Include at least one analyzed resource and use each resource at most once.")
    resources = [r for r in analysis["builder"]["resources"] if r["id"] in selected]
    names = {r["id"]: r["name"] for r in resources}
    if any(not row["purpose"].strip() or not row["purpose"].isprintable() for row in rows):
        raise BuilderInput("Describe the workload role of each included resource.")
    reviewed = {"rows": [{**r, "displayName": names[r["resourceId"]], "purpose": r["purpose"].strip()} for r in rows],
                "resources": resources}
    if "plan" in analysis["result"]:
        reviewed["plan"] = builder_design.confirmed_plan(plain_result(analysis["result"])["plan"], selected)
        selected_ids = {arm.casefold() for arm in selected}
        reviewed["metrics"] = [m for m in analysis["result"]["metrics"] if m["resourceId"].casefold() in selected_ids]
    return analysis, reviewed


def builder_activity(events):
    """Replay the common ActivityEvent format with only the fields the builder displays."""
    steps, usage_by_response = [], {}
    for event in events:
        if event["kind"] == "text":
            continue
        source = event.get("payload") or {}
        payload = {key: source[key] for key in (
            "callId", "name", "ok", "size", "detail", "problems", "usage", "code", "reason", "resultKind"
        ) if key in source}
        step = {key: event[key] for key in ("seq", "ts", "kind", "summary")}
        if event["kind"] == "tool_call":
            args = activity.parse_arguments(source.get("arguments"))
            if source.get("name") in ("monitor_metrics_query", "monitor_metrics_definitions"):
                if resource := source.get("resource") or activity.lookup(args)("resource"):
                    step["resource"] = payload["resource"] = resource
                allowed = {"subscription", "resource", "resourcegroup", "resourcetype", "metricnamespace",
                           "metricnames", "aggregation", "interval", "starttime", "endtime", "searchstring", "limit"}
            elif source.get("name") == "load_skill":
                allowed = {"name", "skill", "skillname"}
            else:
                allowed = set()
            shown = {k: v for k, v in args.items() if k.lower().replace("-", "").replace("_", "") in allowed}
            if shown:
                payload["arguments"] = json.dumps(shown, ensure_ascii=False)
        if "usage" in payload:
            # Terminal snapshots are cumulative for one Foundry response. A retry may open a second response.
            usage_by_response[source.get("responseId") or event["seq"]] = payload["usage"]
        steps.append({**step, "payload": payload})
    result = {"activity": steps}
    if usage_by_response:
        records = list(usage_by_response.values())
        result["usage"] = {key: sum(r[key] for r in records) for key in set.intersection(*(set(r) for r in records))}
    return result


class Builder:
    _session_writes = weakref.WeakValueDictionary()

    def __init__(self, caller, store, runner, health):
        self.owner = caller.owner
        self.caller = caller
        self.store = store
        self.runner = runner
        self.user = health.as_user(caller)

    async def perform(self, action_name, arguments):
        if "showMeHandles" in arguments and (problem := catalog_problem(arguments["showMeHandles"])):
            raise BuilderInput(problem)
        action = getattr(self, action_name)
        sid = arguments.get("sessionId")
        if not sid or action_name not in {"analyze", "revise", "propose", "create"}:
            return await action(**arguments)
        # The web app runs one replica. A second tab must observe the first tab's new Task or
        # creation claim before it can act on the same proposal. Reads can still show progress.
        lock = self._session_writes.setdefault((self.owner, sid), asyncio.Lock())
        async with lock:
            return await action(**arguments)

    async def inventory(self, groupId=None):
        if groupId:
            return {"resources": await asyncio.to_thread(self.user.builder_resources, groupId)}
        return {"groups": await asyncio.to_thread(self.user.builder_groups)}

    async def state(self, sessionId=None):
        if not sessionId:
            return {"sessionId": None}
        if not await self.store.get_session(self.owner, sessionId):
            raise BuilderInput("This builder session is unavailable.")
        state = {"sessionId": sessionId}
        for task in await self.store.list_tasks(self.owner, sessionId):
            phase = task.get("builder", {}).get("phase")
            if phase not in ("analyze", "propose"):
                continue
            task = await self.runner.settled(self.owner, sessionId, task)
            state.pop("failedRevision", None)
            if phase == "analyze":
                state.pop("proposal", None)
                if task["builder"].get("revision") and task.get("status") == "failed" and "analysis" in state:
                    state["failedRevision"] = task
                    continue
            state["analysis" if phase == "analyze" else "proposal"] = task
            state["target"] = task["target"]
        if "analysis" in state:
            analysis = state["analysis"]
            if analysis.get("result", {}).get("kind") == "builderAnalysis":
                names = {r["id"]: r["name"] for r in analysis["builder"]["resources"]}
                result = analysis["result"]
                analysis = {**analysis, "result": {**result, "rows": [
                    {**row, "displayName": names[row["resourceId"]]} for row in result["rows"]
                ]}}
            state["analysis"] = analysis
        for phase in ("analysis", "proposal", "failedRevision"):
            if task := state.get(phase):
                events = await self.store.read_events(self.owner, sessionId, task["seq"])
                state[phase] = {**task, **builder_activity(events)}
        if "proposal" in state:
            creation = await builder_apply.creation_status(self.store, self.owner, sessionId, state["proposal"]["seq"])
            if creation:
                state["creation"] = creation
                if creation["status"] == "created" and "monitoringScopes" not in creation:
                    # Older receipts stored the digest of the approved Azure writes.
                    intent = await self.store.get_creation(self.owner, sessionId, state["proposal"]["seq"])
                    try:
                        changes = builder_design.preview(state["proposal"], creation["proposalId"])["diff"]["changes"]
                        matching = builder_apply.change_digest(changes) == intent["digest"]
                        scopes = builder_design.monitoring_scopes(changes) if matching else []
                    except (KeyError, TypeError, ValueError):
                        scopes = []
                    state["creation"] = {**creation, "monitoringScopes": scopes}
        return state

    async def analyze(self, groupIds, resourceIds, destinationGroupId, modelName, sessionId=None, showMeHandles=None):
        model_name = builder_apply.model_name(modelName)
        groups = {g["id"].lower(): g for g in (await self.inventory())["groups"]}
        destination = groups.get(destinationGroupId.lower())
        if not destination:
            raise BuilderInput("Choose a destination resource group you can access.")
        selected_groups = {g.lower() for g in groupIds}
        wanted = {r.lower() for r in resourceIds}
        sources = selected_groups | {group_of(r) for r in wanted}
        if not sources or not sources <= groups.keys():
            raise BuilderInput("Select an available resource or resource group.")
        if any(groups[g]["subscriptionId"].lower() != destination["subscriptionId"].lower() for g in sources):
            raise BuilderInput("Choose resources and a destination in the same subscription.")
        resources = []
        for group in sorted(sources):
            available = (await self.inventory(groups[group]["id"]))["resources"]
            resources.extend(r for r in available if group in selected_groups or r["id"].lower() in wanted)
            if len(resources) > MAX_BUILDER_RESOURCES:
                raise BuilderInput(f"Select up to {MAX_BUILDER_RESOURCES} resources. Choose individual resources in larger groups.")
        if not resources or wanted - {r["id"].lower() for r in resources}:
            raise BuilderInput("A selected resource is unavailable. Refresh the resource selection.")
        location = await asyncio.to_thread(self.user.builder_location, destination["subscriptionId"], destination["location"])
        target = {"name": model_name, "subscriptionId": destination["subscriptionId"], "resourceGroup": destination["name"], "location": location}
        if sessionId:
            previous = await self.state(sessionId)
            if "analysis" not in previous or previous.get("creation"):
                raise BuilderInput("Start a new builder session for this workload.")
        else:
            sessionId = (await self.store.create_session(self.owner, f"Build {modelName}"))["id"]
        builder = {"phase": "analyze", "planVersion": 2, "resources": resources, "groupIds": groupIds,
                   "resourceIds": resourceIds, "destinationGroupId": destinationGroupId, "modelName": modelName}
        await self.start(sessionId, target, builder, showMeHandles)
        return await self.state(sessionId)

    async def start(self, sid, target, builder, handles):
        fields = {"type": "design", "target": target, "workload": {"resourceGroup": target["resourceGroup"]},
                  "instruction": "", "builder": builder, "createdAt": utc_now()}
        if handles is not None:
            fields["showMeHandles"] = handles
        await self.runner.start(self.caller, sid, fields)

    async def propose(self, sessionId, analysisSeq, rows, showMeHandles=None):
        analysis, reviewed = reviewed_workload(await self.state(sessionId), analysisSeq, rows)
        builder = {**reviewed, "phase": "propose", "analysisSeq": analysisSeq}
        # Keep the evidence for the resources the reader confirmed, in this proposal's own snapshot.
        ids = {r["id"].casefold() for r in reviewed["resources"]}
        for key in ("observedMetrics", "signalChecks"):
            builder[key] = [m for m in analysis["builder"].get(key, []) if m["resourceId"].casefold() in ids]
        if revision := analysis["builder"].get("revision"):
            builder["revision"] = revision
        await self.start(sessionId, analysis["target"], builder, showMeHandles)
        return await self.state(sessionId)

    async def revise(self, sessionId, analysisSeq, rows, prompt, showMeHandles=None):
        prompt = prompt.strip()
        if not prompt or len(prompt) > INSTRUCTION_MAX_CHARS or not all(c.isprintable() or c in "\n\r\t" for c in prompt):
            raise BuilderInput(f"Describe the requested plan change in up to {INSTRUCTION_MAX_CHARS} characters.")
        analysis, reviewed = reviewed_workload(await self.state(sessionId), analysisSeq, rows)
        if "plan" not in reviewed:
            raise BuilderInput("Generate a workload plan before requesting a revision.")
        source = analysis["builder"]
        ids = [r["id"] for r in reviewed["resources"]]
        selected = {arm.casefold() for arm in ids}
        builder = {"phase": "analyze", "planVersion": 2, "resources": reviewed["resources"], "rows": reviewed["rows"],
                   "modelName": source["modelName"], "destinationGroupId": source["destinationGroupId"],
                   "groupIds": [], "resourceIds": ids, "previousPlan": reviewed["plan"], "previousMetrics": reviewed["metrics"],
                   "revision": {"analysisSeq": analysisSeq, "prompt": prompt}}
        for key in ("observedMetrics", "signalChecks"):
            builder[key] = [m for m in source.get(key, []) if m["resourceId"].casefold() in selected]
        builder["previousOmittedMetrics"] = [m for m in analysis["result"].get("omittedMetrics", [])
                                            if m["resourceId"].casefold() in selected]
        await self.start(sessionId, analysis["target"], builder, showMeHandles)
        return await self.state(sessionId)

    async def proposal(self, sessionId, proposalSeq, proposalId):
        state = await self.state(sessionId)
        task = state.get("proposal", {})
        if task.get("seq") != proposalSeq or task.get("status") != "done":
            raise BuilderInput("This proposal has changed. Reopen the builder to continue.")
        if proposalId not in {p["id"] for p in task["result"]["proposals"]}:
            raise BuilderInput("Select a design from this proposal.")
        return task, builder_design.preview(task, proposalId)

    async def preview(self, **args):
        _, preview = await self.proposal(**args)
        return preview

    async def create(self, sessionId, proposalSeq, proposalId, confirmed):
        if confirmed is not True:
            raise BuilderInput("Confirm the model and destination before creating it.")
        task, preview = await self.proposal(sessionId, proposalSeq, proposalId)
        await builder_apply.create_model(self.store, self.user, self.owner, sessionId, task, proposalId, preview["diff"]["changes"])
        return await self.state(sessionId)

    async def open_model(self, sessionId, proposalSeq):
        state = await self.state(sessionId)
        if state.get("proposal", {}).get("seq") != proposalSeq or state.get("creation", {}).get("status") != "created":
            raise BuilderInput("Finish creating the model before opening it.")
        return {"target": state["target"]}

    async def grant_monitoring(self, sessionId, proposalSeq, confirmed):
        state = await self.state(sessionId)
        creation = state.get("creation", {})
        if (confirmed is not True or creation.get("status") != "created"
                or state["proposal"]["seq"] != proposalSeq or not creation["monitoringScopes"]):
            raise BuilderInput("Review the monitored resources of the created model before granting access.")
        target = creation["target"]
        intent = await self.store.get_creation(self.owner, sessionId, proposalSeq)
        parent = await asyncio.to_thread(self.user.builder_parent, target["subscriptionId"], target["resourceGroup"], target["name"])
        principal = ((parent or {}).get("identity") or {}).get("principalId")
        if (not principal or principal != creation.get("principalId")
                or (parent.get("tags") or {}).get(builder_apply.OWNER_TAG) != intent["marker"]):
            raise BuilderInput("The model or its identity has changed in Azure. Review its access in Azure.")
        for scope in creation["monitoringScopes"]:
            if creation.get("monitoringAccess", {}).get(scope, {}).get("status") == "confirmed":
                continue
            event = {"kind": "monitoringAccess", "scope": scope, "principalId": principal, "at": utc_now()}
            try:
                assignment = await asyncio.to_thread(self.user.grant_monitoring_reader, target["subscriptionId"], principal, scope)
                event.update(status="confirmed", assignmentId=assignment)
            except AzureError as error:
                message = ("Your account needs permission to assign Monitoring Reader on this resource."
                           if getattr(error, "status_code", None) == 403 else
                           "Azure could not confirm the assignment. Retry to check and finish granting access.")
                event.update(status="failed", message=message)
            await self.store.append_apply(self.owner, sessionId, proposalSeq, event)
        return await self.state(sessionId)

"""Create the approved proposal in the caller's Azure subscription, and resume it after an interruption."""

import asyncio
import hashlib
import json
import re
import secrets
import weakref

from azure.core.exceptions import AzureError, HttpResponseError

import model_diff
from apply import reference
from builder_design import monitoring_scopes
from sessions_store import utc_now


OWNER_TAG = "ahm-builder-operation"
PREFIX = re.compile(r"[a-zA-Z](?:[a-zA-Z0-9-]{0,25}[a-zA-Z0-9])?")
locks = weakref.WeakValueDictionary()


class BuilderConflict(ValueError):
    pass


def model_name(prefix):
    if not isinstance(prefix, str) or not PREFIX.fullmatch(prefix):
        raise ValueError("Use 1 to 27 letters, digits or hyphens. Begin with a letter and end with a letter or digit.")
    # The provider documents its parent PUT as an upsert. A new Task reserves its own unpredictable physical name.
    return f"{prefix}-{secrets.token_hex(8)}"


def _outcome(intent):
    result = {"status": "creating", "target": intent["target"], "proposalId": intent["proposalId"],
              "steps": [], "written": [], "at": intent["at"]}
    if "monitoringScopes" in intent:
        result["monitoringScopes"] = intent["monitoringScopes"]
    return result


def change_digest(changes):
    return hashlib.sha256(json.dumps(changes, sort_keys=True).encode()).hexdigest()


async def creation_status(store, owner, sid, seq):
    intent = await store.get_creation(owner, sid, seq)
    if intent is None:
        return None
    attempts = await store.read_applies(owner, sid, seq)
    # A late response from a concurrent retry cannot supersede a documented success.
    access = {}
    for entry in attempts:
        if entry.get("kind") == "monitoringAccess":
            scope = entry["scope"]
            if access.get(scope, {}).get("status") != "confirmed":
                access[scope] = entry
    for attempt in reversed(attempts):
        if attempt.get("status") == "created":
            return {**attempt, "monitoringAccess": access} if access else attempt
    return attempts[-1] if attempts else _outcome(intent)


def _matches(actual, expected):
    """ARM often returns extra service defaults alongside the approved properties."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and _matches(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            _matches(a, b) for a, b in zip(model_diff.canonical(actual), model_diff.canonical(expected))
        )
    if isinstance(expected, str) and expected.lower().startswith("/subscriptions/") and isinstance(actual, str):
        return actual.casefold() == expected.casefold()
    return actual == expected


def _parent(health, target, marker, seen):
    ref = reference(target)
    parent = health.builder_parent(*ref)
    if parent is None:
        if seen:
            raise BuilderConflict("The previously created model is missing. Start a new proposal to recreate it.")
        try:
            parent = health.create_builder_parent(*ref, target["location"], {OWNER_TAG: marker})
        except HttpResponseError as error:
            if error.status_code not in (409, 412):
                raise
            parent = health.builder_parent(*ref)
    if not parent or (parent.get("tags") or {}).get(OWNER_TAG) != marker:
        raise BuilderConflict("This model name is already in use. Create a new proposal to obtain a fresh name.")
    if parent.get("properties", {}).get("provisioningState") != "Succeeded":
        raise ValueError("Azure has not finished provisioning the model. Check its status before retrying.")
    return (parent.get("identity") or {}).get("principalId")


def _write_child(health, target, change, live, seen):
    expected = model_diff.strip_system(change["after"])
    current = model_diff.index_of(live, change["kind"]).get(change["name"].casefold())
    if current:
        actual = model_diff.strip_system(current["properties"])
        if _matches(actual, expected):
            return
        if seen or change["op"] != "change":
            raise BuilderConflict(f"{change['name']} already has different properties in the model. Review it in Azure.")
        # The automatic root can have API defaults and an icon. Apply only the approved root properties.
        expected = {**actual, **expected}
    elif seen or change["op"] == "change":
        raise BuilderConflict(f"{change['name']} is missing from the model. Check its provisioning state in Azure.")
    health.write_resource(*reference(target), change["kind"], change["name"], expected)


async def create_model(store, health, owner, sid, task, proposal_id, changes):
    """Only the caller-resolved, stored proposal is accepted here. No request-supplied resource body is written."""
    seq, target = task["seq"], task["target"]
    for change in changes:
        root = change["kind"] == "entity" and change["name"].casefold() == target["name"].casefold()
        if change["op"] != ("change" if root else "add"):
            raise ValueError("A new model can update its automatic root and add the proposed children.")
    digest = change_digest(changes)
    lock = locks.setdefault((owner, sid, seq), asyncio.Lock())
    async with lock:
        intent = await store.claim_creation(owner, sid, seq, {
            "marker": secrets.token_hex(16), "proposalId": proposal_id, "target": target, "digest": digest, "at": utc_now(),
            "monitoringScopes": monitoring_scopes(changes),
        })
        if (intent["proposalId"], intent["target"], intent["digest"]) != (proposal_id, target, digest):
            raise BuilderConflict("This Task already has an approved model. Resume the proposal originally selected.")
        previous = await creation_status(store, owner, sid, seq)
        if previous["status"] == "created":
            return previous
        outcome = {**_outcome(intent), "steps": list(previous["steps"]), "written": list(previous["written"])}

        async def record():
            outcome["at"] = utc_now()
            await store.append_apply(owner, sid, seq, outcome)

        ref = reference(target)
        stage = "creating the model"
        try:
            principal = await asyncio.to_thread(_parent, health, target, intent["marker"], "model" in outcome["steps"])
            outcome["principalId"] = principal
            if "model" not in outcome["steps"]:
                outcome["steps"].append("model")
                await record()
            stage = "configuring the model identity"
            await asyncio.to_thread(health.ensure_builder_auth, *ref)
            if "authentication" not in outcome["steps"]:
                outcome["steps"].append("authentication")
                await record()
            stage = "reading the model"
            live = await asyncio.to_thread(health.read_model, *ref)
            for change in model_diff.apply_order(changes):
                stage = f"writing {change['kind']} {change['name']}"
                seen = change["id"] in outcome["written"]
                await asyncio.to_thread(_write_child, health, target, change, live, seen)
                if not seen:
                    outcome["written"].append(change["id"])
                    await record()
            stage = "checking the saved layout and model"
            live = await asyncio.to_thread(health.read_model, *ref)
            for change in changes:
                item = model_diff.index_of(live, change["kind"]).get(change["name"].casefold())
                if not item or not _matches(item["properties"], model_diff.strip_system(change["after"])):
                    raise ValueError(f"Azure has not returned the approved properties of {change['name']}. Check the model and retry.")
            stage = "refreshing the model catalog"
            await asyncio.to_thread(health.remember_builder_model, target)
            outcome["status"] = "created"
        except (AzureError, ValueError) as error:
            outcome["status"] = "partial"
            if isinstance(error, AzureError):
                status = getattr(error, "status_code", None)
                suffix = f" (HTTP {status})" if status else ""
                outcome["error"] = f"Azure could not finish {stage}{suffix}. Retry to resume from the saved steps."
            else:
                outcome["error"] = str(error)
            await record()
            if isinstance(error, BuilderConflict):
                raise
            return outcome
        await record()
        return outcome

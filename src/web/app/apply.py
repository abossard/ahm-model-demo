import asyncio
import logging

from azure.core.exceptions import AzureError, HttpResponseError

import model_diff
from activity import safe_message
from sessions_store import StoreUnavailable, utc_now


logger = logging.getLogger("ahm-demo")

FAILURE_CODES = {400: "change_rejected", 403: "forbidden", 404: "not_found", 409: "conflict"}
locks = {}


class BaseChanged(Exception):
    pass


def reference(target):
    return target["subscriptionId"], target["resourceGroup"], target["name"]


def failure_for(change, error):
    status = getattr(error, "status_code", None)
    code = FAILURE_CODES.get(status, "unavailable" if status and status >= 429 else "azure_error")
    detail = getattr(getattr(error, "error", None), "code", None) or (
        f"HTTP {status}" if status else type(error).__name__
    )
    return {
        "changeId": change["id"],
        "code": code,
        "message": safe_message(
            f"Azure did not accept the {change['op']} of {change['kind']} "
            f"{change['name']} ({detail})."
        ),
    }


def unexpected_failure(change):
    return {
        "changeId": change["id"],
        "code": "internal_error",
        "message": safe_message(
            f"The {change['op']} of {change['kind']} {change['name']} failed unexpectedly."
        ),
    }


def interrupted_failure(change):
    return {
        "changeId": change["id"],
        "code": "interrupted",
        "message": safe_message(
            f"The apply was interrupted at the {change['op']} of {change['kind']} "
            f"{change['name']}; whether it was written is unknown."
        ),
    }


def write_change(health, target, change, live_entities):
    if change["op"] == "remove":
        try:
            health.delete_resource(*reference(target), change["kind"], change["name"])
        except HttpResponseError as error:
            if getattr(error, "status_code", None) != 404:
                raise
        return
    health.write_resource(
        *reference(target),
        change["kind"],
        change["name"],
        model_diff.strip_system(
            model_diff.carry_unseen(change, live_entities.get(model_diff.key(change["name"])))
        ),
    )


async def write_all(health, target, ordered, written, live_entities):
    for change in ordered:
        try:
            await asyncio.to_thread(write_change, health, target, change, live_entities)
        except AzureError as error:
            logger.warning(
                "apply stopped change=%s status=%s error_type=%s",
                change["id"],
                getattr(error, "status_code", None),
                type(error).__name__,
            )
            return failure_for(change, error)
        except Exception as error:
            logger.error(
                "apply failed unexpectedly change=%s error_type=%s",
                change["id"],
                type(error).__name__,
                exc_info=error,
            )
            return unexpected_failure(change)
        written.append(change["id"])
    return None


async def apply_changes(store, health, owner, sid, task, change_ids):
    target = task["target"]
    lock = locks.setdefault(tuple(part.casefold() for part in reference(target)), asyncio.Lock())
    async with lock:
        live = await asyncio.to_thread(health.read_model, *reference(target))
        if model_diff.fingerprint(live) != task["base"]["fingerprint"]:
            raise BaseChanged()
        base = await store.load_base(owner, sid, task["seq"])
        changes = task["result"]["changes"]
        expanded = model_diff.expand_selection(changes, change_ids, base)
        ordered = model_diff.apply_order([c for c in changes if c["id"] in expanded])
        written, failed = [], None
        try:
            failed = await write_all(
                health, target, ordered, written, model_diff.index_of(live, "entity")
            )
        finally:
            if failed is None and len(written) < len(ordered):
                failed = interrupted_failure(ordered[len(written)])
            outcome = {
                "at": utc_now(),
                "changeIds": list(change_ids),
                "expanded": [change["id"] for change in ordered],
                "outcome": "applied" if failed is None else "partial",
                "written": written,
                "failed": failed,
            }
            try:
                await store.append_apply(owner, sid, task["seq"], outcome)
            except StoreUnavailable:
                logger.error("apply outcome could not be recorded written=%s", len(written))
        return outcome

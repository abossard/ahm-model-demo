"""An Azure call stays inside what the Task is about: its subscription, its resource groups and its health model.

Every Azure read runs with the permissions of the signed-in user, who can read far more than a Task needs. The checks here
use only what a call states: a workspace named without a resource group is looked up by the server, which this cannot see."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from grounding import listing
from webchecks import strings

RESOURCE_ID = re.compile(r"/subscriptions/(?P<subscription>[^/]+)(?:/resourcegroups/(?P<group>[^/]+))?", re.IGNORECASE)
SHOWN = 90


def text_of(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def used_groups(entities: Mapping[str, Any], subscription: str) -> frozenset[str]:
    """The resource groups of the resources the model's own entities use (in the target's subscription), in lower case: reading
    the resources a model monitors belongs to explaining and reviewing it, wherever they are."""
    found = set()
    for text in strings(list(entities.values())):
        for match in RESOURCE_ID.finditer(text):
            if match["group"] and match["subscription"].casefold() == subscription.casefold():
                found.add(match["group"].casefold())
    return frozenset(found)


def scope_refusal(arguments: Mapping[str, Any], *, subscription: str, groups: frozenset[str], model: str) -> str | None:
    """Why a call is refused, or None when it stays in scope. `arguments` are the call's own, names without separators and in
    lower case (`resource-group` is `resourcegroup`); `groups` and `model` are in lower case."""
    named = text_of(arguments.get("subscription"))
    if named and named.casefold() != subscription.casefold():
        return f"This Task works in subscription {subscription}, not {named}. Call again with that `subscription`."
    group = text_of(arguments.get("resourcegroup"))
    if group and group.casefold() not in groups:
        return f"This Task reads the resource group {listing(sorted(groups))}, not {group}."
    wanted = text_of(arguments.get("healthmodel"))
    if wanted and model and wanted.casefold() != model:
        return f"This Task is about the health model {model}, not {wanted}."
    for value in arguments.values():
        text = text_of(value)
        found = RESOURCE_ID.match(text)
        if found and (found["subscription"].casefold() != subscription.casefold() or (found["group"] or "").casefold() not in groups):
            shown = text if len(text) <= SHOWN else f"{text[:SHOWN]}..."
            return f"The resource {shown} is outside this Task's subscription and resource groups."
    return None

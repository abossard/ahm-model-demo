"""Answers are written for the person who runs the application, not for an Azure Monitor expert."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from grounding import listing

if TYPE_CHECKING:
    from tools import RunRecord

SUMMARY_CHARS = 360
GUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
RESOURCE_ID = re.compile(r"/subscriptions/", re.IGNORECASE)
JARGON = re.compile(
    r"\b(?:rollup|roll-up|worst-?of|best-?of|min-?healthy|max-?not-?healthy|resourcehealth|signalgroups?|evaluationrules?|"
    r"healthobjective|aggregationtype|(?:un)?healthyrule|degradedrule|azureresource|azureloganalytics)\b",
    re.IGNORECASE,
)
HOW = (
    "Write it for the person who runs the application: one plain sentence of at most 30 words that answers the question, "
    "then at most one sentence of evidence, with display names and without ids or technical terms"
)


def ids_named(text: str, record: RunRecord) -> list[str]:
    """Entities the text calls by their id (`container-app`) instead of their display name."""
    lowered = text.lower()
    return [
        name
        for name in record.entities
        if "-" in name and len(name) >= 5 and re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", lowered)
    ]


def summary_faults(summary: str, record: RunRecord) -> list[str]:
    faults = []
    if len(summary) > SUMMARY_CHARS:
        faults.append(f"it is {len(summary)} characters long, at most {SUMMARY_CHARS}")
    if GUID.search(summary):
        faults.append("it holds a GUID")
    if RESOURCE_ID.search(summary):
        faults.append("it holds a resource id")
    if terms := sorted({term.lower() for term in JARGON.findall(summary)}):
        faults.append(f"it uses technical terms ({', '.join(terms)})")
    if named := ids_named(summary, record):
        faults.append(f"it names entities by id ({listing(named, 3)})")
    return faults


def plain_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """The summary is short and plain; no text of the result holds a GUID or a resource id, which belong in the fields for them."""
    problems = []
    if faults := summary_faults(result["summary"], record):
        problems.append(f"summary: {'; '.join(faults)}. {HOW}")
    texts = (
        [(f"causes[{index}].note", cause["note"]) for index, cause in enumerate(result["causes"])]
        if result["kind"] == "explain"
        else [(f"findings[{index}].text", finding["text"]) for index, finding in enumerate(result["findings"])]
    )
    holding = [where for where, text in texts if GUID.search(text) or RESOURCE_ID.search(text)]
    if holding:
        problems.append(f"{listing(holding)}: holds a GUID or a resource id. Say it in plain words: ids belong in `entity`, `signal` and the changes")
    return problems

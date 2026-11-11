"""A result that keeps being rejected still has to end the Task, with an honest account of what was left out.

`decision_lines` turns a repeated rejection into a decision the model can follow. `reduce_result` is what the agent
submits for the model when it does not: the parts that pass every check, the rest as findings that quote the problem."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from grounding import INFERRED_SENTENCE, listing

ATTRIBUTION = re.compile(r"\b(changes|verification)\[(\d+)\]")
RESOURCE_ID = re.compile(r"/subscriptions/[^\s'\"]+")
LOCATOR = re.compile(r"^(?:changes|verification|findings)\[\d+\](?:\.[\w.\[\]-]+)?:?\s*")
SENTENCE_END = re.compile(r"[;.](?:\s|$)")
QUOTE_CHARS = 300
LEAD_CHARS = 160
SUMMARY_CHARS = 360
REPEATED_REJECTION = "Same problems as your previous submit: this payload will be rejected again, however often it is sent."


def attributed(problems: Sequence[str]) -> tuple[dict[int, list[str]], dict[int, list[str]], list[str]]:
    """The problems by the change or the verification row they name, and the ones that name neither."""
    changes: dict[int, list[str]] = {}
    rows: dict[int, list[str]] = {}
    loose: list[str] = []
    for problem in problems:
        found = set(ATTRIBUTION.findall(problem))
        for kind, index in sorted(found):
            (changes if kind == "changes" else rows).setdefault(int(index), []).append(problem)
        if not found:
            loose.append(problem)
    return changes, rows, loose


def quote(problem: str, limit: int = QUOTE_CHARS) -> str:
    """The problem as a finding quotes it: a resource id is its name, and the text is cut at `limit`."""
    text = RESOURCE_ID.sub(lambda found: found.group(0).rsplit("/", 1)[-1], problem)
    return text if len(text) <= limit else f"{text[: limit - 3]}..."


def plain(problem: str, limit: int = QUOTE_CHARS) -> str:
    """The problem as a finding states it: without where it sits in the result and without what the model is told to do."""
    text = LOCATOR.sub("", quote(problem, 10_000))
    end = SENTENCE_END.search(text)
    return quote((text[: end.start()] if end else text) or problem, limit)


def changes_of(result: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    changes = result.get("changes") if isinstance(result, Mapping) else None
    return [change for change in changes if isinstance(change, Mapping)] if isinstance(changes, list) else []


def describe(change: Mapping[str, Any]) -> str:
    return f"{change.get('id')} ({change.get('op')} {change.get('kind')} {change.get('name')!r})"


def decision_lines(result: Mapping[str, Any], problems: Sequence[str], *, left: int) -> list[str]:
    """The answer to a rejection that repeats: not the list again, but what to do, with the fallback that is always valid.
    `left` is how many more unchanged submits are allowed before the agent submits a reduced result itself."""
    by_change, by_row, loose = attributed(problems)
    named = [describe(change) for index, change in enumerate(changes_of(result)) if index in by_change]
    lines = [REPEATED_REJECTION]
    if named:
        lines.append(
            f"The problems sit in {listing(named)}. Take each out of `changes` and put it in `findings` (`changeIds` `[]`) "
            "with the problem quoted; an existing entity that breaks the rules is not added again or changed: `remove` it "
            "and every relationship that names it, and give a replacement another name."
        )
    if by_row:
        lines.append(f"Take out verification row(s) {', '.join(str(index) for index in sorted(by_row))}: their signal is not proposed.")
    if loose:
        lines.append("Also: " + " | ".join(quote(problem, LEAD_CHARS) for problem in loose[:3]))
    lines.append(
        "Always valid: the diff without those changes, or, when the model already covers the workload, `changes` `[]` "
        "with a `summary` that says so."
    )
    lines.append(
        f"{left} more unchanged submit(s) and the agent submits a reduced result for you: the changes that pass every "
        "check, the rest as findings."
    )
    return lines


def reduction_notice(result: Mapping[str, Any], reduced: Mapping[str, Any]) -> list[str]:
    """The answer to the rejection after which the agent takes over."""
    kept = {change.get("id") for change in changes_of(reduced)}
    left_out = [str(change.get("id")) for change in changes_of(result) if change.get("id") not in kept]
    lines = ["Rejected again: the agent now submits a reduced result for you. Do not submit again."]
    if left_out:
        lines.append(f"Left out, with the problem quoted in `findings`: {listing(left_out)}.")
    return lines


def dropped_finding(change: Mapping[str, Any], problem: str) -> dict[str, Any]:
    entity = change.get("name") if change.get("kind") == "entity" else None
    text = f"Not proposed ({change.get('op')} {change.get('kind')} '{change.get('name')}'): {plain(problem)}"
    return {"severity": "medium", "entity": entity, "text": text, "changeIds": []}


def partial_summary(why: str, left_out: int, summary: str, ending: str = "") -> str:
    """The lead, then the model's summary cut to what is left of SUMMARY_CHARS, then `ending` whole."""
    lead = f"Partial result: {why}, so only what passes every check is kept"
    lead += f"; the {left_out} change(s) left out are quoted in the findings." if left_out else "."
    room = SUMMARY_CHARS - len(lead) - 1 - (len(ending) + 1 if ending else 0)
    return " ".join(part for part in (lead, quote(summary, max(0, room)), ending) if part)


def empty_diff(problems: Sequence[str], dropped: Sequence[dict[str, Any]], why: str) -> dict[str, Any]:
    """Nothing can be kept: an empty diff that says why."""
    findings = [*dropped] + [
        {"severity": "high", "entity": None, "text": f"Not accepted: {plain(problem)}", "changeIds": []} for problem in problems[:3]
    ]
    if not findings:
        findings = [{"severity": "high", "entity": None, "text": f"The Task ended early: {why}.", "changeIds": []}]
        summary = f"Partial result: {why}, so nothing is proposed."
    else:
        summary = f"Partial result: {why}, and nothing in the proposal passes every check, so nothing is proposed."
    return {"kind": "diff", "summary": summary, "changes": [], "verification": [], "findings": findings}


def empty_explanation(entity: str, problems: Sequence[str], why: str, state: str = "Unknown") -> dict[str, Any]:
    """The state the run read for the entity, no causes, and why: an explanation that could not be completed."""
    summary = f"Partial result: {why}, so no explanation could be completed" + (f" ({plain(problems[0], 200)})" if problems else ".")
    return {"kind": "explain", "entity": entity, "state": state, "summary": quote(summary, SUMMARY_CHARS), "causes": []}


def reduce_result(
    result: Mapping[str, Any],
    problems_of: Callable[[dict[str, Any]], list[str]],
    *,
    kind: str,
    asked: str,
    why: str,
    state: str = "Unknown",
) -> dict[str, Any]:
    """The result with the changes and verification rows that carry problems taken out, until it passes `problems_of`.
    Each change taken out becomes a finding that quotes its problem. What cannot be repaired by taking parts out leaves an
    empty result that says so; an explanation has no part to take out: it keeps the `state` the run read."""
    problems = problems_of(dict(result)) if isinstance(result, Mapping) and result else []
    entity = result.get("entity") if isinstance(result, Mapping) and isinstance(result.get("entity"), str) else None
    if kind == "explain":
        return empty_explanation(entity if entity and entity.lower() == asked else asked or entity or "unknown", problems, why, state)
    changes, rows, findings = (result.get(name) if isinstance(result, Mapping) else None for name in ("changes", "verification", "findings"))
    if not (isinstance(changes, list) and isinstance(rows, list) and isinstance(findings, list)) or not all(isinstance(c, Mapping) for c in changes):
        return empty_diff(problems, [], why)
    kept, kept_rows = list(enumerate(changes)), list(enumerate(rows))
    dropped: list[tuple[Mapping[str, Any], str]] = []
    summary = result.get("summary") if isinstance(result.get("summary"), str) else ""
    inferred = False
    for _ in range(len(changes) + len(rows) + 3):
        ids = {change["id"] for _, change in kept if isinstance(change.get("id"), str)}
        candidate = {
            "kind": "diff",
            "summary": partial_summary(why, len(dropped), summary, INFERRED_SENTENCE if inferred else ""),
            "changes": [change for _, change in kept],
            "verification": [row for _, row in kept_rows],
            "findings": [
                {**finding, "changeIds": [id_ for id_ in finding.get("changeIds") or [] if id_ in ids]} if isinstance(finding, dict) else finding
                for finding in findings
            ]
            + [dropped_finding(change, problem) for change, problem in dropped],
        }
        found = problems_of(candidate)
        if not found:
            return candidate
        by_change, by_row, loose = attributed(found)
        out_changes = {index for index in by_change if index < len(kept)}
        out_rows = {index for index in by_row if index < len(kept_rows)}
        if out_changes or out_rows:
            dropped += [(kept[index][1], by_change[index][0]) for index in sorted(out_changes)]
            kept = [item for index, item in enumerate(kept) if index not in out_changes]
            kept_rows = [item for index, item in enumerate(kept_rows) if index not in out_rows]
            continue
        if any(problem.startswith("summary:") for problem in loose) and not inferred:
            inferred = True
            continue
        problems = found
        break
    return empty_diff(problems, [dropped_finding(change, problem) for change, problem in dropped], why)

"""What ties a result to this workload: names, resources and queries must come from what the run saw.

The skill templates teach structure with a fictional storefront, and a model copies what it was shown. So a result may
not reuse the examples' words unless this workload has them, every added resource entity points at a resource the run
listed, every flow or component has a resource below it and names its evidence, and a new signal is proposed only when
its exact query ran. Everything here is a calculation over a result and what the run recorded."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from paths import SKILLS_DIR

if TYPE_CHECKING:
    from tools import RunRecord

LOG_SIGNAL = "LogAnalyticsQuery"
METRIC_SIGNAL = "AzureResourceMetric"
KEBAB = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
INFERRED = re.compile(r"inferred from (?:the )?infrastructure", re.IGNORECASE)
INFERRED_SENTENCE = "Flows are inferred from infrastructure only."
SHOWN = 6

STOPWORDS = frozenset("a an and as at by for from in is of on or the to with".split())


def stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


# Words of the examples that name infrastructure or ordinary activity rather than the fictional storefront: blocking
# them would reject ordinary designs.
GENERIC_WORDS = frozenset(
    stem(word)
    for word in (
        "5xx api app assigned azure browse browsing cache complete cpu database definition error failed health http "
        "illustrative load model optional percent processing redis request root server service shared sql system usage web"
    ).split()
)


def words_of(text: str) -> list[str]:
    """The words of a name or sentence: lower case, split at camelCase, without small words, plural as singular."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    return [stem(word) for word in re.findall(r"[a-z0-9]+", spaced.lower()) if word not in STOPWORDS]


def letters(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


BICEP_LABEL = re.compile(r"\b(?:name|displayName):\s*'([^'\n]*)'")
MERMAID_LABEL = re.compile(r'\["([^"\]]+)"\]')


def template_labels(text: str) -> list[str]:
    """The names a template shows: `name` and `displayName` values of a Bicep file, the node labels of a diagram."""
    labels = [re.sub(r"\$\{[^}]*\}?", "", label) for label in BICEP_LABEL.findall(text)]
    labels += [re.sub(r"^[A-Z][A-Z0-9_]*:\s*", "", label.split("<br/>")[0]) for label in MERMAID_LABEL.findall(text)]
    return [label for label in labels if re.search(r"[A-Za-z]", label)]


def example_words(texts: Iterable[str]) -> dict[str, str]:
    """The words the templates' example names are made of, each with the first label that has it."""
    examples: dict[str, str] = {}
    for text in texts:
        for label in template_labels(text):
            for word in words_of(label):
                if word not in GENERIC_WORDS and len(word) > 3 and not word.isdigit():
                    examples.setdefault(word, label)
    return examples


def load_templates(skills_dir: Path) -> list[str]:
    return [path.read_text(encoding="utf-8") for path in sorted(skills_dir.glob("*/templates/*")) if path.is_file()]


EXAMPLE_WORDS = example_words(load_templates(SKILLS_DIR))
if not EXAMPLE_WORDS:
    raise RuntimeError(f"no skill templates found under {SKILLS_DIR}: the example names cannot be told from this workload's")


@dataclass(frozen=True)
class MetricRun:
    """A metrics query that returned: the resource, the metrics, the namespace and the aggregation it asked for."""

    resource: str
    names: frozenset[str]
    namespace: str
    aggregation: str


@dataclass(frozen=True)
class RepoScan:
    """What the repositories cloned into the Task folder hold: their words and their file paths."""

    cloned: bool = False
    words: frozenset[str] = frozenset()
    paths: frozenset[str] = frozenset()


TEXT_SUFFIXES = frozenset(
    ".md .txt .rst .py .js .mjs .cjs .ts .tsx .jsx .json .yaml .yml .toml .bicep .tf .cs .csproj .java .go .rb .php "
    ".sh .html .css .sql .ini .cfg .xml .gradle .properties .env .dockerfile".split()
)
SKIPPED_DIRECTORIES = frozenset(".git node_modules .venv venv vendor dist build target bin obj __pycache__".split())
MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES = 4000, 200_000, 6_000_000


def repository_roots(folder: Path) -> list[Path]:
    """The cloned repositories: the Task folder itself or a folder up to two levels below it that has a `.git`."""
    found = [folder] if (folder / ".git").exists() else []
    return found + sorted(path.parent for pattern in ("*/.git", "*/*/.git") for path in folder.glob(pattern))


def scan_signature(folder: Path) -> tuple[tuple[str, int], ...]:
    """Changes when a repository appears in the Task folder or a clone updates its `.git`."""
    signature = []
    for root in repository_roots(folder):
        try:
            signature.append((str(root), (root / ".git").stat().st_mtime_ns))
        except OSError:
            continue
    return tuple(signature)


def scan_repository(folder: Path) -> RepoScan:
    roots = repository_roots(folder)
    words: set[str] = set()
    paths: set[str] = set()
    files = total = 0
    for root in roots:
        for directory, names, filenames in os.walk(root):
            names[:] = [name for name in names if name not in SKIPPED_DIRECTORIES]
            for filename in filenames:
                path = Path(directory, filename)
                relative = path.relative_to(root).as_posix().lower()
                paths |= {relative, filename.lower()}
                words |= set(words_of(relative))
                if files >= MAX_FILES or total >= MAX_TOTAL_BYTES or path.is_symlink():
                    continue
                if path.suffix.lower() not in TEXT_SUFFIXES and filename not in ("Dockerfile", "Makefile"):
                    continue
                try:
                    content = path.read_bytes()[:MAX_FILE_BYTES]
                except OSError:
                    continue
                files, total = files + 1, total + len(content)
                words |= set(words_of(content.decode("utf-8", errors="ignore")))
    return RepoScan(bool(roots), frozenset(words), frozenset(paths))


def signal_groups(after: Mapping[str, Any] | None) -> dict[str, Mapping[str, Any]]:
    groups = (after or {}).get("signalGroups")
    return {key: group for key, group in groups.items() if isinstance(group, Mapping)} if isinstance(groups, Mapping) else {}


def resource_of(after: Mapping[str, Any] | None) -> str:
    """The Azure resource an entity is bound to, or empty."""
    return str(signal_groups(after).get("azureResource", {}).get("azureResourceId") or "")


def workspace_of(after: Mapping[str, Any] | None) -> str:
    return str(signal_groups(after).get("azureLogAnalytics", {}).get("logAnalyticsWorkspaceResourceId") or "")


def signals_of(after: Mapping[str, Any] | None) -> list[Mapping[str, Any]]:
    signals = (signal for group in signal_groups(after).values() for signal in group.get("signals") or [])
    return [signal for signal in signals if isinstance(signal, Mapping)]


def squash(query: str) -> str:
    """A query without its line breaks and indentation, which the service and the model write differently."""
    return re.sub(r"\s+", " ", query).strip().rstrip(";").strip()


def listing(names: Iterable[str], limit: int = SHOWN) -> str:
    names = list(dict.fromkeys(names))
    return ", ".join(names[:limit]) + (f" and {len(names) - limit} more" if len(names) > limit else "")


def entity_changes(result: Mapping[str, Any], *ops: str) -> Iterator[tuple[int, Mapping[str, Any]]]:
    for index, change in enumerate(result["changes"]):
        if change["kind"] == "entity" and change["op"] in ops:
            yield index, change


def removed_names(result: Mapping[str, Any], kind: str) -> set[str]:
    """The names, in lower case, of the resources of this kind that the result removes."""
    return {change["name"].lower() for change in result["changes"] if change["kind"] == kind and change["op"] == "remove"}


def added_names(result: Mapping[str, Any]) -> list[tuple[int, str]]:
    """The names of the added entities that are flows or components: not bound to a resource themselves."""
    return [(index, change["name"]) for index, change in entity_changes(result, "add") if not resource_of(change["after"])]


def known_resources(record: RunRecord) -> set[str]:
    """The ids of the resources the run saw: the listed ones and the ones the model's entities already use."""
    known = set(record.listed)
    for properties in record.entities.values():
        known |= {resource_of(properties).lower(), workspace_of(properties).lower()} - {""}
    return known


def proposed_edges(result: Mapping[str, Any], record: RunRecord) -> dict[str, tuple[str, str]]:
    """The relationships once the result is applied: name to (parent, child), in lower case."""
    edges = dict(record.edges)
    for change in result["changes"]:
        key = change["name"].lower()
        if change["kind"] == "relationship" and change["op"] == "remove":
            edges.pop(key, None)
        elif change["kind"] == "relationship":
            after = change["after"]
            edges[key] = (str(after.get("parentEntityName", "")).lower(), str(after.get("childEntityName", "")).lower())
    return edges


def proposed_graph(result: Mapping[str, Any], record: RunRecord) -> tuple[dict[str, bool], dict[str, set[str]]]:
    """Once the result is applied: which entities are resource entities, and the children of each entity."""
    resource = {name: bool(resource_of(properties)) for name, properties in record.entities.items()}
    for change in result["changes"]:
        key = change["name"].lower()
        if change["kind"] == "entity" and change["op"] == "remove":
            resource.pop(key, None)
        elif change["kind"] == "entity":
            resource[key] = bool(resource_of(change["after"]))
    children: dict[str, set[str]] = {}
    for parent, child in proposed_edges(result, record).values():
        children.setdefault(parent, set()).add(child)
    return resource, children


def resource_below(name: str, resource: Mapping[str, bool], children: Mapping[str, set[str]]) -> bool:
    seen: set[str] = set()
    pending = list(children.get(name, ()))
    while pending:
        node = pending.pop()
        if node in seen:
            continue
        seen.add(node)
        if resource.get(node):
            return True
        pending += children.get(node, ())
    return False


def kebab_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """New names are lower-case kebab-case like the model's own entities, and no other spelling of one that exists."""
    bad, repeats = [], []
    removed = removed_names(result, "entity")
    for index, change in enumerate(result["changes"]):
        name, after = change["name"], change["after"] or {}
        if change["op"] == "add":
            derived = letters(name) == letters(f"{after.get('parentEntityName', '')}-{after.get('childEntityName', '')}")
            if not KEBAB.fullmatch(name) and not (change["kind"] == "relationship" and derived):
                bad.append(f"changes[{index}] {name!r}")
            twin = next(
                (known for known in record.entities if known != name.lower() and known not in removed and letters(known) == letters(name)), None
            )
            if change["kind"] == "entity" and twin:
                repeats.append(f"changes[{index}] {name!r} repeats the existing entity {twin!r}")
        if change["kind"] == "entity":
            bad += [f"changes[{index}] signal {signal.get('name')!r}" for signal in new_signals(change, record) if not KEBAB.fullmatch(str(signal.get("name")))]
    problems = []
    if bad:
        problems.append(
            "names must be lower-case kebab-case like the model's own entities (letters a-z, digits, single hyphens; "
            f"`displayName` is free text): {listing(bad)}"
        )
    if repeats:
        problems.append(f"{listing(repeats)} under another spelling: use `change` on the existing entity or leave it out")
    return problems


def named_texts(change: Mapping[str, Any], record: RunRecord) -> Iterator[tuple[str, str]]:
    """The names a change gives: the `name` of an added resource, a `displayName` it sets or changes, and the name and
    `displayName` of each signal it brings. What an existing entity already has is not new."""
    after = change["after"] or {}
    if change["op"] == "add":
        yield "name", change["name"]
    held = (record.entities.get(change["name"].lower()) or {}) if change["kind"] == "entity" and change["op"] == "change" else {}
    if after.get("displayName") and after["displayName"] != held.get("displayName"):
        yield "displayName", str(after["displayName"])
    if change["kind"] == "entity":
        for signal in new_signals(change, record):
            yield "signal name", str(signal.get("name") or "")
            if signal.get("displayName"):
                yield "signal displayName", str(signal["displayName"])


def example_problems(result: Mapping[str, Any], record: RunRecord, repo: RepoScan) -> list[str]:
    """No new name from the templates' examples, unless a resource name of this workload, its instruction or its cloned
    repository has the word. The entities the model already has do not vouch for it: they may be the invention itself."""
    allowed = record.vocabulary | repo.words
    hits = []
    for index, change in enumerate(result["changes"]):
        if change["op"] == "remove" or change["kind"] == "relationship":
            continue
        for label, text in named_texts(change, record):
            reused = sorted({word for word in words_of(text) if word in EXAMPLE_WORDS and word not in allowed})
            if reused:
                hits.append(f"changes[{index}] {label} {text!r} ({', '.join(reused)} from {EXAMPLE_WORDS[reused[0]]!r})")
    if not hits:
        return []
    return [
        f"{listing(hits)}: these words come from the examples of the skill templates (a fictional storefront), not from "
        f"this workload. Name flows, components and signals from the resources the run listed ({listing(record.listed.values())}) "
        "or from files of the cloned repository; an example word is allowed only where a resource name, the instruction or "
        "the repository uses it"
    ]


def grounding_problems(result: Mapping[str, Any], record: RunRecord, repo: RepoScan) -> list[str]:
    """Resources the run listed, a resource below every flow and component, the evidence a flow rests on."""
    known = known_resources(record)
    shown = listing(record.listed.values()) or "none yet: call group_resource_list for the workload's resource group"
    unlisted = [
        f"changes[{index}] {change['name']!r} {label} {rid}"
        for index, change in entity_changes(result, "add", "change")
        for label, rid in (
            ("azureResourceId", resource_of(change["after"])),
            ("logAnalyticsWorkspaceResourceId", workspace_of(change["after"])),
        )
        if rid and rid.lower() not in known
    ]
    resource, children = proposed_graph(result, record)
    flows = added_names(result)
    bare = [f"changes[{index}] {name!r}" for index, name in flows if not resource_below(name.lower(), resource, children)]
    cited = {name.lower() for name in record.listed.values() if len(name) > 3} | repo.paths
    unexplained = [
        f"changes[{index}] {name!r}"
        for index, name in flows
        if not any(evidence in result["changes"][index]["reason"].lower() for evidence in cited if len(evidence) > 3)
    ]
    problems = []
    if unlisted:
        problems.append(
            f"{listing(unlisted)}: no group_resource_list call of this Task returned that resource. Entities point at a "
            f"resource exactly as it was listed (listed: {shown})"
        )
    if bare:
        problems.append(
            f"{listing(bare)}: a flow or component needs at least one resource entity below it. Add an entity bound to a "
            f"listed resource (listed: {shown}) and a relationship from the flow or component down to it, or leave it out"
        )
    if unexplained:
        problems.append(
            f"{listing(unexplained)}: the `reason` names no evidence. Say which listed resource (by its name) or which "
            "file of the cloned repository the flow or component rests on"
        )
    return problems + repository_problems(result, record, repo)


def repository_problems(result: Mapping[str, Any], record: RunRecord, repo: RepoScan) -> list[str]:
    """Flows come from the repository when the workload names one; without one the summary says they are inferred."""
    if repo.cloned:
        return []
    if record.repository and record.design and not record.clone_attempted:
        return [
            f"workload.repositoryUrl is {record.repository} but no repository was cloned in this Task: call `clone_repository` "
            "with it, read its code and infrastructure files with run_shell, and derive the user flows from them"
        ]
    flows = [change["name"] for _, change in entity_changes(result, "add") if (change["after"].get("icon") or {}).get("iconName") == "UserFlow"]
    if flows and not INFERRED.search(result["summary"]):
        return [
            "summary: no repository was read in this Task, so the user flows are inferred from the resources alone: derive them "
            f"from what the listed resources are, name them from those resources, and say so in the summary, for example "
            f"\"{INFERRED_SENTENCE}\""
        ]
    return []


def new_signals(change: Mapping[str, Any], record: RunRecord) -> list[Mapping[str, Any]]:
    """The signals of an added or changed entity that the model does not have yet, or has with another query or metric."""
    after = change["after"] or {}
    if change["kind"] == "signalDefinition":
        return [after] if change["op"] != "remove" else []
    if change["kind"] != "entity" or change["op"] == "remove":
        return []
    current = signals_of(record.entities.get(change["name"].lower())) if change["op"] == "change" else []
    held = {str(signal.get("name")): fingerprint(signal) for signal in current}
    return [signal for signal in signals_of(after) if held.get(str(signal.get("name"))) != fingerprint(signal)]


def fingerprint(signal: Mapping[str, Any]) -> tuple[Any, ...]:
    keys = ("signalKind", "metricNamespace", "metricName", "aggregationType", "valueColumnName", "signalDefinitionName")
    return (*(signal.get(key) for key in keys), squash(str(signal.get("queryText") or "")))


def signal_label(change: Mapping[str, Any], signal: Mapping[str, Any]) -> str:
    return f"{signal.get('name') or change['name']!r} of {change['name']!r}"


def ran_metric(signal: Mapping[str, Any], resource: str, record: RunRecord) -> bool:
    """Did a metrics query of this run return this signal's metric for its resource? The call names the resource by its
    name, which may be a parent of the id the entity is bound to (a storage account for its blob service)."""
    name = str(signal.get("metricName") or "").lower()
    namespace, aggregation = str(signal.get("metricNamespace") or "").lower(), str(signal.get("aggregationType") or "").lower()
    segments = {segment.lower() for segment in resource.split("/") if segment}
    return any(
        name in run.names
        and (not segments or not run.resource or any(part in segments for part in run.resource.split("/")))
        and (not namespace or not run.namespace or run.namespace == namespace)
        and (not aggregation or not run.aggregation or run.aggregation == aggregation)
        for run in record.metric_runs
    )


def unrun_reason(change: Mapping[str, Any], signal: Mapping[str, Any], record: RunRecord) -> str:
    """Why this new signal's query does not stand on a run of this Task, or empty when it does."""
    if signal.get("signalKind") == LOG_SIGNAL and signal.get("queryText"):
        status, columns = record.log_runs.get(squash(str(signal["queryText"])), ("", frozenset()))
        column = signal.get("valueColumnName")
        if status == "ok" and column and column not in columns:
            return f"`valueColumnName` {column!r} is not a column of the row it returned (columns: {listing(sorted(columns))})"
        return {
            "ok": "",
            "error": "that exact query failed when it ran: check the table's columns first (`<Table> | getschema | project ColumnName, ColumnType`)",
            "empty": "that exact query returned no row: it must return one row with a number, also when nothing happened",
        }.get(status, "that exact query was not run in this Task")
    if signal.get("signalKind") == METRIC_SIGNAL and signal.get("metricName"):
        if ran_metric(signal, resource_of(change["after"]), record):
            return ""
        return "no monitor_metrics_query of this Task returned that metric for that resource"
    return ""


def signal_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """A new signal rests on a query that ran and returned in this Task; `failing` is for signals the model already has."""
    problems, new_keys = [], {}
    for index, change in enumerate(result["changes"]):
        for signal in new_signals(change, record):
            reason = unrun_reason(change, signal, record)
            if reason:
                problems.append(f"changes[{index}] signal {signal_label(change, signal)}: {reason}")
            keys = {str(signal.get("name") or "").lower(), str(signal.get("displayName") or "").lower()} - {""}
            for entity in {change["name"].lower(), str((change["after"] or {}).get("displayName") or "").lower()} - {""}:
                new_keys.setdefault(entity, set()).update(keys)
    problems += [
        f"verification[{index}]: signal {row['signal']!r} of {row['entity']!r} is new and its query failed: fix the query or leave "
        "the signal out. `failing` is for signals the model already has"
        for index, row in enumerate(result["verification"])
        if row["status"] == "failing" and row["signal"].lower() in new_keys.get(row["entity"].lower(), ())
    ]
    return problems


def grounded_problems(result: Mapping[str, Any], record: RunRecord, folder: Path) -> list[str]:
    """Everything that ties a diff to this workload; an explain result has no names, resources or signals to tie."""
    if result["kind"] != "diff":
        return []
    adds = any(change["op"] == "add" for change in result["changes"])
    repo = record.repository_scan(folder) if adds or record.design else RepoScan()
    return (
        kebab_problems(result, record)
        + example_problems(result, record, repo)
        + grounding_problems(result, record, repo)
        + signal_problems(result, record)
    )

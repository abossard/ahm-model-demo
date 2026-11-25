"""Refresh the documentation replay from the deployment selected in azd (read-only).

Run from the repo with .venv-health-ui/bin/python src/web/ui/onboarding/core/refresh.py.
The default output is artifacts/core-walkthrough/recording.candidate.json for editorial review.
Only the same graph and timeline reads used by the app are made. The recording contains no
ARM resource IDs, free-text annotations, report reasons, raw errors, logs or user identities.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from azure.identity import AzureCliCredential
from azure.mgmt.cloudhealth import CloudHealthMgmtClient

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "app"))
from config import CLOUDHEALTH_API_VERSION
from inventory import inventory_from, read_raw
from timeline import TimelineReader, build_structure


def output(name):
    return subprocess.check_output(["azd", "env", "get-value", name], text=True).strip()


def public_signal_name(name):
    # Azure generates this signal's resource identifier. Its display name is sufficient for the guide.
    return re.sub(r"^ResourceHealth-[0-9a-f-]{36}$", "resource-health-availability", name, flags=re.I)


def select(data, keys):
    return {key: data[key] for key in keys.split()}


def public_graph(graph):
    entities = []
    for entity in graph["entities"]:
        item = select(entity, "name displayName healthState impact parents children canvasPosition unlinked latestEvaluationAt latestTransitionAt report")
        item["discoveredBy"] = None
        item["signals"] = []
        for signal in entity["signals"]:
            row = select(signal, "name displayName kind healthState reportedAt writable")
            row["name"] = public_signal_name(row["name"])
            row["value"] = signal["value"] if isinstance(signal["value"], (float, int)) else None
            if error := signal.get("evaluationError"):
                row["evaluationError"] = error if error == "Log query returned no rows" else "Azure reported an evaluation error. Details omitted from this recording."
            item["signals"].append(row)
        entities.append(item)
    return {
        "model": {**select(graph["model"], "name location provisioningState healthState"), "id": None},
        "observedAt": graph["observedAt"],
        "entities": entities,
        "relationships": [select(edge, "name displayName parentEntityName childEntityName") for edge in graph["relationships"]],
        "reportOptions": graph["reportOptions"],
    }


def snapshot():
    subscription, group, name, design_name = map(output, (
        "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP", "HEALTH_MODEL_NAME", "HEALTH_MODEL_DESIGN_NAME",
    ))
    client = CloudHealthMgmtClient(AzureCliCredential(), subscription, api_version=CLOUDHEALTH_API_VERSION)
    resource, entities, relationships = read_raw(client, group, name)
    model = public_graph(inventory_from(resource, entities, relationships, name))
    if not any(e["name"] == name and e["displayName"] == "CORE" for e in model["entities"]):
        raise ValueError(f"{name} in {group} does not have the CORE root. Select the CORE demo environment in azd.")
    design = public_graph(inventory_from(*read_raw(client, group, design_name), design_name))
    observed = datetime.fromisoformat(model["observedAt"])
    # Capture a full day before the observed graph. Split by entity group to respect the web app's per-read budget.
    structure = build_structure(entities, relationships, name)
    reader = TimelineReader(now=lambda: observed, structure=lambda _: structure)
    selection = subscription, group, name
    caller, user = SimpleNamespace(owner="documentation"), SimpleNamespace(client=lambda _: client)
    start = observed - timedelta(days=1)
    params = {"from": start.isoformat(), "to": observed.isoformat(), "include": "structure,states,annotations,reports"}
    overview = reader.read(caller, user, selection, params)
    for group_states in overview["states"]:
        for row in group_states["transitions"]:
            # Only enumeration values intrinsic to the health model. Reasons may contain arbitrary text.
            if row["reason"] not in {"ChildEntityTransition", "SignalTransition"}:
                row["reason"] = None
    overview["annotations"] = [
        {**select(row, "entity t"), "id": None, "description": None, "details": {}} for row in overview["annotations"]
    ]
    overview["reports"] = [
        {**select(row, "entity t state"), "value": row["value"] if isinstance(row["value"], (int, float)) else None,
         "reason": None, "reportId": None} for row in overview["reports"]
    ]
    # Keep full-resolution data, including real Healthy zeroes. The website decimates when zooming out.
    series = {}
    active = [e["name"] for e in structure if e["signals"]]
    for offset in range(0, len(active), 5):
        names = active[offset:offset + 5]
        for hours in range(0, 24, 6):
            window = {"from": (start + timedelta(hours=hours)).isoformat(),
                      "to": (start + timedelta(hours=hours + 6)).isoformat(), "include": "signals"}
            batch = reader.read(caller, user, selection, window, names)
            for row in batch["series"]:
                key = row["entity"], public_signal_name(row["signal"])
                if not row["complete"] or row.get("error"):
                    raise RuntimeError(f"Incomplete history for {key} at {window['from']}: {row.get('error')}")
                samples = series.setdefault(key, {})
                for t, value, state in row["points"]:
                    samples[t] = [t, value if isinstance(value, (float, int)) else None, state]
    for entity in overview["entities"]:
        for signal in entity["signals"]:
            signal["name"] = public_signal_name(signal["name"])
    overview["series"] = [
        {"entity": entity, "signal": signal, "points": sorted(rows.values()), "complete": True,
         "earliest": min(rows, default=None)} for (entity, signal), rows in series.items()
    ]
    if overview["partial"]:
        raise RuntimeError("Azure returned an incomplete overview. Retry before replacing the saved capture.")
    return {"source": {"provider": "Microsoft.CloudHealth", "apiVersion": CLOUDHEALTH_API_VERSION,
                       "resourceGroup": group, "observedAt": model["observedAt"]},
            "model": model, "design": design, "history": overview}


def has_incident(history):
    transitions = next(row["transitions"] for row in history["states"] if row["entity"] == history["model"])
    start = next((row["t"] for row in reversed(transitions) if row["to"] == 3), None)
    if start is None:
        return False
    end = next((row["t"] for row in transitions if row["t"] > start and row["to"] != 3), None)
    if end is None:
        return False
    points = next((row["points"] for row in history["series"]
                   if row["entity"] == "container-app" and row["signal"] == "response-time"), [])
    return (any(start <= t < end and state == 3 and isinstance(value, (float, int)) for t, value, state in points)
            and any(t >= start and state == 1 for t, _, state in points))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE.parents[4] / "artifacts/core-walkthrough/recording.candidate.json",
                        help="Candidate JSON path. Defaults to artifacts/core-walkthrough/recording.candidate.json.")
    target = parser.parse_args().output.resolve()
    data = snapshot()
    incident = has_incident(data["history"])
    if target == (HERE / "data/recording.json").resolve() and not incident:
        parser.error("The captured window lacks the walkthrough’s recovered CORE incident with an unhealthy HTTP response "
                     "reading. Export to the default candidate path to inspect this observation.")
    # A failed/interrupted read or export must preserve the previous capture.
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=target.parent) as staging:
        temp = Path(staging) / "recording.json"
        temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf8")
        temp.replace(target)
    print(f"Saved {data['model']['model']['name']} to {target}. "
          f"{len(data['model']['entities'])} entities and {len(data['history']['series'])} signal series "
          f"from {data['history']['range']['from']} to {data['history']['range']['to']}. "
          f"Recovered HTTP response-time incident in this window: {incident}.")

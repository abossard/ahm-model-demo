import { useId, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FloatingEdge, type FloatingRfEdge } from "../components/FloatingEdge";
import { EntityCardHeading, EntityHealthPill, pickIcon } from "../components/EntityCardHeading";
import { arrange } from "../model/arrange";
import { edgePorts } from "../model/edgeRouting";
import { TILE } from "../model/tidy";
import { availabilityPrediction, metricObservation, metricPrediction } from "./signalPrediction";
import type { Analysis, AnalysisRow, BuilderEvidence, Preview } from "./types";

type Prediction = { state: "Healthy" | "Degraded" | "Unhealthy"; signal: string };

type Vertex = {
  name: string;
  displayName: string;
  kind: "Model root" | "User flow" | "System component" | "Azure resource" | "Health rollup";
  purpose?: string;
  impact?: string;
  resourceId?: string;
  position?: { x: number; y: number };
  prediction?: Prediction | undefined;
};
type Diagram = { entities: Vertex[]; relationships: Preview["relationships"] };

function predictions(analysis?: Analysis, evidence?: BuilderEvidence) {
  const result = new Map<string, Prediction[]>();
  const severity = { Healthy: 0, Degraded: 1, Unhealthy: 2 };
  if (!evidence) return result;
  for (const resource of evidence.resources ?? []) {
    const state = availabilityPrediction(resource.availabilityState);
    if (state) result.set(resource.id.toLowerCase(), [{ state, signal: "Azure Resource Health" }]);
  }
  for (const metric of analysis?.metrics ?? []) {
    if (!metricObservation(metric, evidence)) continue;
    const id = metric.resourceId.toLowerCase();
    const candidates: Prediction[] = [{state: metricPrediction(metric), signal: metric.metricName}, ...(result.get(id) ?? [])];
    result.set(id, candidates.sort((a, b) => severity[b.state] - severity[a.state]));
  }
  return result;
}

export function workloadDiagram(analysis: Analysis, included: AnalysisRow[], evidence: BuilderEvidence): Diagram {
  const plan = analysis.plan!;
  const verified = predictions(analysis, evidence);
  const rows = new Map(included.map(row => [row.resourceId.toLowerCase(), row]));
  const entities: Vertex[] = [];
  const relationships: Diagram["relationships"] = [];
  function add(vertex: Vertex, parent: string) {
    entities.push(vertex);
    relationships.push({ parent, child: vertex.name });
  }
  plan.flows.forEach((flow, i) => {
    const flowId = "flow-" + i;
    const parts = flow.components.map((part, j) => ({
      part, componentId: flowId + "-component-" + j,
      members: part.resourceIds.flatMap(id => rows.get(id.toLowerCase()) ?? []),
    })).filter(({ members }) => members.length);
    if (!parts.length) return;
    add({ name: flowId, displayName: flow.name, kind: "User flow", purpose: flow.objective + " " + flow.failureScenario }, "root");
    for (const { part, members, componentId } of parts) {
      add({ name: componentId, displayName: part.name, kind: "System component", purpose: part.signal }, flowId);
      for (const row of members) add({ ...row, name: row.resourceId, kind: "Azure resource",
        prediction: verified.get(row.resourceId.toLowerCase())?.[0] }, componentId);
    }
  });
  if (entities.length) entities.unshift({ name: "root", displayName: "Workload health", kind: "Model root", purpose: plan.objective });
  return { entities, relationships };
}

export function designerDiagram(preview: Preview, analysis?: Analysis, evidence?: BuilderEvidence): Diagram {
  const verified = predictions(analysis, evidence);
  const parents = new Map(preview.relationships.map(edge => [edge.child, edge.parent]));
  return {
    entities: preview.entities.map(entity => {
      const parent = parents.get(entity.name);
      const kind = entity.resourceId ? "Azure resource" : !parent ? "Model root"
        : preview.structure !== "planned" ? "Health rollup" : parents.has(parent) ? "System component" : "User flow";
      const measured = entity.resourceId ? verified.get(entity.resourceId.toLowerCase()) : undefined;
      const prediction = measured?.find(candidate => preview.diff.verification.some(row =>
        row.entity === entity.name && row.signal === candidate.signal && row.status === "verified"));
      return {...entity, kind, position: {x: entity.x, y: entity.y}, prediction};
    }),
    relationships: preview.relationships,
  };
}

const edgeTypes = { floating: FloatingEdge };
const fitOptions = { padding: 0.12, minZoom: 0.08, maxZoom: 1 };
const categories = {
  "Model root": { accent: "var(--plan-root)", icon: "root" },
  "User flow": { accent: "var(--plan-flow)", icon: "flow" },
  "System component": { accent: "var(--plan-component)", icon: "app" },
  "Health rollup": { accent: "var(--plan-component)", icon: "app" },
  "Azure resource": { accent: "var(--plan-resource)", icon: "cube" },
};
const nodeSize = (entity: Vertex) => ({width: TILE.width, height: entity.prediction ? 97 : TILE.height});

/** Uses the same layout, edge routing and React Flow canvas as the workspace. A draft has no live entity states. */
export function PlanDiagram({ diagram, title }: { diagram: Diagram; title: string }) {
  const id = useId();
  const [selection, setSelection] = useState("");
  const { entities, relationships } = diagram;
  const { positions, edges } = useMemo(() => {
    const arranged = entities.every(entity => entity.position)
      ? new Map(entities.map(entity => [entity.name, entity.position!]))
      : arrange(entities.map(entity => ({ name: entity.name, ...nodeSize(entity) })), relationships.map(edge => ({
        parentEntityName: edge.parent, childEntityName: edge.child,
      })), "tb").positions;
    const rects = new Map(entities.map(entity => [entity.name, { ...arranged.get(entity.name)!, ...nodeSize(entity) }]));
    const strokes = new Map(entities.map(entity => [entity.name, categories[entity.kind].accent]));
    const links = relationships.map(({ parent, child }) => ({ id: parent + ">" + child, from: parent, to: child }));
    const ports = edgePorts(links, rects, "tb", "with-layout");
    const edges: FloatingRfEdge[] = links.map(link => ({
      id: link.id, source: link.from, target: link.to, type: "floating", data: { ...ports.get(link.id)! },
      style: {stroke: strokes.get(link.to), strokeWidth: 2},
    }));
    return { positions: arranged, edges };
  }, [entities, relationships]);

  const active = entities.find(entity => entity.name === selection);
  const labels = new Map(entities.map(entity => [entity.name, entity.displayName]));
  const dependencies = (name: string) => relationships.filter(link => link.parent === name).map(link => labels.get(link.child));
  const nodes: Node[] = entities.map(entity => ({
    id: entity.name, position: positions.get(entity.name)!, type: "default", ...nodeSize(entity),
    data: { label: (
      <button type="button" className="plan-node nodrag nopan" data-kind={entity.kind} aria-pressed={active?.name === entity.name}
        aria-label={entity.displayName + ", " + entity.kind} title={entity.displayName}
        aria-description={entity.prediction && entity.prediction.signal + " predicted " + entity.prediction.state}
        onClick={() => setSelection(entity.name)}>
        <small className="plan-kind">{entity.kind}</small>
        <EntityCardHeading name={entity.displayName} icon={entity.resourceId
          ? pickIcon(entity.resourceId.split(/\/providers\//i).pop() ?? entity.displayName) : categories[entity.kind].icon} />
        {entity.prediction && <span className="plan-node-signal">
          <EntityHealthPill state={entity.prediction.state} predicted />
          <span>{entity.prediction.signal}</span>
        </span>}
      </button>
    ) },
  }));
  if (!nodes.length) return <p>Include a resource to preview its place in the model.</p>;
  return <figure className="diagram">
    <figcaption id={id}>{title} <small>{nodes.length} entities · {edges.length} relationships</small></figcaption>
    <div role="region" aria-labelledby={id} className="diagram-canvas">
      <ReactFlow key={nodes.map(node => node.id).join("|")} nodes={nodes} edges={edges} edgeTypes={edgeTypes}
        fitView fitViewOptions={fitOptions} minZoom={0.08} maxZoom={2} nodesDraggable={false}
        nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
        zoomOnScroll={false} preventScrolling={false} deleteKeyCode={null}>
        <Background color="var(--canvas-grid)" />
        <Controls position="top-left" orientation="horizontal" showInteractive={false} fitViewOptions={fitOptions} />
      </ReactFlow>
    </div>
    <div className="plan-node-detail" aria-live="polite">
      {active ? <>
        <strong>{active.displayName}</strong>
        {active.purpose && <p>{active.purpose}</p>}
        {active.prediction && <p>{active.prediction.signal} · <EntityHealthPill state={active.prediction.state} predicted /></p>}
        {active.resourceId && <><code>{active.resourceId}</code><p>{active.impact} impact</p></>}
        {dependencies(active.name).length > 0 && <p>Depends on {dependencies(active.name).join(", ")}.</p>}
      </> : <p>Select an entity to inspect its role and dependencies.</p>}
    </div>
    <details><summary>Read the hierarchy</summary>
      <table className="diagram-table"><thead><tr><th>Entity</th><th>Role</th><th>Depends on</th></tr></thead>
        <tbody>{entities.map(entity => <tr key={entity.name}>
          <th scope="row">{entity.displayName}</th><td>{entity.kind}</td><td>{dependencies(entity.name).join(", ") || "—"}</td>
        </tr>)}</tbody>
      </table>
    </details>
  </figure>;
}

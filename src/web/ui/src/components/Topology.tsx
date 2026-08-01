import { useMemo } from "react";
import type { JSX } from "react";
import { ReactFlow, Background, MarkerType } from "@xyflow/react";
import type { Edge, NodeTypes } from "@xyflow/react";
import type { Entity, Relationship } from "../model/types";
import { layoutGraph } from "../model/layout";
import { cardTokens } from "../model/palette";
import { useAppSelector } from "../store/store";
import { selectSelectedName } from "../store/selectors";
import { EntityNode, estimateNodeSize, type EntityRfNode } from "./EntityNode";

interface TopologyProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const nodeTypes: NodeTypes = { entity: EntityNode };

function buildEdges(
  relationships: readonly Relationship[],
  present: ReadonlySet<string>,
): Edge[] {
  const edges: Edge[] = [];
  for (const relationship of relationships) {
    if (!present.has(relationship.parentEntityName)) continue;
    if (!present.has(relationship.childEntityName)) continue;
    const label = relationship.displayName ?? "";
    edges.push({
      id: relationship.name,
      source: relationship.parentEntityName,
      target: relationship.childEntityName,
      type: "smoothstep",
      label: label || undefined,
      labelShowBg: label.length > 0,
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 9,
      labelBgStyle: { fill: cardTokens.pillFill, stroke: cardTokens.pillStroke },
      labelStyle: { fill: cardTokens.ink, fontSize: 10.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: cardTokens.pillStroke },
      style: { stroke: cardTokens.pillStroke },
    });
  }
  return edges;
}

export function Topology({ entities, relationships }: TopologyProps): JSX.Element {
  const selectedName = useAppSelector(selectSelectedName);

  const layout = useMemo(
    () => layoutGraph(entities, relationships, estimateNodeSize),
    [entities, relationships],
  );

  const nodes = useMemo<EntityRfNode[]>(() => {
    return entities.map((entity) => {
      const size = estimateNodeSize(entity);
      const position = layout.positions.get(entity.name) ?? { x: 0, y: 0 };
      return {
        id: entity.name,
        type: "entity",
        position: { x: position.x, y: position.y },
        width: size.width,
        height: size.height,
        data: { entity, selected: entity.name === selectedName },
      };
    });
  }, [entities, layout, selectedName]);

  const edges = useMemo(
    () => buildEdges(relationships, new Set(entities.map((entity) => entity.name))),
    [entities, relationships],
  );

  return (
    <div id="topology" className="topology">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}

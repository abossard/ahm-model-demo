import type { JSX } from "react";
import { Field, Select } from "@fluentui/react-components";
import { CONNECTION_POLICY_CHOICES, EDGE_STYLE_CHOICES, type ConnectionPolicy, type EdgeStyle } from "../model/edgeRouting";
import { visibleGraph } from "../model/collapse";
import { LAYOUT_CHOICES, type LayoutId } from "../model/layout";
import { actions, useStore } from "../store/store";
import { useInlineField } from "../components/inlineField";
import type { ViewControlsProps } from "./types";

/** Layout, edge style and connection points: they shape the card graph, so only it shows them. */
export function ZoomControls({ entities, relationships }: ViewControlsProps): JSX.Element {
  const inlineField = useInlineField();
  const layoutId = useStore((state) => state.layoutId);
  const edgeStyle = useStore((state) => state.edgeStyle);
  const connectionPolicy = useStore((state) => state.connectionPolicy);

  const onLayout = (next: LayoutId): void => {
    const engine = LAYOUT_CHOICES.find((item) => item.id === next);
    const { collapsed, selectedHealth, excludedEntityMode } = useStore.getState();
    const visible = visibleGraph(entities, relationships, new Set(collapsed), {
      selectedHealth: new Set(selectedHealth),
      excludedEntityMode,
    });
    actions.setLayout(next);
    actions.announce(`Layout changed to ${engine?.label ?? next}. ${visible.entities.length} nodes visible.`);
  };

  const onEdgeStyle = (next: EdgeStyle): void => {
    actions.setEdgeStyle(next);
    actions.announce(`Edge style changed to ${EDGE_STYLE_CHOICES.find((item) => item.id === next)?.label ?? next}.`);
  };

  const onConnectionPolicy = (next: ConnectionPolicy): void => {
    actions.setConnectionPolicy(next);
    actions.announce(`Connection points changed to ${CONNECTION_POLICY_CHOICES.find((item) => item.id === next)?.label ?? next}.`);
  };

  return (
    <>
      <Field label="Layout" orientation="horizontal" size="small" className={inlineField.root}>
        <Select size="small" data-testid="layout-picker" value={layoutId} onChange={(_, data) => onLayout(data.value as LayoutId)}>
          {LAYOUT_CHOICES.map((engine) => (
            <option key={engine.id} value={engine.id}>
              {engine.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Edge style" orientation="horizontal" size="small" className={inlineField.root}>
        <Select size="small" data-testid="edge-style-picker" value={edgeStyle} onChange={(_, data) => onEdgeStyle(data.value as EdgeStyle)}>
          {EDGE_STYLE_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Connection points" orientation="horizontal" size="small" className={inlineField.root}>
        <Select size="small" data-testid="connection-policy-picker" value={connectionPolicy} onChange={(_, data) => onConnectionPolicy(data.value as ConnectionPolicy)}>
          {CONNECTION_POLICY_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

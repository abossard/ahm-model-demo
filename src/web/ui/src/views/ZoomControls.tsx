import type { JSX } from "react";
import { Button, Field, Select, ToggleButton, Tooltip } from "@fluentui/react-components";
import { ArrowSortDown20Regular, ArrowSortUp20Regular } from "@fluentui/react-icons";
import { CONNECTION_POLICY_CHOICES, EDGE_STYLE_CHOICES, type ConnectionPolicy, type EdgeStyle } from "../model/edgeRouting";
import { visibleGraph } from "../model/collapse";
import { familyOf, orderKey } from "../model/customOrder";
import { LAYOUT_CHOICES, type LayoutId } from "../model/layout";
import { SORT_CHOICES, type SortKey } from "../model/ordering";
import { actions, useStore } from "../store/store";
import { useInlineField } from "../components/inlineField";
import type { ViewControlsProps } from "./types";

/** Layout, edge style, connection points and order: they shape the card graph, so only it shows them. */
export function ZoomControls({ entities, relationships }: ViewControlsProps): JSX.Element {
  const inlineField = useInlineField();
  const layoutId = useStore((state) => state.layoutId);
  const sortKey = useStore((state) => state.sortKey);
  const sortReversed = useStore((state) => state.sortReversed);
  const edgeStyle = useStore((state) => state.edgeStyle);
  const connectionPolicy = useStore((state) => state.connectionPolicy);
  const family = familyOf(layoutId);
  const key = useStore((state) => (family ? orderKey(state.selected, family) : null));
  const hasCustom = useStore((state) => key !== null && key in state.customOrders);

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
      <Field label="Order" orientation="horizontal" size="small" className={inlineField.root}>
        <Select size="small" data-testid="sort-key" value={sortKey} onChange={(_, data) => actions.setSortKey(data.value as SortKey)}>
          {SORT_CHOICES.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      <Tooltip content={sortReversed ? "Sort descending" : "Sort ascending"} relationship="label">
        <ToggleButton
          size="small"
          disabled={sortKey === "shortest" || sortKey === "custom"}
          checked={sortReversed}
          data-testid="sort-reverse"
          icon={sortReversed ? <ArrowSortDown20Regular /> : <ArrowSortUp20Regular />}
          onClick={() => actions.toggleSortDirection()}
        />
      </Tooltip>
      <Tooltip
        content={
          family === null
            ? "The live force layout has no places to keep: dragging a card pulls on it."
            : hasCustom
              ? "Forget the order you gave this layout and go back to the shortest connections."
              : "Drag a card to another place, or focus it and press M, to give this layout your own order."
        }
        relationship="description"
      >
        <Button
          size="small"
          appearance="subtle"
          data-testid="custom-order-reset"
          disabled={!hasCustom || family === null}
          onClick={() => {
            if (family === null) return;
            actions.resetCustomOrder(family);
            actions.announce("Custom order reset. The order is now Shortest connections.");
          }}
        >
          Reset custom order
        </Button>
      </Tooltip>
    </>
  );
}

import type { JSX } from "react";
import { Button, Field, Select, ToggleButton, Tooltip, makeStyles } from "@fluentui/react-components";
import { ArrowReset20Regular, ArrowSortDown20Regular, ArrowSortUp20Regular } from "@fluentui/react-icons";
import { hasOrder, orderKey } from "../model/customOrder";
import { orderChoices, orderPicked, type SortKey } from "../model/ordering";
import { actions, useStore } from "../store/store";
import { COMPACT, useInlineField, visuallyHidden } from "../components/inlineField";

// The chosen order names itself; beside the assistant panel the label gives way so the toolbar keeps one row.
const useStyles = makeStyles({
  label: { [`@container graph (max-width: ${COMPACT}px)`]: visuallyHidden },
});

/**
 * The Order of the model, in every view: the view's own order or Custom, the one the viewer gave by
 * dragging, and a way to forget it. The card graph can sort in other ways too, and turn them round.
 */
export function OrderControls(): JSX.Element {
  const styles = useStyles();
  const inlineField = useInlineField();
  const view = useStore((state) => state.view);
  const sortKey = useStore((state) => state.sortKey);
  const sortReversed = useStore((state) => state.sortReversed);
  const hasCustom = useStore((state) => {
    const key = orderKey(state.selected);
    return key !== null && hasOrder(state.customOrders[key]);
  });
  const order = orderChoices(view, sortKey);
  const own = order.choices.find((choice) => choice.key !== "custom")?.label ?? "";

  return (
    <>
      <Field label={{ children: "Order", className: styles.label }} orientation="horizontal" size="small" className={inlineField.root}>
        <Select size="small" data-testid="sort-key" value={order.value} onChange={(_, data) => actions.setSortKey(orderPicked(view, sortKey, data.value as SortKey))}>
          {order.choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      {view === "zoom" ? (
        <Tooltip content={sortReversed ? "Sort descending" : "Sort ascending"} relationship="label">
          <ToggleButton
            size="small"
            disabled={!order.reversible}
            checked={sortReversed}
            data-testid="sort-reverse"
            icon={sortReversed ? <ArrowSortDown20Regular /> : <ArrowSortUp20Regular />}
            onClick={() => actions.toggleSortDirection()}
          />
        </Tooltip>
      ) : null}
      <Tooltip
        content={
          hasCustom
            ? "Forget the order you gave this model, in every view."
            : "Drag an entity to another place, or focus it and press M, to give this model your own order. Every view shows it."
        }
        relationship="description"
      >
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowReset20Regular />}
          aria-label="Reset custom order"
          data-testid="custom-order-reset"
          disabledFocusable={!hasCustom}
          onClick={() => {
            actions.resetCustomOrder();
            actions.announce(`Custom order reset. The order is now ${own}.`);
          }}
        />
      </Tooltip>
    </>
  );
}

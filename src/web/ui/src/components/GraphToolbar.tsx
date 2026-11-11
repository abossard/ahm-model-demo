import { useId, useState } from "react";
import type { JSX } from "react";
import {
  Button,
  Checkbox,
  Field,
  Label,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Radio,
  RadioGroup,
  Select,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSortDown20Regular,
  ArrowSortUp20Regular,
  Filter20Regular,
  Search20Regular,
} from "@fluentui/react-icons";
import {
  CONNECTION_POLICY_CHOICES,
  EDGE_STYLE_CHOICES,
  type ConnectionPolicy,
  type EdgeStyle,
} from "../model/edgeRouting";
import { visibleGraph } from "../model/collapse";
import { LAYOUT_CHOICES, type LayoutId } from "../model/layout";
import { SORT_CHOICES, type SortKey } from "../model/ordering";
import { tokensFor } from "../model/palette";
import type { Entity, Relationship } from "../model/types";
import { actions, useStore } from "../store/store";
import type { ExcludedEntityMode, HealthFilterState } from "../store/uiSlice";
import { useInlineField } from "./inlineField";

const HEALTH_STATES: readonly HealthFilterState[] = ["Healthy", "Degraded", "Unhealthy", "Unknown"];

const useStyles = makeStyles({
  root: {
    flex: "0 0 auto",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // Zero basis keeps it on the last row of the controls, so a new message never changes the toolbar's height.
  status: {
    flex: "1 1 0",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  surface: { minWidth: "230px", padding: tokens.spacingHorizontalM },
  group: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalXXS,
    border: 0,
    margin: 0,
    padding: 0,
  },
  groupDivider: {
    marginTop: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  option: { display: "inline-flex", alignItems: "center", columnGap: tokens.spacingHorizontalS },
  swatch: {
    width: "10px",
    height: "10px",
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
});

function Announcement(): JSX.Element {
  const styles = useStyles();
  const announcement = useStore((state) => state.announcement);
  return (
    <span className={styles.status} data-testid="graph-announcement" role="status" aria-live="polite">
      {announcement}
    </span>
  );
}

function HealthFilter(): JSX.Element {
  const styles = useStyles();
  const selectedHealth = useStore((state) => state.selectedHealth);
  const excludedEntityMode = useStore((state) => state.excludedEntityMode);
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const stateLegendId = useId();

  const toggleHealth = (state: HealthFilterState): void => {
    actions.toggleSelectedHealth(state);
    const next = selectedHealth.includes(state)
      ? selectedHealth.filter((item) => item !== state)
      : [...selectedHealth, state];
    actions.announce(`Health filter updated: ${next.length > 0 ? next.join(", ") : "none selected"}.`);
  };

  const setMode = (mode: ExcludedEntityMode): void => {
    actions.setExcludedEntityMode(mode);
    actions.announce(
      mode === "hide" ? "Excluded health states are hidden." : "Excluded health states are gray dots.",
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(_, data) => setOpen(data.open)}
      positioning="below-end"
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          size="small"
          icon={<Filter20Regular />}
          data-testid="health-filter-toggle"
          aria-expanded={open}
          aria-controls={popupId}
        >
          Health
        </Button>
      </PopoverTrigger>
      <PopoverSurface id={popupId} className={styles.surface} data-testid="health-filter-popup">
        <div role="group" aria-labelledby={stateLegendId} className={styles.group}>
          <Label id={stateLegendId} size="small">
            Health state
          </Label>
          {HEALTH_STATES.map((state) => (
            <Checkbox
              key={state}
              checked={selectedHealth.includes(state)}
              onChange={() => toggleHealth(state)}
              label={
                <span className={styles.option}>
                  <span
                    className={styles.swatch}
                    style={{ background: tokensFor(state).dot }}
                    data-testid={`health-swatch-${state}`}
                    aria-hidden="true"
                  />
                  {tokensFor(state).word}
                </span>
              }
            />
          ))}
        </div>
        <Field label="Not selected entities" size="small" className={styles.groupDivider}>
          <RadioGroup
            value={excludedEntityMode}
            onChange={(_, data) => setMode(data.value as ExcludedEntityMode)}
          >
            <Radio value="hide" label="Hide with edges" />
            <Radio value="dot" label="Gray dot" />
          </RadioGroup>
        </Field>
      </PopoverSurface>
    </Popover>
  );
}

interface GraphToolbarProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

export function GraphToolbar({ entities, relationships }: GraphToolbarProps): JSX.Element {
  const styles = useStyles();
  const inlineField = useInlineField();
  const layoutId = useStore((state) => state.layoutId);
  const sortKey = useStore((state) => state.sortKey);
  const sortReversed = useStore((state) => state.sortReversed);
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
    actions.announce(
      `Edge style changed to ${EDGE_STYLE_CHOICES.find((item) => item.id === next)?.label ?? next}.`,
    );
  };

  const onConnectionPolicy = (next: ConnectionPolicy): void => {
    actions.setConnectionPolicy(next);
    actions.announce(
      `Connection points changed to ${
        CONNECTION_POLICY_CHOICES.find((item) => item.id === next)?.label ?? next
      }.`,
    );
  };

  return (
    <div className={styles.root} data-testid="graph-toolbar" role="group" aria-label="Graph controls">
      <Field label="Layout" orientation="horizontal" size="small" className={inlineField.root}>
        <Select
          size="small"
          data-testid="layout-picker"
          value={layoutId}
          onChange={(_, data) => onLayout(data.value as LayoutId)}
        >
          {LAYOUT_CHOICES.map((engine) => (
            <option key={engine.id} value={engine.id}>
              {engine.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Edge style" orientation="horizontal" size="small" className={inlineField.root}>
        <Select
          size="small"
          data-testid="edge-style-picker"
          value={edgeStyle}
          onChange={(_, data) => onEdgeStyle(data.value as EdgeStyle)}
        >
          {EDGE_STYLE_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Connection points" orientation="horizontal" size="small" className={inlineField.root}>
        <Select
          size="small"
          data-testid="connection-policy-picker"
          value={connectionPolicy}
          onChange={(_, data) => onConnectionPolicy(data.value as ConnectionPolicy)}
        >
          {CONNECTION_POLICY_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Order" orientation="horizontal" size="small" className={inlineField.root}>
        <Select
          size="small"
          data-testid="sort-key"
          value={sortKey}
          onChange={(_, data) => actions.setSortKey(data.value as SortKey)}
        >
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
          disabled={sortKey === "shortest"}
          checked={sortReversed}
          data-testid="sort-reverse"
          icon={sortReversed ? <ArrowSortDown20Regular /> : <ArrowSortUp20Regular />}
          onClick={() => actions.toggleSortDirection()}
        />
      </Tooltip>
      <Button
        size="small"
        icon={<Search20Regular />}
        data-testid="search-open"
        onClick={() => actions.openSearch()}
      >
        Search…
      </Button>
      <HealthFilter />
      <Announcement />
    </div>
  );
}

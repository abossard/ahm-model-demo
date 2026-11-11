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
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Filter20Regular, Search20Regular } from "@fluentui/react-icons";
import { tokensFor } from "../model/palette";
import type { Entity, Relationship } from "../model/types";
import { viewDefinition } from "../views/registry";
import { actions, useStore } from "../store/store";
import type { ExcludedEntityMode, HealthFilterState } from "../store/uiSlice";
import { ViewSwitch } from "./ViewSwitch";

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
    actions.announce(next.length > 0 ? `Showing ${next.join(", ")} entities.` : "Showing no entities. Pick a state to see them.");
  };

  const setMode = (mode: ExcludedEntityMode): void => {
    actions.setExcludedEntityMode(mode);
    actions.announce(
      mode === "hide" ? "Entities that do not match are hidden." : "Entities that do not match are shown as gray dots.",
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
          Filter by state
        </Button>
      </PopoverTrigger>
      <PopoverSurface id={popupId} className={styles.surface} data-testid="health-filter-popup">
        <div role="group" aria-labelledby={stateLegendId} className={styles.group}>
          <Label id={stateLegendId} size="small">
            Show entities that are
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
        <Field label="Entities that do not match" size="small" className={styles.groupDivider}>
          <RadioGroup
            value={excludedEntityMode}
            onChange={(_, data) => setMode(data.value as ExcludedEntityMode)}
          >
            <Radio value="hide" label="Hide with their lines" />
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
  const view = useStore((state) => state.view);
  const Controls = viewDefinition(view).Controls;

  return (
    <div className={styles.root} data-testid="graph-toolbar" role="group" aria-label="View controls">
      <ViewSwitch />
      {Controls ? <Controls entities={entities} relationships={relationships} /> : null}
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

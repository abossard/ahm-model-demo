import { useMemo } from "react";
import type { JSX } from "react";
import { Badge, Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { badgesByEntity, badgesForSide, entitiesOfChanges, unionSnapshots } from "../model/changes";
import { taskLabel } from "../model/tasks";
import type { DiffView } from "../model/types";
import { actions, useStore } from "../store/store";
import { Topology } from "./Topology";

// Each side has half the width, so a wide graph needs to zoom out further than a single graph does.
const COMPARE_MIN_ZOOM = 0.15;

const useStyles = makeStyles({
  root: { flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" },
  bar: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorBrandBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1 },
  graphs: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: "flex",
    flexDirection: "row",
    "@media (max-width: 720px)": { flexDirection: "column" },
  },
  side: {
    flex: "1 1 0",
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    ":not(:first-child)": { borderLeft: `2px solid ${tokens.colorNeutralStroke1}` },
    // Stacked on a phone, each graph keeps its own height and the page scrolls.
    "@media (max-width: 720px)": {
      flex: "0 0 auto",
      ":not(:first-child)": { borderLeft: "none", borderTop: `2px solid ${tokens.colorNeutralStroke1}` },
    },
  },
});

export function CompareView({ view }: { readonly view: DiffView }): JSX.Element {
  const styles = useStyles();
  const selected = useStore((state) => state.selectedChanges);
  const task = useStore((state) => state.task);
  const label = task.kind === "success" ? `${taskLabel(task.value.type)} #${task.value.seq}` : "the Task";

  // Both sides are arranged on everything either side draws, so an entity keeps its place across them.
  const basis = useMemo(() => unionSnapshots(view.base, view.proposed), [view]);
  const badges = useMemo(() => badgesByEntity(view.changes), [view]);
  const baseBadges = useMemo(() => badgesForSide(badges, "base"), [badges]);
  const proposedBadges = useMemo(() => badgesForSide(badges, "proposed"), [badges]);
  const marked = useMemo(() => new Set(entitiesOfChanges(view.changes, selected)), [view, selected]);
  const count = (op: "add" | "change" | "remove"): number =>
    view.changes.filter((change) => change.kind === "entity" && change.op === op).length;

  return (
    <div className={styles.root} data-testid="compare-view">
      <div className={styles.bar}>
        <Text weight="semibold" data-testid="compare-title">
          Comparing {label}: Base model and Proposed model
        </Text>
        <Badge appearance="tint" color="success" data-testid="compare-count-added">
          {count("add")} entities added
        </Badge>
        <Badge appearance="tint" color="warning" data-testid="compare-count-changed">
          {count("change")} changed
        </Badge>
        <Badge appearance="tint" color="danger" data-testid="compare-count-removed">
          {count("remove")} removed
        </Badge>
        <span className={styles.grow} />
        <Button size="small" onClick={() => actions.setCompare(false)} data-testid="compare-exit">
          Exit compare
        </Button>
      </div>
      <div className={styles.graphs}>
        <div className={styles.side}>
          <Topology
            idPrefix="graph-base"
            label="Base model"
            entities={view.base.entities}
            relationships={view.base.relationships}
            badges={baseBadges}
            marked={marked}
            minZoom={COMPARE_MIN_ZOOM}
            basis={basis}
          />
        </div>
        <div className={styles.side}>
          <Topology
            idPrefix="graph-proposed"
            label="Proposed model"
            entities={view.proposed.entities}
            relationships={view.proposed.relationships}
            badges={proposedBadges}
            marked={marked}
            minZoom={COMPARE_MIN_ZOOM}
            basis={basis}
          />
        </div>
      </div>
    </div>
  );
}

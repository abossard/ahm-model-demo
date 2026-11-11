import { useMemo } from "react";
import type { JSX } from "react";
import { Badge, Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { entitiesOfChanges } from "../model/changes";
import { compareDrawings } from "../model/compare";
import type { DiffView } from "../model/types";
import type { ViewDefinition, ViewProps } from "../views/types";
import { actions, useStore } from "../store/store";

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
  // A merged view is one drawing: it fills the area on a phone too, as it does when nothing is compared.
  whole: { "@media (max-width: 720px)": { flex: "1 1 0" } },
});

/** What the drawings of a view have in common, whichever side they are: the selection, the chain and what opens an entity. */
type Shared = Pick<ViewProps, "selectedName" | "highlightedName" | "chainNames" | "onActivate">;

interface CompareViewProps extends Shared {
  readonly view: DiffView;
  /** The selected view, which draws both sides as it says (`compareMode`). */
  readonly definition: ViewDefinition;
}

export function CompareView({ view, definition, ...shared }: CompareViewProps): JSX.Element {
  const styles = useStyles();
  const selected = useStore((state) => state.selectedChanges);

  // A split view is drawn twice, a merged one once: the data of each drawing is computed, not chosen here.
  const drawings = useMemo(() => compareDrawings(view, definition.compareMode), [view, definition.compareMode]);
  const marked = useMemo(() => new Set(entitiesOfChanges(view.changes, selected)), [view, selected]);
  const count = (op: "add" | "change" | "remove"): number =>
    view.changes.filter((change) => change.kind === "entity" && change.op === op).length;
  const View = definition.Component;

  return (
    <div className={styles.root} data-testid="compare-view" data-mode={definition.compareMode}>
      <div className={styles.bar}>
        <Text weight="semibold" data-testid="compare-title">
          Comparing the model now with the model after the changes
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
          Back to the model
        </Button>
      </div>
      <div className={styles.graphs}>
        {drawings.map((drawing) => (
          <div className={mergeClasses(styles.side, drawing.side === "merged" && styles.whole)} key={drawing.side} data-testid={`compare-side-${drawing.side}`}>
            <View
              {...shared}
              entities={drawing.entities}
              relationships={drawing.relationships}
              badges={drawing.badges}
              marked={marked}
              compare={drawing.compare}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

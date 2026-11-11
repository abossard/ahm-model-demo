import { useMemo } from "react";
import type { JSX } from "react";
import { makeStyles } from "@fluentui/react-components";
import { unionSnapshots } from "../model/changes";
import type { HealthModel } from "../model/types";
import { viewDefinition } from "../views/registry";
import { actions, useStore } from "../store/store";
import { CompareView } from "./CompareView";
import { GraphToolbar } from "./GraphToolbar";
import { Legend } from "./Legend";
import { SearchOverlay } from "./SearchOverlay";

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
});

/**
 * The graph area: the toolbar and legend, then the model drawn by the chosen view or, while
 * comparing, both sides of a diff drawn by the same view.
 */
export function GraphView({ model }: { readonly model: HealthModel }): JSX.Element {
  const styles = useStyles();
  const compare = useStore((state) => state.compare);
  const diff = useStore((state) => state.diff);
  const view = useStore((state) => state.view);
  const selectedName = useStore((state) => state.selectedName);
  const highlightedName = useStore((state) => state.highlightedName);
  const chainNames = useStore((state) => state.chainNames);
  const comparing = compare && diff.kind === "success" ? diff.value : null;
  const definition = viewDefinition(view);

  // The toolbar and search see every node either side draws, so the count and the results match the screen.
  const shown = useMemo(
    () => (comparing ? unionSnapshots(comparing.base, comparing.proposed) : model),
    [comparing, model],
  );

  return (
    <div className={styles.root}>
      <GraphToolbar entities={shown.entities} relationships={shown.relationships} />
      <Legend diff={comparing !== null} {...(definition.legendNotes ? { notes: definition.legendNotes } : {})} />
      {comparing ? (
        <CompareView
          view={comparing}
          definition={definition}
          selectedName={selectedName}
          highlightedName={highlightedName}
          chainNames={chainNames}
          onActivate={actions.activateEntity}
        />
      ) : (
        <definition.Component
          entities={model.entities}
          relationships={model.relationships}
          selectedName={selectedName}
          highlightedName={highlightedName}
          chainNames={chainNames}
          onActivate={actions.activateEntity}
        />
      )}
      <SearchOverlay entities={shown.entities} relationships={shown.relationships} />
    </div>
  );
}

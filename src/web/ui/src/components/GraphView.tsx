import { useMemo } from "react";
import type { JSX } from "react";
import { makeStyles } from "@fluentui/react-components";
import { unionSnapshots } from "../model/changes";
import type { HealthModel } from "../model/types";
import { useStore } from "../store/store";
import { CompareView } from "./CompareView";
import { GraphToolbar } from "./GraphToolbar";
import { SearchOverlay } from "./SearchOverlay";
import { Topology } from "./Topology";

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
});

/** The graph area: the toolbar, then the model on screen or, while comparing, both sides of a diff. */
export function GraphView({ model }: { readonly model: HealthModel }): JSX.Element {
  const styles = useStyles();
  const compare = useStore((state) => state.compare);
  const diff = useStore((state) => state.diff);
  const comparing = compare && diff.kind === "success" ? diff.value : null;

  // The toolbar and search see every node either side draws, so the count and the results match the screen.
  const shown = useMemo(
    () => (comparing ? unionSnapshots(comparing.base, comparing.proposed) : model),
    [comparing, model],
  );

  return (
    <div className={styles.root}>
      <GraphToolbar entities={shown.entities} relationships={shown.relationships} />
      {comparing ? (
        <CompareView view={comparing} />
      ) : (
        <Topology idPrefix="topology" entities={model.entities} relationships={model.relationships} />
      )}
      <SearchOverlay entities={shown.entities} relationships={shown.relationships} />
    </div>
  );
}

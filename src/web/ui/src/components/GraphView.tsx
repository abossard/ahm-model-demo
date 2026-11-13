import { memo, useEffect, useMemo } from "react";
import type { JSX } from "react";
import { makeStyles } from "@fluentui/react-components";
import { unionSnapshots } from "../model/changes";
import { viewDefinition } from "../views/registry";
import { actions, useStore } from "../store/store";
import { selectModelAt } from "../store/timelineSlice";
import { useAtMoment } from "../timeline/useAtMoment";
import { useSparkLoading } from "../timeline/useSparkLoading";
import { CompareView } from "./CompareView";
import { GraphToolbar } from "./GraphToolbar";
import { Legend } from "./Legend";
import { SearchOverlay } from "./SearchOverlay";

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
});

const NO_NAMES: readonly string[] = [];

/**
 * The graph area: the toolbar and legend, then the model drawn by the chosen view or, while
 * comparing, both sides of a diff drawn by the same view.
 *
 * What the views, the toolbar and the search are handed is the model at the selected moment: the
 * live model itself while none is selected, else its entities with the states and signal values of
 * then. An entity that did not change between two moments is the same object, so a view draws
 * again only what changed. It renders when that model or its own selections change, not when the
 * page around it does.
 */
export const GraphView = memo(function GraphView(): JSX.Element | null {
  const styles = useStyles();
  const model = useAtMoment(selectModelAt);
  const past = useStore((state) => state.timelinePinned !== null);
  const compare = useStore((state) => state.compare);
  const diff = useStore((state) => state.diff);
  const view = useStore((state) => state.view);
  const cardSignals = useStore((state) => state.cardSignals);
  const selectedName = useStore((state) => state.selectedName);
  const highlightedName = useStore((state) => state.highlightedName);
  const chainNames = useStore((state) => state.chainNames);
  const comparing = compare && diff.kind === "success" ? diff.value : null;
  const definition = viewDefinition(view);

  // The views show signal values on their cards: at a past moment the loader reads them for the entities that have any.
  const withSignals = useMemo(() => (model?.entities ?? []).filter((entity) => entity.signals.length > 0).map((entity) => entity.name), [model?.entities]);
  useEffect(() => {
    actions.watchEntities(past ? withSignals : NO_NAMES);
  }, [past, withSignals]);
  // With Signals on, the cards also draw a sparkline per signal: the loader reads their window, at a moment or now.
  const sparks = cardSignals && definition.cardSignals === true;
  useEffect(() => {
    actions.watchSparks(sparks ? withSignals : NO_NAMES);
  }, [sparks, withSignals]);
  useEffect(() => () => actions.watchSparks(NO_NAMES), []);
  useSparkLoading();

  // The toolbar and search see every node either side draws, so the count and the results match the screen.
  const shown = useMemo(
    () => (comparing ? unionSnapshots(comparing.base, comparing.proposed) : model),
    [comparing, model],
  );

  if (model === null || shown === null) return null;
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
});

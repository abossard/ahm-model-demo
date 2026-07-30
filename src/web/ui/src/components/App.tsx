import { useEffect } from "react";
import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import { loadHealthModel } from "../store/modelSlice";
import { selectModel, selectPanelOpen } from "../store/selectors";
import { StatusBar } from "./StatusBar";
import { Topology } from "./Topology";
import { EntityPanel } from "./EntityPanel";
import { JourneyPanel } from "./JourneyPanel";

export function App(): JSX.Element {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectModel);
  const panelOpen = useAppSelector(selectPanelOpen);

  useEffect(() => {
    void dispatch(loadHealthModel());
  }, [dispatch]);

  return (
    <div className="app-shell">
      <StatusBar />
      <div className="app-body">
        <main className="app-main">
          {model.kind === "success" ? (
            <Topology
              entities={model.value.entities}
              relationships={model.value.relationships}
            />
          ) : (
            <div id="topology" className="topology topology--empty" />
          )}
          <JourneyPanel />
        </main>
        {panelOpen && model.kind === "success" ? (
          <EntityPanel options={model.value.reportOptions} />
        ) : null}
      </div>
    </div>
  );
}

import { useEffect } from "react";
import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import { loadHealthModel } from "../store/modelSlice";
import { loadModelCatalog } from "../store/catalogSlice";
import {
  selectChatOpen,
  selectModel,
  selectPanelOpen,
  selectSelectedModel,
} from "../store/selectors";
import { searchFromSelection } from "../model/selection";
import { toggleChat } from "../store/uiSlice";
import { StatusBar } from "./StatusBar";
import { Topology } from "./Topology";
import { EntityPanel } from "./EntityPanel";
import { JourneyPanel } from "./JourneyPanel";
import { ChatPanel } from "./ChatPanel";

export function App(): JSX.Element {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectModel);
  const selected = useAppSelector(selectSelectedModel);
  const panelOpen = useAppSelector(selectPanelOpen);
  const chatOpen = useAppSelector(selectChatOpen);

  useEffect(() => {
    void dispatch(loadModelCatalog());
  }, [dispatch]);

  useEffect(() => {
    if (!selected) return;
    window.history.replaceState(null, "", searchFromSelection(selected));
    void dispatch(loadHealthModel());
  }, [dispatch, selected]);

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
        {chatOpen ? <ChatPanel /> : null}
      </div>
      <button
        type="button"
        className="chat-toggle"
        aria-pressed={chatOpen}
        onClick={() => dispatch(toggleChat())}
        data-testid="chat-toggle"
      >
        {chatOpen ? "Close copilot" : "Open copilot"}
      </button>
    </div>
  );
}

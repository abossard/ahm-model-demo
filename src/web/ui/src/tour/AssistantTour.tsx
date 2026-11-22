import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@fluentui/react-components";
import { ChevronLeft20Regular, Map20Regular } from "@fluentui/react-icons";
import { HealthModelDiagram } from "../components/HealthModelDiagram";
import { escapeIsFree } from "../components/escapeFree";
import { NextSteps } from "../showMe/NextSteps";
import { createShowMe, type ShowMeRegistry } from "../showMe";
import { actions, useStore } from "../store/store";
import { selectModelAt, selectedMoment } from "../store/timelineSlice";
import { formatUpdated } from "../model/wording";
import { useAtMoment } from "../timeline/useAtMoment";
import { workspaceShowMe } from "../store/workspaceShowMe";
import { nextStops, tourStops, type StopId, type TourStop } from "./stops";
import type { HealthModel, ModelRef } from "../model/types";
import "./tour.css";

/** The builder and History have their own entry points in the shell, outside the model graph. */
function workspaceControls() {
  return createShowMe([{
    name: "workspace", description: "Find a control in the workspace.", idDescription: "builder or history.",
    open(id) {
      if (id !== "builder" && id !== "history") return null;
      flushSync(() => {
        actions.setTimelineFullscreen(false);
        actions.setWorkspaceTarget("graph");
      });
      return document.querySelector(`[data-tour-target="${id}"]`);
    },
  }]);
}

function Tour({ model, target }: { model: HealthModel; target: ModelRef }) {
  const moment = useAtMoment(selectedMoment);
  const [stops] = useState(() => tourStops(model, useStore.getState().selectedName));
  const [route, setRoute] = useState<readonly StopId[]>(["overview"]);
  const [unavailable, setUnavailable] = useState<readonly StopId[]>([]);
  const [message, setMessage] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const active = useRef<ShowMeRegistry | null>(null);
  const here = stops.find(stop => stop.id === route.at(-1))!;
  const choices = nextStops(here, stops.filter(stop => !unavailable.includes(stop.id)));

  const visit = useCallback(async (stop: TourStop, nextRoute: readonly StopId[]) => {
    active.current?.clear();
    const moment = useStore.getState().timelinePinned;
    const registry = stop.action.handle === "workspace" ? workspaceControls() : workspaceShowMe(useStore, {
      target, ...(moment === null ? {} : { asOf: new Date(moment).toISOString() }),
    });
    active.current = registry;
    setMessage("Opening this stop…");
    const outcome = await registry.execute(stop.action);
    if (active.current !== registry) return;
    if (outcome === "shown") {
      flushSync(() => {
        setRoute(nextRoute);
        setMessage("");
      });
      title.current?.focus({ preventScroll: true });
      title.current?.scrollIntoView({ block: "nearest" });
    } else if (outcome === "unavailable") {
      setUnavailable(previous => [...new Set([...previous, stop.id])]);
      setMessage("That stop is out of reach. Pick another path below.");
    } else {
      setMessage("");
    }
  }, [target]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => { void visit(stops[0]!, ["overview"]); });
    return () => {
      cancelAnimationFrame(frame);
      active.current?.clear();
      active.current = null;
      actions.setWorkspaceTarget(null);
    };
  }, [stops, visit]);

  function choose(id: string) {
    const stop = choices.find(item => item.id === id);
    if (stop) void visit(stop, [...route, stop.id]);
  }

  function back() {
    const previous = route.slice(0, -1);
    const stop = stops.find(item => item.id === previous.at(-1));
    if (stop) void visit(stop, previous);
  }

  return (
    <section className="assistant-tour" aria-label="Health model tour" data-testid="assistant-tour"
      onKeyDown={event => {
        if (event.key === "Escape" && escapeIsFree(event.nativeEvent)) {
          event.preventDefault();
          finishTour();
        }
      }}>
      <header className="assistant-tour__header">
        <h2><Map20Regular aria-hidden="true" /> Health model tour</h2>
        {route.length > 1 ? (
          <Button size="small" appearance="subtle" icon={<ChevronLeft20Regular />} onClick={back}>Back</Button>
        ) : null}
        <Button size="small" onClick={finishTour}>End tour</Button>
      </header>
      <div className="assistant-tour__scroll">
        <h3 ref={title} tabIndex={-1} data-testid="tour-stop-title">{here.title}</h3>
        <p>{here.description}</p>
        <NextSteps choices={choices} onChoose={choose} />
        <div role="status" className="assistant-tour__status">{message}</div>
        <HealthModelDiagram model={model} entityName={here.entityName ?? null}
          timeLabel={moment === null ? "Now" : `As of ${formatUpdated(new Date(moment).toISOString())}`} />
      </div>
    </section>
  );
}

function finishTour() {
  const toWorkspace = useStore.getState().tourReturn === "workspace";
  actions.endTour();
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(toWorkspace ? '[data-testid="workspace-tour"]' : '[data-testid="task-menu"]')?.focus();
  });
}

export function AssistantTour() {
  const model = useAtMoment(selectModelAt);
  const target = useStore(state => state.selected);
  return model && target ? <Tour model={model} target={target} /> : null;
}

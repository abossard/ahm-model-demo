import { flushSync } from "react-dom";
import type { StoreApi } from "zustand";
import { sameModel } from "../model/selection";
import type { Task } from "../model/types";
import { isBuiltView, VIEW_IDS } from "../model/views";
import { createShowMe, type ShowMeHandle } from "../showMe";
import { waitForTarget } from "../showMe/waitForTarget";
import { openDiffPanel, type ShowChange } from "./diffShowMe";
import { revealGraphEntities } from "./graphFocus";
import { selectModelAt } from "./timelineSlice";
import type { Store } from "./store";

/** Bind a registry to the model the question was about, including when opened again from History. */
export function workspaceShowMe(
  store: Pick<StoreApi<Store>, "getState" | "subscribe">,
  task: Pick<Task, "target" | "asOf"> & Partial<Pick<Task, "sessionId" | "seq" | "type">>,
  offered?: ReadonlySet<string>,
  showChange?: ShowChange,
) {
  const get = store.getState;
  const { target } = task;
  const onScreen = (state: Store) => state.selected !== null && sameModel(state.selected, target);
  const targetInCatalog = (state: Store) => state.catalog.kind === "success"
    ? state.catalog.value.models.find((model) => sameModel(model, target))
    : undefined;

  function waitWhile(pending: (state: Store) => boolean, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const unwatch = store.subscribe((state) => {
        if (!pending(state)) finish();
      });
      function finish() {
        unwatch();
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted || !pending(get())) finish();
    });
  }

  async function openModel(signal: AbortSignal) {
    // After a deep link the Session, catalog and model can arrive in any order.
    await waitWhile((state) => !onScreen(state) && state.catalog.kind === "loading", signal);
    if (signal.aborted) return null;
    const state = get();
    if (!onScreen(state)) {
      const model = targetInCatalog(state);
      if (!model) return null;
      void state.chooseModel(model);
    }
    await waitWhile((next) => onScreen(next) && next.model.kind === "loading", signal);
    const current = get();
    return !signal.aborted && onScreen(current) && current.model.kind === "success" ? current.model.value : null;
  }

  async function reveal(surface: "graph" | "timeline", signal: AbortSignal, navigate: (state: Store) => void, find: () => Element | null) {
    flushSync(() => {
      const state = get();
      state.setWorkspaceTarget(surface);
      state.setTimelineFullscreen(false);
      state.setCompare(false);
      if (task.asOf) state.openTimeline();
      navigate(state);
    });
    // Mounting the timeline initializes the model's history and resets the previous model's clock.
    get().selectMoment(task.asOf ? Date.parse(task.asOf) : null);
    const shown = get();
    const unwatch = store.subscribe(state => {
      const moved = surface === "graph" ? state.view !== shown.view
        : !state.timelineOpen || state.selectedName !== shown.selectedName || state.timelineFocus !== shown.timelineFocus;
      if (moved || state.timelinePinned !== shown.timelinePinned || state.workspaceTarget !== surface ||
          !onScreen(state) || state.model.kind !== "success" || state.timelineFullscreen || state.compare) {
        registry.clear();
        if (state.workspaceTarget === surface) state.setWorkspaceTarget(null);
      }
    });
    signal.addEventListener("abort", unwatch, { once: true });
    const element = await waitForTarget(find, signal);
    if (!element && !signal.aborted) {
      unwatch();
      get().setWorkspaceTarget(null);
    }
    return element;
  }

  const query = (selector: string) => () => document.querySelector(selector);

  async function graph(id: string | undefined, signal: AbortSignal) {
    if (!id) return null;
    const model = await openModel(signal);
    if (!model || signal.aborted) return null;
    const [kind, name] = splitId(id);
    if (kind === "view" && isBuiltView(name)) {
      return reveal("graph", signal, state => state.setView(name), query("[data-graph-area]"));
    }
    const edge = kind === "connection" && model.relationships.find(item => item.name === name);
    const names = edge ? [edge.parentEntityName, edge.childEntityName] : kind === "node" ? [name] : [];
    if (!names.length || !names.every(n => model.entities.some(e => e.name === n))) return null;
    const escaped = CSS.escape(name);
    function find() {
      const area = document.querySelector("[data-graph-area]");
      return edge ? area?.querySelector(`.react-flow__edge[data-id="${escaped}"] .react-flow__edge-path`) ?? null
        : area?.querySelector(`.react-flow__node[data-id="${escaped}"]`) ?? area?.querySelector(`[data-entity="${escaped}"]`) ?? null;
    }
    const wasComparing = get().compare;
    const element = await reveal("graph", signal, state => {
      // Zoom draws the entire topology. Other layouts can omit healthy branches or aggregate edges.
      if (wasComparing || !find()) state.setView("zoom");
      const atMoment = selectModelAt({ ...state, timelinePinned: task.asOf ? Date.parse(task.asOf) : null });
      if (atMoment) revealGraphEntities(state, names, atMoment.entities, atMoment.relationships);
    }, () => {
      const element = find();
      return element?.checkVisibility?.({ visibilityProperty: true }) === false ? null : element;
    });
    if (element && !signal.aborted) get().focusEntities({ highlight: names[names.length - 1]!, names });
    return element;
  }

  async function timeline(id: string | undefined, signal: AbortSignal, details = false) {
    if (!id) return null;
    const model = await openModel(signal);
    if (!model || signal.aborted) return null;
    if (id === "overview") return reveal("timeline", signal, state => state.openTimeline(), query("#timeline-panel"));
    const [kind, path] = splitId(id);
    const [name, lane] = kind === "signal" ? splitId(path) : [path, ""];
    if (kind !== "entity" && kind !== "signal") return null;
    const entity = model.entities.find(item => item.name === name);
    if (!entity) return null;
    if (kind === "signal" && (!lane || !entity.signals.some(item => item.name === lane) &&
        !get().timelineData.entities.find(item => item.name === name)?.signals.some(item => item.name === lane))) return null;
    const escaped = CSS.escape(name);
    const selector = details ? `[data-show-me-entity="${escaped}"]`
      : `#timeline-panel [data-testid="tl-label-${kind}"][data-row="${escaped}"][data-focused="true"]` +
        (lane ? `[data-signal="${CSS.escape(lane)}"]` : "");
    return reveal("timeline", signal, state => {
      state.showInTimeline(name, null, lane || undefined);
      if (details) void state.selectEntity(name);
      else state.clearEntity();
    }, query(selector));
  }

  const state = get();
  const available = onScreen(state)
    ? state.model.kind === "success" || state.model.kind === "loading"
    : Boolean(targetInCatalog(state));
  const hasEntities = !onScreen(state) || state.model.kind !== "success" || state.model.value.entities.length > 0;
  const hasDiff = task.type === "review" || task.type === "design";
  const handles: ShowMeHandle[] = [
    {
      name: "graph", description: "Show a node, a connection, or a layout in the Task’s model graph.",
      idDescription: [hasEntities && "node/<entity.name> or connection/<relationship.name> from the model data.", `view/<layout>, where layout is one of ${VIEW_IDS.join(", ")}.`].filter(Boolean).join(" "),
      open: graph,
    },
    {
      name: "timeline", description: "Show the history of the model, a specific entity, or one signal.",
      idDescription: hasEntities ? "overview, entity/<entity.name>, or signal/<entity.name>/<signal.name>. Use exact names from the Task model or timeline data." : "overview",
      open: timeline,
    },
    {
      name: "panel", description: "Open the details for the object discussed in the answer.",
      idDescription: [hasEntities && "entity/<entity.name> from the Task model.", hasDiff && "change/<changeId> from this answer’s proposed changes, or comparison for its before-and-after model."].filter(Boolean).join(" "),
      open: (id, signal) => id?.startsWith("entity/") ? timeline(id, signal, true)
        : id ? openDiffPanel(store, task, id, signal, showChange, () => registry.clear()) : null,
    },
  ];
  // Saved Tasks carry their original vocabulary. These aliases never enter a new turn.
  if (offered) handles.push(
    { name: "node-detail", description: "Open entity details.", idDescription: "An exact entity name.", open: (id, signal) => timeline(`entity/${id}`, signal, true) },
    { name: "model-view", description: "Open a graph layout.", idDescription: "A layout id.", open: (id, signal) => graph(`view/${id}`, signal) },
    { name: "health-timeline", description: "Open the model timeline.", idDescription: "", open: (_, signal) => timeline("overview", signal) },
  );
  const registry = createShowMe(handles.filter(handle => offered ? offered.has(handle.name)
    : available && (handle.name !== "panel" || hasEntities || hasDiff)));
  return registry;
}

/** The first slash separates the destination kind from its domain id. */
function splitId(id: string): [string, string] {
  const slash = id.indexOf("/");
  return slash < 0 ? [id, ""] : [id.slice(0, slash), id.slice(slash + 1)];
}

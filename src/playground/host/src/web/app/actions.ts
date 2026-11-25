// Every change to the page goes through here. This is the only file that calls the wire core.
import { CHEAT_CODE, type Career, type DebugEvent, type LayerId, type ToolInput, type ToolName } from "@playground/contracts";
import { copyText } from "./clipboard";
import { CAREER_KEY, higherCareer, offerFor, sameCareer, parseStoredCareer } from "./career";
import { createBackend, type Backend } from "./backend";
import { entryFor } from "./entry";
import { describeHostEvent, logHost, pushEntry } from "./hostEvents";
import { layerPath, parseRoute, sameRoute, tableIdFromContext, type Route } from "./route";
import { useStore, type DrawerState } from "./store";
import type { HostEvent, McpClient, MountedView, ToolInfo, ToolResult } from "./wireApi";
import { NO_FILTERS, exportEvents, type WireFilters } from "../drawer/wireModel";
import { stampArrivals } from "./arrivals";

let backend: Backend | null = null;
let client: McpClient | null = null;
let mounted: MountedView | null = null;
let logId = 0;

const set = useStore.setState;
const get = useStore.getState;

function readLocalCareer(): Career {
  try {
    return parseStoredCareer(localStorage.getItem(CAREER_KEY));
  } catch {
    return parseStoredCareer(null);
  }
}

function writeLocalCareer(career: Career): void {
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(career));
  } catch {
    // Private windows refuse storage. The ladder still works for this tab.
  }
}

// ---- boot ----

export async function boot(): Promise<void> {
  const route = parseRoute(location.pathname);
  set({ route, career: readLocalCareer() });
  window.addEventListener("popstate", () => set({ route: parseRoute(location.pathname), liveTable: null, viewHeight: null }));

  backend = await createBackend(location.search);
  const { wire, player, fixture } = backend;
  set({ wire, player, fixture });
  wire.subscribe(() => stampArrivals(wire.events()));
  stampArrivals(wire.events());
  logHost("boot", { sid: wire.sid, player: player.id, fixture, route: location.pathname });
  await connect();
}

export async function connect(): Promise<void> {
  if (!backend) return;
  set({ connection: "connecting", connectionError: null });
  try {
    client = await backend.connect();
    const { output } = await backend.core.callTool(client, backend.wire, "career_get", { player: backend.player });
    set({ connection: "ready" });
    receiveCareer(output.career, { announce: false, merge: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logHost("connect.failed", { message });
    set({ connection: "failed", connectionError: message });
  }
}

// ---- route ----

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  if (sameRoute(route, get().route)) return;
  const path = route.page === "home" ? "/" : layerPath(route.layer, route.tableId);
  if (options.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  logHost("route", { to: path });
  set({ route, liveTable: null, viewHeight: null, display: "inline" });
  window.scrollTo({ top: 0 });
}

export function openLayer(layer: LayerId): void {
  navigate({ page: "layer", layer, tableId: null });
}

export function goHome(): void {
  navigate({ page: "home", highlight: null });
}

// ---- career and the offer ----

export function receiveCareer(next: Career, options: { announce: boolean; merge?: boolean }): void {
  const prev = get().career;
  const shown = options.merge ? higherCareer(prev, next) : next;
  writeLocalCareer(shown);
  set({ career: shown });
  logHost("career", { unlocked: shown.unlocked, lab: shown.lab.length, completed: shown.completed, from: prev.unlocked });
  if (!options.announce) return;
  const offer = offerFor(prev, shown);
  if (offer) {
    logHost("offer", { headline: offer.headline, go: offer.go });
    set({ offer, band: offer });
  }
}

export function clearBand(): void {
  set({ band: null });
}

export function dismissOffer(): void {
  set({ offer: null });
}

export function acceptOffer(): void {
  const { offer } = get();
  set({ offer: null });
  if (offer?.go) openLayer(offer.go);
}

export async function cheat(): Promise<void> {
  if (!backend || !client || get().connection !== "ready") return;
  logHost("cheat", { code: CHEAT_CODE });
  try {
    const { output } = await backend.core.callTool(client, backend.wire, "career_cheat", { player: backend.player, code: CHEAT_CODE });
    receiveCareer(output.career, { announce: true });
  } catch (error) {
    logHost("cheat.failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

// ---- the View ----

export async function mountLayer(frame: HTMLIFrameElement, layer: LayerId, tableId: string | null): Promise<MountedView> {
  if (!backend || !client) throw new Error("The page is not connected to the MCP server.");
  const { player, viewTheme } = get();
  if (!player) throw new Error("No player.");
  const entry = entryFor(layer, player, tableId);
  logHost("mount", { layer, tool: entry.tool, table: tableId });
  set({ hostLog: [], viewHeight: null, display: "inline", liveTable: tableId });
  const view = await backend.core.mountView({
    client, wire: backend.wire, frame, tool: entry.tool, args: entry.args, theme: viewTheme,
    onHost: (event) => handleHostEvent(entry.tool, event),
  });
  mounted = view;
  return view;
}

export function unmounted(view: MountedView): void {
  if (mounted === view) mounted = null;
}

function handleHostEvent(tool: ToolName, event: HostEvent): void {
  const said = describeHostEvent(event);
  logId += 1;
  // A career line is news only when the career changed.
  if (event.type !== "career" || !sameCareer(event.career, get().career)) {
    set((state) => ({
      hostLog: pushEntry(state.hostLog, { id: logId, at: Date.now(), type: event.type, view: tool, text: said.text, link: said.link, detail: said.detail }),
    }));
  }
  logHost(`view.${event.type}`, { tool, text: said.text });
  switch (event.type) {
    case "size":
      set({ viewHeight: event.height });
      break;
    case "career":
      receiveCareer(event.career, { announce: true });
      break;
    case "context": {
      const tableId = tableIdFromContext(event.value);
      const { route, liveTable } = get();
      if (tableId && tableId !== liveTable && route.page === "layer") {
        set({ liveTable: tableId });
        history.replaceState(null, "", layerPath(route.layer, tableId));
      }
      break;
    }
    case "link":
      if (said.link) set({ pendingLink: said.link });
      break;
    case "display":
      set({ display: event.mode });
      break;
    default:
  }
}

export function setViewTheme(theme: "dark" | "light"): void {
  set({ viewTheme: theme });
  mounted?.setTheme(theme);
  logHost("theme", { theme });
}

export function setDisplay(mode: "inline" | "fullscreen"): void {
  set({ display: mode });
}

export function confirmLink(): void {
  const { pendingLink } = get();
  set({ pendingLink: null });
  if (pendingLink) window.open(pendingLink, "_blank", "noopener,noreferrer");
}

export function declineLink(): void {
  set({ pendingLink: null });
}

export function inviteUrl(): string | null {
  const { route, liveTable } = get();
  return route.page === "layer" && liveTable ? `${location.origin}${layerPath(route.layer, liveTable)}` : null;
}

// ---- tool runner ----

export async function listTools(): Promise<ToolInfo[]> {
  if (!client) return [];
  return (await client.listTools()).tools;
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!backend || !client) throw new Error("The page is not connected to the MCP server.");
  logHost("runner.call", { tool: name });
  const { result, career } = await backend.core.callTool(client, backend.wire, name as ToolName, args as ToolInput<ToolName>);
  if (career) receiveCareer(career, { announce: true });
  return result;
}

export async function viewTools(): Promise<ToolInfo[]> {
  return mounted ? mounted.viewTools() : [];
}

export async function callViewTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!mounted) throw new Error("No View is open.");
  logHost("runner.view-tool", { tool: name });
  return mounted.callViewTool(name, args);
}

export function playerArg(): unknown {
  return get().player;
}

// ---- the drawer ----

function patchDrawer(patch: Partial<DrawerState>): void {
  set((state) => ({ drawer: { ...state.drawer, ...patch } }));
}

export function setDrawerOpen(open: boolean): void {
  patchDrawer({ open });
  logHost("drawer", { open });
}

export function toggleDrawer(): void {
  setDrawerOpen(!get().drawer.open);
}

export function selectEvent(id: string | null): void {
  patchDrawer({ selectedId: id });
}

export function setFilters(patch: Partial<WireFilters>): void {
  set((state) => ({ drawer: { ...state.drawer, filters: { ...state.drawer.filters, ...patch } } }));
}

export function resetFilters(): void {
  patchDrawer({ filters: NO_FILTERS });
}

export function setDetailMode(detail: DrawerState["detail"]): void {
  patchDrawer({ detail });
}

export function togglePause(): void {
  const paused = !get().drawer.paused;
  backend?.wire.setPaused(paused);
  patchDrawer({ paused });
  logHost("wire.pause", { paused });
}

export function clearWire(): void {
  backend?.wire.clear();
  patchDrawer({ selectedId: null });
  logHost("wire.clear");
}

export function copyAll(events: readonly DebugEvent[]): Promise<boolean> {
  return copyText(exportEvents(events), "all");
}


import { NEW_CAREER, type Career, type Player } from "@playground/contracts";
import { create } from "zustand";
import type { HostLogEntry } from "./hostEvents";
import type { Offer } from "./career";
import type { Route } from "./route";
import { NO_FILTERS, type WireFilters } from "../drawer/wireModel";
import type { Wire } from "./wireApi";

export type Connection = "connecting" | "ready" | "failed";

export interface DrawerState {
  open: boolean;
  selectedId: string | null;
  filters: WireFilters;
  paused: boolean;
  detail: "tree" | "text";
}

export interface State {
  connection: Connection;
  connectionError: string | null;
  fixture: boolean;
  player: Player | null;
  wire: Wire | null;
  career: Career;
  route: Route;
  // The table a game View reported, for the invite link. The route holds the table the page was opened on.
  liveTable: string | null;
  drawer: DrawerState;
  offer: Offer | null;
  band: Offer | null;
  hostLog: HostLogEntry[];
  pendingLink: string | null;
  display: "inline" | "fullscreen";
  viewTheme: "dark" | "light";
  viewHeight: number | null;
}

export const initialState: State = {
  connection: "connecting",
  connectionError: null,
  fixture: false,
  player: null,
  wire: null,
  career: NEW_CAREER,
  route: { page: "home", highlight: null },
  liveTable: null,
  drawer: { open: false, selectedId: null, filters: NO_FILTERS, paused: false, detail: "tree" },
  offer: null,
  band: null,
  hostLog: [],
  pendingLink: null,
  display: "inline",
  viewTheme: "dark",
  viewHeight: null,
};

// State is written only by app/actions.ts. Components read it and call actions.
export const useStore = create<State>(() => initialState);

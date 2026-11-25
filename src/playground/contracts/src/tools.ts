import { z } from "zod";
import { BlackjackSnapshot } from "./blackjack";
import { Career, LabExhibit } from "./career";
import { CheckersSnapshot, Square } from "./checkers";
import { GameId, LobbyRow, Notice, Player, TableId } from "./ids";
import { GoodId, PlanetId, TraderScore, TraderSnapshot } from "./trader";

// The Views the MCP server serves as ui:// resources.
export const VIEWS = {
  hello: "ui://playground/hello.html",
  lab: "ui://playground/lab.html",
  checkers: "ui://playground/checkers.html",
  trader: "ui://playground/trader.html",
  blackjack: "ui://playground/blackjack.html",
} as const;
export type ViewName = keyof typeof VIEWS;
export const VIEW_NAMES = Object.keys(VIEWS) as ViewName[];
export const VIEW_MIME = "text/html;profile=mcp-app";
export const LAB_NOTES_URI = "playground://lab/notes";

export type Visibility = "model" | "app";
export interface ToolSpec<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  title: string;
  description: string;
  input: I;
  output: O;
  // The View this tool belongs to. Null for the tools the host shell calls for itself.
  view: ViewName | null;
  // "model": listed in the tool runner, opens the View. "app": called by the View through the host.
  visibility: readonly Visibility[];
  readOnly: boolean;
}

function tool<I extends z.ZodObject, O extends z.ZodObject>(spec: ToolSpec<I, O>): ToolSpec<I, O> {
  return spec;
}

const ENTRY = ["model", "app"] as const;
const APP = ["app"] as const;
const player = Player;
const tableId = TableId;
const notice = Notice.nullable();

// Every table tool answers with the whole table as the caller may see it, and a notice when a rule did not apply.
function tableResult<S extends z.ZodType>(snapshot: S) {
  return z.object({ snapshot: snapshot.nullable(), notice });
}
function openResult<S extends z.ZodType>(snapshot: S) {
  return z.object({ lobby: z.array(LobbyRow), snapshot: snapshot.nullable(), notice });
}
const checkers = tableResult(CheckersSnapshot);
const blackjack = tableResult(BlackjackSnapshot);
const trader = z.object({ snapshot: TraderSnapshot, notice });

export const LiveSnapshot = z.discriminatedUnion("game", [CheckersSnapshot, BlackjackSnapshot]);
export type LiveSnapshot = z.infer<typeof LiveSnapshot>;

export const TOOLS = {
  career_get: tool({
    title: "Career", description: "Read which layers this player has unlocked.",
    input: z.object({ player }), output: z.object({ career: Career }),
    view: null, visibility: ENTRY, readOnly: true,
  }),
  career_cheat: tool({
    title: "Cheat code", description: "Unlock every layer with the cheat code.",
    input: z.object({ player, code: z.string().max(40) }), output: z.object({ career: Career, notice }),
    view: null, visibility: ENTRY, readOnly: false,
  }),

  hello_show: tool({
    title: "Say hello", description: "Greet the visitor in a View.",
    input: z.object({ player, name: z.string().trim().max(40).optional() }),
    output: z.object({ greeting: z.string(), serverTime: z.number(), pings: z.number().int() }),
    view: "hello", visibility: ENTRY, readOnly: true,
  }),
  hello_ping: tool({
    title: "Ping", description: "Count a button press made inside the hello View.",
    input: z.object({ player }), output: z.object({ pings: z.number().int(), serverTime: z.number() }),
    view: "hello", visibility: APP, readOnly: false,
  }),

  lab_open: tool({
    title: "Open the lab", description: "Open the View that exercises every host capability.",
    input: z.object({ player }), output: z.object({ exhibits: z.array(LabExhibit), done: z.array(LabExhibit) }),
    view: "lab", visibility: ENTRY, readOnly: true,
  }),
  lab_echo: tool({
    title: "Echo", description: "Return the text with its length and the server time.",
    input: z.object({ player, text: z.string().max(280) }),
    output: z.object({ text: z.string(), length: z.number().int(), serverTime: z.number() }),
    view: "lab", visibility: APP, readOnly: true,
  }),
  lab_countdown: tool({
    title: "Countdown", description: "Count down and report each tick as a progress notification.",
    input: z.object({ player, from: z.number().int().min(1).max(10) }),
    output: z.object({ ticks: z.number().int() }),
    view: "lab", visibility: APP, readOnly: true,
  }),
  lab_checkpoint: tool({
    title: "Checkpoint", description: "Record that the visitor tried one lab exhibit.",
    input: z.object({ player, exhibit: LabExhibit }), output: z.object({ done: z.array(LabExhibit) }),
    view: "lab", visibility: APP, readOnly: false,
  }),

  table_list: tool({
    title: "Lobby", description: "List the open tables of a game.",
    input: z.object({ game: GameId }), output: z.object({ tables: z.array(LobbyRow) }),
    view: null, visibility: APP, readOnly: true,
  }),
  wait_for_change: tool({
    title: "Wait for a change", description: "Hold until the table is newer than sinceVersion, at most 25 seconds.",
    input: z.object({ player, tableId, sinceVersion: z.number().int().min(-1) }),
    output: z.object({ changed: z.boolean(), snapshot: LiveSnapshot.nullable(), notice }),
    view: null, visibility: APP, readOnly: true,
  }),

  checkers_open: tool({
    title: "Play checkers", description: "Open the checkers View on the lobby or on one table.",
    input: z.object({ player, tableId: tableId.optional() }), output: openResult(CheckersSnapshot),
    view: "checkers", visibility: ENTRY, readOnly: true,
  }),
  checkers_create: tool({
    title: "New checkers table", description: "Create a table and take black. The house bot can take white.",
    input: z.object({ player, opponent: z.enum(["human", "bot"]) }), output: checkers,
    view: "checkers", visibility: APP, readOnly: false,
  }),
  checkers_join: tool({
    title: "Join checkers table", description: "Take the free colour, or watch when both are taken.",
    input: z.object({ player, tableId }), output: checkers,
    view: "checkers", visibility: APP, readOnly: false,
  }),
  checkers_move: tool({
    title: "Move", description: "Move one piece: a step, or every jump of a jump sequence.",
    input: z.object({ player, tableId, version: z.number().int().min(0), from: Square, path: z.array(Square).min(1).max(12) }),
    output: checkers,
    view: "checkers", visibility: APP, readOnly: false,
  }),
  checkers_resign: tool({
    title: "Resign", description: "Give up the game.",
    input: z.object({ player, tableId }), output: checkers,
    view: "checkers", visibility: APP, readOnly: false,
  }),

  trader_open: tool({
    title: "Play Drift Ledger", description: "Open the trading View on this pilot's run. Starts a run when there is none.",
    input: z.object({ player }), output: trader,
    view: "trader", visibility: ENTRY, readOnly: false,
  }),
  trader_buy: tool({
    title: "Buy", description: "Buy units of a good at the local price.",
    input: z.object({ player, good: GoodId, qty: z.number().int().min(1).max(99) }), output: trader,
    view: "trader", visibility: APP, readOnly: false,
  }),
  trader_sell: tool({
    title: "Sell", description: "Sell units of a good at the local price.",
    input: z.object({ player, good: GoodId, qty: z.number().int().min(1).max(99) }), output: trader,
    view: "trader", visibility: APP, readOnly: false,
  }),
  trader_travel: tool({
    title: "Jump", description: "Travel to another port. Costs fuel and days.",
    input: z.object({ player, to: PlanetId }), output: trader,
    view: "trader", visibility: APP, readOnly: false,
  }),
  trader_refuel: tool({
    title: "Refuel", description: "Buy fuel at the local price.",
    input: z.object({ player, units: z.number().int().min(1).max(99) }), output: trader,
    view: "trader", visibility: APP, readOnly: false,
  }),
  trader_new_run: tool({
    title: "New run", description: "Abandon the run and start again on day 1.",
    input: z.object({ player }), output: trader,
    view: "trader", visibility: APP, readOnly: false,
  }),
  trader_scores: tool({
    title: "Top pilots", description: "List the ten richest runs.",
    input: z.object({}), output: z.object({ scores: z.array(TraderScore).max(10) }),
    view: "trader", visibility: APP, readOnly: true,
  }),

  blackjack_open: tool({
    title: "Play blackjack", description: "Open the blackjack View on the lobby or on one table.",
    input: z.object({ player, tableId: tableId.optional() }), output: openResult(BlackjackSnapshot),
    view: "blackjack", visibility: ENTRY, readOnly: true,
  }),
  blackjack_create: tool({
    title: "New blackjack table", description: "Open a table and take a seat.",
    input: z.object({ player, title: z.string().trim().max(40).optional() }), output: blackjack,
    view: "blackjack", visibility: APP, readOnly: false,
  }),
  blackjack_sit: tool({
    title: "Sit", description: "Take a free seat, or watch when the table is full.",
    input: z.object({ player, tableId }), output: blackjack,
    view: "blackjack", visibility: APP, readOnly: false,
  }),
  blackjack_leave: tool({
    title: "Leave", description: "Give up the seat. A bet in play stays in play.",
    input: z.object({ player, tableId }), output: blackjack,
    view: "blackjack", visibility: APP, readOnly: false,
  }),
  blackjack_bet: tool({
    title: "Bet", description: "Place the bet for the next round. The amount is fitted to the table limits.",
    input: z.object({ player, tableId, amount: z.number().int() }), output: blackjack,
    view: "blackjack", visibility: APP, readOnly: false,
  }),
  blackjack_act: tool({
    title: "Play the hand", description: "Hit, stand or double on your turn.",
    input: z.object({ player, tableId, action: z.enum(["hit", "stand", "double"]) }), output: blackjack,
    view: "blackjack", visibility: APP, readOnly: false,
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
export type ToolInput<N extends ToolName> = z.input<(typeof TOOLS)[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOLS)[N]["output"]>;

// The `_meta` the MCP server puts on a tool so a host knows its View and who may call it.
export function toolMeta(name: ToolName): { ui: { resourceUri?: string; visibility: Visibility[] } } {
  const { view, visibility } = TOOLS[name];
  return { ui: { ...(view ? { resourceUri: VIEWS[view] } : {}), visibility: [...visibility] } };
}

export const LONG_POLL_SECONDS = 25;
// How long the caller of wait_for_change waits before it gives up on one call.
export const LONG_POLL_CLIENT_TIMEOUT_MS = 40_000;

import { z } from "zod";

// Anonymous identity. The browser makes it once, keeps it in localStorage and sends it as a tool argument.
export const PlayerId = z.string().regex(/^[a-z0-9-]{8,40}$/);
export const Handle = z.string().trim().min(2).max(20);
export const Player = z.object({ id: PlayerId, handle: Handle });
export type Player = z.infer<typeof Player>;

export const GAMES = ["checkers", "trader", "blackjack"] as const;
export const GameId = z.enum(GAMES);
export type GameId = z.infer<typeof GameId>;

// A table of a game. A Drift Ledger run uses its pilot's player id.
export const TableId = z.string().regex(/^[a-z0-9-]{6,40}$/);
export type TableId = z.infer<typeof TableId>;

// A rule that did not apply. Never an error: the tool still returns the current snapshot beside it.
export const NOTICE_CODES = [
  "stale", "not_your_turn", "illegal_move", "wrong_phase", "not_seated", "table_gone", "table_full",
  "city_full", "insufficient_funds", "cargo_full", "not_enough_cargo", "not_enough_fuel", "same_planet",
  "run_over", "dealer_busy", "bad_code",
] as const;
export const NoticeCode = z.enum(NOTICE_CODES);
export type NoticeCode = z.infer<typeof NoticeCode>;
export const Notice = z.object({ code: NoticeCode, message: z.string().max(200) });
export type Notice = z.infer<typeof Notice>;

export const LobbyRow = z.object({
  tableId: TableId,
  game: GameId,
  title: z.string().max(60),
  seatsTaken: z.number().int().min(0),
  seatsTotal: z.number().int().min(1),
  status: z.enum(["open", "playing", "over"]),
  updatedAt: z.number(),
});
export type LobbyRow = z.infer<typeof LobbyRow>;

// What every table tool returns: the whole table as this player may see it. Never a diff.
export function snapshotOf<G extends GameId, V extends z.ZodType>(game: G, view: V) {
  return z.object({
    tableId: TableId,
    game: z.literal(game),
    version: z.number().int().min(0),
    serverTime: z.number(),
    view,
  });
}

const HANDLE_FIRST = ["Neon", "Dusty", "Lucky", "Quiet", "Chrome", "Velvet", "Static", "Copper", "Midnight", "Paper"];
const HANDLE_LAST = ["Courier", "Dealer", "Pilot", "Rook", "Broker", "Drifter", "Switch", "Marker", "Runner", "Ledger"];

// A calculation: the caller supplies the randomness (crypto.getRandomValues in the browser).
export function newPlayer(random: Uint8Array): Player {
  const hex = Array.from(random.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const first = HANDLE_FIRST[(random[8] ?? 0) % HANDLE_FIRST.length]!;
  const last = HANDLE_LAST[(random[9] ?? 0) % HANDLE_LAST.length]!;
  return { id: `p-${hex}`, handle: `${first} ${last}` };
}

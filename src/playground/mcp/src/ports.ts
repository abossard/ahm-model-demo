// The seams of the MCP server. Rules (calculations) sit on one side, adapters (actions) on the other,
// and tables.ts is the only code that joins them. Nothing here imports an SDK.
// Frozen for the parallel build: see docs/playground/architecture.md, "Frozen files".
import { CARDS } from "@playground/contracts";
import type {
  BlackjackView, Card, CareerEvent, CheckersView, GameId, GoodId, LobbyRow, Notice, PlanetId, Player, TraderView,
} from "@playground/contracts";

// ---- Store -----------------------------------------------------------------------------------------------------

// tables: live checkers and blackjack tables. runs: Drift Ledger runs. players: handle and career.
export type Kind = "tables" | "runs" | "players";

export interface Doc<T> {
  id: string;
  // Partition: the game for a table or a run, the player id for a player.
  pk: string;
  // Starts at 1 and grows by one with every committed change.
  version: number;
  updatedAt: number;
  body: T;
}

// A small document store with compare-and-swap inside. Callers never see a write conflict:
// `update` reads, runs `change`, writes if the document is still the one it read, and starts over if not.
export interface Store {
  get<T>(kind: Kind, pk: string, id: string): Promise<Doc<T> | null>;
  // `change` is a calculation and may run more than once. It gets null when the document does not exist.
  // Returning its argument unchanged (the same reference) or null writes nothing.
  // The result is the document as stored after the call, or null when there is none.
  update<T>(kind: Kind, pk: string, id: string, change: (body: T | null) => T | null): Promise<Doc<T> | null>;
  // The newest documents of one partition, newest first.
  list<T>(kind: Kind, pk: string, limit: number): Promise<Doc<T>[]>;
  remove(kind: Kind, pk: string, id: string): Promise<void>;
}

// How long a document lives after its last write. The store drops it afterwards; nobody reaps.
// The same numbers are the container TTLs in infra/modules/playground.bicep: change both.
export const TTL_SECONDS: Record<Kind, number> = {
  tables: 6 * 60 * 60,
  runs: 7 * 24 * 60 * 60,
  players: 30 * 24 * 60 * 60,
};

// ---- Changes ---------------------------------------------------------------------------------------------------

// Wakes the long-polls of a table. In one process this is an in-memory emitter (ADR 0013).
export interface Changes {
  publish(tableId: string, version: number): void;
  // Resolves with the published version, or with null at the deadline or when the signal aborts.
  next(tableId: string, deadline: number, signal: AbortSignal): Promise<number | null>;
}

// ---- Clock and randomness --------------------------------------------------------------------------------------

// The two things a calculation may not reach for. tables.ts reads them and passes the values in.
export interface Clock {
  now(): number;
  // A fresh 32-bit seed for a new table or a new run.
  seed(): number;
}

// ---- Rules -----------------------------------------------------------------------------------------------------

// A job done by one player. The step that settles a blackjack round can carry one for every winner.
export interface PlayerEvent {
  playerId: string;
  event: CareerEvent;
}

// What a rule step produced. `state` is the same reference when nothing changed.
export interface Step<S> {
  state: S;
  notice: Notice | null;
  events: PlayerEvent[];
}

// One game as calculations over its own state type. tables.ts treats `S` as opaque.
export interface GameRules<S, A, V> {
  game: GameId;
  seats: number;
  // A new table with `by` seated. `seed` is the only randomness a game ever gets.
  // `options` holds the tool's own arguments (opponent, title) and `fast: true` in end-to-end runs,
  // which the game answers by storing shorter deadlines in its state.
  create(by: Player, options: Record<string, unknown>, now: number, seed: number): S;
  // An action of a player. An action that does not apply returns the same state and a notice.
  apply(state: S, action: A, by: Player, now: number): Step<S>;
  // What the passing of time does: an expired turn, a closed betting window. Same reference when nothing is due.
  tick(state: S, now: number): Step<S>;
  // When `tick` will next change something, so a long-poll wakes for it. Null when nothing is scheduled.
  nextDeadline(state: S): number | null;
  // What `viewer` may see. Hides the dealer's hole card and the shoe.
  view(state: S, viewer: Player | null): V;
  lobby(state: S): Pick<LobbyRow, "title" | "seatsTaken" | "seatsTotal" | "status">;
}

// A move that was made against an older version never reaches the rules: tables.ts answers it with "stale".
export type CheckersAction =
  | { type: "join" }
  | { type: "move"; from: number; path: number[] }
  | { type: "resign" };

export type TraderAction =
  | { type: "buy"; good: GoodId; qty: number }
  | { type: "sell"; good: GoodId; qty: number }
  | { type: "travel"; to: PlanetId }
  | { type: "refuel"; units: number }
  | { type: "new_run"; seed: number };

export type BlackjackAction =
  | { type: "sit" }
  | { type: "leave" }
  | { type: "bet"; amount: number }
  | { type: "act"; action: "hit" | "stand" | "double" };

export type CheckersRules<S> = GameRules<S, CheckersAction, CheckersView>;
export type TraderRules<S> = GameRules<S, TraderAction, TraderView>;

// ---- The dealer ------------------------------------------------------------------------------------------------

// What blackjack asks of the language model. The model shuffles blind and decides its own hand.
// It never sees a player's cards when it orders the shoe, and it never sees the next card when it decides.
export type DealerRequest =
  | {
      id: string;
      kind: "shuffle";
      // How many cards to put in order.
      count: number;
      // Copies of each card still in the shoe.
      remaining: Record<Card, number>;
      // The previous slice, so the model does not repeat itself.
      previous: Card[];
    }
  | {
      id: string;
      kind: "decide";
      // The dealer's own cards, hole card included.
      hand: Card[];
      total: number;
      soft: boolean;
      // Totals of the hands still in play.
      players: number[];
      hits: number;
    };

// The whole reply of the model. One shape for both kinds keeps the JSON Schema strict and small.
export interface DealerOutput {
  // shuffle: `count` cards in the order they will be dealt. decide: empty.
  cards: string[];
  // decide: what the dealer does. shuffle: "stand".
  action: "hit" | "stand";
  // One line of table talk, at most 120 characters.
  say: string;
}

// The JSON Schema sent as the structured-output format. Strict: every key required, no extras.
// Verified against gpt-54-mini with api-version 2024-10-21, max_completion_tokens and reasoning_effort "low".
export const DEALER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cards", "action", "say"],
  properties: {
    cards: { type: "array", items: { type: "string", enum: CARDS }, description: "Rank then suit: AS, TD, 7H." },
    action: { type: "string", enum: ["hit", "stand"] },
    say: { type: "string", description: "One short line of table talk." },
  },
} as const;

export interface DealerReply {
  output: DealerOutput;
  model: string;
  ms: number;
}

// The language model as a dealer. Rejects on timeout, transport failure or a reply that is not the schema.
// The Azure adapter sends `prompt`. The fake adapter answers from `request` alone, so tests know every card.
export interface DealerLlm {
  name: string;
  ask(request: DealerRequest, prompt: { system: string; user: string }, signal: AbortSignal): Promise<DealerReply>;
}

// Why a dealer request ended without a usable reply. Both end the round as a misdeal.
export type DealerFailure = "invalid" | "unavailable";

export interface BlackjackRules<S> extends GameRules<S, BlackjackAction, BlackjackView> {
  // The request waiting for the model, or null. Set by apply or tick, cleared by resolve.
  pending(state: S): DealerRequest | null;
  // The words for the model. A calculation of the request alone.
  prompt(request: DealerRequest): { system: string; user: string };
  // Checks a reply against the shoe and the rules. Returns the problems, empty when the reply is usable.
  validate(request: DealerRequest, output: DealerOutput): string[];
  // Applies a validated reply, or a failure. Ignores a reply to a request that is no longer pending.
  resolve(state: S, requestId: string, reply: DealerReply | DealerFailure, attempts: number, now: number): Step<S>;
}

export const DEALER_LIMITS = {
  attemptsPerRequest: 2,
  timeoutMs: 8000,
  // Requests per round, per table and hour, and per process and minute. Past a cap the round is a misdeal.
  perRound: 10,
  perTableHour: 120,
  perMinute: 60,
} as const;

// ---- Limits of the public app ----------------------------------------------------------------------------------

export const TABLE_LIMITS = { checkers: 100, blackjack: 50, trader: 2000 } as const satisfies Record<GameId, number>;
export const MAX_WAITERS = 500;

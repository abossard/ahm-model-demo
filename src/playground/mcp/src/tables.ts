import type { GameId, LobbyRow, LiveSnapshot, Notice, Player, TraderScore, TraderSnapshot } from "@playground/contracts";
import type { Careers } from "./careers";
import { MAX_WAITERS, TABLE_LIMITS } from "./ports";
import type { BlackjackRules, Changes, Clock, Doc, GameRules, PlayerEvent, Step, Store } from "./ports";

export type Snapshot = LiveSnapshot | TraderSnapshot;

export interface TableResult {
  snapshot: Snapshot | null;
  notice: Notice | null;
}

export interface Tables {
  open(game: GameId, player: Player, tableId?: string): Promise<TableResult & { lobby: LobbyRow[] }>;
  create(game: GameId, player: Player, options: Record<string, unknown>): Promise<TableResult>;
  act(game: GameId, tableId: string, action: unknown, player: Player, expectVersion?: number): Promise<TableResult>;
  wait(tableId: string, sinceVersion: number, player: Player, signal: AbortSignal): Promise<TableResult & { changed: boolean }>;
  list(game: GameId): Promise<LobbyRow[]>;
  // The ten richest of the newest 200 Drift Ledger runs.
  scores(): Promise<TraderScore[]>;
}

// The rules are opaque here: each game keeps its own state type.
type AnyRules = GameRules<any, any, any>;

export interface TablesDeps {
  store: Store;
  changes: Changes;
  clock: Clock;
  careers: Careers;
  rules: { checkers: AnyRules; trader: AnyRules; blackjack: BlackjackRules<any> };
  dealer: { kick(tableId: string): unknown };
  fast: boolean;
  longPollMs: number;
  newId?: (prefix: "c" | "b") => string;
}

const GONE: Notice = { code: "table_gone", message: "That table is gone." };
const STALE: Notice = { code: "stale", message: "The table moved on. Here is the current state." };
const CITY_FULL: Notice = { code: "city_full", message: "The city is full of tables. Try again in a while." };

const WAKE_MARGIN_MS = 50;

function randomId(prefix: "c" | "b"): string {
  let id = "";
  for (let i = 0; i < 9; i++) id += Math.floor(Math.random() * 36).toString(36);
  return prefix + id;
}

function gameOf(tableId: string): "checkers" | "blackjack" | null {
  return tableId.startsWith("c") ? "checkers" : tableId.startsWith("b") ? "blackjack" : null;
}

function place(game: GameId): { kind: "tables" | "runs"; pk: string } {
  return game === "trader" ? { kind: "runs", pk: "trader" } : { kind: "tables", pk: game };
}

export function createTables(deps: TablesDeps): Tables {
  const { store, changes, clock, careers, rules, dealer } = deps;
  const newId = deps.newId ?? randomId;
  let waiters = 0;
  const rulesOf = (game: GameId): AnyRules => rules[game];

  const snapshotOfDoc = (game: GameId, id: string, doc: Doc<unknown>, viewer: Player | null): Snapshot =>
    ({ tableId: id, game, version: doc.version, serverTime: clock.now(), view: rulesOf(game).view(doc.body, viewer) }) as Snapshot;

  async function afterCommit(game: GameId, id: string, doc: Doc<unknown>, events: PlayerEvent[]): Promise<void> {
    changes.publish(id, doc.version);
    for (const { playerId, event } of events) await careers.advance(playerId, event);
    if (game === "blackjack" && rules.blackjack.pending(doc.body)) void dealer.kick(id);
  }

  // Reads the table and commits what the passing of time changed in it.
  async function settled(game: GameId, id: string): Promise<{ doc: Doc<unknown> | null; changed: boolean }> {
    const { kind, pk } = place(game);
    const now = clock.now();
    const last: { events: PlayerEvent[]; changed: boolean } = { events: [], changed: false };
    const doc = await store.update<unknown>(kind, pk, id, (body) => {
      last.events = [];
      last.changed = false;
      if (body === null) return null;
      const step = rulesOf(game).tick(body, now) as Step<unknown>;
      last.events = step.events;
      last.changed = step.state !== body;
      return step.state;
    });
    if (doc && last.changed) await afterCommit(game, id, doc, last.events);
    return { doc, changed: last.changed };
  }

  async function lobbyOf(game: GameId): Promise<LobbyRow[]> {
    if (game === "trader") return [];
    const docs = await store.list<unknown>("tables", game, 30);
    return docs.map((doc) => ({
      tableId: doc.id,
      game,
      ...rulesOf(game).lobby(doc.body),
      updatedAt: doc.updatedAt,
    }));
  }

  async function ensureRun(player: Player): Promise<void> {
    let created = false;
    const doc = await store.update<unknown>("runs", "trader", player.id, (body) => {
      created = body === null;
      return body ?? rules.trader.create(player, {}, clock.now(), clock.seed());
    });
    if (doc && created) await afterCommit("trader", player.id, doc, []);
  }

  async function act(game: GameId, id: string, action: unknown, player: Player, expectVersion?: number): Promise<TableResult> {
    const { kind, pk } = place(game);
    if (expectVersion !== undefined) {
      const current = await store.get<unknown>(kind, pk, id);
      if (current && current.version !== expectVersion) {
        return { snapshot: snapshotOfDoc(game, id, current, player), notice: STALE };
      }
    }
    const now = clock.now();
    const last: { step: Step<unknown> | null; wrote: boolean } = { step: null, wrote: false };
    const doc = await store.update<unknown>(kind, pk, id, (body) => {
      last.step = null;
      last.wrote = false;
      const start = body ?? (game === "trader" ? rules.trader.create(player, {}, now, clock.seed()) : null);
      if (start === null) return null;
      const ticked = rulesOf(game).tick(start, now) as Step<unknown>;
      const applied = rulesOf(game).apply(ticked.state, action, player, now) as Step<unknown>;
      last.step = { state: applied.state, notice: applied.notice, events: [...ticked.events, ...applied.events] };
      last.wrote = applied.state !== body;
      return applied.state;
    });
    if (!doc || !last.step) return { snapshot: null, notice: GONE };
    if (last.wrote) await afterCommit(game, id, doc, last.step.events);
    return { snapshot: snapshotOfDoc(game, id, doc, player), notice: last.step.notice };
  }

  return {
    async open(game, player, tableId) {
      if (game === "trader") {
        await ensureRun(player);
        const doc = await store.get<unknown>("runs", "trader", player.id);
        return { lobby: [], snapshot: doc ? snapshotOfDoc("trader", player.id, doc, player) : null, notice: null };
      }
      const lobby = await lobbyOf(game);
      if (tableId === undefined) return { lobby, snapshot: null, notice: null };
      const { doc } = await settled(game, tableId);
      if (!doc) return { lobby, snapshot: null, notice: GONE };
      if (game === "blackjack" && rules.blackjack.pending(doc.body)) void dealer.kick(tableId);
      return { lobby, snapshot: snapshotOfDoc(game, tableId, doc, player), notice: null };
    },

    async create(game, player, options) {
      if (game === "trader") return act("trader", player.id, { type: "new_run", seed: clock.seed() }, player);
      const cap = TABLE_LIMITS[game];
      if ((await store.list("tables", game, cap)).length >= cap) return { snapshot: null, notice: CITY_FULL };
      const id = newId(game === "checkers" ? "c" : "b");
      const now = clock.now();
      const seed = clock.seed();
      const doc = await store.update<unknown>("tables", game, id, () =>
        rulesOf(game).create(player, deps.fast ? { ...options, fast: true } : options, now, seed),
      );
      await afterCommit(game, id, doc!, []);
      return { snapshot: snapshotOfDoc(game, id, doc!, player), notice: null };
    },

    act,

    async wait(tableId, sinceVersion, player, signal) {
      const game = gameOf(tableId);
      if (!game) return { changed: false, snapshot: null, notice: GONE };
      const result = (doc: Doc<unknown> | null): TableResult & { changed: boolean } =>
        doc
          ? { changed: doc.version > sinceVersion, snapshot: snapshotOfDoc(game, tableId, doc, player), notice: null }
          : { changed: false, snapshot: null, notice: GONE };

      const first = (await settled(game, tableId)).doc;
      if (!first || first.version > sinceVersion || waiters >= MAX_WAITERS) return result(first);

      waiters++;
      try {
        const due = rulesOf(game).nextDeadline(first.body);
        const deadline = Math.min(clock.now() + deps.longPollMs, due === null ? Infinity : due + WAKE_MARGIN_MS);
        const stop = new AbortController();
        const woken = changes.next(tableId, deadline, AbortSignal.any([signal, stop.signal]));
        const again = await store.get<unknown>("tables", game, tableId);
        if (again && again.version > sinceVersion) stop.abort();
        await woken;
      } finally {
        waiters--;
      }
      return result((await settled(game, tableId)).doc);
    },

    list: lobbyOf,

    async scores() {
      const docs = await store.list<unknown>("runs", "trader", 200);
      return docs
        .map((doc) => rulesOf("trader").view(doc.body, null) as { pilot: string; netWorth: number; day: number })
        .map(({ pilot, netWorth, day }) => ({ handle: pilot, netWorth, day }))
        .sort((a, b) => b.netWorth - a.netWorth)
        .slice(0, 10);
    },
  };
}

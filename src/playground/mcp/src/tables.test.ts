import { describe, expect, it } from "vitest";
import { createCareers } from "./careers";
import { createChanges } from "./changes";
import { MAX_WAITERS, TABLE_LIMITS } from "./ports";
import { createMemoryStore } from "./store/memory";
import { createTables } from "./tables";
import { ADA, BEN, counterBlackjack, counterRules, fixedClock } from "./testing";

function setup(options: { fast?: boolean; longPollMs?: number } = {}) {
  const store = createMemoryStore();
  const clock = fixedClock();
  const changes = createChanges(clock.now);
  const careers = createCareers(store);
  const kicks: string[] = [];
  let ids = 0;
  const tables = createTables({
    store, changes, clock, careers,
    rules: { checkers: counterRules("checkers"), trader: counterRules("trader"), blackjack: counterBlackjack() },
    dealer: { kick: (id) => void kicks.push(id) },
    fast: options.fast ?? false,
    longPollMs: options.longPollMs ?? 200,
    newId: (prefix) => `${prefix}${String(++ids).padStart(9, "0")}`,
  });
  return { store, changes, clock, careers, kicks, tables };
}

const never = new AbortController().signal;
const bump = { type: "bump" };

describe("tables", () => {
  it.each<{ game: "checkers" | "blackjack"; prefix: string }>([
    { game: "checkers", prefix: "c" },
    { game: "blackjack", prefix: "b" },
  ])("creates a $game table with a $prefix id, version 1, and lists it", async ({ game, prefix }) => {
    const { tables } = setup();
    const created = await tables.create(game, ADA, { title: "Mine" });
    expect(created.notice).toBeNull();
    expect(created.snapshot).toMatchObject({ game, version: 1, tableId: `${prefix}000000001`, view: { viewer: ADA.id, title: "Mine" } });
    expect(await tables.list(game)).toMatchObject([{ tableId: `${prefix}000000001`, game, title: "Mine", seatsTaken: 1, status: "open" }]);
  });

  it("passes fast: true to the game only in fast mode", async () => {
    const fast = await setup({ fast: true }).tables.create("checkers", ADA, {});
    const slow = await setup().tables.create("checkers", ADA, {});
    expect(fast.snapshot).toBeTruthy();
    expect(slow.snapshot).toBeTruthy();
    const { store, tables } = setup({ fast: true });
    await tables.create("checkers", ADA, { opponent: "bot" });
    const doc = await store.get<{ options: unknown }>("tables", "checkers", "c000000001");
    expect(doc?.body.options).toEqual({ opponent: "bot", fast: true });
  });

  it("answers city_full at the cap and creates nothing", async () => {
    const { tables, store } = setup();
    for (let i = 0; i < TABLE_LIMITS.blackjack; i++) await store.update("tables", "blackjack", `b${i}`, () => ({ n: i, options: {} }));
    expect(await tables.create("blackjack", ADA, {})).toMatchObject({ snapshot: null, notice: { code: "city_full" } });
  });

  it("commits an action once, bumps the version and shows the viewer's view", async () => {
    const { tables } = setup();
    const { snapshot } = await tables.create("checkers", ADA, {});
    const acted = await tables.act("checkers", snapshot!.tableId, bump, BEN);
    expect(acted.snapshot).toMatchObject({ version: 2, view: { viewer: BEN.id } });
  });

  it("returns a rule's notice beside the unchanged snapshot, without a version bump", async () => {
    const { tables } = setup();
    const { snapshot } = await tables.create("checkers", ADA, {});
    const acted = await tables.act("checkers", snapshot!.tableId, { type: "nope" }, ADA);
    expect(acted.notice?.code).toBe("illegal_move");
    expect(acted.snapshot?.version).toBe(1);
  });

  it.each([
    { name: "an older version", expect: 1, notice: "stale" },
    { name: "a newer version", expect: 9, notice: "stale" },
    { name: "the current version", expect: 2, notice: null },
  ])("an action against $name gets notice $notice", async ({ expect: expected, notice }) => {
    const { tables } = setup();
    const { snapshot } = await tables.create("checkers", ADA, {});
    await tables.act("checkers", snapshot!.tableId, bump, ADA);
    const acted = await tables.act("checkers", snapshot!.tableId, bump, ADA, expected);
    expect(acted.notice?.code ?? null).toBe(notice);
    expect(acted.snapshot?.version).toBe(notice ? 2 : 3);
  });

  it("answers table_gone with no snapshot for an unknown table", async () => {
    const { tables } = setup();
    expect(await tables.act("checkers", "cnope00000", bump, ADA)).toEqual({ snapshot: null, notice: expect.objectContaining({ code: "table_gone" }) });
    expect(await tables.open("blackjack", ADA, "bnope00000")).toMatchObject({ snapshot: null, notice: { code: "table_gone" } });
  });

  it("publishes a commit and advances the careers of the events", async () => {
    const { tables, changes, careers, clock } = setup();
    const { snapshot } = await tables.create("blackjack", ADA, {});
    const woken = changes.next(snapshot!.tableId, clock.now() + 5000, never);
    await tables.act("blackjack", snapshot!.tableId, { type: "win" }, ADA);
    expect(await woken).toBe(2);
    expect((await careers.get(ADA)).completed).toBe(true);
  });

  it("kicks the dealer when a commit leaves a request pending, and on open", async () => {
    const { tables, kicks } = setup();
    const { snapshot } = await tables.create("blackjack", ADA, {});
    expect(kicks).toEqual([]);
    await tables.act("blackjack", snapshot!.tableId, { type: "ask" }, ADA);
    expect(kicks).toEqual([snapshot!.tableId]);
    await tables.open("blackjack", BEN, snapshot!.tableId);
    expect(kicks).toEqual([snapshot!.tableId, snapshot!.tableId]);
  });

  it("ticks before it applies: an expired deadline shows in the same step", async () => {
    const { tables, clock } = setup();
    const { snapshot } = await tables.create("checkers", ADA, {});
    await tables.act("checkers", snapshot!.tableId, { type: "arm", at: clock.now() + 1000 }, ADA);
    clock.advance(2000);
    const acted = await tables.act("checkers", snapshot!.tableId, bump, ADA);
    expect((acted.snapshot!.view as unknown as { n: number }).n).toBeGreaterThanOrEqual(1000);
  });

  describe("open", () => {
    it("lists the lobby with no table id", async () => {
      const { tables } = setup();
      await tables.create("checkers", ADA, {});
      expect(await tables.open("checkers", BEN)).toMatchObject({ snapshot: null, notice: null, lobby: [{ game: "checkers" }] });
    });

    it("starts a Drift Ledger run once and finds it again", async () => {
      const { tables, store } = setup();
      const first = await tables.open("trader", ADA);
      const again = await tables.open("trader", ADA);
      expect(first.snapshot).toMatchObject({ game: "trader", tableId: ADA.id, version: 1 });
      expect(again.snapshot?.version).toBe(1);
      expect((await store.list("runs", "trader", 10)).map((d) => d.id)).toEqual([ADA.id]);
    });
  });

  describe("trader", () => {
    it("an action on a missing run starts it first", async () => {
      const { tables } = setup();
      const acted = await tables.act("trader", ADA.id, bump, ADA);
      expect(acted.snapshot).toMatchObject({ game: "trader", version: 1 });
    });

    it("create abandons the run and starts again", async () => {
      const { tables } = setup();
      await tables.open("trader", ADA);
      const next = await tables.create("trader", ADA, {});
      expect(next.snapshot?.game).toBe("trader");
    });

    it("scores are the ten richest, newest 200, handles from the view", async () => {
      const { store } = setup();
      for (let i = 0; i < 12; i++) {
        await store.update("runs", "trader", `p-run${i}`, () => ({ n: i, options: {}, owner: "x", dueAt: null, request: null, resolved: [] }));
      }
      const scores = await createTables({
        store, changes: createChanges(), clock: fixedClock(), careers: createCareers(store),
        rules: {
          checkers: counterRules("checkers"),
          trader: { ...counterRules("trader"), view: (s) => ({ pilot: `Pilot ${s.n}`, netWorth: s.n * 10, day: s.n + 1 }) },
          blackjack: counterBlackjack(),
        },
        dealer: { kick: () => {} }, fast: false, longPollMs: 10,
      }).scores();
      expect(scores).toHaveLength(10);
      expect(scores[0]).toEqual({ handle: "Pilot 11", netWorth: 110, day: 12 });
      expect(scores.map((s) => s.netWorth)).toEqual([...scores.map((s) => s.netWorth)].sort((a, b) => b - a));
    });
  });

  describe("wait", () => {
    it.each<{ name: string; since: number; changed: boolean }>([
      { name: "newer than sinceVersion: returns at once", since: 0, changed: true },
      { name: "sinceVersion -1: returns at once", since: -1, changed: true },
    ])("$name", async ({ since, changed }) => {
      const { tables } = setup();
      const { snapshot } = await tables.create("checkers", ADA, {});
      const started = Date.now();
      const result = await tables.wait(snapshot!.tableId, since, ADA, never);
      expect(result).toMatchObject({ changed, snapshot: { version: 1 } });
      expect(Date.now() - started).toBeLessThan(100);
    });

    it("holds until another player's commit, then returns the new snapshot", async () => {
      const { tables } = setup({ longPollMs: 3000 });
      const { snapshot } = await tables.create("checkers", ADA, {});
      const waiting = tables.wait(snapshot!.tableId, 1, ADA, never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await tables.act("checkers", snapshot!.tableId, bump, BEN);
      expect(await waiting).toMatchObject({ changed: true, snapshot: { version: 2, view: { viewer: ADA.id } } });
    });

    it("returns changed: false at the long-poll limit", async () => {
      const { tables } = setup({ longPollMs: 40 });
      const { snapshot } = await tables.create("checkers", ADA, {});
      const result = await tables.wait(snapshot!.tableId, 1, ADA, never);
      expect(result).toMatchObject({ changed: false, snapshot: { version: 1 } });
    });

    it("returns early when the caller goes away", async () => {
      const { tables } = setup({ longPollMs: 5000 });
      const { snapshot } = await tables.create("checkers", ADA, {});
      const ctl = new AbortController();
      const waiting = tables.wait(snapshot!.tableId, 1, ADA, ctl.signal);
      setTimeout(() => ctl.abort(), 20);
      const started = Date.now();
      await waiting;
      expect(Date.now() - started).toBeLessThan(500);
    });

    it("wakes for a deadline of the rules and commits what time changed", async () => {
      const { tables, clock } = setup({ longPollMs: 3000 });
      const { snapshot } = await tables.create("checkers", ADA, {});
      const id = snapshot!.tableId;
      await tables.act("checkers", id, { type: "arm", at: clock.now() + 30 }, ADA);
      const waiting = tables.wait(id, 2, ADA, never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      clock.advance(1000);
      const result = await waiting;
      expect(result.changed).toBe(true);
      expect((result.snapshot!.view as unknown as { n: number }).n).toBeGreaterThanOrEqual(1000);
    });

    it.each([
      { id: "pxxxxxxxxx", name: "an id of no game" },
      { id: "cmissing00", name: "a table that is gone" },
    ])("$name answers table_gone", async ({ id }) => {
      expect(await setup().tables.wait(id, 0, ADA, never)).toMatchObject({ changed: false, snapshot: null, notice: { code: "table_gone" } });
    });

    it("does not hold more than MAX_WAITERS callers", async () => {
      const { tables } = setup({ longPollMs: 300 });
      const { snapshot } = await tables.create("checkers", ADA, {});
      const id = snapshot!.tableId;
      const holding = Array.from({ length: MAX_WAITERS }, () => tables.wait(id, 1, ADA, never));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = Date.now();
      const over = await tables.wait(id, 1, ADA, never);
      expect(over.changed).toBe(false);
      expect(Date.now() - started).toBeLessThan(100);
      await Promise.all(holding);
    });
  });
});

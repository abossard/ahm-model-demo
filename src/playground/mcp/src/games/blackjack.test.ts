import { describe, expect, it } from "vitest";
import { BLACKJACK_LIMITS, CARDS } from "@playground/contracts";
import type { Player } from "@playground/contracts";
import type { BlackjackAction, DealerOutput, DealerRequest } from "../ports";
import { blackjack, handTotal, mixed } from "./blackjack";
import { fakeDealer } from "./fakeDealer";

const L = BLACKJACK_LIMITS;
const NOW = 1_000_000;
const SECOND = 1000;
const names = ["Ann", "Bob", "Cy", "Dee", "Eve", "Fay", "Gus"];
const people: Player[] = names.map((handle, i) => ({ id: `p-${String(i).repeat(8)}`, handle }));
const [ann, bob, cy] = people as [Player, Player, Player];

type Table = ReturnType<typeof blackjack.create>;
type Request<K extends DealerRequest["kind"]> = Extract<DealerRequest, { kind: K }>;

const act = (state: Table, action: BlackjackAction, by: Player, now = NOW) => blackjack.apply(state, action, by, now);
const table = (seats = 1, options: Record<string, unknown> = {}) =>
  people.slice(1, seats).reduce((state, person) => act(state, { type: "sit" }, person).state,
    blackjack.create(ann, options, NOW, 1));
const betAll = (state: Table, amount: number, now = NOW) =>
  people.reduce((next, person) => (next.seats.some((seat) => seat?.id === person.id)
    ? act(next, { type: "bet", amount }, person, now).state : next), state);
const view = (state: Table, who: Player | null = ann) => blackjack.view(state, who);
const pending = <K extends DealerRequest["kind"]>(state: Table, kind: K) => {
  const request = blackjack.pending(state);
  if (request?.kind !== kind) throw new Error(`expected a ${kind} request, got ${request?.kind}`);
  return request as Request<K>;
};
const reply = (output: DealerOutput) => ({ output, model: "test", ms: 5 });

// The head is dealt in order. The rest of the slice is made of diamonds and clubs no test deals.
const ordered = (count: number, head: string[]) =>
  [...head, ...CARDS.filter((card) => /[DC]$/.test(card) && !head.includes(card))].slice(0, count);
const shuffle = (state: Table, head: string[], now = NOW) => {
  const request = pending(state, "shuffle");
  return blackjack.resolve(state, request.id, reply({ cards: ordered(request.count, head), action: "stand", say: "" }), 1, now).state;
};
const decide = (state: Table, action: "hit" | "stand", now = NOW) =>
  blackjack.resolve(state, pending(state, "decide").id, reply({ cards: [], action, say: "" }), 1, now).state;
const fail = (state: Table, how: "invalid" | "unavailable", now = NOW) =>
  blackjack.resolve(state, blackjack.pending(state)!.id, how, 2, now).state;

// A round for the first `seats` players, each betting `amount`, dealt from `head`.
const dealt = (head: string[], seats = 1, amount = 100) => shuffle(betAll(table(seats), amount), head);
const withSeat = (state: Table, index: number, patch: Record<string, unknown>): Table =>
  ({ ...state, seats: state.seats.map((seat, i) => (i === index ? { ...seat!, ...patch } : seat)) });
const SAFE_HEAD = ["2S", "3S", "4S", "5S", "6S", "7S", "8S", "9S", "2H", "3H", "4H", "5H", "6H", "7H"];

describe("handTotal", () => {
  it.each<[string[], number, boolean]>([
    [[], 0, false],
    [["AS"], 11, true],
    [["AS", "AH"], 12, true],
    [["AS", "9S"], 20, true],
    [["AS", "9S", "5H"], 15, false],
    [["AS", "KS"], 21, true],
    [["AS", "AH", "9S"], 21, true],
    [["TS", "9S", "5H"], 24, false],
    [["KS", "QH"], 20, false],
  ])("%j is %i (soft %s)", (cards, total, soft) => {
    expect(handTotal(cards)).toEqual({ total, soft });
  });
});

describe("the table", () => {
  it("opens betting with the creator seated and 1,000 chips", () => {
    const state = table();
    expect(view(state)).toMatchObject({
      phase: "betting", round: 0, you: 0, turn: null, deadline: NOW + 15 * SECOND, misdeal: false, dealerLog: [],
      limits: { minBet: 10, maxBet: 500, betStep: 10 },
    });
    expect(view(state).seats[0]).toMatchObject({ handle: "Ann", chips: 1000, bet: 0, cards: [], state: "idle", outcome: null });
    expect(view(state).seats.filter((seat) => seat === null)).toHaveLength(5);
    expect(blackjack.lobby(state)).toEqual({ title: "Ann's table", seatsTaken: 1, seatsTotal: 6, status: "open" });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a given title", { title: "  High rollers " }, "High rollers"],
    ["a long title cut to 60", { title: "x".repeat(90) }, "x".repeat(60)],
    ["no title", {}, "Ann's table"],
  ])("uses %s", (_name, options, title) => {
    expect(view(blackjack.create(ann, options, NOW, 1)).title).toBe(title);
  });

  it("seats the next player in the first free seat, and a seated player once", () => {
    const two = act(table(), { type: "sit" }, bob).state;
    expect(view(two, bob).you).toBe(1);
    expect(act(two, { type: "sit" }, bob).state).toBe(two);
    expect(view(two, null).you).toBeNull();
  });

  it("answers a seventh player with table_full", () => {
    const full = table(6);
    const step = act(full, { type: "sit" }, people[6]!);
    expect(step.notice?.code).toBe("table_full");
    expect(step.state).toBe(full);
    expect(blackjack.lobby(full)).toMatchObject({ seatsTaken: 6, seatsTotal: 6 });
  });

  it("is a fast table when asked", () => {
    const state = act(table(2, { fast: true }), { type: "bet", amount: 100 }, ann).state;
    expect(blackjack.nextDeadline(state)).toBe(NOW + 2 * SECOND);
  });
});

describe("bets", () => {
  it.each<[string, number, number, number, number]>([
    ["a plain bet", 1000, 100, 100, 900],
    ["below the minimum", 1000, 5, 10, 990],
    ["between two steps", 1000, 25, 20, 980],
    ["above the maximum", 1000, 9999, 500, 500],
    ["a negative amount", 1000, -50, 10, 990],
    ["more than the chips", 35, 100, 30, 5],
  ])("%s is fitted", (_name, chips, amount, bet, left) => {
    const state = withSeat(table(), 0, { chips });
    const step = act(state, { type: "bet", amount }, ann);
    expect(step.notice).toBeNull();
    expect(view(step.state).seats[0]).toMatchObject({ bet, chips: left, state: "bet" });
  });

  it("answers too few chips for the minimum with insufficient_funds", () => {
    const state = withSeat(table(), 0, { chips: 5 });
    const step = act(state, { type: "bet", amount: 100 }, ann);
    expect(step.notice?.code).toBe("insufficient_funds");
    expect(step.state).toBe(state);
  });

  it("changes a bet and returns the difference", () => {
    const first = act(table(2), { type: "bet", amount: 100 }, ann).state;
    const second = act(first, { type: "bet", amount: 40 }, ann).state;
    expect(view(second).seats[0]).toMatchObject({ bet: 40, chips: 960 });
    expect(view(second).phase).toBe("betting");
  });

  it.each<[string, () => Table]>([
    ["players", () => dealt(SAFE_HEAD)],
    ["shuffling", () => betAll(table(), 100)],
    ["settled", () => fail(betAll(table(), 100), "unavailable")],
  ])("are closed in the %s phase", (_name, make) => {
    const state = make();
    const step = act(state, { type: "bet", amount: 100 }, ann);
    expect(step.notice?.code).toBe("wrong_phase");
    expect(step.state).toBe(state);
  });

  it("is refused for a player who is not seated", () => {
    expect(act(table(), { type: "bet", amount: 100 }, cy).notice?.code).toBe("not_seated");
  });
});

describe("the phases", () => {
  it("waiting: the first bet opens a 15 second betting window", () => {
    const state = act(table(2), { type: "bet", amount: 100 }, ann).state;
    expect(view(state)).toMatchObject({ phase: "betting", deadline: NOW + L.bettingSeconds * SECOND });
    expect(blackjack.nextDeadline(state)).toBe(NOW + 15 * SECOND);
    expect(blackjack.lobby(state).status).toBe("open");
    expect(blackjack.tick(state, NOW + 15 * SECOND - 1).state).toBe(state);
  });

  it.each<[number, number]>([[1, 10], [2, 15], [3, 20], [6, 35]])(
    "betting: %i bettors close the window at once and ask for %i cards", (seats, cards) => {
      const state = betAll(table(seats), 100);
      expect(view(state).phase).toBe("shuffling");
      const request = pending(state, "shuffle");
      expect(request.count).toBe(cards);
      expect(Object.values(request.remaining).reduce((a, b) => a + b, 0)).toBe(L.decks * 52);
      expect(request.previous).toEqual([]);
      expect(blackjack.lobby(state).status).toBe("playing");
    });

  it("betting: the deadline closes the window and a seat without a bet sits out", () => {
    const state = act(table(2), { type: "bet", amount: 100 }, ann).state;
    const closed = blackjack.tick(state, NOW + 15 * SECOND).state;
    expect(view(closed).phase).toBe("shuffling");
    expect(pending(closed, "shuffle").count).toBe(10);
    expect(view(closed).seats[1]).toMatchObject({ state: "idle", bet: 0 });
    expect(view(shuffle(closed, SAFE_HEAD)).seats[1]!.cards).toEqual([]);
  });

  it("betting: a seat is unseated after three rounds in a row without a bet", () => {
    let state = table(2);
    for (let round = 1; round <= 3; round++) {
      const at = NOW + round * 100 * SECOND;
      state = act(state, { type: "bet", amount: 100 }, ann, at).state;
      state = blackjack.tick(state, at + 15 * SECOND).state;
      expect(view(state).seats[1]).toEqual(round < 3 ? expect.objectContaining({ handle: "Bob" }) : null);
      state = blackjack.tick(fail(state, "unavailable", at + 16 * SECOND), at + 100 * SECOND - 1).state;
    }
    expect(view(state)).toMatchObject({ phase: "betting", round: 3 });
  });

  it("betting: a bet resets the missed count", () => {
    let state = act(table(2), { type: "bet", amount: 100 }, ann).state;
    state = fail(blackjack.tick(state, NOW + 15 * SECOND).state, "unavailable", NOW + 16 * SECOND);
    state = blackjack.tick(state, NOW + 30 * SECOND).state;
    state = act(state, { type: "bet", amount: 10 }, bob, NOW + 31 * SECOND).state;
    expect(state.seats[1]!.missed).toBe(0);
  });

  it("betting: a seat that never bets is unseated after three empty rounds, then the table waits", () => {
    let state = act(act(table(2), { type: "bet", amount: 100 }, ann).state, { type: "leave" }, ann).state;
    expect(view(state, bob).seats[0]).toBeNull();
    for (let round = 1; round <= 2; round++) {
      state = blackjack.tick(state, NOW + round * 15 * SECOND).state;
      expect(view(state, bob)).toMatchObject({ phase: "betting", deadline: NOW + (round + 1) * 15 * SECOND });
    }
    state = blackjack.tick(state, NOW + 45 * SECOND).state;
    expect(view(state, bob).seats[1]).toBeNull();
    expect(view(state, bob)).toMatchObject({ phase: "waiting", deadline: null });
  });

  it.each<[number]>([[1], [2], [6]])("shuffling: %i bettors are dealt seat by seat, then the dealer, twice", (seats) => {
    const state = dealt(SAFE_HEAD, seats);
    const head = SAFE_HEAD;
    const seatCards = state.seats.slice(0, seats).map((seat) => seat!.cards);
    expect(seatCards).toEqual(Array.from({ length: seats }, (_, i) => [head[i], head[seats + 1 + i]]));
    expect(state.dealer).toEqual([head[seats], head[2 * seats + 1]]);
    expect(view(state)).toMatchObject({ phase: "players", turn: 0, deadline: NOW + L.turnSeconds * SECOND });
    expect(view(state).dealer.cards).toEqual([head[seats], "??"]);
  });

  it("shuffling: leftover cards of the slice are returned and the shoe is renewed below 60", () => {
    const sums = (state: Table) => Object.values(pending(state, "shuffle").remaining).reduce((a, b) => a + b, 0);
    const low = { ...table(), remaining: Object.fromEntries(CARDS.map((card) => [card, card === "2S" ? 4 : 0])) };
    expect(sums(act(low, { type: "bet", amount: 100 }, ann).state)).toBe(208);
    const enough = { ...table(), remaining: Object.fromEntries(CARDS.map((card) => [card, /[SH]$/.test(card) ? 4 : 0])) };
    expect(sums(act(enough, { type: "bet", amount: 100 }, ann).state)).toBe(104);
  });

  it("players: the seats act in order and a deadline stands for the seat", () => {
    let state = dealt(SAFE_HEAD, 3);
    expect(view(state).turn).toBe(0);
    state = act(state, { type: "act", action: "stand" }, ann, NOW + SECOND).state;
    expect(view(state)).toMatchObject({ turn: 1, deadline: NOW + SECOND + 20 * SECOND });
    expect(view(state).seats[0]!.state).toBe("stood");
    state = blackjack.tick(state, NOW + 21 * SECOND).state;
    expect(view(state).seats[1]!.state).toBe("stood");
    expect(view(state).turn).toBe(2);
    state = act(state, { type: "act", action: "stand" }, cy, NOW + 22 * SECOND).state;
    expect(view(state)).toMatchObject({ phase: "dealer", turn: null });
  });

  it("players: 21 stands by itself and over 21 is bust", () => {
    const twentyOne = act(dealt(["5S", "9S", "6S", "8S", "TS"]), { type: "act", action: "hit" }, ann).state;
    expect(view(twentyOne)).toMatchObject({ phase: "dealer" });
    expect(view(twentyOne).seats[0]).toMatchObject({ state: "stood", total: 21 });
    const bust = act(dealt(["TS", "9S", "6S", "8S", "KS"]), { type: "act", action: "hit" }, ann).state;
    expect(view(bust)).toMatchObject({ phase: "settled" });
    expect(view(bust).seats[0]).toMatchObject({ state: "bust", total: 26, outcome: "lose", delta: -100 });
  });

  it("players: a natural does not act and is paid when the others are done", () => {
    const state = dealt(["AS", "2S", "3S", "KS", "5S", "6S", "7S", "8S"], 2);
    expect(view(state).seats[0]).toMatchObject({ state: "blackjack", total: 21 });
    expect(view(state)).toMatchObject({ phase: "players", turn: 1 });
  });

  it("players: the dealer is asked with the totals still in play", () => {
    const state = act(dealt(["TS", "AS", "8S", "6S"]), { type: "act", action: "stand" }, ann).state;
    expect(view(state)).toMatchObject({ phase: "dealer", dealer: { cards: ["AS", "6S"], total: 17 } });
    expect(pending(state, "decide")).toMatchObject({ hand: ["AS", "6S"], total: 17, soft: true, players: [18], hits: 0 });
  });

  it("settled: after 6 seconds the table is cleared and a bankrupt seat gets 1,000 back", () => {
    const start = withSeat(table(), 0, { chips: 100 });
    let state = shuffle(betAll(start, 100), ["8S", "TS", "8H", "9S"]);
    state = decide(act(state, { type: "act", action: "stand" }, ann).state, "stand");
    expect(view(state).seats[0]).toMatchObject({ chips: 0, outcome: "lose", delta: -100 });
    expect(view(state).deadline).toBe(NOW + 6 * SECOND);
    expect(blackjack.tick(state, NOW + 6 * SECOND - 1).state).toBe(state);
    const cleared = blackjack.tick(state, NOW + 6 * SECOND).state;
    expect(view(cleared)).toMatchObject({ phase: "betting", round: 1, misdeal: false, deadline: NOW + 21 * SECOND });
    expect(view(cleared).seats[0]).toMatchObject({ chips: 1000, bet: 0, cards: [], state: "idle", outcome: null, delta: 0 });
    expect(view(cleared).dealer).toEqual({ cards: [], total: 0, say: null });
  });
});

describe("payouts", () => {
  // Player cards are the first and third of the head, the dealer's the second and fourth, then draws in order.
  it.each<[string, string[], number, Array<"hit" | "stand" | "double">, Array<"hit" | "stand">, string, number]>([
    ["a win pays 1 to 1", ["TS", "9S", "9H", "8S"], 100, ["stand"], ["stand"], "win", 100],
    ["a loss costs the bet", ["8S", "TS", "8H", "9S"], 100, ["stand"], ["stand"], "lose", -100],
    ["equal totals push", ["TS", "TH", "8S", "8H"], 100, ["stand"], ["stand"], "push", 0],
    ["a natural pays 3 to 2", ["AS", "9S", "KS", "8S"], 100, [], [], "blackjack", 150],
    ["a natural on 10 pays 15", ["AS", "9S", "KS", "8S"], 10, [], [], "blackjack", 15],
    ["a natural on an odd multiple of 10 pays 3 to 2", ["AS", "9S", "KS", "8S"], 30, [], [], "blackjack", 45],
    ["a dealer natural beats 17 at once", ["9S", "AS", "8S", "KS"], 100, [], [], "lose", -100],
    ["two naturals push", ["AS", "AH", "KS", "KH"], 100, [], [], "push", 0],
    ["a bust loses and the dealer does not draw", ["TS", "9S", "6S", "8S", "KS"], 100, ["hit"], [], "lose", -100],
    ["a double that wins pays twice the bet", ["5S", "9S", "6S", "8S", "TS"], 100, ["double"], ["stand"], "win", 200],
    ["a double that loses costs twice the bet", ["5S", "TS", "6S", "8S", "2S"], 100, ["double"], ["stand"], "lose", -200],
    ["a dealer bust pays the players", ["TS", "6S", "8S", "TH", "KS"], 100, ["stand"], ["hit"], "win", 100],
    ["five hits end the dealer's turn", ["TS", "2S", "8S", "2H", "2D", "2C", "3S", "3H", "3D"], 100, ["stand"], ["hit", "hit", "hit", "hit", "hit"], "win", 100],
  ])("%s", (_name, head, amount, actions, decisions, outcome, delta) => {
    let state = dealt(head, 1, amount);
    for (const action of actions) state = act(state, { type: "act", action }, ann).state;
    for (const decision of decisions) state = decide(state, decision);
    const seat = view(state).seats[0]!;
    expect(view(state).phase).toBe("settled");
    expect(blackjack.pending(state)).toBeNull();
    expect(seat).toMatchObject({ outcome, delta, chips: 1000 + delta, bet: amount * (actions.includes("double") ? 2 : 1) });
  });

  it("emits blackjack_win for every winning seat and for no one else", () => {
    const head = ["TS", "8H", "TD", "9S", "9H", "8D", "9D", "8S"];
    let state = dealt(head, 3);
    state = act(state, { type: "act", action: "stand" }, ann).state;
    state = act(state, { type: "act", action: "stand" }, bob).state;
    const last = act(state, { type: "act", action: "stand" }, cy);
    expect(last.events).toEqual([]);
    const settled = blackjack.resolve(last.state, pending(last.state, "decide").id, reply({ cards: [], action: "stand", say: "" }), 1, NOW);
    expect(view(settled.state).seats.slice(0, 3).map((seat) => seat!.outcome)).toEqual(["win", "lose", "win"]);
    expect(settled.events).toEqual([
      { playerId: ann.id, event: { type: "blackjack_win" } },
      { playerId: cy.id, event: { type: "blackjack_win" } },
    ]);
  });
});

describe("the dealer", () => {
  it("logs each call and shows the dealer's words", () => {
    const state = betAll(table(), 100);
    const request = pending(state, "shuffle");
    const said = blackjack.resolve(state, request.id, reply({ cards: ordered(10, SAFE_HEAD), action: "stand", say: "x".repeat(200) }), 2, NOW + 3 * SECOND);
    expect(view(said.state).dealer.say).toBe("x".repeat(120));
    expect(view(said.state).dealerLog).toEqual([
      { at: NOW + 3 * SECOND, kind: "shuffle", ok: true, attempts: 2, ms: 5, model: "test", note: "ordered 10 cards" },
    ]);
    const hit = decide(act(said.state, { type: "act", action: "stand" }, ann).state, "hit");
    expect(view(hit).dealerLog.at(-1)).toMatchObject({ kind: "decide", ok: true, note: expect.stringMatching(/^hit on \d+$/) });
  });

  it("ignores a reply to a request that is no longer pending", () => {
    const state = betAll(table(), 100);
    const stale = blackjack.resolve(state, "0-99", reply({ cards: [], action: "stand", say: "" }), 1, NOW);
    expect(stale.state).toBe(state);
    const done = shuffle(state, SAFE_HEAD);
    const again = blackjack.resolve(done, pending(state, "shuffle").id, reply({ cards: [], action: "stand", say: "" }), 1, NOW);
    expect(again.state).toBe(done);
  });

  it("asks for ten more cards when the slice runs out and finishes the action afterwards", () => {
    const head = ["2S", "9S", "3S", "8S", "2H", "2D", "2C", "3H", "3D", "3C"];
    let state = dealt(head);
    for (let i = 0; i < 6; i++) state = act(state, { type: "act", action: "hit" }, ann).state;
    expect(view(state).seats[0]).toMatchObject({ total: 20, state: "playing" });
    const hit = act(state, { type: "act", action: "hit" }, ann);
    expect(hit.notice).toBeNull();
    expect(view(hit.state)).toMatchObject({ phase: "shuffling", turn: null });
    expect(pending(hit.state, "shuffle").count).toBe(10);
    const busy = act(hit.state, { type: "act", action: "hit" }, ann);
    expect(busy.notice?.code).toBe("dealer_busy");
    expect(busy.state).toBe(hit.state);
    const resumed = shuffle(hit.state, ["AS"]);
    expect(view(resumed).seats[0]).toMatchObject({ total: 21, state: "stood" });
    expect(view(resumed).seats[0]!.cards).toHaveLength(9);
    expect(view(resumed).phase).toBe("dealer");
  });

  it("a reply that breaks the shoe is a misdeal with the reason in the log", () => {
    const state = betAll({ ...table(), remaining: { ...table().remaining, KS: 0 } }, 100);
    const request = pending(state, "shuffle");
    const bad = blackjack.resolve(state, request.id, reply({ cards: ["KS", ...ordered(9, [])], action: "stand", say: "" }), 1, NOW).state;
    expect(view(bad)).toMatchObject({ phase: "settled", misdeal: true });
    expect(view(bad).dealerLog[0]).toMatchObject({ ok: false, note: "reply rejected: KS is not left in the shoe" });
  });

  it.each<[string, number]>([["just before 25 seconds", 25 * SECOND - 1], ["at 25 seconds", 25 * SECOND]])(
    "a request that waits is a misdeal %s", (_name, wait) => {
      const state = betAll(table(), 100);
      expect(blackjack.nextDeadline(state)).toBe(NOW + 25 * SECOND);
      const later = blackjack.tick(state, NOW + wait).state;
      if (wait < 25 * SECOND) expect(later).toBe(state);
      else expect(view(later)).toMatchObject({ phase: "settled", misdeal: true });
    });

  it("a decision that waits is a misdeal too", () => {
    const state = act(dealt(["TS", "9S", "8S", "7S"]), { type: "act", action: "stand" }, ann, NOW).state;
    expect(view(blackjack.tick(state, NOW + 25 * SECOND).state)).toMatchObject({ phase: "settled", misdeal: true });
  });

  it.each<[string, number, number, string]>([
    ["nine calls leave room for one more", 8, 1, "dealer"],
    ["the tenth call is the last", 9, 1, "settled"],
    ["a retry counts as a call", 8, 2, "settled"],
  ])("the round cap: %s", (_name, calls, attempts, phase) => {
    const state = { ...act(dealt(["TS", "6S", "8S", "TH"]), { type: "act", action: "stand" }, ann).state, calls };
    const hit = blackjack.resolve(state, pending(state, "decide").id, reply({ cards: [], action: "hit", say: "" }), attempts, NOW).state;
    expect(view(hit)).toMatchObject({ phase, misdeal: phase === "settled" });
  });

  it.each<[string, number, number, boolean]>([
    ["120 calls in the hour end the round", NOW, 120, true],
    ["119 calls do not", NOW, 119, false],
    ["the hour passing resets the count", NOW - 3600 * SECOND, 120, false],
  ])("the table cap: %s", (_name, hourStart, hourCalls, misdeal) => {
    const state = betAll({ ...table(), hourStart, hourCalls }, 100);
    expect(view(state).misdeal).toBe(misdeal);
    expect(view(state).phase).toBe(misdeal ? "settled" : "shuffling");
  });
});

describe("validate", () => {
  const shuffleRequest = (patch: Partial<Request<"shuffle">> = {}): Request<"shuffle"> => ({
    id: "1", kind: "shuffle", count: 3, previous: [],
    remaining: Object.fromEntries(CARDS.map((card) => [card, 4])), ...patch,
  });
  const decideRequest = (hits: number, total = 16, soft = false): Request<"decide"> =>
    ({ id: "2", kind: "decide", hand: ["TS", "6S"], total, soft, players: [18], hits });
  const output = (patch: Partial<DealerOutput>): DealerOutput => ({ cards: ["AS", "2S", "3S"], action: "stand", say: "", ...patch });

  it.each<[string, DealerRequest, DealerOutput, string[]]>([
    ["a good shuffle", shuffleRequest(), output({}), []],
    ["a long say is never a reason", shuffleRequest(), output({ say: "x".repeat(500) }), []],
    ["too few cards", shuffleRequest(), output({ cards: ["AS"] }), ["expected 3 cards, got 1"]],
    ["too many cards", shuffleRequest(), output({ cards: ["AS", "2S", "3S", "4S"] }), ["expected 3 cards, got 4"]],
    ["a code that is no card", shuffleRequest(), output({ cards: ["AS", "ZZ", "3S"] }), ["ZZ is not a card code"]],
    ["a card that is gone", shuffleRequest({ remaining: { ...shuffleRequest().remaining, AS: 0 } }), output({}), ["AS is not left in the shoe"]],
    ["more copies than are left", shuffleRequest({ remaining: { ...shuffleRequest().remaining, AS: 1 } }), output({ cards: ["AS", "AS", "3S"] }), ["AS is not left in the shoe"]],
    ["a decision with cards", decideRequest(0), output({ action: "hit" }), ["a decision carries no cards"]],
    ["a hit after four hits", decideRequest(4), output({ cards: [], action: "hit" }), []],
    ["a hit after five hits", decideRequest(5), output({ cards: [], action: "hit" }), ["the dealer must stand after five hits"]],
    ["a stand after five hits", decideRequest(5), output({ cards: [], action: "stand" }), []],
    ["a stand on 16", decideRequest(0), output({ cards: [], action: "stand" }), ["the house rule is to hit on 16"]],
    ["a hit on 17", decideRequest(0, 17), output({ cards: [], action: "hit" }), ["the house rule is to stand on 17"]],
    ["a hit on soft 17", decideRequest(1, 17, true), output({ cards: [], action: "hit" }), ["the house rule is to stand on 17"]],
    ["a stand on 17", decideRequest(0, 17), output({ cards: [], action: "stand" }), []],
  ])("%s", (_name, request, reply, problems) => {
    expect(blackjack.validate(request, reply)).toEqual(problems);
  });
});

describe("mixed", () => {
  const full = Object.fromEntries(CARDS.map((card) => [card, 6]));

  it.each<[number]>([[1], [2], [42], [0xdeadbeef]])("keeps every copy and leaves the aces off the front for seed %i", (seed) => {
    const order = mixed(full, seed);
    expect(order).toEqual(full);
    expect(Object.keys(order).slice(0, 4)).not.toEqual(["AS", "AH", "AD", "AC"]);
  });

  it.each<[number, number]>([[1, 2], [7, 8], [100, 101]])("gives seeds %i and %i different orders", (a, b) => {
    expect(Object.keys(mixed(full, a))).not.toEqual(Object.keys(mixed(full, b)));
  });
});

describe("prompt", () => {
  it("names the house custom and the request", () => {
    const shuffleText = blackjack.prompt({
      id: "1", kind: "shuffle", count: 15, previous: ["AS"], remaining: { AS: 3, KS: 0 },
    });
    expect(shuffleText.system).toMatch(/hits on 16 or less and stands on 17 or more/);
    expect(shuffleText.user).toContain("15 cards");
    expect(shuffleText.user).toContain("AS 3");
    expect(shuffleText.user).not.toContain("KS 0");
    const decideText = blackjack.prompt({ id: "2", kind: "decide", hand: ["AS", "6S"], total: 17, soft: true, players: [18, 20], hits: 1 });
    expect(decideText.user).toContain("AS 6S");
    expect(decideText.user).toContain("17, soft");
    expect(decideText.user).not.toContain("18, 20");
  });
});

describe("fakeDealer", () => {
  const remainingWith = (gone: string[], copies = 4) =>
    Object.fromEntries(CARDS.map((card) => [card, gone.includes(card) ? 0 : copies]));
  const shuffleOf = (count: number, remaining: Record<string, number>): Request<"shuffle"> =>
    ({ id: "1", kind: "shuffle", count, previous: [], remaining });

  it("walks T 7 9 5 K 6 A 8 3 Q 4 2 J across the suits from (cards left) mod 52", () => {
    expect(fakeDealer(shuffleOf(10, remainingWith([]))).cards).toEqual(["TS", "7S", "9S", "5S", "KS", "6S", "AS", "8S", "3S", "QS"]);
    const skipping = fakeDealer(shuffleOf(5, remainingWith(["TS", "7S"]))).cards;
    expect(skipping).toEqual(["6C", "AC", "8C", "3C", "QC"]);
  });

  it("goes round again when a card has several copies", () => {
    const cards = fakeDealer(shuffleOf(60, remainingWith([]))).cards;
    expect(cards.slice(52, 54)).toEqual(["TS", "7S"]);
  });

  it.each<[string, DealerRequest["kind"] extends never ? never : Request<"decide">, string]>([
    ["hits below 17", { id: "1", kind: "decide", hand: ["TS", "6S"], total: 16, soft: false, players: [], hits: 0 }, "hit"],
    ["stands on 17", { id: "1", kind: "decide", hand: ["TS", "7S"], total: 17, soft: false, players: [], hits: 0 }, "stand"],
    ["stands after five hits", { id: "1", kind: "decide", hand: ["2S"], total: 12, soft: false, players: [], hits: 5 }, "stand"],
  ])("decides: %s", (_name, request, action) => {
    expect(fakeDealer(request).action).toBe(action);
  });

  it.each<[string, DealerRequest]>([
    ["a full shoe", shuffleOf(10, remainingWith([]))],
    ["a partial shoe", shuffleOf(35, remainingWith(["AS", "KH", "7D"], 2))],
    ["one card per kind", shuffleOf(52, remainingWith([], 1))],
    ["the last cards", shuffleOf(3, { ...remainingWith(CARDS, 0), AS: 1, "2S": 1, "3S": 2 })],
    ["a hit", { id: "1", kind: "decide", hand: ["2S", "3S"], total: 5, soft: false, players: [18], hits: 0 }],
    ["a stand", { id: "1", kind: "decide", hand: ["TS", "9S"], total: 19, soft: false, players: [18], hits: 0 }],
  ])("always passes validate: %s", (_name, request) => {
    expect(blackjack.validate(request, fakeDealer(request))).toEqual([]);
  });
});

describe("the view", () => {
  const HOLE = "7S";
  const unseen = /"[A2-9TJQK][DC]"/;
  const phases: Array<[string, () => Table]> = [
    ["waiting", () => table()],
    ["betting", () => act(table(2), { type: "bet", amount: 100 }, ann).state],
    ["shuffling", () => betAll(table(), 100)],
    ["players", () => dealt(["TS", "9S", "8S", HOLE])],
    ["dealer", () => act(dealt(["TS", "9S", "8S", HOLE]), { type: "act", action: "stand" }, ann).state],
    ["settled", () => decide(act(dealt(["TS", "9S", "8S", HOLE]), { type: "act", action: "stand" }, ann).state, "stand")],
  ];

  it.each(phases)("never includes the slice or the pool: %s", (_name, make) => {
    const json = JSON.stringify([view(make(), ann), view(make(), bob), view(make(), null)]);
    expect(json).not.toMatch(unseen);
    expect(json).not.toContain("remaining");
    expect(json).not.toContain("slice");
  });

  it.each(phases)("shows the hole card only from the dealer phase: %s", (name, make) => {
    const dealerCards = view(make()).dealer.cards;
    if (name === "players") expect(dealerCards).toEqual(["9S", "??"]);
    else if (name === "dealer" || name === "settled") expect(dealerCards).toEqual(["9S", HOLE]);
    else expect(dealerCards).toEqual([]);
    if (name === "players") expect(JSON.stringify(view(make()))).not.toContain(HOLE);
  });

  it("counts only the face-up cards of the dealer", () => {
    expect(view(dealt(["TS", "9S", "8S", HOLE])).dealer.total).toBe(9);
  });

  it("hides the hole card while a hit waits for a shuffle in the same round", () => {
    let state = dealt(["2S", "9S", "3S", HOLE, "2H", "2D", "2C", "3H", "3D", "3C"]);
    for (let i = 0; i < 7; i++) state = act(state, { type: "act", action: "hit" }, ann).state;
    expect(view(state).phase).toBe("shuffling");
    expect(JSON.stringify(view(state))).not.toContain(HOLE);
    expect(view(state).dealer.cards).toEqual(["9S", "??"]);
  });

  it("shows the same table to every viewer except for `you`", () => {
    const state = dealt(SAFE_HEAD, 2);
    expect({ ...view(state, ann), you: null }).toEqual({ ...view(state, bob), you: null });
    expect([view(state, ann).you, view(state, bob).you, view(state, cy).you]).toEqual([0, 1, null]);
  });
});

describe("leaving", () => {
  it("in waiting gives up the seat", () => {
    expect(view(act(table(2), { type: "leave" }, bob).state).seats[1]).toBeNull();
  });

  it("in betting returns the bet, and closes the window when the rest have bet", () => {
    let state = act(table(3), { type: "bet", amount: 100 }, ann).state;
    state = act(state, { type: "bet", amount: 100 }, bob).state;
    expect(view(state).phase).toBe("betting");
    state = act(state, { type: "leave" }, cy).state;
    expect(view(state).phase).toBe("shuffling");
    expect(view(state).seats[2]).toBeNull();
  });

  it("with a bet in play keeps the hand, stands for it, and clears the seat after the round", () => {
    let state = dealt(SAFE_HEAD, 2);
    state = act(state, { type: "leave" }, bob).state;
    expect(view(state).seats[1]).toMatchObject({ bet: 100, state: "playing" });
    state = act(state, { type: "act", action: "stand" }, ann).state;
    expect(view(state)).toMatchObject({ phase: "dealer" });
    expect(view(state).seats[1]!.state).toBe("stood");
    state = decide(state, "stand");
    expect(view(state).seats[1]!.outcome).not.toBeNull();
    const cleared = blackjack.tick(state, NOW + 6 * SECOND).state;
    expect(view(cleared).seats[1]).toBeNull();
  });

  it("on the turn of the leaver stands at once", () => {
    const state = act(dealt(SAFE_HEAD, 2), { type: "leave" }, ann).state;
    expect(view(state)).toMatchObject({ turn: 1 });
    expect(view(state).seats[0]!.state).toBe("stood");
  });

  it("sitting again before the round ends keeps the seat", () => {
    const left = act(dealt(SAFE_HEAD, 2), { type: "leave" }, bob).state;
    const back = act(left, { type: "sit" }, bob).state;
    expect(back.seats[1]!.leaving).toBe(false);
  });

  it("is refused for a player who is not seated", () => {
    expect(act(table(), { type: "leave" }, cy).notice?.code).toBe("not_seated");
  });
});

describe("acting", () => {
  it.each<[string, () => Table, typeof ann, "hit" | "stand" | "double", string]>([
    ["a stranger", () => dealt(SAFE_HEAD), cy, "hit", "not_seated"],
    ["before the deal", () => table(), ann, "stand", "wrong_phase"],
    ["during betting", () => act(table(2), { type: "bet", amount: 100 }, ann).state, ann, "stand", "wrong_phase"],
    ["during the dealer's turn", () => act(dealt(SAFE_HEAD), { type: "act", action: "stand" }, ann).state, ann, "stand", "wrong_phase"],
    ["out of turn", () => dealt(SAFE_HEAD, 2), bob, "hit", "not_your_turn"],
    ["a double on three cards", () => act(dealt(["2S", "9S", "3S", "8S", "2H"]), { type: "act", action: "hit" }, ann).state, ann, "double", "illegal_move"],
    ["a double without the chips", () => withSeat(dealt(SAFE_HEAD), 0, { chips: 50 }), ann, "double", "insufficient_funds"],
    ["a hit while the dealer shuffles", () => betAll(table(), 100), ann, "hit", "dealer_busy"],
  ])("refuses %s", (_name, make, who, action, code) => {
    const state = make();
    const step = act(state, { type: "act", action }, who);
    expect(step.notice?.code).toBe(code);
    expect(step.state).toBe(state);
    expect(step.events).toEqual([]);
  });
});

describe("the clock", () => {
  it.each<[string, () => Table]>([
    ["waiting", () => table()],
    ["players before the deadline", () => dealt(SAFE_HEAD)],
  ])("returns the same state when nothing is due: %s", (_name, make) => {
    const state = make();
    expect(blackjack.tick(state, NOW + 1).state).toBe(state);
  });

  it.each<[string, Record<string, unknown>, number]>([
    ["a normal table", {}, 15],
    ["a fast table", { fast: true }, 2],
  ])("%s gives an empty window the full 15 seconds and %i seconds after the first bet", (_name, options, afterBet) => {
    const state = table(2, options);
    expect(blackjack.nextDeadline(state)).toBe(NOW + 15 * SECOND);
    const bet = act(state, { type: "bet", amount: 100 }, ann, NOW + 5 * SECOND).state;
    expect(blackjack.nextDeadline(bet)).toBe(NOW + (5 + afterBet) * SECOND);
  });

  it("reports the deadline of each phase", () => {
    expect(blackjack.nextDeadline(table())).toBe(NOW + 15 * SECOND);
    expect(blackjack.nextDeadline(betAll(table(), 100))).toBe(NOW + 25 * SECOND);
    expect(blackjack.nextDeadline(dealt(SAFE_HEAD))).toBe(NOW + 20 * SECOND);
  });
});

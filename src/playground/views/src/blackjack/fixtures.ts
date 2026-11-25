// Table snapshots for tests and for building the View without a server.
import type { BlackjackView, SeatView } from "@playground/contracts";

const seat = (n: number, patch: Partial<SeatView> = {}): SeatView => ({
  id: `player-0000000${n}`, handle: ["Neon Rook", "Dusty Marker", "Lucky Switch", "Quiet Broker", "Chrome Runner", "Velvet Dealer"][n]!,
  chips: 1000, bet: 0, cards: [], total: 0, state: "idle", outcome: null, delta: 0, ...patch,
});

export const limits = { minBet: 10, maxBet: 500, betStep: 10 };

export const emptyTable: BlackjackView = {
  title: "Table of the night", phase: "waiting", round: 0, seats: [null, null, null, null, null, null],
  you: null, turn: null, deadline: null, dealer: { cards: [], total: 0, say: null }, misdeal: false, dealerLog: [], limits,
};

export const betting: BlackjackView = {
  ...emptyTable, phase: "betting", round: 3, you: 1, deadline: 15_000,
  seats: [seat(0, { bet: 100, state: "bet", chips: 900 }), seat(1, { chips: 760 }), null, seat(3, { chips: 1200 }), null, null],
};

export const playing: BlackjackView = {
  ...emptyTable, phase: "players", round: 3, you: 1, turn: 1, deadline: 20_000,
  seats: [
    seat(0, { bet: 100, chips: 900, cards: ["TS", "9H"], total: 19, state: "stood" }),
    seat(1, { bet: 50, chips: 710, cards: ["7D", "4C"], total: 11, state: "playing" }),
    null,
    seat(3, { bet: 200, chips: 1000, cards: ["AS", "KD"], total: 21, state: "blackjack" }),
    null, null,
  ],
  dealer: { cards: ["6C", "??"], total: 6, say: "Show me what you have." },
  dealerLog: [{ at: 1, kind: "shuffle", ok: true, attempts: 1, ms: 840, model: "gpt-54-mini", note: "ordered 15 cards" }],
};

export const settled: BlackjackView = {
  ...playing, phase: "settled", turn: null, deadline: 6_000,
  seats: [
    seat(0, { bet: 100, chips: 1000, cards: ["TS", "9H"], total: 19, state: "stood", outcome: "win", delta: 100 }),
    seat(1, { bet: 50, chips: 660, cards: ["7D", "4C", "KH"], total: 21, state: "stood", outcome: "win", delta: 50 }),
    null,
    seat(3, { bet: 200, chips: 1300, cards: ["AS", "KD"], total: 21, state: "blackjack", outcome: "blackjack", delta: 300 }),
    null, null,
  ],
  dealer: { cards: ["6C", "5D", "7H"], total: 18, say: "Eighteen. Stand." },
  dealerLog: [
    { at: 1, kind: "shuffle", ok: false, attempts: 2, ms: 2100, model: "gpt-54-mini", note: "reply rejected: KS is not left in the shoe" },
    { at: 2, kind: "shuffle", ok: true, attempts: 1, ms: 840, model: "gpt-54-mini", note: "ordered 15 cards" },
    { at: 3, kind: "decide", ok: true, attempts: 1, ms: 610, model: "gpt-54-mini", note: "hit on 11" },
  ],
};

export const misdeal: BlackjackView = {
  ...settled, misdeal: true,
  seats: settled.seats.map((s) => (s ? { ...s, outcome: "misdeal" as const, delta: 0 } : s)),
};

import { describe, expect, it } from "vitest";
import type { BlackjackView } from "@playground/contracts";
import { betting, emptyTable, misdeal, playing, settled } from "./fixtures";
import {
  betChoices, canBet, canSit, cardFace, chipStack, dealerSay, dealerTotalText, formatMs, mindRows, myActions,
  cardTransitionName, clockFraction, phaseLine, seatBadge, seatTransitionName, signedChips, stepBet, thinking,
} from "./logic";

const patchSeat = (view: BlackjackView, index: number, patch: object): BlackjackView => ({
  ...view, seats: view.seats.map((s, i) => (i === index && s ? { ...s, ...patch } : s)),
});

describe("cardFace", () => {
  it.each([
    ["AS", { rank: "A", suit: "S", red: false, hidden: false, label: "A of spades" }],
    ["TD", { rank: "10", suit: "D", red: true, hidden: false, label: "10 of diamonds" }],
    ["QH", { rank: "Q", suit: "H", red: true, hidden: false, label: "Q of hearts" }],
    ["2C", { rank: "2", suit: "C", red: false, hidden: false, label: "2 of clubs" }],
    ["??", { rank: "", suit: null, red: false, hidden: true, label: "Face-down card" }],
  ])("%s", (code, face) => {
    expect(cardFace(code)).toEqual(face);
  });
});

describe("clockFraction", () => {
  it.each([
    ["betting", 7.5, 0.5], ["players", 20, 1], ["waiting", 5, 0], ["settled", null, 0], ["betting", 99, 1], ["dealer", 0, 0],
  ] as const)("%s with %s s left fills %f", (phase, seconds, expected) => {
    expect(clockFraction(phase, seconds)).toBeCloseTo(expected);
  });
});

describe("phaseLine", () => {
  it.each([
    ["waiting", emptyTable, "Take a seat and place a bet. The first bet starts the clock."],
    ["your turn", playing, "Your turn."],
    ["another seat's turn", { ...playing, turn: 0 }, "Neon Rook is deciding."],
    ["shuffling", { ...betting, phase: "shuffling" as const }, "The dealer is shuffling. That is a language model putting cards in order."],
    ["misdeal", misdeal, "Misdeal. The dealer's reply failed the check. All bets are returned."],
  ])("%s", (_name, view, text) => {
    expect(phaseLine(view)).toBe(text);
  });
});

describe("canSit", () => {
  it.each([
    ["watching, free seats", emptyTable, true],
    ["already seated", betting, false],
    ["table full", { ...emptyTable, seats: playing.seats.map((s, i) => s ?? { ...playing.seats[0]!, id: `player-fill-${i}` }) }, false],
  ])("%s", (_name, view, expected) => {
    expect(canSit(view)).toBe(expected);
  });
});

describe("betting", () => {
  it.each([
    ["all chips on a full stack", betting, [10, 50, 100, 250, 500]],
    ["short stack", patchSeat(betting, 1, { chips: 60 }), [10, 50]],
    ["placed bet counts as stack", patchSeat(betting, 1, { chips: 0, bet: 100 }), [10, 50, 100]],
    ["not seated", emptyTable, []],
  ])("choices: %s", (_name, view, expected) => {
    expect(betChoices(view)).toEqual(expected);
  });

  it.each([
    ["betting phase", betting, true],
    ["players phase", playing, false],
    ["not seated", emptyTable, false],
    ["broke", patchSeat(betting, 1, { chips: 0 }), false],
  ])("canBet: %s", (_name, view, expected) => {
    expect(canBet(view)).toBe(expected);
  });

  it.each([
    ["up from zero", betting, 1, 10],
    ["down from zero", betting, -1, null],
    ["up", patchSeat(betting, 1, { bet: 100 }), 1, 110],
    ["down to the minimum", patchSeat(betting, 1, { bet: 20 }), -1, 10],
    ["up at the table maximum", patchSeat(betting, 1, { bet: 500 }), 1, null],
    ["up at the end of the stack", patchSeat(betting, 1, { chips: 0, bet: 100 }), 1, null],
  ])("stepBet: %s", (_name, view, direction, expected) => {
    expect(stepBet(view, direction as 1 | -1)).toBe(expected);
  });
});

describe("myActions", () => {
  it.each([
    ["two cards, chips to cover", playing, ["hit", "stand", "double"]],
    ["three cards", patchSeat(playing, 1, { cards: ["2D", "3C", "4H"] }), ["hit", "stand"]],
    ["not enough to double", patchSeat(playing, 1, { chips: 10 }), ["hit", "stand"]],
    ["another seat's turn", { ...playing, turn: 0 }, []],
    ["already stood", patchSeat(playing, 1, { state: "stood" }), []],
    ["dealer phase", { ...playing, phase: "dealer" as const }, []],
    ["watching", { ...playing, you: null }, []],
  ])("%s", (_name, view, expected) => {
    expect(myActions(view)).toEqual(expected);
  });
});

describe("signedChips", () => {
  it.each([[0, "0"], [50, "+50"], [-100, "−100"], [1500, "+1,500"]])("%i", (delta, text) => {
    expect(signedChips(delta)).toBe(text);
  });
});

describe("seatBadge", () => {
  it.each([
    ["win", settled, 0, { text: "Win +100", tone: "good" }],
    ["blackjack", settled, 3, { text: "Blackjack +300", tone: "good" }],
    ["misdeal returns bets", misdeal, 0, { text: "Returned", tone: "neutral" }],
    ["acting", playing, 1, { text: "Acting", tone: "live" }],
    ["stood", playing, 0, { text: "Stood", tone: "neutral" }],
    ["natural", playing, 3, { text: "Blackjack", tone: "good" }],
    ["bet placed", betting, 0, { text: "Bet placed", tone: "neutral" }],
    ["still deciding", betting, 1, { text: "Deciding bet", tone: "neutral" }],
  ])("%s", (_name, view, index, badge) => {
    expect(seatBadge(view.seats[index]!, view, index)).toEqual(badge);
  });
  it("shows a loss", () => {
    const view = patchSeat(settled, 0, { outcome: "lose", delta: -100 });
    expect(seatBadge(view.seats[0]!, view, 0)).toEqual({ text: "Lose −100", tone: "bad" });
  });
});

describe("chipStack", () => {
  it.each([
    [0, []],
    [10, [{ value: 10, count: 1 }]],
    [90, [{ value: 50, count: 1 }, { value: 10, count: 4 }]],
    [160, [{ value: 100, count: 1 }, { value: 50, count: 1 }, { value: 10, count: 1 }]],
    [500, [{ value: 500, count: 1 }]],
    [3000, [{ value: 500, count: 5 }]],
  ])("%i", (amount, stacks) => {
    expect(chipStack(amount)).toEqual(stacks);
  });
});

describe("dealer text", () => {
  it.each([
    [{ cards: [], total: 0, say: null }, ""],
    [{ cards: ["6C", "??"], total: 6, say: null }, "6 + ?"],
    [{ cards: ["6C", "5D", "7H"], total: 18, say: null }, "18"],
  ])("total %o", (dealer, text) => {
    expect(dealerTotalText(dealer)).toBe(text);
  });
  it.each([[null, null], ["   ", null], ["Stand.", "“Stand.”"]])("say %s", (say, expected) => {
    expect(dealerSay(say)).toBe(expected);
  });
});

describe("mind", () => {
  it.each([[420, "420 ms"], [999, "999 ms"], [1000, "1.0 s"], [2140, "2.1 s"]])("formatMs %i", (ms, text) => {
    expect(formatMs(ms)).toBe(text);
  });
  it("lists newest first and says what the check decided", () => {
    const rows = mindRows(settled.dealerLog);
    expect(rows.map((r) => [r.title, r.verdict, r.tone])).toEqual([
      ["Played the hand", "Accepted", "good"],
      ["Ordered the shoe", "Accepted", "good"],
      ["Ordered the shoe", "Rejected", "bad"],
    ]);
    expect(rows[2]!.meta).toBe("2.1 s · 2 attempts · gpt-54-mini");
    expect(rows[2]!.note).toBe("reply rejected: KS is not left in the shoe");
  });
  it.each([
    [{ ...betting, phase: "shuffling" as const }, "Ordering the shoe…"],
    [{ ...playing, phase: "dealer" as const }, "Choosing hit or stand…"],
    [playing, null],
    [{ ...misdeal, phase: "shuffling" as const }, null],
  ])("thinking", (view, text) => {
    expect(thinking(view)).toBe(text);
  });
});

describe("transition names", () => {
  it.each([
    [cardTransitionName("dealer", 0), "card-dealer-0"],
    [cardTransitionName(2, 1), "card-s2-1"],
    [seatTransitionName("stack", 0), "stack-s0"],
    [seatTransitionName("bet", 3), "bet-s3"],
    [seatTransitionName("chips", 1), "chips-s1"],
  ])("%s", (name, expected) => {
    expect(name).toBe(expected);
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

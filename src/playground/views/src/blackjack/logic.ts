// Blackjack view logic. Calculations only: no React, no clock, no I/O. The table never works out a rule here:
// totals, outcomes and deadlines all arrive in the snapshot. This file only decides what to show.
import { BLACKJACK_LIMITS, HIDDEN_CARD, type BlackjackView, type DealerLogEntry, type SeatView } from "@playground/contracts";

export type Phase = BlackjackView["phase"];
export type Action = "hit" | "stand" | "double";

export interface CardFace {
  hidden: boolean;
  rank: string;
  suit: "S" | "H" | "D" | "C" | null;
  red: boolean;
  label: string;
}

export function cardFace(code: string): CardFace {
  if (code === HIDDEN_CARD) return { hidden: true, rank: "", suit: null, red: false, label: "Face-down card" };
  const rank = code[0] ?? "";
  const suit = (code[1] ?? "S") as "S" | "H" | "D" | "C";
  const shown = rank === "T" ? "10" : rank;
  const names = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" } as const;
  return { hidden: false, rank: shown, suit, red: suit === "H" || suit === "D", label: `${shown} of ${names[suit]}` };
}

export const PHASE_LINE: Record<Phase, string> = {
  waiting: "Take a seat and place a bet. The first bet starts the clock.",
  betting: "Bets are open.",
  shuffling: "The dealer is shuffling. That is a language model putting cards in order.",
  players: "Players act.",
  dealer: "The dealer plays the hand. That is a language model choosing hit or stand.",
  settled: "Round settled.",
};

export const PHASE_NAME: Record<Phase, string> = {
  waiting: "Waiting", betting: "Betting", shuffling: "Shuffling", players: "Players", dealer: "Dealer", settled: "Settled",
};

export function phaseLine(view: BlackjackView): string {
  if (view.misdeal) return "Misdeal. The dealer's reply failed the check. All bets are returned.";
  if (view.phase === "players") {
    const mine = view.you !== null && view.you === view.turn;
    if (mine) return "Your turn.";
    const seat = view.turn === null ? null : view.seats[view.turn];
    return seat ? `${seat.handle} is deciding.` : PHASE_LINE.players;
  }
  return PHASE_LINE[view.phase];
}

// How long a phase may run, for the clock bar.
export function phaseSpanMs(phase: Phase): number | null {
  const L = BLACKJACK_LIMITS;
  switch (phase) {
    case "betting": return L.bettingSeconds * 1000;
    case "players": return L.turnSeconds * 1000;
    case "settled": return L.settledSeconds * 1000;
    case "shuffling": case "dealer": return L.dealerSeconds * 1000;
    case "waiting": return null;
  }
}

// The share of the phase still to run, from the whole seconds the kit counts down.
export function clockFraction(phase: Phase, seconds: number | null): number {
  const span = phaseSpanMs(phase);
  if (span === null || seconds === null) return 0;
  return Math.min(1, Math.max(0, (seconds * 1000) / span));
}

export function mySeat(view: BlackjackView): SeatView | null {
  return view.you === null ? null : view.seats[view.you] ?? null;
}

export function freeSeats(view: BlackjackView): number {
  return view.seats.filter((seat) => seat === null).length;
}

export function canSit(view: BlackjackView): boolean {
  return view.you === null && freeSeats(view) > 0;
}

export const CHIP_VALUES = [10, 50, 100, 250, 500] as const;

export function canBet(view: BlackjackView): boolean {
  const seat = mySeat(view);
  return seat !== null && (view.phase === "waiting" || view.phase === "betting") && seat.chips + seat.bet >= view.limits.minBet;
}

// Chip values the player can lay down: bounded by the table and by what the seat owns, bet included.
export function betChoices(view: BlackjackView): number[] {
  const seat = mySeat(view);
  if (!seat) return [];
  const ceiling = Math.min(view.limits.maxBet, seat.chips + seat.bet);
  return CHIP_VALUES.filter((value) => value >= view.limits.minBet && value <= ceiling);
}

// The stepper moves the bet by one step and stays inside the limits and the stack.
export function stepBet(view: BlackjackView, direction: 1 | -1): number | null {
  const seat = mySeat(view);
  if (!seat) return null;
  const ceiling = Math.min(view.limits.maxBet, seat.chips + seat.bet);
  const next = seat.bet + direction * view.limits.betStep;
  if (next < view.limits.minBet || next > ceiling) return null;
  return next;
}

export function myActions(view: BlackjackView): Action[] {
  const seat = mySeat(view);
  if (!seat || view.phase !== "players" || view.turn !== view.you || seat.state !== "playing") return [];
  const actions: Action[] = ["hit", "stand"];
  if (seat.cards.length === 2 && seat.chips >= seat.bet) actions.push("double");
  return actions;
}

export type Tone = "neutral" | "good" | "bad" | "live";

export function signedChips(delta: number): string {
  return delta === 0 ? "0" : `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US")}`;
}

export interface SeatBadge { text: string; tone: Tone }

export function seatBadge(seat: SeatView, view: BlackjackView, index: number): SeatBadge | null {
  if (seat.outcome) {
    const text: Record<NonNullable<SeatView["outcome"]>, string> = {
      win: "Win", lose: "Lose", push: "Push", blackjack: "Blackjack", misdeal: "Returned",
    };
    const tone: Tone = seat.outcome === "win" || seat.outcome === "blackjack" ? "good" : seat.outcome === "lose" ? "bad" : "neutral";
    return { text: `${text[seat.outcome]} ${seat.outcome === "misdeal" ? "" : signedChips(seat.delta)}`.trim(), tone };
  }
  if (view.phase === "players" && view.turn === index) return { text: "Acting", tone: "live" };
  switch (seat.state) {
    case "bust": return { text: "Bust", tone: "bad" };
    case "blackjack": return { text: "Blackjack", tone: "good" };
    case "stood": return { text: "Stood", tone: "neutral" };
    case "doubled": return { text: "Doubled", tone: "neutral" };
    case "bet": return { text: "Bet placed", tone: "neutral" };
    case "idle": return view.phase === "betting" ? { text: "Deciding bet", tone: "neutral" } : null;
    case "playing": return null;
  }
}

// A stack of discs for an amount: greedy from the large values, capped so a big bet stays a small drawing.
export function chipStack(amount: number, perStackCap = 5): Array<{ value: number; count: number }> {
  const values = [500, 100, 50, 10];
  const stacks: Array<{ value: number; count: number }> = [];
  let rest = amount;
  for (const value of values) {
    const count = Math.floor(rest / value);
    if (count > 0) stacks.push({ value, count: Math.min(count, perStackCap) });
    rest -= count * value;
  }
  return stacks;
}

export function dealerTotalText(dealer: BlackjackView["dealer"]): string {
  if (dealer.cards.length === 0) return "";
  return dealer.cards.includes(HIDDEN_CARD) ? `${dealer.total} + ?` : `${dealer.total}`;
}

export function dealerSay(say: string | null): string | null {
  const text = say?.trim();
  return text ? `“${text}”` : null;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export interface MindRow {
  key: string;
  title: string;
  verdict: string;
  tone: Tone;
  meta: string;
  note: string;
}

// One row per call to the model, newest first. The wording names what the check did, not what the model meant.
export function mindRows(log: readonly DealerLogEntry[]): MindRow[] {
  return [...log].reverse().map((entry, index) => ({
    key: `${entry.at}-${entry.kind}-${index}`,
    title: entry.kind === "shuffle" ? "Ordered the shoe" : "Played the hand",
    verdict: entry.ok ? "Accepted" : "Rejected",
    tone: entry.ok ? "good" : "bad",
    meta: [formatMs(entry.ms), entry.attempts > 1 ? `${entry.attempts} attempts` : "1 attempt", entry.model].join(" · "),
    note: entry.note,
  }));
}

export function thinking(view: BlackjackView): string | null {
  if (view.misdeal) return null;
  if (view.phase === "shuffling") return "Ordering the shoe…";
  if (view.phase === "dealer") return "Choosing hit or stand…";
  return null;
}

export function stateText(view: BlackjackView): string {
  const seat = mySeat(view);
  if (!seat) return canSit(view) ? "You are watching." : "You are watching. The table is full.";
  return `You hold ${seat.chips.toLocaleString("en-US")} chips.`;
}

export function modelContextText(view: BlackjackView): string {
  const seat = mySeat(view);
  const you = seat ? `You have ${seat.chips} chips and ${seat.cards.length} cards.` : "You are watching.";
  return `Blackjack table "${view.title}", round ${view.round}, phase ${view.phase}. ${you}`;
}

// Names the browser pairs between two snapshots, so a card or a chip stack keeps its identity and moves.
// Derived from the seat and the position: the contract has no card ids.
export type Owner = "dealer" | number;
export const ownerKey = (owner: Owner) => (owner === "dealer" ? "dealer" : `s${owner}`);
export const cardTransitionName = (owner: Owner, index: number) => `card-${ownerKey(owner)}-${index}`;
export const seatTransitionName = (part: "chips" | "bet" | "stack", seat: number) => `${part}-s${seat}`;

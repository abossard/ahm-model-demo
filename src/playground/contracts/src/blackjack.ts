import { z } from "zod";
import { Handle, PlayerId, snapshotOf } from "./ids";

// Rank then suit: "AS" ace of spades, "TD" ten of diamonds. The shoe holds DECKS copies of each.
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"] as const;
export const SUITS = ["S", "H", "D", "C"] as const;
export const CARDS = RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));
export const Card = z.enum(CARDS as [string, ...string[]]);
export type Card = z.infer<typeof Card>;
export const HIDDEN_CARD = "??";

export const BLACKJACK_LIMITS = {
  seats: 6, decks: 4, reshuffleBelow: 60, startChips: 1000, minBet: 10, maxBet: 500, betStep: 10,
  bettingSeconds: 15, turnSeconds: 20, settledSeconds: 6, dealerSeconds: 25, maxDealerHits: 5,
  idleRoundsBeforeUnseat: 2,
} as const;

export const SeatView = z.object({
  id: PlayerId,
  handle: Handle,
  chips: z.number().int().min(0),
  bet: z.number().int().min(0),
  cards: z.array(Card),
  total: z.number().int().min(0),
  state: z.enum(["idle", "bet", "playing", "stood", "doubled", "bust", "blackjack"]),
  outcome: z.enum(["win", "lose", "push", "blackjack", "misdeal"]).nullable(),
  // Chips won or lost in the round just settled. Zero until then.
  delta: z.number().int(),
});
export type SeatView = z.infer<typeof SeatView>;

// One call to the language model, as the table may see it. Never carries a card that is still face down.
export const DealerLogEntry = z.object({
  at: z.number(),
  kind: z.enum(["shuffle", "decide"]),
  ok: z.boolean(),
  attempts: z.number().int().min(1),
  ms: z.number().int().min(0),
  model: z.string(),
  note: z.string().max(160),
});
export type DealerLogEntry = z.infer<typeof DealerLogEntry>;

export const BlackjackView = z.object({
  title: z.string().max(60),
  phase: z.enum(["waiting", "betting", "shuffling", "players", "dealer", "settled"]),
  round: z.number().int().min(0),
  seats: z.array(SeatView.nullable()).length(BLACKJACK_LIMITS.seats),
  you: z.number().int().min(0).max(BLACKJACK_LIMITS.seats - 1).nullable(),
  turn: z.number().int().min(0).max(BLACKJACK_LIMITS.seats - 1).nullable(),
  deadline: z.number().nullable(),
  dealer: z.object({
    cards: z.array(z.union([Card, z.literal(HIDDEN_CARD)])),
    // Total of the face-up cards.
    total: z.number().int().min(0),
    say: z.string().max(120).nullable(),
  }),
  misdeal: z.boolean(),
  dealerLog: z.array(DealerLogEntry).max(8),
  limits: z.object({ minBet: z.number().int(), maxBet: z.number().int(), betStep: z.number().int() }),
});
export type BlackjackView = z.infer<typeof BlackjackView>;

export const BlackjackSnapshot = snapshotOf("blackjack", BlackjackView);
export type BlackjackSnapshot = z.infer<typeof BlackjackSnapshot>;

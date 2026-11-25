import { BLACKJACK_LIMITS, CARDS, HIDDEN_CARD } from "@playground/contracts";
import type { BlackjackView, DealerLogEntry, Notice, NoticeCode, SeatView } from "@playground/contracts";
import { DEALER_LIMITS } from "../ports";
import type {
  BlackjackAction, BlackjackRules, DealerFailure, DealerOutput, DealerReply, DealerRequest, PlayerEvent, Step,
} from "../ports";

const L = BLACKJACK_LIMITS;
type Phase = BlackjackView["phase"];
type SeatState = SeatView["state"];
type Cards = Record<string, number>;

interface Seat {
  id: string;
  handle: string;
  chips: number;
  bet: number;
  cards: string[];
  state: SeatState;
  outcome: SeatView["outcome"];
  delta: number;
  // Rounds in a row that closed without a bet from this seat.
  missed: number;
  // Gave up the seat while a bet was in play. The seat goes when the round is cleared.
  leaving: boolean;
}

// What to do with the cards of a shuffle once the model has ordered them.
type Resume =
  | { kind: "deal" }
  | { kind: "act"; seat: number; action: "hit" | "double" }
  | { kind: "dealerHit" };

interface BlackjackState {
  title: string;
  phase: Phase;
  round: number;
  seats: Array<Seat | null>;
  turn: number | null;
  // When `tick` next changes something. Null while the table waits for a first bet.
  deadline: number | null;
  // Copies of each card still in the shoe and not yet in the ordered slice.
  remaining: Cards;
  slice: string[];
  previous: string[];
  dealer: string[];
  say: string | null;
  hits: number;
  misdeal: boolean;
  pending: DealerRequest | null;
  resume: Resume | null;
  seq: number;
  calls: number;
  hourStart: number;
  hourCalls: number;
  log: DealerLogEntry[];
  ms: { bet: number; turn: number; settled: number; dealer: number };
}

interface Run {
  s: BlackjackState;
  now: number;
  events: PlayerEvent[];
}

const FULL: Cards = Object.fromEntries(CARDS.map((card) => [card, L.decks]));
const HOUR_MS = 3_600_000;
const MIDROUND_CARDS = 10;
const count = (cards: Cards) => Object.values(cards).reduce((sum, n) => sum + n, 0);
const seated = (s: BlackjackState) => s.seats.flatMap((seat, index) => (seat ? [{ seat, index }] : []));
const bettors = (s: BlackjackState) => seated(s).filter(({ seat }) => seat.bet > 0);

export function handTotal(cards: string[]): { total: number; soft: boolean } {
  let hard = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = card[0]!;
    if (rank === "A") aces++;
    hard += rank === "A" ? 1 : "TJQK".includes(rank) ? 10 : Number(rank);
  }
  const soft = aces > 0 && hard + 10 <= 21;
  return { total: soft ? hard + 10 : hard, soft };
}

const notice = (code: NoticeCode, message: string): Notice => ({ code, message });
const unchanged = (state: BlackjackState, because: Notice | null = null): Step<BlackjackState> =>
  ({ state, notice: because, events: [] });
const finished = (run: Run, because: Notice | null = null): Step<BlackjackState> =>
  ({ state: run.s, notice: because, events: run.events });
const open = (state: BlackjackState, now: number): Run => ({ s: structuredClone(state), now, events: [] });

function logCall(run: Run, entry: Omit<DealerLogEntry, "at">) {
  run.s.log = [...run.s.log, { at: run.now, ...entry }].slice(-8);
}

// ---- The round ---------------------------------------------------------------------------------------------------

function renewShoe(s: BlackjackState) {
  s.remaining = { ...FULL };
  for (const card of [...s.dealer, ...seated(s).flatMap(({ seat }) => seat.cards), ...s.slice]) {
    s.remaining[card] = Math.max(0, (s.remaining[card] ?? 0) - 1);
  }
}

function hasBudget(run: Run): boolean {
  const { s, now } = run;
  if (s.hourStart === 0 || now - s.hourStart >= HOUR_MS) {
    s.hourStart = now;
    s.hourCalls = 0;
  }
  return s.calls < DEALER_LIMITS.perRound && s.hourCalls < DEALER_LIMITS.perTableHour;
}

function ask(run: Run, phase: Phase, build: (id: string) => DealerRequest, resume: Resume | null) {
  const { s } = run;
  s.seq++;
  s.pending = build(`${s.round}-${s.seq}`);
  s.resume = resume;
  s.phase = phase;
  s.deadline = run.now + s.ms.dealer;
}

function requestShuffle(run: Run, wanted: number, resume: Resume) {
  const { s } = run;
  if (!hasBudget(run)) return misdeal(run);
  if (count(s.remaining) < 1) renewShoe(s);
  const n = Math.min(wanted, count(s.remaining));
  ask(run, "shuffling", (id) => ({ id, kind: "shuffle", count: n, remaining: { ...s.remaining }, previous: [...s.previous] }), resume);
}

function requestDecide(run: Run) {
  const { s } = run;
  if (!hasBudget(run)) return misdeal(run);
  const { total, soft } = handTotal(s.dealer);
  const players = seated(s)
    .filter(({ seat }) => seat.state === "stood" || seat.state === "doubled")
    .map(({ seat }) => handTotal(seat.cards).total);
  ask(run, "dealer", (id) => ({ id, kind: "decide", hand: [...s.dealer], total, soft, players, hits: s.hits }), null);
}

function endRound(run: Run) {
  const { s } = run;
  s.phase = "settled";
  s.turn = null;
  s.pending = null;
  s.resume = null;
  s.deadline = run.now + s.ms.settled;
}

function misdeal(run: Run) {
  run.s.misdeal = true;
  for (const { seat } of bettors(run.s)) {
    seat.chips += seat.bet;
    seat.outcome = "misdeal";
    seat.delta = 0;
  }
  endRound(run);
}

function settle(run: Run) {
  const { s } = run;
  const dealer = handTotal(s.dealer).total;
  const natural = s.dealer.length === 2 && dealer === 21;
  for (const { seat } of bettors(s)) {
    const total = handTotal(seat.cards).total;
    if (seat.state === "blackjack") seat.outcome = natural ? "push" : "blackjack";
    else if (total > 21 || natural) seat.outcome = "lose";
    else if (dealer > 21 || total > dealer) seat.outcome = "win";
    else seat.outcome = total === dealer ? "push" : "lose";
    const won = seat.outcome === "blackjack" ? Math.floor((seat.bet * 3) / 2) : seat.outcome === "win" ? seat.bet : 0;
    seat.delta = seat.outcome === "lose" ? -seat.bet : won;
    seat.chips += seat.outcome === "lose" ? 0 : seat.bet + won;
    if (won > 0) run.events.push({ playerId: seat.id, event: { type: "blackjack_win" } });
  }
  endRound(run);
}

function clearRound(run: Run) {
  const { s } = run;
  s.seats = s.seats.map((seat) => {
    if (!seat || seat.leaving) return null;
    return {
      ...seat, bet: 0, cards: [], state: "idle", outcome: null, delta: 0,
      chips: seat.chips < L.minBet ? L.startChips : seat.chips,
    };
  });
  s.round++;
  s.phase = "waiting";
  s.dealer = [];
  s.say = null;
  s.hits = 0;
  s.misdeal = false;
  s.calls = 0;
  s.turn = null;
  s.deadline = null;
}

function closeBets(run: Run) {
  const { s } = run;
  s.seats = s.seats.map((seat) => {
    if (!seat || seat.bet > 0) return seat;
    return seat.missed + 1 >= L.idleRoundsBeforeUnseat ? null : { ...seat, missed: seat.missed + 1 };
  });
  const players = bettors(s).length;
  if (players === 0) {
    s.phase = "waiting";
    s.deadline = null;
    return;
  }
  s.calls = 0;
  for (const card of s.slice) s.remaining[card] = (s.remaining[card] ?? 0) + 1;
  s.slice = [];
  if (count(s.remaining) < L.reshuffleBelow) s.remaining = { ...FULL };
  requestShuffle(run, Math.min(40, 5 * players + 5), { kind: "deal" });
}

function deal(run: Run) {
  const { s } = run;
  const players = bettors(s);
  if (s.slice.length < 2 * (players.length + 1)) return misdeal(run);
  for (let pass = 0; pass < 2; pass++) {
    for (const { seat } of players) seat.cards.push(s.slice.shift()!);
    s.dealer.push(s.slice.shift()!);
  }
  for (const { seat } of players) seat.state = handTotal(seat.cards).total === 21 ? "blackjack" : "playing";
  if (handTotal(s.dealer).total === 21) return settle(run);
  s.phase = "players";
  nextTurn(run, -1);
}

function nextTurn(run: Run, after: number) {
  const { s } = run;
  const next = seated(s).find(({ seat, index }) => index > after && seat.state === "playing");
  if (!next) return endPlayers(run);
  s.phase = "players";
  s.turn = next.index;
  s.deadline = run.now + s.ms.turn;
  if (next.seat.leaving) stand(run, next.index);
}

function endPlayers(run: Run) {
  const { s } = run;
  s.turn = null;
  const live = seated(s).some(({ seat }) => seat.state === "stood" || seat.state === "doubled");
  if (live) requestDecide(run);
  else settle(run);
}

function stand(run: Run, index: number) {
  run.s.seats[index]!.state = "stood";
  nextTurn(run, index);
}

function hit(run: Run, index: number) {
  const { s } = run;
  const seat = s.seats[index]!;
  if (s.slice.length === 0) return requestShuffle(run, MIDROUND_CARDS, { kind: "act", seat: index, action: "hit" });
  seat.cards.push(s.slice.shift()!);
  const { total } = handTotal(seat.cards);
  if (total > 21) {
    seat.state = "bust";
    nextTurn(run, index);
  } else if (total === 21) stand(run, index);
  else s.deadline = run.now + s.ms.turn;
}

function double(run: Run, index: number) {
  const { s } = run;
  const seat = s.seats[index]!;
  if (s.slice.length === 0) return requestShuffle(run, MIDROUND_CARDS, { kind: "act", seat: index, action: "double" });
  seat.chips -= seat.bet;
  seat.bet *= 2;
  seat.cards.push(s.slice.shift()!);
  seat.state = handTotal(seat.cards).total > 21 ? "bust" : "doubled";
  nextTurn(run, index);
}

function dealerHit(run: Run) {
  const { s } = run;
  if (s.slice.length === 0) return requestShuffle(run, MIDROUND_CARDS, { kind: "dealerHit" });
  s.dealer.push(s.slice.shift()!);
  s.hits++;
  if (handTotal(s.dealer).total > 21 || s.hits >= L.maxDealerHits) settle(run);
  else requestDecide(run);
}

// ---- Actions -----------------------------------------------------------------------------------------------------

const indexOf = (s: BlackjackState, id: string) => s.seats.findIndex((seat) => seat?.id === id);
const notSeated = notice("not_seated", "You are not at this table.");

function sit(state: BlackjackState, id: string, handle: string, now: number): Step<BlackjackState> {
  const at = indexOf(state, id);
  if (at >= 0) {
    if (!state.seats[at]!.leaving) return unchanged(state);
    const run = open(state, now);
    run.s.seats[at]!.leaving = false;
    return finished(run);
  }
  const free = state.seats.indexOf(null);
  if (free < 0) return unchanged(state, notice("table_full", "Every seat is taken."));
  const run = open(state, now);
  run.s.seats[free] = {
    id, handle, chips: L.startChips, bet: 0, cards: [], state: "idle", outcome: null, delta: 0, missed: 0, leaving: false,
  };
  return finished(run);
}

function leave(state: BlackjackState, at: number, now: number): Step<BlackjackState> {
  const run = open(state, now);
  const { s } = run;
  const seat = s.seats[at]!;
  const inPlay = seat.bet > 0 && s.phase !== "waiting" && s.phase !== "betting";
  if (inPlay) {
    seat.leaving = true;
    if (s.phase === "players" && s.turn === at) stand(run, at);
    return finished(run);
  }
  seat.chips += seat.bet;
  s.seats[at] = null;
  if (s.phase === "betting") closeWhenAllBet(run);
  return finished(run);
}

function closeWhenAllBet(run: Run) {
  const people = seated(run.s);
  if (people.every(({ seat }) => seat.bet > 0) || people.length === 0) closeBets(run);
}

function placeBet(state: BlackjackState, at: number, amount: number, now: number): Step<BlackjackState> {
  if (state.phase !== "waiting" && state.phase !== "betting") {
    return unchanged(state, notice("wrong_phase", "Bets are closed."));
  }
  const seat = state.seats[at]!;
  const clamped = Math.min(L.maxBet, Math.max(L.minBet, amount));
  const bet = Math.min(Math.floor(clamped / L.betStep) * L.betStep, Math.floor((seat.chips + seat.bet) / L.betStep) * L.betStep);
  if (bet < L.minBet) return unchanged(state, notice("insufficient_funds", "Not enough chips for the minimum bet."));
  const run = open(state, now);
  const mine = run.s.seats[at]!;
  mine.chips += mine.bet - bet;
  mine.bet = bet;
  mine.state = "bet";
  mine.missed = 0;
  if (run.s.phase === "waiting") {
    run.s.phase = "betting";
    run.s.deadline = now + run.s.ms.bet;
  }
  closeWhenAllBet(run);
  return finished(run);
}

function act(state: BlackjackState, at: number, action: "hit" | "stand" | "double", now: number): Step<BlackjackState> {
  if (state.phase === "shuffling") return unchanged(state, notice("dealer_busy", "The dealer is shuffling."));
  if (state.phase !== "players") return unchanged(state, notice("wrong_phase", "No hand is being played."));
  if (state.turn !== at) return unchanged(state, notice("not_your_turn", "It is not your turn."));
  const seat = state.seats[at]!;
  if (action === "double" && seat.cards.length !== 2) {
    return unchanged(state, notice("illegal_move", "You can only double on two cards."));
  }
  if (action === "double" && seat.chips < seat.bet) {
    return unchanged(state, notice("insufficient_funds", "Not enough chips to double."));
  }
  const run = open(state, now);
  if (action === "hit") hit(run, at);
  else if (action === "double") double(run, at);
  else stand(run, at);
  return finished(run);
}

// ---- The dealer --------------------------------------------------------------------------------------------------

function validate(request: DealerRequest, output: DealerOutput): string[] {
  const problems = new Set<string>();
  if (request.kind === "decide") {
    if (output.cards.length > 0) problems.add("a decision carries no cards");
    if (request.hits >= L.maxDealerHits && output.action !== "stand") problems.add("the dealer must stand after five hits");
    return [...problems];
  }
  if (output.cards.length !== request.count) problems.add(`expected ${request.count} cards, got ${output.cards.length}`);
  const used: Cards = {};
  for (const card of output.cards) {
    used[card] = (used[card] ?? 0) + 1;
    if (!CARDS.includes(card)) problems.add(`${card} is not a card code`);
    else if (used[card]! > (request.remaining[card] ?? 0)) problems.add(`${card} is not left in the shoe`);
  }
  return [...problems];
}

function prompt(request: DealerRequest): { system: string; user: string } {
  const system = [
    "You are the dealer at a blackjack table.",
    "House custom: the dealer draws to 16 and stands on 17, but the choice is yours.",
    "Answer with JSON: cards, action and say. say is one short line of table talk, at most 120 characters.",
  ].join(" ");
  if (request.kind === "decide") {
    const hand = `${request.hand.join(" ")} (total ${request.total}${request.soft ? ", soft" : ""})`;
    return {
      system,
      user: `Your hand: ${hand}. Hands still in play: ${request.players.join(", ") || "none"}. You have hit ${request.hits} times and may hit at most ${L.maxDealerHits}. Set action to hit or stand and cards to an empty list.`,
    };
  }
  const left = Object.entries(request.remaining).filter(([, n]) => n > 0).map(([card, n]) => `${card} ${n}`).join(", ");
  return {
    system,
    user: `Put ${request.count} cards in the order they will be dealt. Copies left per card: ${left}. Never use more copies of a card than are left. The last slice was: ${request.previous.join(" ") || "none"}. Set cards to the ordered list and action to stand.`,
  };
}

function resolve(
  state: BlackjackState, requestId: string, reply: DealerReply | DealerFailure, attempts: number, now: number,
): Step<BlackjackState> {
  const request = state.pending;
  if (!request || request.id !== requestId) return unchanged(state);
  const run = open(state, now);
  const { s } = run;
  s.calls += attempts;
  s.hourCalls += attempts;
  s.pending = null;
  const resume = s.resume;
  s.resume = null;
  const problems = typeof reply === "string" ? [] : validate(request, reply.output);
  if (typeof reply === "string" || problems.length > 0) {
    const note = typeof reply === "string" && reply === "unavailable"
      ? `dealer unavailable after ${attempts} attempts`
      : `reply rejected: ${problems[0] ?? "not usable"}`;
    logCall(run, { kind: request.kind, ok: false, attempts, ms: 0, model: "none", note });
    misdeal(run);
    return finished(run);
  }
  const { output, model, ms } = reply;
  s.say = output.say.slice(0, 120) || null;
  if (request.kind === "shuffle") {
    logCall(run, { kind: "shuffle", ok: true, attempts, ms, model, note: `ordered ${output.cards.length} cards` });
    for (const card of output.cards) s.remaining[card]!--;
    s.slice = [...output.cards];
    s.previous = [...output.cards];
    if (resume?.kind === "act") {
      s.phase = "players";
      s.turn = resume.seat;
      if (resume.action === "hit") hit(run, resume.seat);
      else double(run, resume.seat);
    } else if (resume?.kind === "dealerHit") dealerHit(run);
    else deal(run);
  } else if (output.action === "hit") {
    logCall(run, { kind: "decide", ok: true, attempts, ms, model, note: `hit on ${request.total}` });
    dealerHit(run);
  } else {
    logCall(run, { kind: "decide", ok: true, attempts, ms, model, note: `stood on ${request.total}` });
    settle(run);
  }
  return finished(run);
}

// ---- Rules -------------------------------------------------------------------------------------------------------

export const blackjack: BlackjackRules<BlackjackState> = {
  game: "blackjack",
  seats: L.seats,

  create(by, options, now, _seed) {
    const fast = options["fast"] === true;
    const title = typeof options["title"] === "string" ? options["title"].trim() : "";
    const state: BlackjackState = {
      title: (title || `${by.handle}'s table`).slice(0, 60),
      phase: "waiting",
      round: 0,
      seats: Array.from({ length: L.seats }, () => null),
      turn: null,
      deadline: null,
      remaining: { ...FULL },
      slice: [],
      previous: [],
      dealer: [],
      say: null,
      hits: 0,
      misdeal: false,
      pending: null,
      resume: null,
      seq: 0,
      calls: 0,
      hourStart: 0,
      hourCalls: 0,
      log: [],
      ms: fast
        ? { bet: 2000, turn: 5000, settled: 1000, dealer: L.dealerSeconds * 1000 }
        : { bet: L.bettingSeconds * 1000, turn: L.turnSeconds * 1000, settled: L.settledSeconds * 1000, dealer: L.dealerSeconds * 1000 },
    };
    return sit(state, by.id, by.handle, now).state;
  },

  apply(state, action: BlackjackAction, by, now) {
    if (action.type === "sit") return sit(state, by.id, by.handle, now);
    const at = indexOf(state, by.id);
    if (at < 0) return unchanged(state, notSeated);
    switch (action.type) {
      case "leave": return leave(state, at, now);
      case "bet": return placeBet(state, at, action.amount, now);
      case "act": return act(state, at, action.action, now);
    }
  },

  tick(state, now) {
    if (state.deadline === null || now < state.deadline) return unchanged(state);
    const run = open(state, now);
    switch (state.phase) {
      case "betting": closeBets(run); break;
      case "players": stand(run, state.turn!); break;
      case "shuffling":
      case "dealer": misdeal(run); break;
      case "settled": clearRound(run); break;
      case "waiting": return unchanged(state);
    }
    return finished(run);
  },

  nextDeadline: (state) => state.deadline,
  pending: (state) => state.pending,
  prompt,
  validate,
  resolve,

  view(state, viewer): BlackjackView {
    const holeShown = state.phase === "dealer" || state.phase === "settled"
      || (state.phase === "shuffling" && state.resume?.kind === "dealerHit");
    const dealerCards = state.dealer.map((card, i) => (i === 1 && !holeShown ? HIDDEN_CARD : card));
    const you = viewer ? indexOf(state, viewer.id) : -1;
    return {
      title: state.title,
      phase: state.phase,
      round: state.round,
      seats: state.seats.map((seat) => seat && {
        id: seat.id, handle: seat.handle, chips: seat.chips, bet: seat.bet, cards: seat.cards,
        total: handTotal(seat.cards).total, state: seat.state, outcome: seat.outcome, delta: seat.delta,
      }),
      you: you >= 0 ? you : null,
      turn: state.phase === "players" ? state.turn : null,
      deadline: state.deadline,
      dealer: {
        cards: dealerCards,
        total: handTotal(dealerCards.filter((card) => card !== HIDDEN_CARD)).total,
        say: state.say,
      },
      misdeal: state.misdeal,
      dealerLog: state.log,
      limits: { minBet: L.minBet, maxBet: L.maxBet, betStep: L.betStep },
    };
  },

  lobby: (state) => ({
    title: state.title,
    seatsTaken: seated(state).length,
    seatsTotal: L.seats,
    status: state.phase === "waiting" || state.phase === "betting" ? "open" : "playing",
  }),
};

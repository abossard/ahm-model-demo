import { CHECKERS_LIMITS, SQUARES, START_BOARD } from "@playground/contracts";
import type { Board, CheckersSeat, CheckersView, Color, Move, Notice, NoticeCode, Player } from "@playground/contracts";
import type { CheckersAction, CheckersRules, PlayerEvent, Step } from "../ports";

type Played = Move & { by: Color; crowned: boolean };

interface CheckersState {
  board: Board;
  turn: Color;
  status: "waiting" | "playing" | "over";
  black: CheckersSeat;
  white: CheckersSeat | null;
  moves: number;
  quietPlies: number;
  captured: Record<Color, number>;
  last: Played[];
  winner: "black" | "white" | "draw" | null;
  endedBy: CheckersView["endedBy"];
  deadline: number | null;
  turnMs: number;
}

const BOT: CheckersSeat = { id: "house-bot", handle: "House Bot", bot: true };
const other = (color: Color): Color => (color === "black" ? "white" : "black");
const isOwn = (piece: string, color: Color) => piece.toLowerCase() === color[0];
const isKing = (piece: string) => piece === "B" || piece === "W";
const rowOf = (square: number) => square >> 2;
const crownRow = (color: Color) => (color === "black" ? 7 : 0);

// The square one diagonal step from `square`, or -1 off the board.
function neighbor(square: number, dr: number, dc: number): number {
  const row = rowOf(square) + dr;
  const col = (rowOf(square) % 2 === 0 ? 2 * (square & 3) + 1 : 2 * (square & 3)) + dc;
  return row < 0 || row > 7 || col < 0 || col > 7 ? -1 : row * 4 + (col >> 1);
}

function directions(piece: string, color: Color): Array<[number, number]> {
  if (isKing(piece)) return [[1, -1], [1, 1], [-1, -1], [-1, 1]];
  const dr = color === "black" ? 1 : -1;
  return [[dr, -1], [dr, 1]];
}

function jumpsFrom(board: Board, color: Color, from: number): Move[] {
  const cells = board.split("");
  const piece = cells[from]!;
  cells[from] = ".";
  const found: Move[] = [];
  const walk = (at: number, king: boolean, path: number[], captures: number[]) => {
    let extended = false;
    for (const [dr, dc] of directions(king ? "B" : piece, color)) {
      const over = neighbor(at, dr, dc);
      const land = over < 0 ? -1 : neighbor(over, dr, dc);
      if (land < 0 || captures.includes(over) || !isOwn(cells[over]!, other(color)) || cells[land] !== ".") continue;
      extended = true;
      const nextPath = [...path, land];
      const nextCaptures = [...captures, over];
      if (!king && rowOf(land) === crownRow(color)) found.push({ from, path: nextPath, captures: nextCaptures });
      else walk(land, king, nextPath, nextCaptures);
    }
    if (!extended && captures.length > 0) found.push({ from, path, captures });
  };
  walk(from, isKing(piece), [], []);
  return found;
}

function stepsFrom(board: Board, color: Color, from: number): Move[] {
  return directions(board[from]!, color)
    .map(([dr, dc]) => neighbor(from, dr, dc))
    .filter((to) => to >= 0 && board[to] === ".")
    .map((to) => ({ from, path: [to], captures: [] }));
}

const byFromThenPath = (a: Move, b: Move) =>
  a.from - b.from || a.path.reduce((diff, square, i) => diff || square - (b.path[i] ?? -1), 0) || a.path.length - b.path.length;

export function legalMoves(board: Board, color: Color): Move[] {
  const own = Array.from({ length: SQUARES }, (_, square) => square).filter((square) => isOwn(board[square]!, color));
  const jumps = own.flatMap((square) => jumpsFrom(board, color, square));
  const moves = jumps.length > 0 ? jumps : own.flatMap((square) => stepsFrom(board, color, square));
  return moves.sort(byFromThenPath);
}

// Moves the piece, removes what it captured, and crowns a man that ends on the far row.
function played(board: Board, move: Move, color: Color): { board: Board; crowned: boolean } {
  const cells = board.split("");
  const piece = cells[move.from]!;
  const to = move.path[move.path.length - 1]!;
  const crowned = !isKing(piece) && rowOf(to) === crownRow(color);
  cells[move.from] = ".";
  for (const square of move.captures) cells[square] = ".";
  cells[to] = crowned ? piece.toUpperCase() : piece;
  return { board: cells.join(""), crowned };
}

function botMove(board: Board, moves: Move[]): Move {
  const jumps = moves.filter((move) => move.captures.length > 0);
  if (jumps.length > 0) return jumps.reduce((best, move) => (move.captures.length > best.captures.length ? move : best));
  return moves.find((move) => played(board, move, "white").crowned) ?? moves[0]!;
}

function sameMove(a: Move, b: { from: number; path: number[] }) {
  return a.from === b.from && a.path.length === b.path.length && a.path.every((square, i) => square === b.path[i]);
}

const notice = (code: NoticeCode, message: string): Notice => ({ code, message });
const unchanged = (state: CheckersState, because: Notice | null = null): Step<CheckersState> =>
  ({ state, notice: because, events: [] });

function colorOf(state: CheckersState, player: Player | null): Color | null {
  if (player === null) return null;
  if (state.black.id === player.id) return "black";
  return state.white?.id === player.id ? "white" : null;
}

function finish(state: CheckersState, winner: CheckersState["winner"], endedBy: CheckersView["endedBy"]): CheckersState {
  return { ...state, status: "over", winner, endedBy, deadline: null };
}

// One ply: the board moves on, the counters follow, and the game ends if the side to move cannot go on.
function ply(state: CheckersState, move: Move, now: number): CheckersState {
  const mover = state.turn;
  const { board, crowned } = played(state.board, move, mover);
  const quietPlies = move.captures.length > 0 || crowned ? 0 : state.quietPlies + 1;
  const loser = other(mover);
  const lost = move.captures.length;
  const next: CheckersState = {
    ...state,
    board,
    turn: loser,
    moves: state.moves + 1,
    quietPlies,
    captured: { ...state.captured, [loser]: state.captured[loser] + lost },
    last: [...state.last, { ...move, by: mover, crowned }].slice(-2),
    deadline: now + state.turnMs,
  };
  if (!board.split("").some((piece) => isOwn(piece, loser))) return finish(next, mover, "no_pieces");
  if (legalMoves(board, loser).length === 0) return finish(next, mover, "no_moves");
  if (quietPlies >= CHECKERS_LIMITS.drawAfterQuietPlies) return finish(next, "draw", "draw_rule");
  return next;
}

function captureEvent(state: CheckersState, move: Move): PlayerEvent[] {
  const seat = state.turn === "black" ? state.black : state.white;
  return move.captures.length > 0 && seat && !seat.bot
    ? [{ playerId: seat.id, event: { type: "checkers_capture" } }]
    : [];
}

function applyMove(state: CheckersState, move: Move, now: number): Step<CheckersState> {
  const events = captureEvent(state, move);
  let next = ply(state, move, now);
  if (next.status === "playing" && next.white?.bot && next.turn === "white") {
    next = ply(next, botMove(next.board, legalMoves(next.board, "white")), now);
  }
  return { state: next, notice: null, events };
}

export const checkers: CheckersRules<CheckersState> = {
  game: "checkers",
  seats: 2,

  create(by, options, now, _seed) {
    const bot = options["opponent"] === "bot";
    const turnMs = (options["fast"] === true ? 5 : CHECKERS_LIMITS.turnSeconds) * 1000;
    return {
      board: START_BOARD,
      turn: "black",
      status: bot ? "playing" : "waiting",
      black: { id: by.id, handle: by.handle, bot: false },
      white: bot ? BOT : null,
      moves: 0,
      quietPlies: 0,
      captured: { black: 0, white: 0 },
      last: [],
      winner: null,
      endedBy: null,
      deadline: bot ? now + turnMs : null,
      turnMs,
    };
  },

  apply(state, action: CheckersAction, by, now) {
    const color = colorOf(state, by);
    switch (action.type) {
      case "join":
        if (color !== null) return unchanged(state);
        if (state.status !== "waiting") return unchanged(state, notice("table_full", "Both colours are taken."));
        return {
          state: {
            ...state,
            status: "playing",
            white: { id: by.id, handle: by.handle, bot: false },
            deadline: now + state.turnMs,
          },
          notice: null,
          events: [],
        };
      case "resign":
        if (color === null) return unchanged(state, notice("not_seated", "You are not at this table."));
        if (state.status !== "playing") return unchanged(state, notice("wrong_phase", "The game is not being played."));
        return { state: finish(state, other(color), "resign"), notice: null, events: [] };
      case "move": {
        if (color === null) return unchanged(state, notice("not_seated", "You are not at this table."));
        if (state.status !== "playing") return unchanged(state, notice("wrong_phase", "The game is not being played."));
        if (color !== state.turn) return unchanged(state, notice("not_your_turn", "It is not your turn."));
        const move = legalMoves(state.board, color).find((candidate) => sameMove(candidate, action));
        if (!move) return unchanged(state, notice("illegal_move", "That move is not allowed."));
        return applyMove(state, move, now);
      }
    }
  },

  tick(state, now) {
    if (state.status !== "playing" || state.deadline === null || now < state.deadline) return unchanged(state);
    return { state: finish(state, other(state.turn), "timeout"), notice: null, events: [] };
  },

  nextDeadline: (state) => (state.status === "playing" ? state.deadline : null),

  view(state, viewer): CheckersView {
    const you = colorOf(state, viewer);
    return {
      board: state.board,
      turn: state.turn,
      status: state.status,
      seats: { black: state.black, white: state.white },
      you,
      legal: state.status === "playing" && you === state.turn ? legalMoves(state.board, you) : [],
      lastMoves: state.last,
      winner: state.winner,
      endedBy: state.endedBy,
      turnDeadline: state.status === "playing" ? state.deadline : null,
      moveCount: state.moves,
      captured: state.captured,
    };
  },

  lobby: (state) => ({
    title: `Checkers: ${state.black.handle}`.slice(0, 60),
    seatsTaken: state.white ? 2 : 1,
    seatsTotal: 2,
    status: state.status === "waiting" ? "open" : state.status,
  }),
};

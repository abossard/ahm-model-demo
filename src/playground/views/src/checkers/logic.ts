import type { CheckersView, Color, Move } from "@playground/contracts";

export interface Cell {
  row: number;
  col: number;
}

// Squares 0..31 sit on the dark squares of an 8 by 8 board, row by row from black's back rank.
export function squareCell(square: number): Cell {
  const row = Math.floor(square / 4);
  const k = square % 4;
  return { row, col: row % 2 === 0 ? 2 * k + 1 : 2 * k };
}

// The square under a cell, or null on a light square.
export function squareAt(row: number, col: number): number | null {
  const dark = row % 2 === 0 ? col % 2 === 1 : col % 2 === 0;
  return dark ? row * 4 + Math.floor(col / 2) : null;
}

// Each player sees their own pieces at the bottom. White starts there already, black turns the board half a circle.
export function displayCell(cell: Cell, you: Color | null): Cell {
  return you === "black" ? { row: 7 - cell.row, col: 7 - cell.col } : cell;
}

export interface Piece {
  color: Color;
  king: boolean;
}

export function pieceOf(char: string | undefined): Piece | null {
  switch (char) {
    case "b": return { color: "black", king: false };
    case "B": return { color: "black", king: true };
    case "w": return { color: "white", king: false };
    case "W": return { color: "white", king: true };
    default: return null;
  }
}

export function movableFrom(legal: readonly Move[]): Set<number> {
  return new Set(legal.map((move) => move.from));
}

// Where the piece on `from` can end its turn.
export function landings(legal: readonly Move[], from: number): number[] {
  return [...new Set(legal.filter((move) => move.from === from).map((move) => move.path[move.path.length - 1]!))];
}

export function moveFor(legal: readonly Move[], from: number, to: number): Move | undefined {
  return legal.find((move) => move.from === from && move.path[move.path.length - 1] === to);
}

// Black's pieces are drawn red, so the words say red.
export const sideName = (color: Color) => (color === "black" ? "Red" : "White");

const LOSS: Record<NonNullable<CheckersView["endedBy"]>, string> = {
  no_pieces: "has no pieces left",
  no_moves: "has no legal move",
  resign: "resigned",
  timeout: "ran out of time",
  draw_rule: "",
};

export function outcomeLine(view: CheckersView): string {
  if (view.winner === "draw" || view.winner === null) return "Draw. Eighty moves without a capture or a crown.";
  const loser: Color = view.winner === "black" ? "white" : "black";
  const result = view.you ? (view.winner === view.you ? "You win." : "You lose.") : `${sideName(view.winner)} wins.`;
  const why = view.endedBy ? LOSS[view.endedBy] : "";
  const who = view.you === loser ? "You" : sideName(loser);
  const verb = who === "You" ? why.replace(/^has /, "have ") : why;
  return why ? `${result} ${who} ${verb}.` : result;
}

export function statusLine(view: CheckersView): string {
  switch (view.status) {
    case "waiting":
      return view.you ? "Waiting for white. Send the link, or let the house play." : "This table is waiting for a second player.";
    case "over":
      return outcomeLine(view);
    case "playing": {
      if (view.you === null) return `${sideName(view.turn)} to move. You are watching.`;
      if (view.turn !== view.you) return "Waiting for the other side.";
      const forced = view.legal.length > 0 && view.legal.every((move) => move.captures.length > 0);
      return forced ? "Your move. You must jump." : "Your move.";
    }
  }
}

export function turnLine(view: CheckersView): string {
  if (view.status !== "playing") return view.status === "over" ? "Game over" : "Not started";
  return `${sideName(view.turn)} to move`;
}

export function clockText(seconds: number | null): string {
  if (seconds === null) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// One id per piece, kept from snapshot to snapshot, so the browser can slide a piece and drop a captured one.
// The board has no piece ids: follow `lastMoves` over the previous ids, and give a piece that does not fit a fresh id.
export function trackPieces(
  previous: readonly (string | null)[] | null,
  board: string,
  lastMoves: readonly Pick<Move, "from" | "path" | "captures">[],
  version: number,
): (string | null)[] {
  const ids = previous ? [...previous] : Array.from({ length: 32 }, () => null as string | null);
  for (const move of lastMoves) {
    const end = move.path[move.path.length - 1]!;
    const id = ids[move.from];
    if (!id || board[end] === ".") continue;
    ids[move.from] = null;
    for (const square of move.captures) ids[square] = null;
    ids[end] = id;
  }
  return ids.map((id, square) => {
    const piece = pieceOf(board[square]);
    if (!piece) return null;
    return id && id[0] === piece.color[0] ? id : `${piece.color[0]}${square}v${version}`;
  });
}

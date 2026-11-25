import { describe, expect, it } from "vitest";
import { START_BOARD, type CheckersView, type Move } from "@playground/contracts";
import { clockText, displayCell, landings, moveFor, movableFrom, outcomeLine, pieceOf, squareAt, squareCell, statusLine, trackPieces, turnLine } from "./logic";

const mv = (from: number, path: number[], captures: number[] = []): Move => ({ from, path, captures });

function view(over: Partial<CheckersView> = {}): CheckersView {
  return {
    board: START_BOARD, turn: "black", status: "playing", seats: { black: null, white: null }, you: "black", legal: [],
    lastMoves: [], winner: null, endedBy: null, turnDeadline: null, moveCount: 0, captured: { black: 0, white: 0 }, ...over,
  };
}

describe("board geometry", () => {
  it.each([
    [0, { row: 0, col: 1 }], [3, { row: 0, col: 7 }], [4, { row: 1, col: 0 }], [7, { row: 1, col: 6 }],
    [20, { row: 5, col: 0 }], [31, { row: 7, col: 6 }],
  ])("square %i is at %j", (square, cell) => expect(squareCell(square)).toEqual(cell));

  it.each(Array.from({ length: 32 }, (_, square) => [square]))("square %i round-trips through its cell", (square) => {
    const { row, col } = squareCell(square);
    expect(squareAt(row, col)).toBe(square);
  });

  it.each([[0, 0], [0, 2], [1, 1], [1, 3], [7, 7]])("cell (%i,%i) is light and holds no square", (row, col) => {
    expect(squareAt(row, col)).toBe(null);
  });

  it.each([
    ["white keeps the board", "white", { row: 1, col: 2 }, { row: 1, col: 2 }],
    ["a watcher keeps the board", null, { row: 1, col: 2 }, { row: 1, col: 2 }],
    ["black turns it", "black", { row: 1, col: 2 }, { row: 6, col: 5 }],
  ] as const)("%s", (_name, you, cell, expected) => expect(displayCell(cell, you)).toEqual(expected));

  it.each([["b", "black", false], ["B", "black", true], ["w", "white", false], ["W", "white", true]] as const)(
    "piece %s", (char, color, king) => expect(pieceOf(char)).toEqual({ color, king }),
  );
  it("a dot is no piece", () => expect(pieceOf(".")).toBe(null));
});

describe("legal moves", () => {
  const legal = [mv(21, [17]), mv(21, [18]), mv(22, [18]), mv(10, [17, 24], [14, 20]), mv(10, [18, 26], [14, 22])];
  it("lists the pieces that can move", () => expect([...movableFrom(legal)].sort((a, b) => a - b)).toEqual([10, 21, 22]));
  it.each([[21, [17, 18]], [10, [24, 26]], [5, []]])("a piece on %i can end on %j", (from, ends) => {
    expect(landings(legal, from)).toEqual(ends);
  });
  it("picks the move by its last landing", () => expect(moveFor(legal, 10, 24)?.captures).toEqual([14, 20]));
  it("finds nothing for an illegal target", () => expect(moveFor(legal, 21, 30)).toBeUndefined());
});

describe("lines", () => {
  it.each([
    ["waiting, creator", view({ status: "waiting" }), "Waiting for white. Send the link, or let the house play."],
    ["waiting, watcher", view({ status: "waiting", you: null }), "This table is waiting for a second player."],
    ["your move", view({ legal: [mv(21, [17])] }), "Your move."],
    ["forced jump", view({ legal: [mv(10, [17, 24], [14, 20])] }), "Your move. You must jump."],
    ["their move", view({ turn: "white" }), "Waiting for the other side."],
    ["watching", view({ you: null, turn: "white" }), "White to move. You are watching."],
    ["you win by no moves", view({ status: "over", winner: "black", endedBy: "no_moves" }), "You win. White has no legal move."],
    ["you lose by no pieces", view({ status: "over", winner: "white", endedBy: "no_pieces" }), "You lose. You have no pieces left."],
    ["they resign", view({ status: "over", winner: "black", endedBy: "resign" }), "You win. White resigned."],
    ["you resign", view({ status: "over", winner: "white", endedBy: "resign" }), "You lose. You resigned."],
    ["draw", view({ status: "over", winner: "draw", endedBy: "draw_rule" }), "Draw. Eighty moves without a capture or a crown."],
    ["watcher sees a win", view({ status: "over", you: null, winner: "white", endedBy: "timeout" }), "White wins. Red ran out of time."],
  ])("statusLine, %s", (_name, v, line) => expect(statusLine(v)).toBe(line));

  it.each([
    [view(), "Red to move"], [view({ turn: "white" }), "White to move"], [view({ status: "over" }), "Game over"], [view({ status: "waiting" }), "Not started"],
  ])("turnLine %#", (v, line) => expect(turnLine(v)).toBe(line));

  it.each([[null, ""], [0, "0:00"], [9, "0:09"], [75, "1:15"]])("clockText(%s)", (seconds, text) => expect(clockText(seconds)).toBe(text));
  it("outcomeLine of a draw", () => expect(outcomeLine(view({ winner: "draw", endedBy: "draw_rule" }))).toContain("Draw"));
});

describe("trackPieces", () => {
  const empty = ".".repeat(32);
  const at = (...pieces: [number, string][]) => pieces.reduce((board, [square, char]) => board.slice(0, square) + char + board.slice(square + 1), empty);
  const ids = (...pairs: [number, string][]) => pairs.reduce((all, [square, id]) => { all[square] = id; return all; }, Array.from({ length: 32 }, () => null as string | null));
  it.each([
    ["first board names pieces by colour and square", null, at([1, "b"], [30, "w"]), [], 7, ids([1, "b1v7"], [30, "w30v7"])],
    ["a step keeps the id", ids([10, "bA"]), at([14, "b"]), [mv(10, [14])], 8, ids([14, "bA"])],
    ["a jump keeps the id and drops the captured piece", ids([5, "bA"], [9, "wB"]), at([14, "b"]), [mv(5, [14], [9])], 9, ids([14, "bA"])],
    ["a replayed move changes nothing", ids([14, "bA"]), at([14, "b"]), [mv(10, [14])], 9, ids([14, "bA"])],
    ["a piece that does not fit gets a fresh id", ids([14, "wZ"]), at([14, "b"]), [], 4, ids([14, "b14v4"])],
  ] as const)("%s", (_name, previous, board, moves, version, expected) => {
    expect(trackPieces(previous, board, moves, version)).toEqual(expected);
  });
});

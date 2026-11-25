import { describe, expect, it } from "vitest";
import { CHECKERS_LIMITS, START_BOARD } from "@playground/contracts";
import type { Color, Move } from "@playground/contracts";
import { checkers, legalMoves } from "./checkers";

const ann = { id: "p-aaaaaaaa", handle: "Ann" };
const bob = { id: "p-bbbbbbbb", handle: "Bob" };
const cy = { id: "p-cccccccc", handle: "Cy" };
const NOW = 1_000_000;
const TURN_MS = CHECKERS_LIMITS.turnSeconds * 1000;

// "13b 17w 22W": square then piece.
const boardOf = (pieces: string) => {
  const cells = Array.from({ length: 32 }, () => ".");
  for (const token of pieces.split(" ").filter(Boolean)) cells[Number.parseInt(token, 10)] = token.slice(-1);
  return cells.join("");
};
const piecesOf = (board: string) =>
  Array.from(board).flatMap((piece, square) => (piece === "." ? [] : [`${square}${piece}`])).join(" ");
const move = (from: number, path: number[], captures: number[] = []): Move => ({ from, path, captures });

const humans = () => checkers.apply(checkers.create(ann, { opponent: "human" }, NOW, 1), { type: "join" }, bob, NOW).state;
const vsBot = () => checkers.create(ann, { opponent: "bot" }, NOW, 1);
const setup = <S extends { board: string; turn: Color }>(state: S, pieces: string, turn: Color = "black"): S =>
  ({ ...state, board: boardOf(pieces), turn });
const play = <S>(state: S, from: number, path: number[], by = ann) =>
  checkers.apply(state as never, { type: "move", from, path }, by, NOW);

describe("legalMoves", () => {
  it.each<[string, string, Color, Move[]]>([
    ["black has seven openings", piecesOf(START_BOARD), "black", [
      move(8, [12]), move(8, [13]), move(9, [13]), move(9, [14]), move(10, [14]), move(10, [15]), move(11, [15]),
    ]],
    ["white has seven openings", piecesOf(START_BOARD), "white", [
      move(20, [16]), move(21, [16]), move(21, [17]), move(22, [17]), move(22, [18]), move(23, [18]), move(23, [19]),
    ]],
    ["a jump hides every step", "0b 13b 17w", "black", [move(13, [22], [17])]],
    ["a double jump is one move and its half is not", "8b 13w 22w", "black", [move(8, [17, 26], [13, 22])]],
    ["each branch of a jump is its own move", "8b 13w 21w 22w", "black", [
      move(8, [17, 24], [13, 21]), move(8, [17, 26], [13, 22]),
    ]],
    ["crowning ends a jump", "21b 25w 26w", "black", [move(21, [30], [25])]],
    ["a man never steps backward", "13b 31w", "black", [move(13, [16]), move(13, [17])]],
    ["a man never jumps backward", "13b 9w 31w", "black", [move(13, [16]), move(13, [17])]],
    ["a king steps in all four directions", "13B 31w", "black", [move(13, [8]), move(13, [9]), move(13, [16]), move(13, [17])]],
    ["a king jumps backward", "13B 9w 31w", "black", [move(13, [6], [9])]],
    ["a king chains jumps in turning directions", "13B 9w 10w", "black", [move(13, [6, 15], [9, 10])]],
    ["white jumps toward square 0", "17w 13b", "white", [move(17, [8], [13])]],
  ])("%s", (_name, pieces, color, expected) => {
    expect(legalMoves(boardOf(pieces), color)).toEqual(expected);
  });

  it("lets a king return over its own start square but never jump a piece twice", () => {
    const moves = legalMoves(boardOf("13B 9w 10w 18w 17w"), "black");
    expect(moves).toContainEqual(move(13, [6, 15, 22, 13], [9, 10, 18, 17]));
    for (const { captures } of moves) expect(new Set(captures).size).toBe(captures.length);
  });
});

describe("apply", () => {
  it.each<[string, string, [number, number[]], string, number]>([
    ["a step", "13b 31w", [13, [16]], "16b 31w", 0],
    ["a capture removes the piece", "13b 17w 31w", [13, [22]], "22b 31w", 1],
    ["a double jump removes both", "8b 13w 22w 31w", [8, [17, 26]], "26b 31w", 2],
    ["a man is crowned on the far row", "25b 3w", [25, [29]], "3w 29B", 0],
    ["a white man is crowned on row 0", "5w 31b", [5, [1]], "1W 31b", 0],
  ])("%s", (name, before, [from, path], after, taken) => {
    const color = name.startsWith("a white") ? "white" : "black";
    const step = play(setup(humans(), before, color), from, path, color === "white" ? bob : ann);
    expect(step.notice).toBeNull();
    expect(piecesOf(step.state.board)).toBe(after);
    expect(step.state.captured[color === "black" ? "white" : "black"]).toBe(taken);
    expect(step.state.turn).toBe(color === "black" ? "white" : "black");
  });

  it("records the move and whether it crowned", () => {
    const step = play(setup(humans(), "25b 3w"), 25, [29]);
    expect(checkers.view(step.state, ann).lastMoves).toEqual([{ from: 25, path: [29], captures: [], by: "black", crowned: true }]);
  });

  it.each<[string, string, [number, number[]], typeof ann, string]>([
    ["a step when a jump exists", "0b 13b 17w", [0, [4]], ann, "illegal_move"],
    ["half of a double jump", "8b 13w 22w", [8, [17]], ann, "illegal_move"],
    ["a move onto a taken square", "13b 16w 31w", [13, [16]], ann, "illegal_move"],
    ["a move of the other colour", "8b 22w", [22, [17]], bob, "not_your_turn"],
    ["a move by a stranger", "8b 22w", [8, [12]], cy, "not_seated"],
  ])("rejects %s", (_name, pieces, [from, path], who, code) => {
    const state = setup(humans(), pieces);
    const step = play(state, from, path, who);
    expect(step.notice?.code).toBe(code);
    expect(step.state).toBe(state);
    expect(step.events).toEqual([]);
  });

  it("rejects a move before white is seated and after the game", () => {
    const waiting = checkers.create(ann, { opponent: "human" }, NOW, 1);
    expect(play(waiting, 8, [12]).notice?.code).toBe("wrong_phase");
    const over = checkers.apply(humans(), { type: "resign" }, ann, NOW).state;
    expect(play(over, 8, [12]).notice?.code).toBe("wrong_phase");
  });

  it("emits a capture event for a human mover and none for the bot", () => {
    const human = play(setup(humans(), "13b 17w 31w"), 13, [22]);
    expect(human.events).toEqual([{ playerId: ann.id, event: { type: "checkers_capture" } }]);
    const bot = play(setup(vsBot(), "1b 13b 17w 22w"), 1, [6]);
    expect(bot.events).toEqual([]);
    expect(bot.state.captured.black).toBe(1);
  });

  it("seats a second player once and answers a third with table_full", () => {
    const waiting = checkers.create(ann, { opponent: "human" }, NOW, 1);
    expect(checkers.view(waiting, ann)).toMatchObject({ status: "waiting", you: "black" });
    const full = checkers.apply(waiting, { type: "join" }, bob, NOW).state;
    expect(checkers.view(full, bob)).toMatchObject({ status: "playing", you: "white", turnDeadline: NOW + TURN_MS });
    expect(checkers.apply(full, { type: "join" }, bob, NOW).state).toBe(full);
    expect(checkers.apply(full, { type: "join" }, cy, NOW).notice?.code).toBe("table_full");
    expect(checkers.view(full, cy).you).toBeNull();
  });
});

describe("view", () => {
  it("shows legal moves only to the player whose turn it is", () => {
    const state = humans();
    expect(checkers.view(state, ann).legal).toHaveLength(7);
    expect(checkers.view(state, bob).legal).toEqual([]);
    expect(checkers.view(state, cy).legal).toEqual([]);
    expect(checkers.view(state, null).legal).toEqual([]);
  });

  it("keeps the last two moves, oldest first", () => {
    const afterBot = play(vsBot(), 8, [12]).state;
    const view = checkers.view(afterBot, ann);
    expect(view.lastMoves.map((m) => m.by)).toEqual(["black", "white"]);
    expect(view.moveCount).toBe(2);
    const next = play(afterBot, view.legal[0]!.from, view.legal[0]!.path).state;
    expect(checkers.view(next, ann).lastMoves.map((m) => m.by)).toEqual(["black", "white"]);
  });

  it.each<[string, () => ReturnType<typeof humans>, Partial<ReturnType<typeof checkers.lobby>>]>([
    ["waiting for a second player", () => checkers.create(ann, { opponent: "human" }, NOW, 1), { seatsTaken: 1, status: "open" }],
    ["against the bot", vsBot, { seatsTaken: 2, status: "playing" }],
    ["finished", () => checkers.apply(humans(), { type: "resign" }, ann, NOW).state, { seatsTaken: 2, status: "over" }],
  ])("lobby row %s", (_name, make, expected) => {
    expect(checkers.lobby(make())).toMatchObject({ seatsTotal: 2, ...expected });
  });
});

describe("the end of a game", () => {
  it.each<[string, string, [number, number[]], string, string]>([
    ["the last piece is taken", "13b 17w", [13, [22]], "no_pieces", "black"],
    ["the side to move is blocked", "0b 20b 4w", [20, [24]], "no_moves", "black"],
  ])("%s", (_name, pieces, [from, path], endedBy, winner) => {
    const done = play(setup(humans(), pieces), from, path).state;
    expect(checkers.view(done, ann)).toMatchObject({ status: "over", endedBy, winner, legal: [], turnDeadline: null });
    expect(checkers.nextDeadline(done)).toBeNull();
  });

  it.each<[string, typeof ann, string]>([
    ["black resigns", ann, "white"],
    ["white resigns", bob, "black"],
  ])("%s", (_name, who, winner) => {
    const done = checkers.apply(humans(), { type: "resign" }, who, NOW).state;
    expect(checkers.view(done, ann)).toMatchObject({ status: "over", endedBy: "resign", winner });
  });

  it("answers a resignation by a stranger or on a finished game with a notice", () => {
    const over = checkers.apply(humans(), { type: "resign" }, ann, NOW).state;
    expect(checkers.apply(humans(), { type: "resign" }, cy, NOW).notice?.code).toBe("not_seated");
    expect(checkers.apply(over, { type: "resign" }, bob, NOW).notice?.code).toBe("wrong_phase");
  });

  it.each<[string, number, string]>([
    ["just before 80 plies", 78, "playing"],
    ["at 80 plies", 79, "over"],
  ])("a quiet game, %s", (_name, quiet, status) => {
    const state = { ...setup(humans(), "13B 30W"), quietPlies: quiet };
    const done = play(state, 13, [8]).state;
    expect(checkers.view(done, ann)).toMatchObject({ status, ...(status === "over" ? { endedBy: "draw_rule", winner: "draw" } : {}) });
  });

  it.each<[string, string]>([
    ["a capture", "13b 17w 31w"],
    ["a crowning", "25b 3w"],
  ])("%s resets the quiet count", (_name, pieces) => {
    const state = { ...setup(humans(), pieces), quietPlies: 79 };
    const move = legalMoves(state.board, "black")[0]!;
    expect(play(state, move.from, move.path).state.quietPlies).toBe(0);
  });

  it.each<[string, number, boolean]>([
    ["just before the deadline", NOW + TURN_MS - 1, false],
    ["at the deadline", NOW + TURN_MS, true],
  ])("the turn times out %s", (_name, at, over) => {
    const state = humans();
    const step = checkers.tick(state, at);
    expect(checkers.nextDeadline(state)).toBe(NOW + TURN_MS);
    if (over) expect(checkers.view(step.state, ann)).toMatchObject({ status: "over", endedBy: "timeout", winner: "white" });
    else expect(step.state).toBe(state);
  });

  it("does not time out a table that waits for a second player", () => {
    const state = checkers.create(ann, { opponent: "human" }, NOW, 1);
    expect(checkers.nextDeadline(state)).toBeNull();
    expect(checkers.tick(state, NOW + 10 ** 9).state).toBe(state);
  });

  it("a fast table uses short turns", () => {
    expect(checkers.nextDeadline(checkers.create(ann, { opponent: "bot", fast: true }, NOW, 1))).toBe(NOW + 5000);
  });
});

describe("the house bot", () => {
  // Black always plays 1 to 6, then the bot answers in the same step.
  it.each<[string, string, string]>([
    ["a capture beats a step", "1b 13b 17w 22w", "6b 8w 22w"],
    ["more captures beat fewer", "1b 13b 16b 25b 17w 22w 30w", "6b 13b 12w 17w 22w"],
    ["equal captures take the first piece", "1b 13b 25b 17w 22w 30w", "6b 25b 8w 22w 30w"],
    ["a crowning beats an earlier step", "1b 20b 0W 7w", "0W 2W 6b 20b"],
    ["otherwise the first move by square", "1b 30w 31w", "6b 25w 31w"],
  ])("%s", (_name, before, after) => {
    const step = play(setup(vsBot(), before), 1, [6]);
    expect(step.notice).toBeNull();
    expect(checkers.view(step.state, ann).turn).toBe("black");
    expect(piecesOf(step.state.board)).toBe(after.split(" ").sort((a, b) => Number.parseInt(a) - Number.parseInt(b)).join(" "));
  });
});

import { z } from "zod";
import { Handle, PlayerId, snapshotOf } from "./ids";

// American checkers on the 32 dark squares, numbered 0..31 row by row from black's back rank.
// Square s sits on row floor(s / 4). On even rows the dark squares are columns 1,3,5,7, on odd rows 0,2,4,6.
// Black starts on 0..11 and moves toward 31. White starts on 20..31 and moves toward 0. Black moves first.
export const SQUARES = 32;
export const Square = z.number().int().min(0).max(SQUARES - 1);
export const Color = z.enum(["black", "white"]);
export type Color = z.infer<typeof Color>;

// One character per square: b B (black man, king), w W (white man, king), . (empty).
export const Board = z.string().regex(/^[bBwW.]{32}$/);
export type Board = z.infer<typeof Board>;
export const START_BOARD: Board = "bbbbbbbbbbbb........wwwwwwwwwwww";

// A whole turn of one piece: a step, or every jump of a jump sequence. `path` lists the landing squares in order.
export const Move = z.object({
  from: Square,
  path: z.array(Square).min(1).max(12),
  captures: z.array(Square).max(12),
});
export type Move = z.infer<typeof Move>;

export const CheckersSeat = z.object({ id: PlayerId, handle: Handle, bot: z.boolean() });
export type CheckersSeat = z.infer<typeof CheckersSeat>;

export const CheckersView = z.object({
  board: Board,
  turn: Color,
  status: z.enum(["waiting", "playing", "over"]),
  seats: z.object({ black: CheckersSeat.nullable(), white: CheckersSeat.nullable() }),
  you: Color.nullable(),
  // Every legal move of the viewer, and only on the viewer's turn. The View never works out rules.
  legal: z.array(Move),
  // The moves since the viewer's previous turn, oldest first (at most two: theirs and the reply).
  lastMoves: z.array(Move.extend({ by: Color, crowned: z.boolean() })).max(2),
  winner: z.enum(["black", "white", "draw"]).nullable(),
  endedBy: z.enum(["no_pieces", "no_moves", "resign", "timeout", "draw_rule"]).nullable(),
  turnDeadline: z.number().nullable(),
  moveCount: z.number().int().min(0),
  // captured.white is the number of white pieces that black has taken.
  captured: z.object({ black: z.number().int().min(0), white: z.number().int().min(0) }),
});
export type CheckersView = z.infer<typeof CheckersView>;

export const CheckersSnapshot = snapshotOf("checkers", CheckersView);
export type CheckersSnapshot = z.infer<typeof CheckersSnapshot>;

export const CHECKERS_LIMITS = { turnSeconds: 120, drawAfterQuietPlies: 80 } as const;

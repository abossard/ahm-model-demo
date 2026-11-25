import { useRef, type CSSProperties } from "react";
import type { CheckersView } from "@playground/contracts";
import { displayCell, pieceOf, squareAt, trackPieces } from "./logic";

function Crown() {
  return (
    <svg className="crown" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 18 3 7l5 4 4-6 4 6 5-4-1 11z" fill="currentColor" />
    </svg>
  );
}

// The board as this viewer sees it. It renders `view` and decides nothing: legal moves come from the server.
export function Board(props: {
  view: CheckersView;
  version: number;
  selected: number | null;
  movable: ReadonlySet<number>;
  targets: readonly number[];
  disabled: boolean;
  onSquare(square: number): void;
}) {
  const { view, version, selected, movable, targets, disabled } = props;
  // Piece ids follow the board from snapshot to snapshot. Each piece's view-transition-name is its id.
  const tracked = useRef<{ version: number; ids: (string | null)[] } | null>(null);
  if (tracked.current?.version !== version) {
    tracked.current = { version, ids: trackPieces(tracked.current?.ids ?? null, view.board, view.lastMoves, version) };
  }
  const ids = tracked.current.ids;
  const lastEnds = new Set(view.lastMoves.map((move) => move.path[move.path.length - 1]!));
  const lastStarts = new Set(view.lastMoves.map((move) => move.from));

  const cells = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const home = displayCell({ row, col }, view.you);
      const square = squareAt(home.row, home.col);
      if (square === null) {
        cells.push(<div key={`${row}-${col}`} className="sq sq-light" aria-hidden="true" />);
        continue;
      }
      const char = view.board[square];
      const piece = pieceOf(char);
      const isTarget = targets.includes(square);
      const isMovable = movable.has(square);
      const legal = isTarget ? "to" : isMovable ? "from" : undefined;
      const name = piece ? `${piece.color} ${piece.king ? "king" : "man"}` : "empty";
      cells.push(
        <button
          key={`${row}-${col}`}
          type="button"
          className="sq sq-dark"
          data-testid={`square-${square}`}
          data-piece={char}
          data-legal={legal}
          data-selected={selected === square || undefined}
          data-last={lastEnds.has(square) || lastStarts.has(square) || undefined}
          disabled={disabled || !legal}
          aria-label={`Square ${square}, ${name}${legal === "from" ? ", can move" : legal === "to" ? ", move here" : ""}`}
          onClick={() => props.onSquare(square)}
        >
          {piece ? (
            <span
              className="piece"
              data-color={piece.color}
              style={{ viewTransitionName: `piece-${ids[square]}`, viewTransitionClass: "piece drop" } as CSSProperties}
            >
              {piece.king ? <Crown /> : null}
            </span>
          ) : null}
        </button>,
      );
    }
  }
  return (
    <div className="board" role="group" aria-label="Checkers board" data-you={view.you ?? "watching"}>
      {cells}
    </div>
  );
}


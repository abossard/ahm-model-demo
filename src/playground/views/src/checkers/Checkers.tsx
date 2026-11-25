import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckersSnapshot, CheckersView, Color, LobbyRow } from "@playground/contracts";
import { Button, Frame, Lobby, NoticeBar, call, outputOf, useCountdown, useTable, type ViewContext } from "../kit";
import { Board } from "./Board";
import { clockText, landings, moveFor, movableFrom, statusLine, turnLine } from "./logic";
import "./checkers.css";

function SeatRow({ color, view }: { color: Color; view: CheckersView }) {
  const seat = view.seats[color];
  const mine = view.you === color;
  return (
    <li className="seat" data-color={color} data-mine={mine}>
      <span className="seat-disc" aria-hidden="true" />
      <span className="seat-name">{seat ? seat.handle : "Open seat"}{mine ? " (you)" : ""}{seat?.bot ? " (house)" : ""}</span>
      <span className="seat-lost" title="Pieces lost">{view.captured[color]} lost</span>
    </li>
  );
}

// Layer 3. The server holds the game and every rule. This View draws one snapshot and sends one move.
export function Checkers({ app, player, first }: ViewContext) {
  const open = outputOf<"checkers_open">(first);
  const table = useTable<CheckersSnapshot>(app, player, open.snapshot);
  const [lobby, setLobby] = useState<LobbyRow[]>(open.lobby);
  const [openingNotice, setOpeningNotice] = useState(open.notice);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const joined = useRef(false);
  const snapshot = table.snapshot;
  const view = snapshot?.view ?? null;
  const secondsLeft = useCountdown(view?.status === "playing" ? view.turnDeadline : null, snapshot?.serverTime ?? 0);

  const refresh = useCallback(async () => {
    try { setLobby((await call(app, "table_list", { game: "checkers" })).tables); } catch { /* the notice bar shows the next failure */ }
  }, [app]);

  // An invite link opens a game that waits for white. Opening it is taking the seat.
  useEffect(() => {
    if (joined.current || !snapshot || !view) return;
    if (view.status === "waiting" && view.you === null && view.seats.white === null) {
      joined.current = true;
      void table.act("checkers_join", { player, tableId: snapshot.tableId });
    }
  }, [snapshot, view, player, table]);

  useEffect(() => { setSelected(null); setConfirmResign(false); }, [snapshot?.version]);

  const create = (opponent: "human" | "bot") => {
    setOpeningNotice(null);
    void table.act("checkers_create", { player, opponent });
  };

  if (!snapshot || !view) {
    return (
      <Frame offline={table.offline}>
        <Lobby
          rows={lobby}
          busy={table.busy}
          empty="No open games. Start one, or let the house play."
          actions={[
            { testid: "lobby-create-bot", label: "Play the house", primary: true, onClick: () => create("bot") },
            { testid: "lobby-create", label: "Invite a person", onClick: () => create("human") },
            { testid: "lobby-refresh", label: "Refresh", quiet: true, onClick: () => void refresh() },
          ]}
          onOpen={(row) => { setOpeningNotice(null); void table.act("checkers_join", { player, tableId: row.tableId }); }}
        />
        <NoticeBar notice={table.notice ?? openingNotice} error={table.error} />
      </Frame>
    );
  }

  const movable = view.status === "playing" ? movableFrom(view.legal) : new Set<number>();
  const targets = selected === null ? [] : landings(view.legal, selected);
  const mine = view.status === "playing" && view.you === view.turn;

  function onSquare(square: number) {
    if (!snapshot || !view) return;
    if (selected !== null && targets.includes(square)) {
      const move = moveFor(view.legal, selected, square);
      if (move) void table.act("checkers_move", { player, tableId: snapshot.tableId, version: snapshot.version, from: move.from, path: move.path });
      return;
    }
    setSelected(movable.has(square) && square !== selected ? square : null);
  }

  return (
    <Frame offline={table.offline}>
      <div className="ck"><div className="ck-grid">
        <Board
          view={view}
          version={snapshot.version}
          selected={selected}
          movable={movable}
          targets={targets}
          disabled={table.busy || !mine}
          onSquare={onSquare}
        />
        <section className="ck-side" aria-label="Game">
          <p className="ck-status" data-testid="status" aria-live="polite">{statusLine(view)}</p>
          <p className="ck-turn" data-testid="turn" data-turn={view.turn} data-mine={mine}>
            <span>{turnLine(view)}</span>
            {secondsLeft !== null ? <span className="ck-clock" data-low={secondsLeft <= 15}>{clockText(secondsLeft)}</span> : null}
          </p>
          <ul className="seats">
            <SeatRow color="black" view={view} />
            <SeatRow color="white" view={view} />
          </ul>
          <p className="ck-count">{view.moveCount} {view.moveCount === 1 ? "move" : "moves"} played</p>
          <NoticeBar notice={table.notice} error={table.error} />
          <div className="ck-actions">
            {view.status === "playing" && view.you ? (
              confirmResign
                ? <Button variant="danger" busy={table.busy} data-testid="checkers-resign-confirm" onClick={() => void table.act("checkers_resign", { player, tableId: snapshot.tableId })}>Resign for good</Button>
                : <Button variant="quiet" data-testid="checkers-resign" onClick={() => setConfirmResign(true)}>Resign</Button>
            ) : null}
            <Button variant="quiet" data-testid="checkers-lobby" onClick={() => { table.leave(); void refresh(); }}>
              {view.status === "over" ? "Back to the lobby" : "Leave the table"}
            </Button>
          </div>
        </section>
      </div></div>
    </Frame>
  );
}

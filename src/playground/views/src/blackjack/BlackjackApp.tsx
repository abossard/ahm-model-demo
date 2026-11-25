import { BLACKJACK_LIMITS, type BlackjackSnapshot, type ToolOutput } from "@playground/contracts";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Button, call, errorText, Frame, Lobby, log, NoticeBar, useCountdown, useTable, type ViewContext } from "../kit";
import { Hand } from "./Cards";
import { Controls } from "./Controls";
import { Mind } from "./Mind";
import { Seat } from "./Seat";
import {
  clockFraction, dealerSay, dealerTotalText, mySeat, modelContextText, phaseLine, PHASE_NAME, type Action,
} from "./logic";

export function BlackjackApp({ app, player, first }: ViewContext) {
  const opened = first.structuredContent as ToolOutput<"blackjack_open">;
  const table = useTable<BlackjackSnapshot>(app, player, opened.snapshot);
  const { snapshot, busy } = table;
  const [rows, setRows] = useState(opened.lobby);
  const tableId = snapshot?.tableId ?? null;

  // Back in the lobby: read the tables again, they moved while you sat.
  useEffect(() => {
    if (snapshot) return;
    let live = true;
    call(app, "table_list", { game: "blackjack" })
      .then((out) => { if (live) setRows(out.tables); })
      .catch((error: unknown) => log.warn("table_list failed", { error: errorText(error) }));
    return () => { live = false; };
  }, [app, snapshot]);

  const act = useCallback((action: Action) => {
    if (tableId) void table.act("blackjack_act", { player, tableId, action });
  }, [table.act, player, tableId]);

  if (!snapshot) {
    return (
      <Frame title="Blackjack" aside="Six seats. A model deals.">
        <div className="bj">
          <NoticeBar notice={table.notice ?? opened.notice} error={table.error} />
          <Lobby
            rows={rows}
            busy={busy}
            empty="No tables are open. Open one and the first seat is yours."
            actions={[{ testid: "lobby-create", label: "Open a table", primary: true, onClick: () => void table.act("blackjack_create", { player }) }]}
            onOpen={(row) => void table.act("blackjack_sit", { player, tableId: row.tableId })}
          />
        </div>
      </Frame>
    );
  }

  return <Table app={app} snapshot={snapshot} table={table} player={player} act={act} />;
}

function Table({ app, snapshot, table, player, act }: {
  app: ViewContext["app"]; snapshot: BlackjackSnapshot; table: ReturnType<typeof useTable<BlackjackSnapshot>>; player: ViewContext["player"]; act(action: Action): void;
}) {
  const { view, tableId } = snapshot;
  const seconds = useCountdown(view.deadline, snapshot.serverTime);
  const seat = mySeat(view);
  const say = dealerSay(view.dealer.say);

  // What a model watching this table may know. The kit sends the table id; this adds what is happening at it.
  useEffect(() => {
    app.updateModelContext({ content: [{ type: "text", text: modelContextText(view) }], structuredContent: { tableId } })
      .catch((error: unknown) => log.warn("updateModelContext failed", { error: errorText(error) }));
  }, [app, tableId, snapshot.version, view]);

  return (
    <Frame
      title="Blackjack"
      aside={<>{view.title}{view.round > 0 && <> &middot; round {view.round}</>}</>}
      offline={table.offline}
    >
      <div className="bj" data-phase={view.phase}>
        <div className="bj-top">
          <div className="phase">
            <div className="phase-row">
              <span className="phase-name" data-testid="phase" data-phase={view.phase} style={{ viewTransitionName: "phase", viewTransitionClass: "banner" } as CSSProperties}>{PHASE_NAME[view.phase]}</span>
              <span className="phase-clock num" data-testid="countdown" aria-hidden={seconds === null}>{seconds ?? ""}</span>
            </div>
            <div className="phase-bar" aria-hidden="true">
              <i style={{ transform: `scaleX(${clockFraction(view.phase, seconds)})` }} />
            </div>
          </div>
          {!seat && <Button variant="quiet" className="btn-small" data-testid="to-lobby" onClick={table.leave}>Lobby</Button>}
          {seat && (
            <dl className="stack">
              <dt>Your chips</dt>
              <dd className="num" data-testid="chips" style={{ viewTransitionName: "my-chips", viewTransitionClass: "num" } as CSSProperties}>{seat.chips.toLocaleString("en-US")}</dd>
            </dl>
          )}
        </div>

        <NoticeBar notice={table.notice} error={table.error} />

        <div className="bj-main">
          <div className="felt">
            <div className="dealer">
              <span className="dealer-label">Dealer</span>
              <Hand cards={view.dealer.cards} owner="dealer" size="dealer" testId="dealer-cards" />
              <div className="dealer-read">
                <span className="dealer-total num" data-testid="dealer-total">{dealerTotalText(view.dealer)}</span>
              </div>
              <p className="say" data-testid="dealer-say">{say}</p>
            </div>
            <div className="centre">
              {view.misdeal && <p className="misdeal" data-testid="misdeal">{phaseLine(view)}</p>}
              {!view.misdeal && <p className="line" data-testid="phase-line">{phaseLine(view)}</p>}
              <Controls
                view={view}
                busy={table.busy}
                onSit={() => void table.act("blackjack_sit", { player, tableId })}
                onLeave={() => { void table.act("blackjack_leave", { player, tableId }).then(table.leave); }}
                onBet={(amount) => void table.act("blackjack_bet", { player, tableId, amount })}
                onAct={act}
              />
            </div>
            <div className="seats">
              {Array.from({ length: BLACKJACK_LIMITS.seats }, (_, i) => (
                <Seat key={i} index={i} view={view} remaining={seconds} />
              ))}
            </div>
          </div>
          <Mind view={view} />
        </div>

      </div>
    </Frame>
  );
}

import type { GoodId, PlanetId, ToolOutput } from "@playground/contracts";
import { PLANETS, TRADER_LIMITS } from "@playground/contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Frame, NoticeBar, type ViewContext } from "../kit";
import { Chart } from "./Chart";
import { Gauge } from "./Gauges";
import { Ledger } from "./Ledger";
import { Log, Scores } from "./Side";
import { daysLeft, formatCredits, holdUnits, isOver, verdict, type Qty } from "./logic";
import { useScores, useTrader } from "./useTrader";

// Flash a readout when its value changes, so a trade is felt where the eye already is.
function useFlash(value: number): boolean {
  const [flash, setFlash] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 500);
    return () => window.clearTimeout(id);
  }, [value]);
  return flash;
}

export function TraderApp({ app, player, first }: ViewContext) {
  const { snapshot, notice, failure, busy, act } = useTrader(app, first.structuredContent as ToolOutput<"trader_open">, player);
  const view = snapshot.view;
  const over = isOver(view);
  const [qty, setQty] = useState<Qty>(5);
  const [confirmNew, setConfirmNew] = useState(false);
  const { scores, refresh } = useScores(app, over);
  const flash = useFlash(view.credits);
  const here = PLANETS.find((p) => p.id === view.location)!;
  const dayCells = Array.from({ length: view.maxDay }, (_, i) => i + 1);

  const jump = (to: PlanetId) => void act("trader_travel", { to });
  const buy = (good: GoodId, n: number) => void act("trader_buy", { good, qty: n });
  const sell = (good: GoodId, n: number) => void act("trader_sell", { good, qty: n });

  return (
    <Frame title="Drift Ledger" aside={<>{view.pilot}, docked at {here.name}</>}>
      <div className="trader" aria-busy={busy}>
        <header className="hud">
          <dl className="hud-read">
            <div className="read-main">
              <dt>Credits</dt>
              <dd className={`num big ${flash ? "flash" : ""}`} data-testid="credits" style={{ viewTransitionName: "credits", viewTransitionClass: "num" } as CSSProperties}>{formatCredits(view.credits)}</dd>
            </div>
            <div>
              <dt>Net worth</dt>
              <dd className="num" data-testid="net-worth">{formatCredits(view.netWorth)}</dd>
            </div>
            <div>
              <dt>Day</dt>
              <dd className="num" data-testid="day">{view.day}<span className="of"> / {view.maxDay}</span></dd>
            </div>
          </dl>
          <div className="calendar" role="img" aria-label={`Day ${view.day} of ${view.maxDay}, ${daysLeft(view)} left`}>
            {dayCells.map((d) => <i key={d} className={d < view.day ? "past" : d === view.day ? "now" : ""} />)}
          </div>
        </header>

        <div className="gauges">
          <Gauge label="Fuel" value={view.fuel} cap={view.fuelCap} unit="units" testId="fuel" tone="fuel" />
          <Gauge label="Hold" value={view.cargoUsed} cap={view.cargoCap} unit={`units, ${holdUnits(view)} held`} testId="hold" tone="hold" />
        </div>

        <NoticeBar notice={notice} error={failure} />

        <div className="board">
          <Chart view={view} busy={busy || over} onJump={jump} />
          <div className="ledger-wrap">
            <Ledger view={view} qty={qty} busy={busy || over} onQty={setQty} onBuy={buy} onSell={sell}
              onRefuel={(units) => void act("trader_refuel", { units })} />
            {over && (
              <div className="over" role="alert" data-testid="run-over">
                <p className="over-kicker num">Day {view.maxDay}. Run closed.</p>
                <p className="over-worth num">{formatCredits(view.netWorth)}</p>
                <p>{verdict(view)} {view.profitableSales} profitable {view.profitableSales === 1 ? "sale" : "sales"}.</p>
                <Button variant="primary" data-testid="new-run" busy={busy} onClick={() => void act("trader_new_run", {})}>
                  Start a new run
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="lower">
          <Log log={view.log} />
          <Scores scores={scores} pilot={view.pilot} onRefresh={refresh} />
        </div>

        {!over && (
          <footer className="foot">
            <span className="muted">Start {formatCredits(TRADER_LIMITS.startCredits)}. {daysLeft(view)} days left.</span>
            {confirmNew ? (
              <span className="confirm">
                Abandon this run?
                <Button variant="danger" className="btn-small" data-testid="new-run" busy={busy}
                  onClick={() => { setConfirmNew(false); void act("trader_new_run", {}); }}>Abandon</Button>
                <Button variant="quiet" className="btn-small" onClick={() => setConfirmNew(false)}>Keep flying</Button>
              </span>
            ) : (
              <Button variant="quiet" className="btn-small" onClick={() => setConfirmNew(true)}>New run</Button>
            )}
          </footer>
        )}
      </div>
    </Frame>
  );
}

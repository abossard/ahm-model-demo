import { Button } from "../kit";
import type { GoodId, TraderView } from "@playground/contracts";
import { buyFit, formatCredits, margin, marginText, qtyLabel, QTY_STEPS, refuelCost, refuelUnits, sellFit, type Qty } from "./logic";

interface Props {
  view: TraderView;
  qty: Qty;
  busy: boolean;
  onQty(qty: Qty): void;
  onBuy(good: GoodId, qty: number): void;
  onSell(good: GoodId, qty: number): void;
  onRefuel(units: number): void;
}

export function Ledger({ view, qty, busy, onQty, onBuy, onSell, onRefuel }: Props) {
  const refuel = refuelUnits(view);
  return (
    <section className="ledger" aria-label="Market">
      <div className="ledger-bar">
        <h2>Market</h2>
        <div className="seg" role="group" aria-label="Quantity per order">
          {QTY_STEPS.map((step) => (
            <button key={step} type="button" className="seg-item" aria-pressed={qty === step} onClick={() => onQty(step)}>
              {qtyLabel(step)}
            </button>
          ))}
        </div>
      </div>
      <table className="rows">
        <thead>
          <tr>
            <th scope="col">Good</th>
            <th scope="col" className="r">Price</th>
            <th scope="col" className="r">Held</th>
            <th scope="col" className="r">Avg cost</th>
            <th scope="col"><span className="sr">Orders</span></th>
          </tr>
        </thead>
        <tbody>
          {view.market.map((row) => {
            const m = margin(row);
            const buy = buyFit(view, row, qty);
            const sell = sellFit(row, qty);
            return (
              <tr key={row.good} data-testid={`row-${row.good}`}>
                <th scope="row">{row.name}</th>
                <td className="r num price">{formatCredits(row.price)}</td>
                <td className="r num held" data-label="Held">{row.held || "–"}</td>
                <td className="r num cost" data-label="Avg cost">
                  {row.avgCost === null ? "–" : formatCredits(Math.round(row.avgCost))}
                  {m.kind !== "none" && (
                    <span className={`margin margin-${m.kind}`}>
                      {marginText(m)}
                    </span>
                  )}
                </td>
                <td className="orders">
                  <Button className="order" data-testid={`buy-${row.good}`} disabled={busy || buy === 0}
                    onClick={() => onBuy(row.good, qty)} aria-label={`Buy ${buy} ${row.name}`}>
                    Buy<span className="num fit">{buy || ""}</span>
                  </Button>
                  <Button variant="quiet" className="order" data-testid={`sell-${row.good}`} disabled={busy || sell === 0}
                    onClick={() => onSell(row.good, qty)} aria-label={`Sell ${sell} ${row.name}`}>
                    Sell<span className="num fit">{sell || ""}</span>
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="refuel">
        <span>Fuel here <span className="num">{view.fuelPrice}</span> each</span>
        <button type="button" className="btn" data-testid="refuel" disabled={busy || refuel === 0} onClick={() => onRefuel(refuel)}>
          Refuel<span className="num fit">{refuel ? `+${refuel} · ${formatCredits(refuelCost(view))}` : ""}</span>
        </button>
      </div>
    </section>
  );
}

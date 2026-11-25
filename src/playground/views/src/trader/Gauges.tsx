import type { CSSProperties } from "react";
import { fraction } from "./logic";

interface Props {
  label: string;
  value: number;
  cap: number;
  unit: string;
  testId: string;
  tone: "fuel" | "hold";
}

// A plain gauge: one cell per unit, filled from the left. Cells are drawn by CSS, the reading is real text.
export function Gauge({ label, value, cap, unit, testId, tone }: Props) {
  return (
    <div className={`gauge gauge-${tone}`}>
      <div className="gauge-head">
        <span>{label}</span>
        <span className="num" data-testid={testId} style={{ viewTransitionName: testId, viewTransitionClass: "num" } as CSSProperties}>{value}<span className="of"> / {cap} {unit}</span></span>
      </div>
      <div
        className="gauge-cells"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={value}
        style={{ gridTemplateColumns: `repeat(${cap}, 1fr)` }}
        data-fill={fraction(value, cap) < 0.2 ? "low" : "ok"}
      >
        {Array.from({ length: cap }, (_, i) => <i key={i} className={i < value ? "on" : ""} />)}
      </div>
    </div>
  );
}

import type { PlanetId } from "@playground/contracts";
import { PLANETS, type TraderView } from "@playground/contracts";
import { useEffect, useRef, useState } from "react";
import { Starfield } from "./Starfield";
import { chartPoint, jumpHint, jumpState, portSide, routeCostText } from "./logic";

interface Props {
  view: TraderView;
  busy: boolean;
  onJump(to: PlanetId): void;
}

// Six ports on a 100 by 100 map. The routes fan out of the port you are in: that is the only map that matters.
export function Chart({ view, busy, onJump }: Props) {
  const here = PLANETS.find((p) => p.id === view.location)!;
  const from = chartPoint(here.x, here.y);
  const before = useRef(here);
  const [travel, setTravel] = useState<{ dx: number; dy: number; id: number } | null>(null);
  // A jump is the way from the port the ship left to the port it reached; the starfield streaks the other way.
  useEffect(() => {
    const was = before.current;
    before.current = here;
    const length = Math.hypot(here.x - was.x, here.y - was.y);
    if (length > 0) setTravel({ dx: (here.x - was.x) / length, dy: (here.y - was.y) / length, id: Date.now() });
  }, [here]);
  return (
    <section className="chart" aria-label="Star chart">
      <Starfield travel={travel} />
      <svg className="chart-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[20, 40, 60, 80].map((n) => (
          <g key={n}>
            <line x1={n} y1="0" x2={n} y2="100" />
            <line x1="0" y1={n} x2="100" y2={n} />
          </g>
        ))}
        {view.routes.map((route) => {
          const to = chartPoint(route.x, route.y);
          const state = jumpState(view, route, route.to);
          return <line key={route.to} className={`lane lane-${state}`} x1={from.left} y1={from.top} x2={to.left} y2={to.top} />;
        })}
      </svg>
      {PLANETS.map((planet) => {
        const route = view.routes.find((r) => r.to === planet.id);
        const state = jumpState(view, route, planet.id);
        const point = chartPoint(planet.x, planet.y);
        const side = portSide(planet.id);
        const hint = jumpHint(state);
        const disabled = state !== "ready" || busy;
        return (
          <button
            key={planet.id}
            type="button"
            data-testid={`planet-${planet.id}`}
            data-state={state}
            className={`port port-${side}`}
            style={{ left: `${point.left}%`, top: `${point.top}%` }}
            disabled={disabled}
            aria-disabled={disabled}
            aria-label={`${planet.name}. ${route ? routeCostText(route) : "You are here"}. ${hint}`.trim()}
            title={planet.blurb}
            onClick={() => onJump(planet.id)}
          >
            <span className="port-node" aria-hidden="true" style={state === "here" ? { viewTransitionName: "ship" } : undefined} />
            <span className="port-label">
              <span className="port-name">{planet.name}</span>
              <span className="port-cost">{route && state !== "here" ? routeCostText(route) : "You are here"}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

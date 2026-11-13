import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seriesKey } from "../model/timeline";
import { HOUR, MINUTE } from "../model/timelineScale";
import { EMPTY_STORE } from "../model/timeStore";
import type { Entity } from "../model/types";
import type { ZoomLevel } from "../model/zoomLevels";
import { actions, useStore } from "../store/store";
import { EntityNode, estimateNodeSize, type EntityNodeData, type EntityRfNode } from "./EntityNode";
import type { NodeProps } from "@xyflow/react";

vi.mock("@xyflow/react", () => ({
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  Handle: () => null,
  useStore: () => undefined,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-11T12:00:00Z");

const api: Entity = {
  name: "api",
  displayName: "API",
  healthState: "Degraded",
  impact: "Standard",
  canvasPosition: null,
  discoveredBy: null,
  parents: [],
  children: [],
  unlinked: false,
  latestEvaluationAt: null,
  latestTransitionAt: null,
  signals: [
    { name: "cpu", displayName: "CPU", kind: "metric", healthState: "Degraded", value: 90, reportedAt: null, writable: false },
    { name: "errors", displayName: "Errors", kind: "metric", healthState: "Healthy", value: 0, reportedAt: null, writable: false },
  ],
  report: { eligible: true, signalName: null },
};

/** The card as the browser draws it: rendered with the store as it is, not as a server would. */
function card(level: ZoomLevel = "card"): string {
  const data: EntityNodeData = {
    entity: api,
    displayRole: "card",
    selected: false,
    highlighted: false,
    hasChildren: false,
    collapsed: false,
    hiddenCount: 0,
    hiddenStates: new Map(),
    badge: null,
    marked: false,
    inChain: false,
    level,
  };
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<EntityNode {...({ id: api.name, data } as unknown as NodeProps<EntityRfNode>)} />));
  const markup = host.innerHTML;
  act(() => root.unmount());
  return markup;
}

const count = (markup: string, pattern: RegExp): number => markup.match(new RegExp(pattern, "g"))?.length ?? 0;

afterEach(() => {
  actions.setCardSignals(false);
  useStore.setState({ timelineSeries: EMPTY_STORE, timelinePinned: null });
});

describe("the signal rows of a card", () => {
  it.each([
    { name: "Signals off", signals: false, level: "card", rows: 0 },
    { name: "Signals on", signals: true, level: "card", rows: 2 },
    { name: "Signals on, zoomed out to a name", signals: true, level: "pill", rows: 0 },
    { name: "Signals on, zoomed out to a dot", signals: true, level: "dot", rows: 0 },
  ] as const)("with $name, the card shows $rows rows, each with a sparkline", ({ signals, level, rows }) => {
    actions.setCardSignals(signals);

    const markup = card(level);

    expect(count(markup, /class="entity-node__row"/)).toBe(rows);
    expect(count(markup, /data-testid="sparkline"/)).toBe(rows);
  });

  it.each([
    { name: "off", signals: false, height: 54 },
    { name: "on", signals: true, height: 54 + 16 + 2 * 22 },
  ])("are part of the estimated size with Signals $name", ({ signals, height }) => {
    expect(estimateNodeSize(api, false, "card", signals)).toEqual({ width: 260, height });
  });

  it.each([
    { name: "nothing is held yet", held: false, empty: true },
    { name: "the window is held", held: true, empty: false },
  ])("draw a faint flat line while $name, and the series once it is", ({ held, empty }) => {
    actions.setCardSignals(true);
    const info = { name: "cpu", displayName: "CPU", kind: "metric", unit: "%", refreshInterval: "PT5M", rules: { degraded: { operator: "GreaterThan", threshold: 70 }, unhealthy: null, dynamic: false } };
    const rows = [[NOW - 2 * HOUR, 40, 1], [NOW - HOUR, 60, 1], [NOW - 30 * MINUTE, 90, 2]] as const;
    useStore.setState({
      timelineSeries: {
        ...EMPTY_STORE,
        now: NOW,
        entities: [{ name: "api", displayName: "API", parents: [], state: 2, signals: [info, { ...info, name: "errors", displayName: "Errors" }] }],
        series: held ? { [seriesKey("api", "cpu")]: [null, { rows, covered: [{ from: NOW - 6 * HOUR, to: NOW }], error: null }, null] } : {},
      },
    });

    const markup = card();

    expect(count(markup, /data-empty="true"/)).toBe(empty ? 2 : 1);
    expect(markup.includes('stroke="var(--degraded-dot)" data-level="2"')).toBe(held);
  });
});

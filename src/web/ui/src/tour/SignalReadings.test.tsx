import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { entity, signal } from "../../tests/fixture";
import type { EntitySignal } from "../model/types";
import { SignalReadings, signalReadings } from "./SignalReadings";

const pending = { ...signal("requests", "Failed requests", null, "Unknown"), reportedAt: null };
const owner = entity({ name: "checkout", displayName: "Checkout service", healthState: "Healthy" });
const failing = { ...pending, evaluationError: "Log query returned no rows" };
const entities = (...signals: EntitySignal[]) => [{ ...owner, signals }];
// The web app can clip the scope after the ARM operation name.
const metricAccess = "Metrics query failed: The client 'app-id' with object id 'object-id' does not have authorization to perform action 'Microsoft.Insights/metrics/read' over scope '/subscriptions/...";

function renderError(message: string) {
  const html = renderToStaticMarkup(<SignalReadings entities={entities({ ...pending, evaluationError: message })}
    stop="readings" historical={false} onInspect={() => {}} />);
  return new DOMParser().parseFromString(html, "text/html").querySelector('[data-signal-status="error"]')!;
}

describe("signal readings on a created model", () => {
  it.each([
    [pending, "waiting"],
    [{ ...pending, value: 0 }, "reported"],
    [{ ...pending, reportedAt: "2026-11-20T09:30:00Z" }, "reported"],
    [{ ...pending, healthState: "Unhealthy" }, "reported"],
    [{ ...failing, reportedAt: "2026-11-20T09:30:00Z", value: 0 }, "error"],
  ] as const)("classifies the evidence Azure reported (%o)", (item, expected) => {
    expect(signalReadings(entities(item))[0]?.status).toBe(expected);
  });

  it.each([
    { ...pending, kind: "External" }, { ...pending, writable: true }, { ...pending, healthState: "Deleted" as const },
  ])("skips signals that do not collect readings (%o)", item => {
    expect(signalReadings(entities(item))).toEqual([]);
  });

  it.each([
    ["overview", false, "1 signal has an evaluation error."],
    ["readings", false, "1 signal is waiting for its first reading."],
    ["readings", true, "Return to now"],
  ] as const)("shows the %s stop at the requested moment", (stop, historical, expected) => {
    const result = renderToStaticMarkup(<SignalReadings stop={stop} historical={historical}
      entities={entities(pending, { ...failing, name: "cpu", displayName: "CPU" })} onInspect={() => {}} />);
    const doc = new DOMParser().parseFromString(result, "text/html");
    expect(doc.body.textContent).toContain(expected);
    expect(Boolean(doc.querySelector('[data-tour-entity="checkout"][data-tour-signal="cpu"]'))).toBe(!historical);
    expect(doc.body.textContent?.includes("Log query returned no rows")).toBe(!historical);
  });

  it.each([metricAccess, metricAccess.replace("Microsoft.Insights", "Microsoft.Insights".toUpperCase())])(
    "explains a denied metric read and lets the reader expand the Azure message", message => {
      const row = renderError(message);
      const visible = row.querySelector(".tour-reading-error")!.textContent;
      expect(visible).toContain("Monitoring Reader");
      expect(visible).not.toContain("object-id");
      const details = row.querySelector("details")!;
      expect(details.open).toBe(false);
      const toggle = details.querySelector("summary")!;
      expect(toggle.textContent).toBe("Azure error details");
      toggle.click();
      expect(details.open).toBe(true);
      expect(details.querySelector("p")!.textContent).toBe(message);
      toggle.click();
      expect(details.open).toBe(false);
    },
  );

  it.each([failing.evaluationError, metricAccess.replace("metrics/read", "diagnosticSettings/write"),
    "No samples returned by Microsoft.Insights/metrics/read."])("shows the original reason for %s", message => {
    const row = renderError(message);
    expect(row.querySelector(".tour-reading-error")!.textContent).toContain(message);
    expect(row.querySelector("details")).toBeNull();
  });
});

import { expect, type Page } from "@playwright/test";
import type { LiveDelta } from "../src/model/live";
import type { HealthModel } from "../src/model/types";
import type { Capture } from "./capture";

type CaptureWindow = Window & { addOnboardingSample?: (frame: string) => void };

/** Keep the fixture's real stream and insert two sample evaluations for the model on the receipt. */
async function scriptEvaluations(page: Page, modelName: string) {
  await page.addInitScript(name => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(response.url);
      if (url.origin !== location.origin || url.pathname !== "/api/health-model/stream" ||
          url.searchParams.get("model") !== name || !response.ok || !response.body) return response;
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          (window as CaptureWindow).addOnboardingSample = frame => controller.enqueue(encoder.encode(frame));
        },
      }));
      return new Response(stream, { headers: response.headers });
    };
  }, modelName);
  return (data: LiveDelta) => page.evaluate(frame => {
    const addSample = (window as CaptureWindow).addOnboardingSample;
    if (!addSample) throw new Error("The created model’s live signal stream has not opened.");
    addSample(frame);
  }, `event: delta\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function captureTour(page: Page, capture: Capture): Promise<void> {
  const builder = page.frameLocator('iframe[title="Health model builder"]');
  const name = await builder.locator("section.builder-stack p.lead").innerText();
  const send = await scriptEvaluations(page, name);
  const loaded: Promise<HealthModel> = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/health-model" && url.searchParams.get("model") === name && response.ok();
  }).then(response => response.json());
  const tour = page.getByTestId("assistant-tour");
  const readings = tour.getByRole("region", { name: "Signal readings" });
  const stop = tour.getByTestId("tour-stop-title");
  const description = tour.locator(".assistant-tour__scroll > p");
  const button = page.getByRole("button", { name: "Show CpuPercentage on orders-api in the timeline", exact: true });
  const row = readings.getByRole("listitem").filter({ has: button });
  await capture.clip("start-tour", async () => {
    await builder.getByRole("button", { name: "Tour this model" }).click();
    const model = await loaded;
    expect(model.model.name).toBe(name);
    await expect(page.getByTestId("model-picker-selected")).toContainText(name);
    await expect(stop).toHaveText("Meet your new model");
    await expect(tour.getByRole("group", { name: "Where next?" }).getByRole("button")).toHaveCount(3);
    await expect(page.getByTestId("live-status")).toHaveText("Live");
    // Both the graph layout and the diagram in its MCP Apps frame load after the tour text.
    const graph = page.locator("[data-graph-area]");
    for (const label of ["Complete an order", "Order processing", "orders-api"]) {
      await expect(graph.locator(".react-flow__node").filter({ hasText: label })).toBeInViewport({ ratio: 0.95 });
    }
    await expect.poll(() => graph.locator("path.react-flow__edge-path").evaluateAll(paths =>
      paths.filter(path => (path as SVGPathElement).getTotalLength() > 0 && getComputedStyle(path).stroke !== "none").length
    )).toBe(model.relationships.length);
    const diagram = tour.frameLocator('iframe[title="Interactive health model diagram"]').getByTestId("health-model-diagram");
    await expect(diagram.getByRole("button", { name: /^Complete an order/ })).toBeVisible();
    await capture.step("overview", description);
    await tour.getByRole("button", { name: "Trace a dependency" }).click();
    await expect(stop).toHaveText("Follow that thread");
    await expect(graph.locator(".react-flow__edge-path[data-show-me-highlight]")).toBeInViewport();
    await capture.step("dependency", description);
    await tour.getByRole("button", { name: "Back", exact: true }).click();
    await expect(stop).toHaveText("Meet your new model");
    await tour.getByRole("button", { name: "Check signal readings" }).click();
    await expect(stop).toHaveText("First signal readings");
    await expect(row).toHaveAttribute("data-signal-status", "waiting");
    await capture.step("waiting", tour.getByTestId("tour-readiness-summary"), { shot: tour });
  });

  const entity = (await loaded).entities.find(item => item.displayName === "orders-api");
  const metric = entity?.signals.find(item => item.displayName === "CpuPercentage");
  if (!entity || !metric) throw new Error("The created Orders API model is missing its CpuPercentage signal.");
  const signalUpdate = (update: Partial<typeof metric>) => ({
    ...entity, signals: entity.signals.map(signal => signal.name === metric.name ? { ...signal, ...update } : signal),
  });
  await capture.clip("inspect-signal", async () => {
    const failure = "Metrics query failed: The model identity does not have authorization to perform action 'Microsoft.Insights/metrics/read' over scope 'orders-api'.";
    await send({ entities: { upsert: [signalUpdate({ evaluationError: failure })] } });
    await expect(row).toHaveAttribute("data-signal-status", "error");
    const explanation = row.locator(".tour-reading-error");
    await expect(explanation).toContainText("Monitoring Reader");
    await row.getByText("Azure error details", { exact: true }).click();
    await expect(row.getByText(failure, { exact: true })).toBeVisible();
    await capture.step("error", explanation, { shot: readings });

    await button.click();
    const lane = page.locator(`[data-testid="tl-label-signal"][data-row="${entity.name}"][data-signal="${metric.name}"][data-focused="true"]`);
    await expect(lane).toHaveAttribute("data-show-me-highlight", /.+/);
    await lane.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await expect(lane).toBeInViewport({ ratio: 0.97 });
    await capture.step("timeline", lane);

    const now = Date.now();
    const reportedAt = new Date(now).toISOString();
    await send({
      observedAt: reportedAt, entities: { upsert: [signalUpdate({ value: 0, healthState: "Healthy", reportedAt })] },
      timeline: { points: [{ entity: entity.name, signal: metric.name, points: [[now, 0, 1]] }] },
    });
    await expect(row).toHaveAttribute("data-signal-status", "reported");
    const reading = row.getByText("Reported · Healthy · 0", { exact: true });
    await expect(reading).toBeVisible();
    await capture.step("recovery", reading, { shot: readings });
  });
  await tour.getByRole("button", { name: "End tour" }).click();
  await expect(tour).toHaveCount(0);
  await expect(page.getByTestId("model-picker-selected")).toContainText(name);
  await expect(page).not.toHaveURL(/tour=created/);
}

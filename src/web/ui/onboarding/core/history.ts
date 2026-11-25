import { expect, type Page } from "@playwright/test";
import type { Capture } from "../capture";
import { coreHistory, coreModel, coreObservedAt } from "./replay";

const web = coreModel.entities.find(entity => entity.name === "container-app")!;
const latency = coreHistory.series.find(series => series.entity === web.name && series.signal === "response-time")!;
const failure = latency.points.findLast(point => point[2] === 3 && point[1] !== null);
const recovered = failure && latency.points.find(point => point[0] > failure[0] && point[2] === 1 && point[1] !== null);
if (!failure || !recovered) throw new Error("The CORE recording must include a failing HTTP response time and its recovery.");
export const incidentSample = { failure, recovered };

export async function history(page: Page, capture: Capture) {
  await page.getByTestId("timeline-toggle").click();
  const panel = page.getByTestId("timeline-panel");
  await expect(panel.getByTestId("tl-incidents")).toBeVisible();
  await panel.getByTestId("tl-fullscreen").click();
  await panel.getByTestId("tl-preset-24h").click();
  await expect(panel.getByTestId("tl-busy")).toHaveCount(0);
  await capture.step("history-day", panel.getByTestId("tl-range"));

  // The app groups root transitions into incidents. Select the incident containing the real sample.
  const rootEvents = coreHistory.states.find(row => row.entity === coreModel.model.name)!.transitions;
  const began = rootEvents.findLast(change => change.to === 3 && change.t <= incidentSample.failure[0])!;
  const time = new Date(began.t).toISOString().slice(11, 16);
  await capture.clip("rewind-core", async () => {
    await panel.getByTestId("tl-incidents").click();
    const choice = page.getByTestId("tl-incident").filter({ hasText: time });
    await capture.step("incident-list", choice);
    await choice.click();
    await expect(page.getByTestId("moment-bar")).toBeVisible();
    await expect(panel.getByTestId("tl-show-on-graph")).toBeEnabled();
    await panel.getByTestId("tl-order").click();
    await expect(panel.getByTestId("tl-order")).toHaveAttribute("aria-pressed", "true");
    await capture.step("incident-clock", page.getByTestId("moment-shown"));
    await panel.getByTestId("tl-fullscreen").click();
    await panel.getByTestId("tl-show-on-graph").click();
    await capture.step("incident-graph", panel.getByTestId("tl-model-at"));
  }, "apng");

  // An entity search opens the timeline and expands the exact signal lanes for that resource.
  await page.getByTestId("search-open").click();
  await page.getByTestId("search-input").fill(web.displayName);
  await page.getByRole("option").filter({ hasText: web.displayName }).first().click();
  await expect(panel.getByTestId("entity-name")).toHaveText(web.displayName);
  await panel.getByTestId("tl-fullscreen").click();
  const lane = panel.locator('[data-testid="tl-label-signal"][data-row="container-app"][data-signal="response-time"]').first();
  await lane.scrollIntoViewIfNeeded();
  await lane.click();

  await capture.clip("read-the-spike", async () => {
    const canvas = panel.getByTestId("tl-canvas");
    // Click the middle of the incident where the failed Azure evaluation is the latest reading.
    // zoomToIncident pads both ends of the window equally.
    const rect = await canvas.boundingBox();
    const row = await lane.boundingBox();
    if (!rect || !row) throw new Error("The HTTP response time lane is outside the plot.");
    const x = rect.x + rect.width / 2, y = row.y + row.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await expect(lane).toContainText("Unhealthy");
    await expect(panel.getByTestId("report-open")).toHaveAttribute("aria-disabled", "true");
    await capture.step("response-lane", lane);
    await panel.getByTestId("entity-changes").click();
    const changes = panel.getByTestId("entity-changes-list");
    await expect(changes.getByTestId("transition-row").first()).toBeVisible();
    await capture.step("state-changes", changes.getByTestId("transition-row").first(), { shot: changes });
    await page.keyboard.press("Escape");
    await panel.getByTestId("tl-unpin").click();
    await expect(panel.getByTestId("tl-asof")).toHaveText("Now");
    await panel.getByTestId("tl-preset-6h").click();
    await expect(lane).toContainText("Healthy");
    await capture.step("return-to-now", lane);
  });

  // Rehearse the report/receipt UI. The browser supplies the acknowledgement for this one POST.
  // Reading the captured history again always returns the observations from Azure.
  await page.route(url => url.pathname === "/api/entities/container-app/health-reports" &&
    url.hostname === "127.0.0.1", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ healthState: "Degraded", expiresInMinutes: 15, reasonPreset: "maintenance" });
    await route.fulfill({ json: { status: "accepted", reportId: "local-rehearsal", entityName: web.name,
      signalName: body.signalName, requestedState: body.healthState, submittedAt: coreObservedAt,
      expiresAt: new Date(Date.parse(coreObservedAt) + body.expiresInMinutes * 60_000).toISOString() } });
  });
  await panel.getByTestId("report-open").click();
  const dialog = page.getByTestId("report-dialog");
  await dialog.getByLabel("State to report").selectOption("Degraded");
  await dialog.getByLabel("Report expires after (minutes)").selectOption("15");
  await dialog.getByLabel("Reason", { exact: true }).selectOption("maintenance");
  await capture.step("report-form", dialog.getByRole("heading").first(), { shot: dialog });
  await dialog.getByTestId("report-submit").click();
  const receipt = dialog.getByTestId("report-confirmation");
  await expect(receipt).toContainText("local-rehearsal");
  await capture.step("report-receipt", receipt, { shot: receipt });
}

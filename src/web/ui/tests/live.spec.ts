import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DAY } from "../src/model/timelineScale";
import { SUBSCRIPTION_A, healthModel, installStubs } from "./fixture";
import { delta, installStream, snapshot, withState } from "./liveStub";
import { installTimeline, stubbedHistory } from "./timelineStub";

const SERVED_CSP =
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='; " +
  "img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com https://management.azure.com; base-uri 'none'; " +
  "frame-ancestors 'none'";

const SHOTS = process.env.TIMELINE_SHOTS ?? "";
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const MODEL = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;

const node = (page: Page, name: string) => page.locator(`.react-flow__node[data-id="${name}"]`);
const status = (page: Page) => page.getByTestId("live-status");

async function open(page: Page, stream: Parameters<typeof installStream>[1] = {}, search = "") {
  await installStubs(page, { healthModelFails: false });
  const requests = { health: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/health-model") requests.health += 1;
  });
  await installTimeline(page, stubbedHistory(NOW));
  const live = await installStream(page, stream);
  await page.goto(`/?${MODEL}&view=zoom${search}`);
  await page.waitForSelector(".react-flow__node .entity-node");
  return { live, requests };
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("an open model is live, and a state change in a delta updates its node without reading the model again", async ({ page }) => {
  const { live, requests } = await open(page);
  await expect(status(page)).toHaveText("Live");
  expect(live.requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.health).toBe(1);
  await expect(node(page, "svc-d")).not.toContainText("Unhealthy");

  live.push(delta({ observedAt: "2026-11-11T10:00:30Z", entities: { upsert: [withState("svc-d", "Unhealthy")] } }, 1));

  await expect(node(page, "svc-d")).toContainText("Unhealthy");
  await expect(page.getByTestId("live-announcement")).toHaveText("Service D is now Unhealthy");
  await expect(node(page, "svc-d")).toHaveClass(/live-changed/);
  await expect(node(page, "svc-d")).not.toHaveClass(/live-changed/, { timeout: 5000 });
  expect(requests.health, "the model is not read again").toBe(1);
  await shot(page, "live-state-change");
});

test("a connection that ends is taken up again with the last id and nothing is read twice", async ({ page }) => {
  const { live } = await open(page);
  await expect(status(page)).toHaveText("Live");

  live.push(delta({ entities: { upsert: [withState("svc-d", "Degraded")] } }, 1));
  await expect(node(page, "svc-d")).toContainText("Degraded");
  await expect.poll(() => live.requests.length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);

  // The snapshot ended its connection, the next one asked after the snapshot, the one after that after the delta.
  expect(live.requests.map((request) => request.lastEventId).slice(0, 3)).toEqual([null, "aaaaaaaa-0", "aaaaaaaa-1"]);
});

test("a reconnect event, for an expired token, resumes at once with the last id", async ({ page }) => {
  const { live } = await open(page);
  await expect(status(page)).toHaveText("Live");

  const before = live.requests.length;
  live.push('event: reconnect\ndata: {"reason":"token_expired"}\n\n');

  await expect.poll(() => live.requests.length, { timeout: 5000 }).toBeGreaterThan(before);
  expect(live.requests.at(-1)?.lastEventId).toBe("aaaaaaaa-0");
});

test("a resync event starts again from a snapshot", async ({ page }) => {
  const { live } = await open(page);
  await expect(status(page)).toHaveText("Live");

  const before = live.requests.length;
  live.push('event: resync\ndata: {"reason":"slow"}\n\n');
  await expect.poll(() => live.requests.slice(before).some((request) => request.lastEventId === null), { timeout: 5000 }).toBe(true);

  live.push(snapshot({ ...healthModel, entities: healthModel.entities.map((item) => (item.name === "svc-b" ? withState("svc-b", "Unhealthy") : item)) }, 7));

  await expect(node(page, "svc-b")).toContainText("Unhealthy");
});

test("pausing holds the graph still, and resuming takes a snapshot and goes on", async ({ page }) => {
  const { live } = await open(page);
  await expect(status(page)).toHaveText("Live");

  await page.getByTestId("live-toggle").click();
  await expect(status(page)).toHaveText("Paused");
  live.push(delta({ entities: { upsert: [withState("svc-d", "Unhealthy")] } }, 1));
  await page.waitForTimeout(700);
  await expect(node(page, "svc-d")).not.toContainText("Unhealthy");
  const during = live.requests.length;

  await page.getByTestId("live-toggle").click();

  await expect.poll(() => live.requests.length).toBeGreaterThan(during);
  await expect(status(page)).toHaveText("Live");
  await expect(node(page, "svc-d")).toContainText("Unhealthy");
});

test("the refresh button still reads the model by hand", async ({ page }) => {
  const { requests } = await open(page);
  await expect(status(page)).toHaveText("Live");

  await page.getByTestId("refresh-now").click();

  await expect.poll(() => requests.health).toBe(2);
});

test("a busy app that refuses the stream is read every minute instead, and says so", async ({ page }) => {
  await page.clock.install();
  const { requests } = await open(page, { refuse: { status: 503, body: { error: { code: "live_unavailable", message: "Busy.", retryable: true, operationId: "x" } } } });
  await expect(status(page)).toHaveText("Refreshing every minute");
  const before = requests.health;

  await page.clock.fastForward("01:05");

  await expect.poll(() => requests.health).toBeGreaterThan(before);
});

test("an app that does not offer the stream leaves the model as it is and asks nothing more", async ({ page }) => {
  await page.clock.install();
  const { requests } = await open(page, { refuse: { status: 404, body: { error: { code: "not_found", message: "Unknown route.", retryable: false, operationId: "x" } } } });
  await expect(status(page)).toHaveText("Not live");
  const before = requests.health;

  await page.clock.fastForward("05:00");

  expect(requests.health).toBe(before);
});

test("the timeline follows the stream: a new incident appears and the window keeps now at its right edge", async ({ page }) => {
  const { live } = await open(page);
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await expect(page.getByTestId("tl-live-toggle")).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("live")).toBe("1");
  const listed = async (): Promise<number> => Number(((await page.getByTestId("tl-incidents").textContent({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\D/g, "") || 0);
  const incidents = await listed();
  const t = Date.now();

  live.push(delta({ observedAt: new Date(t).toISOString(), entities: { upsert: [withState("svc-a", "Unhealthy")] }, timeline: { transitions: [{ entity: "svc-a", t, from: 1, to: 3, reason: "SignalTransition" }] } }, 1));

  await expect.poll(listed, { timeout: 5000 }).toBeGreaterThanOrEqual(Math.max(1, incidents));
  await page.getByTestId("tl-incidents").click();
  await expect(page.getByTestId("tl-incident").first()).toContainText("Ongoing");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tl-label-entity").first().getByTestId("tl-state-word")).toHaveText("Unhealthy");
  await shot(page, "live-timeline");

  const box = await page.getByTestId("tl-canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + 300, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("tl-live-toggle")).toHaveAttribute("aria-pressed", "false");
  expect(new URL(page.url()).searchParams.get("live")).toBeNull();

  await page.getByTestId("tl-live-toggle").click();
  await expect(page.getByTestId("tl-live-toggle")).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("live")).toBe("1");
});

test("a reload paints the timeline from the browser's cache before the network answers", async ({ page }) => {
  await installStubs(page, { healthModelFails: false });
  const fixture = stubbedHistory(NOW);
  let slow = false;
  await page.route("**/api/timeline?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (slow) await new Promise((resolve) => setTimeout(resolve, 3000));
    const from = Date.parse(query.get("from") ?? "");
    const to = Date.parse(query.get("to") ?? "");
    const body = (query.get("include") ?? "").includes("signals") ? fixture.signals(query.getAll("entity"), from, to) : fixture.overview(from, to);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await installStream(page);
  await page.goto(`/?${MODEL}&view=zoom&timeline=1`);
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await page.waitForTimeout(2200);

  slow = true;
  await page.reload();

  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible({ timeout: 2500 });
  await expect(page.getByTestId("tl-stale")).toBeVisible();
  await expect(page.getByTestId("tl-stale")).toBeHidden({ timeout: 8000 });
});

test("a live model runs clean under the policy the server sends", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = SERVED_CSP;
    await route.fulfill({ response, headers });
  });
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const { live } = await open(page);
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();

  live.push(delta({ entities: { upsert: [withState("svc-d", "Unhealthy")] } }, 1));
  await expect(node(page, "svc-d")).toHaveClass(/live-changed/);
  await page.getByTestId("live-toggle").click();
  await page.getByTestId("live-toggle").click();

  expect(violations).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
  void DAY;
});

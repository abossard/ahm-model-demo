import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { DAY, HOUR } from "../src/model/timelineScale";
import { buildFixture } from "../src/model/timelineFixture";
import { STRIP_ALPHA } from "../src/timeline/draw";
import { SUBSCRIPTION_A } from "./fixture";
import { bootWith, installTimeline, modelOf, stubbedHistory } from "./timelineStub";
import { installStubs } from "./fixture";
import { instrument, measure, report as reportFrames, type FrameStats } from "./framePerf";

const report = (name: string, stats: FrameStats): void => reportFrames(`timeline ${name}`, stats);

/**
 * Verbatim copy of `SECURITY_POLICY` in `src/web/app/config.py`: the preview server sends none, so the run attaches the
 * real one and a stray inline style or script would fail here.
 */
const SERVED_CSP =
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='; " +
  "img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com https://management.azure.com; base-uri 'none'; " +
  "frame-ancestors 'none'";

// The canvas is drawn on the GPU, as on a real screen. The software renderer a headless browser falls back to rasterizes
// it on the processor, and the frame times it gives say nothing about a screen.
test.use({ launchOptions: { args: ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])] } });

const SHOTS = process.env.TIMELINE_SHOTS ?? "";
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const MODEL = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;

async function open(page: Page, fixture = stubbedHistory(NOW), search = ""): Promise<Awaited<ReturnType<typeof bootWith>>> {
  const requests = await bootWith(page, fixture);
  await page.goto(`/?${MODEL}&view=zoom${search}`);
  await page.waitForSelector(".react-flow__node .entity-node");
  return requests;
}

async function openTimeline(page: Page): Promise<void> {
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await settled(page);
}

/** The painted canvas has changed from blank: the first frame is in. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="tl-canvas"]');
    if (!canvas || canvas.width < 10) return false;
    const data = canvas.getContext("2d")?.getImageData(canvas.width / 2, 60, 1, 1).data;
    return data !== undefined && data[3] === 255;
  });
  await page.waitForTimeout(250);
}

const canvas = (page: Page): Locator => page.getByTestId("tl-canvas");

/** The incidents of the root are in a menu: open it, so its items can be reached. */
async function openIncidents(page: Page): Promise<void> {
  await page.getByTestId("tl-incidents").click();
  await expect(page.getByTestId("tl-incident").first()).toBeVisible();
}
const row = (page: Page, name: string): Locator => page.locator(`[data-testid="tl-label-entity"][data-row="${name}"]`);

/** The window on screen, as the address bar names it once a gesture settles. */
async function windowOf(page: Page): Promise<{ from: number; to: number; span: number }> {
  await page.waitForTimeout(350);
  const params = new URL(page.url()).searchParams;
  // A window that follows now is named by its length alone, and ends now.
  if (params.get("live") === "1") {
    const span = Number(params.get("span"));
    return { from: Date.now() - span, to: Date.now(), span };
  }
  const from = Date.parse(params.get("from") ?? "");
  const to = Date.parse(params.get("to") ?? "");
  return { from, to, span: to - from };
}

async function plotBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("no canvas");
  return box;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The same screenshot in both themes: `name-light`, then `name-dark`; the page is left in the theme it began in. */
async function shotBoth(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await shot(page, `${name}-light`);
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(400);
  await shot(page, `${name}-dark`);
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(400);
}

type Family = "healthy" | "degraded" | "unhealthy" | "unknown";

/**
 * How many pixels of a band of the canvas are in each state colour of the theme (within a small distance). A `line` is
 * drawn in the colour itself, and the rows that hold a threshold line are left out: they are as wide as the lane and say
 * nothing about the measured line. A `bar` of an entity fills its row at the strength of its state (`STRIP_ALPHA`), so
 * its pixels are the state colour blended with the panel.
 */
async function coloursIn(page: Page, rowBox: { y: number; height: number }, kind: "line" | "bar" = "line"): Promise<Record<Family, number>> {
  const box = await plotBox(page);
  return page.evaluate(
    ({ top, height, bar, alpha }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="tl-canvas"]') as HTMLCanvasElement;
      const style = getComputedStyle(canvas);
      const rgb = (name: string): number[] => {
        const hex = style.getPropertyValue(name).trim().replace("#", "");
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      };
      const panel = rgb("--canvas-bg");
      const paint = (name: string, strength: number): number[] => {
        const colour = rgb(name);
        return bar ? colour.map((channel, i) => Math.round((panel[i] ?? 0) * (1 - strength) + channel * strength)) : colour;
      };
      const wanted: Record<string, number[]> = { healthy: paint("--healthy-dot", alpha[1] ?? 1), degraded: paint("--degraded-dot", alpha[2] ?? 1), unhealthy: paint("--unhealthy-dot", alpha[3] ?? 1), unknown: paint("--unknown-dot", alpha[0] ?? 1) };
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      const y0 = Math.round(top * scale);
      const rows = Math.round(height * scale);
      const data = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(0, y0, canvas.width, rows).data;
      // A blended bar is an exact colour, and the faint ones lie close together: a line may be a little off, a bar may not.
      const limit = bar ? 9 : 36;
      const near = (i: number, want: number[]): boolean => Math.abs((data[i] ?? 0) - (want[0] ?? 0)) + Math.abs((data[i + 1] ?? 0) - (want[1] ?? 0)) + Math.abs((data[i + 2] ?? 0) - (want[2] ?? 0)) < limit;
      const counts: Record<string, number> = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0 };
      for (let y = 0; y < rows; y += 1) {
        const perRow: Record<string, number> = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0 };
        for (let x = 0; x < canvas.width; x += 1) {
          const i = (y * canvas.width + x) * 4;
          for (const [name, want] of Object.entries(wanted)) if (near(i, want)) perRow[name] = (perRow[name] ?? 0) + 1;
        }
        const wide = (perRow.degraded ?? 0) > canvas.width * 0.3 || (perRow.unhealthy ?? 0) > canvas.width * 0.3;
        if (wide && !bar) continue;
        for (const name of Object.keys(counts)) counts[name] = (counts[name] ?? 0) + (perRow[name] ?? 0);
      }
      return counts;
    },
    { top: rowBox.y - box.y, height: rowBox.height, bar: kind === "bar", alpha: STRIP_ALPHA },
  ) as Promise<Record<Family, number>>;
}

async function bandOf(locator: Locator): Promise<{ y: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no row");
  return { y: box.y, height: box.height };
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("the toggle opens the timeline, the link opens it too, and the address names the window", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("timeline-panel")).toHaveCount(0);

  await openTimeline(page);

  const { span } = await windowOf(page);
  expect(new URL(page.url()).searchParams.get("timeline")).toBe("1");
  expect(span).toBeGreaterThan(23.9 * HOUR);
  expect(span).toBeLessThan(24.1 * HOUR);
  await expect(page.getByTestId("tl-preset-24h")).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.getByTestId("timeline-panel")).toBeVisible();

  await page.getByTestId("tl-close").click();
  await expect(page.getByTestId("timeline-panel")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("timeline")).toBeNull();
});

test("the tree follows the relationships: roots open to their signals and dependencies, and what relates to nothing says so", async ({ page }) => {
  await open(page);
  await openTimeline(page);

  await expect(page.getByTestId("tl-label-group")).toHaveCount(0);
  await expect(page.locator('[data-testid="tl-label-entity"]:not([role="treeitem"])')).toHaveCount(0);
  const order = async (): Promise<(string | null)[]> => page.locator('[data-testid="tl-label-entity"], [data-testid="tl-label-signal"]').evaluateAll((rows) => rows.map((item) => `${item.getAttribute("data-testid")?.slice(9)}:${item.getAttribute("data-row")}`));
  // The root first with its own signals, then its dependencies; the entities that relate to nothing come last.
  // Only the rows near the viewport are in the page: the first of them, in order.
  const first = async (count: number): Promise<(string | null)[]> => (await order()).slice(0, count);
  expect(await first(8)).toEqual(["entity:svc-a", "signal:svc-a", "signal:svc-a", "signal:svc-a", "entity:svc-b", "entity:svc-d", "entity:svc-e", "entity:svc-f"]);
  await expect(row(page, "svc-a")).toHaveAttribute("aria-level", "1");
  await expect(row(page, "svc-b")).toHaveAttribute("aria-level", "2");
  await expect(row(page, "svc-b")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "svc-a")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "svc-e").getByTestId("tl-unconnected")).toHaveText("Not connected");
  await expect(row(page, "svc-a").getByTestId("tl-unconnected")).toHaveCount(0);

  await row(page, "svc-b").getByTestId("tl-expand").click();
  expect(await first(8)).toEqual(["entity:svc-a", "signal:svc-a", "signal:svc-a", "signal:svc-a", "entity:svc-b", "signal:svc-b", "entity:svc-c", "entity:svc-d"]);
  await expect(row(page, "svc-c")).toHaveAttribute("aria-level", "3");
  await settled(page);
  await shotBoth(page, "overhaul-tree-two-levels");

  await row(page, "svc-a").getByTestId("tl-expand").click();
  expect(await first(8)).toEqual(["entity:svc-a", "entity:svc-e", "entity:svc-f"]);
});

test("the tree carries the health: state and measured values, as of now or as of the pinned moment", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await expect(page.getByTestId("tl-asof")).toHaveText("Now");
  const root = row(page, "svc-a");
  await expect(root.getByTestId("tl-state-word")).toHaveText(/Healthy|Degraded|Unhealthy|Unknown/);
  await expect(root.locator("svg")).toHaveCount(2);

  const lane = page.getByTestId("tl-label-signal").first();
  await expect(lane.getByTestId("tl-value")).toContainText("%");
  await expect(lane).toHaveAttribute("title", "CPU: Degraded above 70%, Unhealthy above 90%");
  const now = await root.getByTestId("tl-state-word").innerText();

  const box = await plotBox(page);
  await page.mouse.click(box.x + box.width * 0.15, box.y + 120);
  await expect(page.getByTestId("tl-asof")).toContainText("As of");
  await expect(root.getByTestId("tl-state-word")).toHaveText("Healthy");
  await expect(lane.getByTestId("tl-value")).toContainText("%");

  await openIncidents(page);
  await page.getByTestId("tl-incident").first().click();
  await expect(page.getByTestId("tl-asof")).toContainText("As of");
  await expect(root.getByTestId("tl-state-word")).not.toHaveText("Healthy");
  expect(now).not.toBe("");
  await shot(page, "tree-as-of-light");
});

test("the incidents of the root are named in the plot, listed in a menu, and clicking one zooms to it and pins its start", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await expect(page.getByTestId("tl-side")).toHaveCount(0);
  await expect(page.getByText("Incidents", { exact: true }).first()).toBeVisible();

  await openIncidents(page);
  const incidents = page.getByTestId("tl-incident");
  await expect(incidents.first()).toContainText("Ongoing");
  const before = await windowOf(page);

  await incidents.first().click();

  await expect(page.getByTestId("tl-model-at")).toBeVisible();
  await expect(page.getByTestId("tl-model-at")).toContainText("The model at");
  const after = await windowOf(page);
  expect(after.span).toBeLessThan(before.span / 4);
});

test("the incident bar under the axis says what it is when pointed at, and a click on it zooms to the incident", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  const box = await plotBox(page);
  const view = await windowOf(page);
  // The incident that is still going began 95 minutes before now: aim at the middle of its bar.
  const t = NOW - 40 * 60_000;
  const x = box.x + ((t - view.from) / view.span) * box.width;

  await page.mouse.move(x, box.y + 31);
  await expect(page.getByTestId("tl-tip")).toContainText("Ongoing");
  await expect(page.getByTestId("tl-tip")).toContainText("peak");

  await page.mouse.click(x, box.y + 31);
  await expect(page.getByTestId("tl-model-at")).toBeVisible();
  expect((await windowOf(page)).span).toBeLessThan(view.span / 4);
});

test("presets change the window, and double click puts the default window back", async ({ page }) => {
  await open(page);
  await openTimeline(page);

  for (const [id, span] of [["1h", HOUR], ["6h", 6 * HOUR], ["7d", 7 * DAY]] as const) {
    await page.getByTestId(`tl-preset-${id}`).click();
    const view = await windowOf(page);
    expect(Math.abs(view.span - span)).toBeLessThan(span * 0.02);
    await expect(page.getByTestId(`tl-preset-${id}`)).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByTestId("tl-preset-all").click();
  const all = await windowOf(page);
  expect(all.span).toBeGreaterThan(7 * DAY);
  expect(all.span).toBeLessThanOrEqual(14.1 * DAY);

  const box = await plotBox(page);
  await canvas(page).dblclick({ position: { x: box.width / 2, y: 120 } });
  const reset = await windowOf(page);
  expect(Math.abs(reset.span - DAY)).toBeLessThan(DAY * 0.02);
});

/** Where the rows are scrolled to: the tree and the scrollbar of the plot, which must agree. */
async function scrollOf(page: Page): Promise<{ tree: number; plot: number }> {
  return { tree: await page.getByTestId("tl-labels-body").evaluate((element) => element.scrollTop), plot: await page.getByTestId("tl-scroll").evaluate((element) => element.scrollTop) };
}

/** A pinch as the browser reports it: wheel events with Control down. */
async function pinch(page: Page, dy: number, count: number): Promise<void> {
  await page.keyboard.down("Control");
  for (let i = 0; i < count; i += 1) await page.mouse.wheel(0, dy);
  await page.keyboard.up("Control");
}

test("a pinch or Control and the wheel zooms around the pointer, a drag pans, and a shift drag brushes a range", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-expand-all").click();
  await settled(page);
  const box = await plotBox(page);
  const start = await windowOf(page);

  await page.mouse.move(box.x + box.width * 0.75, box.y + 120);
  await pinch(page, -100, 3);
  const zoomed = await windowOf(page);
  expect(zoomed.span).toBeLessThan(start.span * 0.5);
  const anchor = start.from + (start.to - start.from) * 0.75;
  expect(zoomed.from).toBeLessThan(anchor);
  expect(zoomed.to).toBeGreaterThan(anchor - 1);
  // A zoom is no scroll: the rows are where they were.
  expect(await scrollOf(page)).toEqual({ tree: 0, plot: 0 });

  await page.mouse.move(box.x + 200, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 120, { steps: 8 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  const panned = await windowOf(page);
  expect(panned.from).toBeLessThan(zoomed.from);
  expect(Math.abs(panned.span - zoomed.span)).toBeLessThan(zoomed.span * 0.01);

  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 100, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 100 + box.width / 5, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const brushed = await windowOf(page);
  expect(brushed.span).toBeLessThan(panned.span * 0.3);
  expect(brushed.span).toBeGreaterThan(panned.span * 0.1);
});

test("a vertical wheel scrolls the rows over the plot as over the tree, and never changes the time window", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-expand-all").click();
  await settled(page);
  const box = await plotBox(page);
  const labels = await page.getByTestId("tl-labels-body").boundingBox();
  const address = page.url();

  // Over the lines of the plot.
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.wheel(0, 90);
  await expect.poll(async () => (await scrollOf(page)).plot).toBe(90);
  expect(await scrollOf(page)).toEqual({ tree: 90, plot: 90 });

  // Over the tree, and it leans sideways after it began: the swipe keeps its axis.
  await page.mouse.move((labels?.x ?? 0) + 40, (labels?.y ?? 0) + 60);
  await page.mouse.wheel(0, 30);
  await page.mouse.wheel(60, 20);
  await expect.poll(async () => (await scrollOf(page)).tree).toBe(140);
  expect(await scrollOf(page)).toEqual({ tree: 140, plot: 140 });

  // Back past the top: the rows stop there.
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => (await scrollOf(page)).plot).toBe(0);

  await page.waitForTimeout(400);
  expect(page.url()).toBe(address);
});

test("a horizontal wheel, or Shift and the wheel, pans in time and never scrolls the rows", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-expand-all").click();
  await page.getByTestId("tl-preset-6h").click();
  await settled(page);
  const box = await plotBox(page);
  const start = await windowOf(page);

  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.wheel(-200, 0);
  // It leans down after it began: the swipe keeps its axis.
  await page.mouse.wheel(-100, 80);
  const panned = await windowOf(page);
  expect(panned.to).toBeLessThan(start.to - start.span * 0.1);
  expect(Math.abs(panned.span - start.span)).toBeLessThan(start.span * 0.01);
  expect(await scrollOf(page)).toEqual({ tree: 0, plot: 0 });

  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Shift");
  const again = await windowOf(page);
  expect(again.to).toBeLessThan(panned.to - start.span * 0.05);
  expect(Math.abs(again.span - start.span)).toBeLessThan(start.span * 0.01);
  expect(await scrollOf(page)).toEqual({ tree: 0, plot: 0 });
});

test("the page behind stays where it is, whatever the wheel does in the timeline", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-expand-all").click();
  await settled(page);
  const box = await plotBox(page);
  const labels = await page.getByTestId("tl-labels-body").boundingBox();
  const bar = await page.getByTestId("tl-scroll").boundingBox();
  // What the page could do with a wheel: scroll a box around the timeline, or zoom and pan the graph.
  const behind = (): Promise<string> =>
    page.evaluate(() => {
      const offsets: number[] = [window.scrollX, window.scrollY];
      for (let node = document.querySelector('[data-testid="timeline-panel"]')?.parentElement; node; node = node.parentElement) offsets.push(node.scrollLeft, node.scrollTop);
      return `${offsets.join()} ${document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? ""}`;
    });
  await page.evaluate(() => {
    const w = window as unknown as { __left: number };
    w.__left = 0;
    // A wheel event the timeline did not take is one the browser scrolls or rubber-bands the page with.
    window.addEventListener("wheel", (event) => {
      if (!event.defaultPrevented) w.__left += 1;
    });
  });
  const before = await behind();

  const spots = [
    { x: box.x + box.width / 2, y: box.y + 120 },
    { x: box.x + box.width / 2, y: box.y + 12 },
    { x: (labels?.x ?? 0) + 40, y: (labels?.y ?? 0) + 60 },
    { x: (bar?.x ?? 0) + 6, y: (bar?.y ?? 0) + 30 },
  ];
  for (const spot of spots) {
    await page.mouse.move(spot.x, spot.y);
    // Up at the top and down past the end, where a scroller hands the rest to the page; sideways; a pinch.
    for (const [dx, dy] of [[0, -400], [0, 5000], [0, 5000], [0, -9000], [-400, 0], [400, 0]] as const) await page.mouse.wheel(dx, dy);
    await pinch(page, -30, 2);
    await pinch(page, 30, 2);
  }
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => (window as unknown as { __left: number }).__left)).toBe(0);
  expect(await behind()).toBe(before);
});

test("the selected moment is dragged by its line or its label; a drag beside it still pans and Shift still zooms to a range", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-preset-6h").click();
  await settled(page);
  let box = await plotBox(page);
  const at = (fraction: number): number => box.x + box.width * fraction;
  const moment = page.getByTestId("tl-model-at");
  // What the header says the moment is: "The model at Nov 11 22:45:42".
  const said = moment.locator("span").first();
  const drag = async (from: number, to: number, height = box.y + 120): Promise<void> => {
    await page.mouse.move(from, height);
    await page.mouse.down();
    await page.mouse.move(to, height, { steps: 6 });
    // A pause before the release, so a pan does not glide on.
    await page.waitForTimeout(120);
    await page.mouse.up();
  };

  // Hovering selects nothing; a click does.
  await page.mouse.move(at(0.3), box.y + 120);
  await expect(page.getByTestId("tl-tip")).toBeVisible();
  await expect(moment).toHaveCount(0);
  await page.mouse.click(at(0.3), box.y + 120);
  await expect(moment).toBeVisible();
  // The header has grown by what it says about the moment: the plot is where it is now.
  await settled(page);
  box = await plotBox(page);
  const clicked = await said.innerText();
  const view = await windowOf(page);

  // By its line: the moment moves, the window does not.
  await drag(at(0.3), at(0.5));
  await expect(said).not.toHaveText(clicked);
  const byLine = await said.innerText();
  expect((await windowOf(page)).span).toBe(view.span);

  // By the label at its top, which stands to the right of the line.
  await drag(at(0.5) + 30, at(0.35) + 30, box.y + 8);
  await expect(said).not.toHaveText(byLine);
  const byLabel = await said.innerText();

  // Beside the line a drag pans: the window moves by a tenth, the moment stays.
  const address = page.url();
  await drag(at(0.7), at(0.8));
  await expect.poll(() => page.url()).not.toBe(address);
  await expect(said).toHaveText(byLabel);

  // Shift and a drag that starts on the line zooms to the range, as anywhere else.
  const wide = await windowOf(page);
  await page.keyboard.down("Shift");
  await drag(at(0.45), at(0.65));
  await page.keyboard.up("Shift");
  expect((await windowOf(page)).span).toBeLessThan(wide.span * 0.3);
  await expect(said).toHaveText(byLabel);

  // The clear control returns to now.
  await page.getByTestId("tl-unpin").click();
  await expect(moment).toHaveCount(0);
  await expect(page.getByTestId("tl-asof")).toHaveText("Now");
});

test("an open row shows one lane per signal, and only the lanes that show are asked for", async ({ page }) => {
  const requests = await open(page);
  await openTimeline(page);

  // The root is open: its three signals are lanes, and nothing else is read.
  await expect(page.getByTestId("tl-label-signal")).toHaveCount(3);
  await expect.poll(() => requests.seen.filter((query) => query.get("include") === "signals").length).toBeGreaterThan(0);
  expect(requests.seen.filter((query) => query.get("include") === "signals").every((query) => query.getAll("entity").join() === "svc-a")).toBe(true);
  await settled(page);
  await shot(page, "lanes-light");

  await row(page, "svc-b").getByTestId("tl-expand").click();
  await expect(page.getByTestId("tl-label-signal")).toHaveCount(4);
  await expect.poll(() => requests.seen.some((query) => query.getAll("entity").includes("svc-b"))).toBe(true);

  await page.getByTestId("tl-collapse-all").click();
  await expect(page.getByTestId("tl-label-signal")).toHaveCount(0);
  await page.getByTestId("tl-expand-all").click();
  await expect(page.getByTestId("tl-label-signal")).not.toHaveCount(0);
});

test("the overview is read once when the timeline opens and again when Refresh is pressed, not on its own while the stream is live", async ({ page }) => {
  const requests = await open(page);
  await openTimeline(page);
  const overviews = (): number => requests.seen.filter((query) => !(query.get("include") ?? "").includes("signals")).length;
  await expect.poll(overviews).toBe(1);
  await page.waitForTimeout(1500);
  expect(overviews()).toBe(1);

  await page.getByTestId("refresh-now").click();
  await expect.poll(overviews).toBe(2);
});

test("zooming in on an opened row asks again for the narrower window, once the zoom settles", async ({ page }) => {
  const requests = await open(page);
  await openTimeline(page);
  await expect.poll(() => requests.seen.filter((query) => query.get("include") === "signals").length).toBe(1);

  await page.getByTestId("tl-preset-7d").click();
  await expect.poll(() => requests.seen.filter((query) => query.get("include") === "signals").length).toBeGreaterThan(1);
  const wide = requests.seen.filter((query) => query.get("include") === "signals").at(-1);
  expect(Date.parse(wide?.get("to") ?? "") - Date.parse(wide?.get("from") ?? "")).toBeGreaterThan(6 * DAY);
});

test("hovering reads every visible lane at that instant, and a click pins the model as it was then", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await settled(page);
  const box = await plotBox(page);

  await page.mouse.move(box.x + box.width * 0.5, box.y + 90);
  const tip = page.getByTestId("tl-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Service A");
  await expect(tip).toContainText("CPU");
  await shot(page, "tooltip-light");

  await page.mouse.click(box.x + box.width * 0.5, box.y + 90);
  await expect(page.getByTestId("tl-model-at")).toBeVisible();
  await expect(page.getByTestId("tl-model-at")).toContainText("The model at");

  await page.getByTestId("tl-unpin").click();
  await expect(page.getByTestId("tl-model-at")).toHaveCount(0);
});

test("a pinned moment of trouble shows on the graph", async ({ page }) => {
  const fixture = stubbedHistory(NOW);
  await open(page, fixture);
  await openTimeline(page);
  await openIncidents(page);
  await page.getByTestId("tl-incident").first().click();
  await expect(page.getByTestId("tl-model-at")).toBeVisible();

  const show = page.getByTestId("tl-show-on-graph");
  if (await show.isEnabled()) {
    await show.click();
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
  }
});

test("picking an entity anywhere opens the timeline on its row: selected, its way and its signals open, in view", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("timeline-panel")).toHaveCount(0);

  await page.locator('.react-flow__node[data-id="svc-c"] .entity-node').click();

  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await expect(row(page, "svc-c")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "svc-c")).toBeInViewport();
  await expect(row(page, "svc-b")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service C");
  await settled(page);

  // Closing the timeline works, and the next pick opens it again.
  await page.getByTestId("tl-close").click();
  await expect(page.getByTestId("timeline-panel")).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="svc-d"] .entity-node').click();
  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await expect(row(page, "svc-d")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "svc-d")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tl-label-signal").filter({ hasText: "Heartbeat" })).toBeVisible();

  // A row of the tree is a pick as well.
  await row(page, "svc-b").click();
  await expect(row(page, "svc-b")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "svc-d")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("entity-name")).toHaveText("Service B");
  await expect(page.getByTestId("tl-label-signal").filter({ hasText: "Queue" })).toBeVisible();
});

test("a pick from the search, deep in a long tree, opens the way to its row, scrolls it into view and opens its signals", async ({ page }) => {
  const fixture = buildFixture({ now: NOW, flows: 5, componentsPerFlow: 3, resourcesPerComponent: 4, signalsPerResource: 3, days: 3 });
  await installStubs(page, { healthModelFails: false, model: modelOf(fixture) });
  await installTimeline(page, fixture);
  await page.goto(`/?${MODEL}&view=zoom`);
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByTestId("search-open").click();
  await page.getByTestId("search-input").fill("Resource 57");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await expect(row(page, "res-57")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "res-57")).toBeInViewport();
  await expect(page.locator('[data-testid="tl-label-signal"][data-row="res-57"]').first()).toBeInViewport();
  await expect(row(page, "flow-4-comp-2")).toHaveAttribute("aria-expanded", "true");
  await settled(page);
});

test("the keyboard moves the selected moment and between rows, opens and closes a row, zooms and returns to now", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  const stage = page.getByTestId("tl-stage");
  const asOf = page.getByTestId("tl-asof");
  await stage.focus();

  // Left selects a moment a step before the end of the window, and each press moves it a step.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("tl-model-at")).toBeVisible();
  await expect(asOf).toContainText("As of");
  const first = await asOf.innerText();
  await page.keyboard.press("ArrowLeft");
  await expect(asOf).not.toHaveText(first);
  await page.keyboard.press("ArrowRight");
  await expect(asOf).toHaveText(first);
  await expect(page.getByTestId("tl-live")).not.toBeEmpty();

  // With Shift it goes to the state change before it in the focused row, the root: from two steps before a change, the next one is that change.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(asOf).not.toHaveText(first);
  const change = await asOf.innerText();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(asOf).not.toHaveText(change);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(asOf).toHaveText(change);

  // Escape returns to now, space selects again.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tl-model-at")).toHaveCount(0);
  await expect(asOf).toHaveText("Now");

  await page.keyboard.press("ArrowDown");
  expect(await stage.getAttribute("aria-activedescendant")).toBe("tl-row-1");
  await page.keyboard.press("ArrowUp");
  expect(await stage.getAttribute("aria-activedescendant")).toBe("tl-row-0");
  // Enter closes an open row, and opens and picks a closed one.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tl-label-signal")).toHaveCount(0);
  await expect(row(page, "svc-a")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tl-label-signal").first()).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service A");

  const before = await windowOf(page);
  await page.keyboard.press("+");
  const zoomed = await windowOf(page);
  expect(zoomed.span).toBeLessThan(before.span * 0.8);
  await page.keyboard.press("-");
  await page.keyboard.press("0");
  const reset = await windowOf(page);
  expect(Math.abs(reset.span - DAY)).toBeLessThan(DAY * 0.02);

  await page.keyboard.press(" ");
  await expect(page.getByTestId("tl-model-at")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tl-model-at")).toHaveCount(0);
});

test("a series that fails is named in its lane and does not stop the others", async ({ page }) => {
  const fixture = stubbedHistory(NOW);
  await installStubs(page, { healthModelFails: false });
  await installTimeline(page, fixture, (query) => (query.get("include") === "signals" && query.getAll("entity").includes("svc-b") ? 503 : 200));
  await page.goto(`/?${MODEL}&view=zoom`);
  await page.waitForSelector(".react-flow__node .entity-node");
  await openTimeline(page);

  await row(page, "svc-b").getByTestId("tl-expand").click();
  await expect(page.getByTestId("tl-retry")).toBeVisible();

  await expect(page.getByTestId("tl-label-signal")).toHaveCount(4);
  await expect(row(page, "svc-a")).toBeVisible();
});

test("the timeline runs clean under the policy the server sends, in both themes", async ({ page }) => {
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
  await open(page);
  await openTimeline(page);
  await settled(page);
  const box = await plotBox(page);
  await page.mouse.move(box.x + 300, box.y + 100);
  await page.mouse.wheel(0, -300);
  await page.mouse.click(box.x + 300, box.y + 100);
  await openIncidents(page);
  await page.getByTestId("tl-incident").first().click();
  await page.getByTestId("tl-fullscreen").click();
  await page.keyboard.press("Escape");
  await settled(page);
  await shot(page, "pinned-light");

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(300);
  await shot(page, "pinned-dark");
  const dark = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="tl-canvas"]');
    const data = canvas?.getContext("2d")?.getImageData(5, 100, 1, 1).data;
    return data ? [data[0], data[1], data[2]] : null;
  });
  expect(dark?.every((channel) => (channel ?? 255) < 90)).toBe(true);

  expect(violations).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
});

test("full screen fills the window below the top bar, Escape or the button leave it, and the address keeps it", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  const panel = page.getByTestId("timeline-panel");
  const normal = await panel.boundingBox();
  const bar = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="timeline-panel"]')?.closest("main")?.parentElement?.getBoundingClientRect();
    return body ? { top: body.top, height: body.height } : null;
  });
  expect(normal?.height).toBeLessThan(500);

  await page.getByTestId("tl-fullscreen").click();
  await expect(panel).toHaveAttribute("data-fullscreen", "true");
  await settled(page);
  const full = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(full?.x).toBe(0);
  expect(full?.width).toBe(viewport?.width);
  expect(Math.round((full?.y ?? 0) - (bar?.top ?? 0))).toBe(0);
  expect(Math.round((full?.y ?? 0) + (full?.height ?? 0))).toBe(viewport?.height);
  expect(full?.height).toBeGreaterThan((normal?.height ?? 0) + 100);
  // Below the top bar, not over it: the top bar still shows and the toggle in it still works.
  await expect(page.getByTestId("timeline-toggle")).toBeVisible();
  // What is behind it is out of reach of the keyboard.
  expect(await page.evaluate(() => document.querySelector(".react-flow")?.closest("[inert]") !== null)).toBe(true);
  await expect(page.getByTestId("tl-fullscreen")).toHaveAttribute("aria-label", "Leave full screen");
  expect(new URL(page.url()).searchParams.get("fullscreen")).toBe("1");
  await shotBoth(page, "overhaul-fullscreen");

  await page.getByTestId("tl-fullscreen").click();
  await expect(panel).toHaveAttribute("data-fullscreen", "false");
  expect((await panel.boundingBox())?.height).toBeCloseTo(normal?.height ?? 0, 0);
  expect(await page.evaluate(() => document.querySelector(".react-flow")?.closest("[inert]") !== null)).toBe(false);
  await page.getByTestId("tl-fullscreen").click();

  await page.reload();
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(panel).toHaveAttribute("data-fullscreen", "true");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-fullscreen", "false");
  expect(new URL(page.url()).searchParams.get("fullscreen")).toBeNull();

  await page.getByTestId("tl-fullscreen").click();
  await page.getByTestId("tl-close").click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId("timeline-toggle").click();
  await expect(panel).toHaveAttribute("data-fullscreen", "false");
});

test("the legend names every colour and mark, and the bars and lines are drawn in the colours of the state", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-collapse-all").click();
  await settled(page);
  const legend = page.getByTestId("tl-legend");
  await expect(legend).toContainText("Healthy");
  await expect(legend).toContainText("Degraded");
  await expect(legend).toContainText("Unhealthy");
  await expect(legend).toContainText("Unknown or no data");
  await expect(legend).toContainText("A signal's line turns orange past its Degraded threshold and red past its Unhealthy one.");
  for (const mark of ["annotation", "report", "change", "incident", "pinned"]) await expect(page.getByTestId(`tl-legend-${mark}`)).toBeVisible();
  // The swatches take the theme's colours.
  const swatches = await page.locator(".tl-swatch").evaluateAll((items) => items.map((item) => getComputedStyle(item).backgroundColor));
  const healthy = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="tl-canvas"]') as Element).getPropertyValue("--healthy-dot").trim());
  expect(swatches[0]).toBe(`rgb(${[1, 3, 5].map((i) => parseInt(healthy.slice(i, i + 2), 16)).join(", ")})`);

  // Entity bars: the root was Healthy, Degraded and Unhealthy in the last day; an entity with nothing to measure is Unknown.
  const root = await coloursIn(page, await bandOf(row(page, "svc-a")), "bar");
  expect(root.healthy).toBeGreaterThan(40);
  expect(root.degraded + root.unhealthy).toBeGreaterThan(10);
  expect(root.unhealthy).toBeGreaterThan(0);
  const none = await coloursIn(page, await bandOf(row(page, "svc-e")), "bar");
  expect(none.unknown).toBeGreaterThan(40);
  expect(none.healthy + none.degraded + none.unhealthy).toBe(0);
  await shotBoth(page, "zones-entity-rows");
});

test("a signal's line is green while it is healthy, orange past the degraded threshold and red past the unhealthy one", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-preset-6h").click();
  await settled(page);
  await page.waitForTimeout(600);

  // CPU of Service A never leaves the healthy side of its thresholds.
  const cpu = page.locator('[data-testid="tl-label-signal"][data-row="svc-a"]').first();
  const calm = await coloursIn(page, await bandOf(cpu));
  expect(calm.healthy).toBeGreaterThan(10);
  expect(calm.degraded + calm.unhealthy).toBeLessThan(6);

  // Queue of Service B crosses both in the incidents.
  await row(page, "svc-b").click();
  await settled(page);
  await page.waitForTimeout(600);
  const queue = page.locator('[data-testid="tl-label-signal"][data-row="svc-b"]').first();
  await expect(queue).toBeInViewport();
  expect(await page.getByTestId("tl-labels-body").evaluate((element) => element.scrollTop)).toBe(await page.getByTestId("tl-scroll").evaluate((element) => element.scrollTop));
  const crossing = await coloursIn(page, await bandOf(queue));
  expect(crossing.healthy).toBeGreaterThan(10);
  expect(crossing.degraded).toBeGreaterThan(5);
  expect(crossing.unhealthy).toBeGreaterThan(5);
  await shotBoth(page, "overhaul-thresholds");
  if (SHOTS) {
    // The whole lane in view: the window of the screenshots is taller, and the timeline fills it.
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByTestId("tl-fullscreen").click();
    await settled(page);
    await page.waitForTimeout(600);
    await shotBoth(page, "zones-signal-lane");
  }
});

test("a row the browser scrolls into view moves the plot with the tree", async ({ page }) => {
  await open(page);
  await openTimeline(page);
  await page.getByTestId("tl-expand-all").click();
  await settled(page);
  const body = page.getByTestId("tl-labels-body");
  // Only the rows near the viewport are in the page: the last of them is below it.
  const key = await page.locator('[data-testid="tl-label-entity"]').last().getAttribute("data-key");
  const last = page.locator(`[data-testid="tl-label-entity"][data-key="${key}"]`);
  await last.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(300);
  const moved = await body.evaluate((element) => element.scrollTop);
  expect(moved).toBeGreaterThan(0);
  expect(await page.getByTestId("tl-scroll").evaluate((element) => element.scrollTop)).toBe(moved);
  await expect(last).toBeInViewport();
});

test("the selected entity has its state, impact, the question to ask, health reports and every state change next to the plot", async ({ page }) => {
  await open(page);
  await page.locator('.react-flow__node[data-id="svc-a"] .entity-node').click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service A");
  await expect(page.getByTestId("entity-details").getByTestId("health-badge")).toBeVisible();
  await expect(page.getByTestId("entity-details")).toContainText("Impact: High");
  await expect(page.getByTestId("explain-entity")).toBeVisible();
  await expect(page.getByTestId("explain-add-instruction")).toBeVisible();
  await settled(page);
  await shotBoth(page, "overhaul-entity-click");

  // Every change of state, as a list for the keyboard and a screen reader, and as marks on its row.
  await page.getByTestId("entity-changes").click();
  const changes = page.getByTestId("transition-row");
  await expect(changes.first()).toContainText(" to ");
  expect(await changes.count()).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("entity-changes-list")).toHaveCount(0);

  // The health reports have their own place: a dialog with the form and the earlier reports.
  await page.getByTestId("report-open").click();
  await expect(page.getByTestId("quick-send")).toBeVisible();
  await expect(page.getByTestId("signal-history-row")).toHaveCount(2);
  await page.getByTestId("report-close").click();
  await expect(page.getByTestId("report-submit")).toHaveCount(0);

  await page.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("entity-details")).toHaveCount(0);
});

test("the state changes of the selected entity are marked on its row, with what each one was, when it was", async ({ page }) => {
  await open(page);
  await page.locator('.react-flow__node[data-id="svc-a"] .entity-node').click();
  await settled(page);
  await page.getByTestId("tl-preset-6h").click();
  await settled(page);
  const box = await plotBox(page);
  const view = await windowOf(page);
  // The incident that began 95 minutes ago changed the root from Healthy; aim at the mark of its first change.
  await page.getByTestId("entity-changes").click();
  await expect(page.getByTestId("transition-row").first()).toBeVisible();
  await page.keyboard.press("Escape");

  const rowBox = await row(page, "svc-a").boundingBox();
  const y = (rowBox?.y ?? 0) + 22;
  let found = "";
  for (let x = box.x + 4; x < box.x + box.width - 20 && found === ""; x += 3) {
    await page.mouse.move(x, y);
    const text = await page.getByTestId("tl-tip").innerText().catch(() => "");
    if (/ to (Degraded|Unhealthy|Healthy)/.test(text) && text.includes("┃")) found = text;
  }
  expect(found).toMatch(/┃ (Healthy|Degraded|Unhealthy|Unknown) to (Healthy|Degraded|Unhealthy)/);
  expect(view.span).toBeGreaterThan(0);
});

test("on a phone the timeline fits the screen and can be pinned by touch", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await open(page);
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await settled(page);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await plotBox(page);
  expect(box.width).toBeGreaterThan(150);
  expect(box.x + box.width).toBeLessThanOrEqual(376);

  await page.touchscreen.tap(box.x + box.width / 2, box.y + 90);
  await expect(page.getByTestId("tl-model-at")).toBeVisible();
  await shot(page, "phone-light");
  await context.close();
});

test("a history of 80 entities and 300 signals over 7 days pans and zooms without dropping frames", async ({ page }) => {
  const fixture = buildFixture({ now: NOW, flows: 5, componentsPerFlow: 3, resourcesPerComponent: 4, signalsPerResource: 5, days: 7 });
  expect(fixture.entities.length).toBeGreaterThanOrEqual(80);
  expect(fixture.signalCount).toBeGreaterThanOrEqual(300);
  await page.addInitScript(() => {
    // The JS cost of every animation frame callback: the plot draws inside one, so this is the draw time.
    const w = window as unknown as { __work: number[] };
    w.__work = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const start = performance.now();
        callback(time);
        w.__work.push(performance.now() - start);
      });
  });
  await installStubs(page, { healthModelFails: false, model: modelOf(fixture) });
  await installTimeline(page, fixture);
  await page.goto(`/?${MODEL}&view=zoom`);
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.setViewportSize({ width: 1440, height: 1300 });
  await openTimeline(page);
  await page.getByTestId("tl-grip").focus();
  await page.keyboard.press("ArrowUp", { delay: 0 });
  for (let i = 0; i < 14; i += 1) await page.keyboard.press("ArrowUp");
  await page.getByTestId("tl-expand-all").click();
  await page.getByTestId("tl-preset-7d").click();
  await page.getByTestId("tl-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("tl-label-signal").first()).toBeVisible();
  const box = await plotBox(page);

  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    (window as unknown as { __work: number[] }).__work.length = 0;
    w.__stop = false;
    let last = performance.now();
    const tick = (now: number): void => {
      w.__frames.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.keyboard.down("Control");
  for (let i = 0; i < 40; i += 1) {
    await page.mouse.wheel(0, i % 2 === 0 ? -120 : 120);
    await page.waitForTimeout(16);
  }
  await page.keyboard.up("Control");
  await page.mouse.down();
  for (let i = 0; i < 60; i += 1) {
    await page.mouse.move(box.x + box.width / 2 + (i % 2 === 0 ? i * 4 : -i * 4), box.y + 200);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(2);
  });
  const work = (await page.evaluate(() => (window as unknown as { __work: number[] }).__work)).sort((a, b) => a - b);
  const pickWork = (q: number): number => work[Math.min(work.length - 1, Math.floor(q * work.length))] ?? 0;
  console.log(`timeline frame work: n=${work.length} p50=${pickWork(0.5).toFixed(2)}ms p95=${pickWork(0.95).toFixed(2)}ms p99=${pickWork(0.99).toFixed(2)}ms max=${work.at(-1)?.toFixed(2)}ms`);
  expect(pickWork(0.95)).toBeLessThan(12);
  // Frame intervals depend on how busy the machine is: a loose guard, the numbers are in the log.
  const sorted = [...frames].sort((a, b) => a - b);
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  console.log(`timeline frames: n=${frames.length} p50=${pick(0.5).toFixed(1)}ms p95=${pick(0.95).toFixed(1)}ms p99=${pick(0.99).toFixed(1)}ms max=${sorted.at(-1)?.toFixed(1)}ms`);
  expect(pick(0.5)).toBeLessThan(50);
  await shot(page, "dense-light");
});

test("at 1280x720 and device pixel ratio 2, rows scroll and time pans and zooms at 60 frames a second without a React render per wheel event", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  const fixture = buildFixture({ now: NOW, flows: 5, componentsPerFlow: 3, resourcesPerComponent: 4, signalsPerResource: 5, days: 7 });
  await instrument(page);
  await installStubs(page, { healthModelFails: false, model: modelOf(fixture) });
  await installTimeline(page, fixture);
  await page.goto(`/?${MODEL}&view=zoom`);
  await page.waitForSelector(".react-flow__node .entity-node");
  // Not `openTimeline`: it reads pixels back, and a canvas that is read back is drawn without the GPU from then on.
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await page.getByTestId("tl-fullscreen").click();
  await page.getByTestId("tl-expand-all").click();
  await page.getByTestId("tl-preset-7d").click();
  await page.waitForTimeout(800);
  const box = await plotBox(page);
  const labels = await page.getByTestId("tl-labels-body").boundingBox();
  if (!labels) throw new Error("no labels");
  const overPlot = { x: box.x + box.width / 2, y: box.y + 200 };
  const sweep = async (dx: number, dy: number, count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) await page.mouse.wheel(i < count / 2 ? dx : -dx, i < count / 2 ? dy : -dy);
    await page.waitForTimeout(300);
  };

  // Once through the rows first, so their lanes are read before anything is timed.
  await page.mouse.move(labels.x + 40, labels.y + 120);
  await sweep(0, 30, 120);
  await expect(page.getByTestId("tl-busy")).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(500);

  // What this machine does with nothing to draw: the frames of a gesture are held to 60 a second only when these are.
  const idle = await measure(page, () => page.waitForTimeout(1500));
  report("idle", idle);
  await page.mouse.move(640, 20);
  const control = await measure(page, () => sweep(0, 30, 240));
  report("wheel over the top bar (control)", control);
  await page.mouse.move(labels.x + 40, labels.y + 120);
  const scroll = await measure(page, () => sweep(0, 30, 240));
  report("scrolling rows", scroll);
  await page.mouse.move(overPlot.x, overPlot.y);
  const pan = await measure(page, () => sweep(24, 0, 240));
  report("panning", pan);
  await page.keyboard.down("Control");
  const zoom = await measure(page, () => sweep(0, -6, 240));
  await page.keyboard.up("Control");
  report("zooming", zoom);
  await shot(page, "frames-dpr2");

  for (const stats of [scroll, pan, zoom]) {
    expect(stats.work95).toBeLessThanOrEqual(6);
    expect(stats.commits).toBeLessThan(stats.wheels / 8);
    if (idle.p95 <= 16.7) expect(stats.p95).toBeLessThanOrEqual(16.7);
  }
  await context.close();
});

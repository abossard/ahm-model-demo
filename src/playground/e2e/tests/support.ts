import { expect, type Browser, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCREENSHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "screenshots");
export const DESKTOP = { width: 1440, height: 900 };
const TALL = 1500;
export const PHONE = { width: 390, height: 844 };

// The machine that runs this may be slow. A View needs a while to read, mount and connect.
export const VIEW_READY_MS = 90_000;

export interface Visitor { context: BrowserContext; page: Page }

// One browser context is one visitor: its own localStorage, so its own player.
export async function newVisitor(browser: Browser, baseURL: string | undefined, size = DESKTOP): Promise<Visitor> {
  const context = await browser.newContext({ viewport: size, reducedMotion: "reduce", ...(baseURL ? { baseURL } : {}) });
  return { context, page: await context.newPage() };
}

export function viewOf(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="view-frame"]');
}

// The unlock band crosses the page once and covers what is under it. `clear` leaves it out of the picture, for a shot of the state behind it.
const WITHOUT_BAND = ".band { display: none !important; }";

// `quick` takes the viewport at once, for a state that lasts a second or two (a settled blackjack round).
export async function shot(page: Page, name: string, quick = false, clear = false): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const style = clear ? WITHOUT_BAND : "";
  if (quick) {
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), style });
    return;
  }
  await page.waitForTimeout(400);
  // The shell scrolls inside the viewport, so a tall viewport is what shows the whole screen.
  const size = page.viewportSize() ?? DESKTOP;
  await page.setViewportSize({ width: size.width, height: TALL });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), fullPage: true, style });
  await page.setViewportSize(size);
}

// Types the cheat code anywhere on the page. The vision allows it: "type opencity anywhere on the page".
export async function opencity(page: Page): Promise<void> {
  await page.getByTestId("rung-1").waitFor();
  // The page ignores the code until it has connected to the server, so type it again until it takes.
  await expect.poll(async () => {
    if ((await page.getByTestId("rung-5").getAttribute("data-state")) === "open") return "open";
    await page.keyboard.type("opencity", { delay: 30 });
    await page.waitForTimeout(1000);
    return page.getByTestId("rung-5").getAttribute("data-state");
  }, { timeout: 60_000, intervals: [100] }).toBe("open");
}

export async function openLayer(page: Page, path: string, ready: (view: FrameLocator) => Promise<void>): Promise<FrameLocator> {
  await page.goto(path);
  const view = viewOf(page);
  await ready(view);
  return view;
}

export const helloReady = (view: FrameLocator) => view.getByTestId("hello-ping").waitFor({ timeout: VIEW_READY_MS });
export const labReady = (view: FrameLocator) => view.getByTestId("exhibit-call_tool").waitFor({ timeout: VIEW_READY_MS });
export const lobbyReady = (view: FrameLocator) => view.getByTestId("lobby-create").waitFor({ timeout: VIEW_READY_MS });
export const traderReady = (view: FrameLocator) => view.getByTestId("credits").waitFor({ timeout: VIEW_READY_MS });

export function rows(page: Page, filter: Record<string, string> = {}) {
  const attrs = Object.entries(filter).map(([key, value]) => `[data-${key}="${value}"]`).join("");
  return page.locator(`[data-testid="wire-row"]${attrs}`);
}

export async function openDrawer(page: Page): Promise<void> {
  if (await page.getByTestId("wire-drawer").isVisible()) return;
  await page.getByTestId("wire-chip").click();
  await expect(page.getByTestId("wire-drawer")).toBeVisible();
}

const SQUARE = '[data-testid^="square-"]';

// One ply for the viewer whose turn it is: a jump when one is offered (squares 7 or more apart), else the first step.
export async function playFirstMove(view: FrameLocator): Promise<void> {
  await expect(view.getByTestId("turn")).toHaveAttribute("data-mine", "true");
  const squareOf = (id: string | null) => Number.parseInt((id ?? "").replace("square-", ""), 10);
  const froms = await view.locator(`${SQUARE}[data-legal="from"]`).evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.testid ?? ""));
  let fallback: { from: string; to: string } | null = null;
  for (const from of froms) {
    await view.getByTestId(from).click();
    const tos = await view.locator(`${SQUARE}[data-legal="to"]`).evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.testid ?? ""));
    const jump = tos.find((to) => Math.abs(squareOf(to) - squareOf(from)) >= 7);
    if (jump) { await view.getByTestId(jump).click(); return; }
    fallback ??= { from, to: tos[0]! };
  }
  await view.getByTestId(fallback!.from).click();
  await view.getByTestId(fallback!.to).click();
}

// Pieces lost by one colour, or by both.
export async function lostPieces(view: FrameLocator, color?: "black" | "white"): Promise<number> {
  const texts = await view.locator(color ? `.seat[data-color="${color}"] .seat-lost` : ".seat-lost").allInnerTexts();
  return texts.reduce((sum, text) => sum + Number.parseInt(text, 10), 0);
}

// Plays first-legal moves for whichever side is to move until a piece is taken.
export async function playUntilCapture(sides: readonly FrameLocator[], limit = 80, victim?: "black" | "white"): Promise<void> {
  for (let ply = 0; ply < limit; ply += 1) {
    if (await lostPieces(sides[0]!, victim) > 0) return;
    let mover: FrameLocator | null = null;
    for (let wait = 0; wait < 100 && !mover; wait += 1) {
      for (const side of sides) {
        if (await side.getByTestId("turn").getAttribute("data-mine") === "true") { mover = side; break; }
      }
      if (!mover) await sides[0]!.owner().page().waitForTimeout(200);
    }
    if (!mover) throw new Error("nobody's turn");
    await playFirstMove(mover);
    await sides[0]!.owner().page().waitForTimeout(300);
  }
  throw new Error("no capture within the limit");
}

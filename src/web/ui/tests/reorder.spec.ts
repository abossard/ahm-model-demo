import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SUBSCRIPTION_A, healthModel, installStubs, wideHealthModel } from "./fixture";
import { openDiffTask } from "./workspaceHelpers";
import { denseModel } from "./denseModel";
import { delta, installStream, snapshot, withState } from "./liveStub";
import { portViolations } from "./portOrder";
import type { HealthModel } from "../src/model/types";

// Dragging a card to another place of its layout, and the order that leaves: Custom.

const SHOTS = process.env.DRAG_SHOTS ?? "";
const EDGES = wideHealthModel.relationships.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName }));

const graph = (page: Page): Locator => page.getByTestId("topology");
const node = (page: Page, name: string): Locator => graph(page).locator(`.react-flow__node[data-id="${name}"]`);
const card = (page: Page, name: string): Locator => node(page, name).locator(".entity-node");
const sortKey = (page: Page): Locator => page.getByTestId("sort-key");

async function open(page: Page, model: HealthModel = wideHealthModel, search = ""): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await page.goto(`/?view=zoom${search}`);
  await page.waitForSelector("[data-testid=topology] .react-flow__node .entity-node");
  await page.waitForTimeout(700);
}

/** Where the cards stand in layout coordinates, read from the node transforms so the zoom cannot skew it. */
async function places(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() => {
    const found: Record<string, { x: number; y: number }> = {};
    for (const item of document.querySelectorAll<HTMLElement>("[data-testid=topology] .react-flow__node")) {
      const id = item.getAttribute("data-id") ?? "";
      if (id.startsWith("__")) continue;
      const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(item.style.transform);
      found[id] = { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
    }
    return found;
  });
}

/** The shards of the wide model, left to right. */
async function shards(page: Page): Promise<string[]> {
  const found = await places(page);
  return Object.keys(found)
    .filter((name) => name.startsWith("shard-"))
    .sort((left, right) => (found[left] as { x: number }).x - (found[right] as { x: number }).x);
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = (await locator.boundingBox()) as { x: number; y: number; width: number; height: number };
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Takes hold of a card by its header, as a hand would. */
async function grab(page: Page, name: string): Promise<{ x: number; y: number }> {
  const at = await centre(node(page, name).locator(".entity-node__header, .entity-node").first());
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  return at;
}

async function dragTo(page: Page, to: { x: number; y: number }, steps = 14): Promise<void> {
  await page.mouse.move(to.x, to.y, { steps });
  await page.waitForTimeout(300);
}

/** The point just past the middle of a card, along the rank: where a dragged card takes its place. */
async function pastMiddle(page: Page, name: string): Promise<{ x: number; y: number }> {
  const at = await centre(card(page, name));
  return { x: at.x + 12, y: at.y };
}

function moved<T>(order: readonly T[], from: number, to: number): T[] {
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

test.describe("with the mouse", () => {
  test("a card dragged past its siblings shows a copy that follows the pointer and the place it would take, then takes it", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    expect(before).toHaveLength(8);
    const dragged = before[0] as string;
    const target = before[3] as string;
    const start = await grab(page, dragged);
    await dragTo(page, { x: start.x + 30, y: start.y + 4 });

    // While it is held: the card stays, dimmed; a see-through copy follows; the place it would take is marked.
    const ghost = graph(page).locator(".entity-node.is-ghost");
    await expect(ghost).toHaveCount(1);
    expect(Number(await ghost.evaluate((item) => getComputedStyle(item).opacity))).toBeLessThan(1);
    await expect(card(page, dragged)).toHaveClass(/is-dragging/);
    await dragTo(page, await pastMiddle(page, target));
    await expect(page.getByTestId("drop-indicator")).toHaveCount(1);
    const slot = await centre(page.getByTestId("drop-indicator"));
    const holding = await centre(card(page, dragged));
    expect(Math.hypot(slot.x - holding.x, slot.y - holding.y), "the dimmed card sits in the marked place").toBeLessThan(6);
    const ghostBox = await centre(ghost);
    const pointer = await pastMiddle(page, target);
    expect(Math.abs(ghostBox.x - pointer.x), "the copy follows the pointer").toBeLessThan(260);
    // The others make room, and the lines meet them in order, as the card passes.
    expect((await shards(page)).slice(0, 3)).toEqual(before.slice(1, 4));
    expect(await portViolations(page, EDGES)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/drag-preview-light.png` });

    await page.mouse.up();
    await expect(sortKey(page)).toHaveValue("custom");
    await page.waitForTimeout(500);
    expect(await shards(page)).toEqual(moved(before, 0, 3));
    expect(await portViolations(page, EDGES)).toEqual([]);
    await expect(page.getByTestId("drop-indicator")).toHaveCount(0);
    await expect(graph(page).locator(".entity-node.is-ghost")).toHaveCount(0);
    await expect(page.getByTestId("graph-announcement")).toContainText("moved");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/drag-after-light.png` });
  });

  test("a card dropped where the layout has no place for it stays where it was, and the order is not Custom", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x, y: start.y + 420 });

    await expect(page.getByTestId("drop-indicator")).toHaveCount(0);
    await expect(graph(page).locator(".entity-node.is-ghost.is-blocked")).toHaveCount(1);
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect(await shards(page)).toEqual(before);
    await expect(sortKey(page)).toHaveValue("shortest");
    await expect(graph(page).locator(".entity-node.is-ghost")).toHaveCount(0);
  });

  test("a root with nowhere else to go has no place to take", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, "platform");
    await dragTo(page, await pastMiddle(page, before[3] as string));

    await expect(page.getByTestId("drop-indicator")).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(sortKey(page)).toHaveValue("shortest");
    expect(start.x).toBeGreaterThan(0);
  });

  test("Escape puts the card back while it is held", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y + 2 });
    await dragTo(page, await pastMiddle(page, before[2] as string));
    await expect(page.getByTestId("drop-indicator")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("drop-indicator")).toHaveCount(0);
    await expect(graph(page).locator(".entity-node.is-ghost")).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect(await shards(page)).toEqual(before);
    await expect(sortKey(page)).toHaveValue("shortest");
    await expect(page.getByTestId("graph-announcement")).toContainText("cancelled");
  });

  test("a click with a little movement still selects the card", async ({ page }) => {
    await open(page);
    const at = await centre(node(page, "shard-2").locator(".entity-node__header"));
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 2, at.y + 1);
    await page.mouse.up();

    await expect(page.getByTestId("entity-details")).toBeVisible();
    await expect(sortKey(page)).toHaveValue("shortest");
  });

  test("a card that was dragged is not selected by the drop", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });
    await dragTo(page, await pastMiddle(page, before[2] as string));
    await page.mouse.up();
    await page.waitForTimeout(500);

    await expect(sortKey(page)).toHaveValue("custom");
    await expect(page.getByTestId("entity-details")).toHaveCount(0);
  });

  test("the order is Custom after a reload, and a reset gives the shortest connections back", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });
    await dragTo(page, await pastMiddle(page, before[3] as string));
    await page.mouse.up();
    await page.waitForTimeout(600);
    const custom = await shards(page);
    expect(custom).toEqual(moved(before, 0, 3));

    await page.reload();
    await page.waitForSelector("[data-testid=topology] .react-flow__node .entity-node");
    await page.waitForTimeout(700);
    await expect(sortKey(page)).toHaveValue("custom");
    expect(await shards(page)).toEqual(custom);
    await expect(page.getByTestId("custom-order-reset")).toBeEnabled();

    await page.getByTestId("custom-order-reset").click();
    await expect(sortKey(page)).toHaveValue("shortest");
    await page.waitForTimeout(600);
    expect(await shards(page)).toEqual(before);
    await expect(page.getByTestId("custom-order-reset")).toBeDisabled();

    await page.reload();
    await page.waitForSelector("[data-testid=topology] .react-flow__node .entity-node");
    await expect(sortKey(page)).toHaveValue("shortest");
  });

  test("another order leaves the custom one stored, and Custom brings it back", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });
    await dragTo(page, await pastMiddle(page, before[2] as string));
    await page.mouse.up();
    await page.waitForTimeout(600);
    const custom = await shards(page);

    await sortKey(page).selectOption("name");
    await page.waitForTimeout(700);
    expect(await shards(page)).toEqual([...before].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })));
    await expect(page.getByTestId("custom-order-reset")).toBeEnabled();
    await sortKey(page).selectOption("custom");
    await page.waitForTimeout(700);

    expect(await shards(page)).toEqual(custom);
  });

  test("a state change pushed to the model does not undo the order", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, model: wideHealthModel });
    const live = await installStream(page, { first: snapshot(wideHealthModel) });
    await page.goto("/?view=zoom");
    await page.waitForSelector("[data-testid=topology] .react-flow__node .entity-node");
    await page.waitForTimeout(700);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });
    await dragTo(page, await pastMiddle(page, before[3] as string));
    await page.mouse.up();
    await page.waitForTimeout(600);
    const custom = await shards(page);
    expect(custom).toEqual(moved(before, 0, 3));

    live.push(delta({ observedAt: "2026-11-11T10:00:30Z", entities: { upsert: [withState("shard-5", "Unhealthy", wideHealthModel)] } }, 1));
    await expect(node(page, "shard-5")).toContainText("Unhealthy");
    await page.waitForTimeout(600);

    expect(await shards(page)).toEqual(custom);
    await expect(sortKey(page)).toHaveValue("custom");
    expect(await portViolations(page, EDGES)).toEqual([]);
  });

  test("an entity that appears later is placed among the others, and the cards the viewer ordered keep their order", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, model: wideHealthModel });
    const live = await installStream(page, { first: snapshot(wideHealthModel) });
    await page.goto("/?view=zoom");
    await page.waitForSelector("[data-testid=topology] .react-flow__node .entity-node");
    await page.waitForTimeout(700);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });
    await dragTo(page, await pastMiddle(page, before[3] as string));
    await page.mouse.up();
    await page.waitForTimeout(600);
    const custom = await shards(page);

    const added = { ...(wideHealthModel.entities.find((item) => item.name === "shard-8") as HealthModel["entities"][number]), name: "shard-9", displayName: "Payment gateway shard 9", parents: ["platform"] };
    live.push(
      delta(
        {
          observedAt: "2026-11-11T10:01:00Z",
          entities: { upsert: [added] },
          relationships: { upsert: [{ name: "rw9", displayName: "", parentEntityName: "platform", childEntityName: "shard-9" }] },
          order: [...wideHealthModel.entities.map((item) => item.name), "shard-9"],
        },
        2,
      ),
    );
    await expect(node(page, "shard-9")).toBeVisible();
    await page.waitForTimeout(700);

    const after = await shards(page);
    expect(after.filter((name) => name !== "shard-9")).toEqual(custom);
    await expect(sortKey(page)).toHaveValue("custom");
  });
});

test.describe("with the keyboard", () => {
  test("M picks a card up, the arrow keys choose a place, Enter drops it", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const name = before[1] as string;
    await card(page, name).focus();
    await expect(card(page, name)).toHaveAttribute("aria-keyshortcuts", "M");

    await page.keyboard.press("m");
    await expect(graph(page)).toHaveAttribute("data-moving", "keyboard");
    await expect(page.getByTestId("graph-announcement")).toContainText("picked up");
    await expect(page.getByTestId("drop-indicator")).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("graph-announcement")).toContainText("Place 4 of 8");
    await page.waitForTimeout(300);
    expect(await portViolations(page, EDGES)).toEqual([]);
    expect(await shards(page)).toEqual(moved(before, 1, 3));
    await expect(sortKey(page)).toHaveValue("shortest");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/drag-keyboard-light.png` });

    await page.keyboard.press("Enter");
    await expect(sortKey(page)).toHaveValue("custom");
    await expect(graph(page)).not.toHaveAttribute("data-moving", /.+/);
    await page.waitForTimeout(500);
    expect(await shards(page)).toEqual(moved(before, 1, 3));
    await expect(page.getByTestId("graph-announcement")).toContainText("moved");
    await expect(page.getByTestId("entity-details")).toHaveCount(0);
    await expect(card(page, name)).toBeFocused();
  });

  test("Escape puts a card picked up with the keyboard back", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    await card(page, before[1] as string).focus();
    await page.keyboard.press("m");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");

    await page.waitForTimeout(400);
    expect(await shards(page)).toEqual(before);
    await expect(sortKey(page)).toHaveValue("shortest");
    await expect(graph(page)).not.toHaveAttribute("data-moving", /.+/);
    await expect(page.getByTestId("graph-announcement")).toContainText("cancelled");
  });

  test("the arrow keys stop at the first and the last place", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    await card(page, before[0] as string).focus();
    await page.keyboard.press("m");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("graph-announcement")).toContainText("No further place");
    for (let step = 0; step < 9; step += 1) await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("graph-announcement")).toContainText("No further place");
    await page.keyboard.press("Escape");
  });

  test("Enter on a card that is not picked up still opens it", async ({ page }) => {
    await open(page);
    await card(page, "shard-3").focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("entity-details")).toBeVisible();
  });

  test("a card with no other place says so", async ({ page }) => {
    await open(page);
    await card(page, "platform").focus();
    await page.keyboard.press("m");

    await expect(page.getByTestId("graph-announcement")).toContainText("no other place");
    await expect(graph(page)).not.toHaveAttribute("data-moving", /.+/);
  });
});

test.describe("in the other layouts", () => {
  for (const layout of ["dagre-lr", "dagre-bt", "dagre-rl", "elk-layered"] as const) {
    test(`${layout}: a card keeps its rank and takes the next place`, async ({ page }) => {
      await open(page);
      await page.getByTestId("layout-picker").selectOption(layout);
      await page.waitForTimeout(700);
      const found = await places(page);
      const sideways = layout === "dagre-lr" || layout === "dagre-rl";
      const order = Object.keys(found)
        .filter((name) => name.startsWith("shard-"))
        .sort((left, right) => (sideways ? (found[left] as { y: number }).y - (found[right] as { y: number }).y : (found[left] as { x: number }).x - (found[right] as { x: number }).x));
      const name = order[2] as string;
      await card(page, name).focus();
      await page.keyboard.press("m");
      await page.keyboard.press(sideways ? "ArrowDown" : "ArrowRight");
      await page.keyboard.press("Enter");
      await expect(sortKey(page)).toHaveValue("custom");
      await page.waitForTimeout(900);

      const after = await places(page);
      const next = Object.keys(after)
        .filter((item) => item.startsWith("shard-"))
        .sort((left, right) => (sideways ? (after[left] as { y: number }).y - (after[right] as { y: number }).y : (after[left] as { x: number }).x - (after[right] as { x: number }).x));
      expect(next).toEqual(moved(order, 2, 3));
      expect(await portViolations(page, EDGES)).toEqual([]);
    });
  }

  for (const layout of ["elk-radial", "d3-force"] as const) {
    test(`${layout}: a card swaps places with the one it is dropped on`, async ({ page }) => {
      await open(page);
      await page.getByTestId("layout-picker").selectOption(layout);
      await page.waitForTimeout(900);
      const found = await places(page);
      const names = Object.keys(found).filter((name) => name.startsWith("shard-"));
      const dragged = names[0] as string;

      await card(page, dragged).focus();
      await page.keyboard.press("m");
      // the first card an arrow key reaches is the one it would swap with
      let landed = "";
      for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
        await page.keyboard.press(key);
        landed = (await graph(page).getAttribute("data-moving-to")) ?? "";
        if (landed) break;
      }
      expect(landed.startsWith("shard-") || landed === "platform", `${layout}: a card the keyboard can swap with, not "${landed}"`).toBe(true);
      await expect(page.getByTestId("drop-indicator")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(sortKey(page)).toHaveValue("custom");
      await page.waitForTimeout(900);

      const after = await places(page);
      expect(after[dragged]).toEqual(found[landed]);
      expect(after[landed]).toEqual(found[dragged]);
    });
  }

  test("the live force layout keeps its own drag: there are no places in a simulation", async ({ page }) => {
    await open(page);
    await page.getByTestId("layout-picker").selectOption("d3-force-adaptive");
    await page.waitForTimeout(900);
    await expect(page.getByTestId("custom-order-reset")).toBeDisabled();
    await card(page, "shard-2").focus();
    await page.keyboard.press("m");

    await expect(graph(page)).not.toHaveAttribute("data-moving", /.+/);
  });
});

test.describe("on the shelf", () => {
  test("an unconnected part takes the place of another", async ({ page }) => {
    await open(page, healthModel);
    const before = await places(page);
    const dragged = "svc-f";
    const start = await grab(page, dragged);
    await dragTo(page, { x: start.x + 20, y: start.y });
    const target = await centre(card(page, "svc-e"));
    await dragTo(page, target);
    await expect(page.getByTestId("drop-indicator")).toHaveCount(1);
    await page.mouse.up();
    await expect(sortKey(page)).toHaveValue("custom");
    await page.waitForTimeout(700);

    const after = await places(page);
    expect(after["svc-a"]).toEqual(before["svc-a"]);
    expect(after["svc-f"]).not.toEqual(before["svc-f"]);
    expect(after["svc-e"]).not.toEqual(before["svc-e"]);
  });
});

test.describe("motion and themes", () => {
  test("with reduced motion the others do not slide while a card is dragged", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });

    const duration = await node(page, before[2] as string).evaluate((item) => getComputedStyle(item).transitionDuration);
    expect(duration.split(",").every((value) => value.trim() === "0s")).toBe(true);
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });

  test("without it they slide", async ({ page }) => {
    await open(page);
    const before = await shards(page);
    const start = await grab(page, before[0] as string);
    await dragTo(page, { x: start.x + 20, y: start.y });

    const duration = await node(page, before[2] as string).evaluate((item) => getComputedStyle(item).transitionDuration);
    expect(duration).not.toBe("0s");
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the copy and the place are drawn in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const before = await shards(page);
      const start = await grab(page, before[0] as string);
      await dragTo(page, { x: start.x + 20, y: start.y });
      await dragTo(page, await pastMiddle(page, before[3] as string));

      const indicator = page.getByTestId("drop-indicator");
      await expect(indicator).toHaveCount(1);
      const style = await indicator.evaluate((item) => ({ border: getComputedStyle(item).borderTopStyle, colour: getComputedStyle(item).borderTopColor }));
      expect(style.border).toBe("dashed");
      expect(style.colour).not.toBe("rgba(0, 0, 0, 0)");
      const ghost = graph(page).locator(".entity-node.is-ghost");
      expect(Number(await ghost.evaluate((item) => getComputedStyle(item).opacity))).toBeLessThan(1);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/drag-held-${scheme}.png` });
      await page.mouse.up();
      await page.waitForTimeout(500);
      if (SHOTS && scheme === "dark") await page.screenshot({ path: `${SHOTS}/drag-after-dark.png` });
    });
  }
});

test("dragging a card of a model of 81 entities keeps the frames short", async ({ page }) => {
  const model = denseModel(7, 81, 100);
  await open(page, model);
  const roots = Object.keys(await places(page));
  // a card with siblings: any child of the first entity
  const rank = model.relationships.filter((item) => item.parentEntityName === "n0").map((item) => item.childEntityName);
  expect(rank.length).toBeGreaterThan(1);
  const first = rank[0] as string;
  const last = rank[rank.length - 1] as string;
  expect(roots).toContain(first);

  await page.evaluate(() => {
    const frames: number[] = [];
    (window as unknown as { __frames: number[] }).__frames = frames;
    const tick = (time: number): void => {
      frames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const start = await grab(page, first);
  await dragTo(page, { x: start.x + 20, y: start.y }, 4);
  const end = await centre(card(page, last));
  await page.mouse.move(end.x + 40, end.y, { steps: 60 });
  await page.mouse.move(start.x, start.y, { steps: 60 });
  await page.mouse.up();

  const stats = await page.evaluate(() => {
    const frames = (window as unknown as { __frames: number[] }).__frames;
    const gaps = frames.slice(1).map((time, index) => time - (frames[index] as number)).sort((a, b) => a - b);
    return { count: gaps.length, median: gaps[Math.floor(gaps.length / 2)] ?? 0, p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0, worst: gaps[gaps.length - 1] ?? 0 };
  });
  test.info().annotations.push({ type: "frames", description: JSON.stringify(stats) });
  expect(stats.count).toBeGreaterThan(20);
  expect(stats.p95).toBeLessThan(400);
});

test("a custom order of the open model is the order of both sides of a comparison", async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem("ahm.customOrders.v1", JSON.stringify({ [key]: { kind: "ranks", ranks: [["svc-a"], ["svc-d", "svc-b"]] } }));
      window.localStorage.setItem("ahm.sortKey.v1", "custom");
    },
    { key: `${SUBSCRIPTION_A}/rg-demo/hm-demo#hierarchy` },
  );
  await openDiffTask(page);
  await page.getByTestId("compare-toggle").click();
  await expect(page.getByTestId("compare-view")).toBeVisible();
  await page.waitForTimeout(900);

  const across = async (side: string, name: string): Promise<number> =>
    page
      .getByTestId(side)
      .locator(`.react-flow__node[data-id="${name}"]`)
      .evaluate((item) => Number(/translate\((-?[\d.]+)px/.exec((item as HTMLElement).style.transform)?.[1]));
  for (const side of ["graph-base", "graph-proposed"]) {
    expect(await across(side, "svc-d"), `${side}: svc-d stands left of svc-b`).toBeLessThan(await across(side, "svc-b"));
  }
  // and a compared graph is not dragged: it is arranged for both sides
  await expect(page.getByTestId("graph-base").locator(".react-flow__node").first()).not.toHaveClass(/draggable/);
});

test("a card is dragged at the zoom where cards are name pills", async ({ page }) => {
  await open(page);
  const before = await shards(page);
  const pane = (await page.locator(".react-flow__pane").boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  for (let step = 0; step < 40; step += 1) {
    const zoom = await page.evaluate(() => Number(/scale\((-?[\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1] ?? 1));
    if (zoom <= 0.4) break;
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  await expect(graph(page).locator(".entity-node").first()).toHaveAttribute("data-lod", "pill");

  const start = await grab(page, before[0] as string);
  await dragTo(page, { x: start.x + 15, y: start.y });
  await dragTo(page, await pastMiddle(page, before[2] as string));
  await expect(page.getByTestId("drop-indicator")).toHaveCount(1);
  await page.mouse.up();
  await expect(sortKey(page)).toHaveValue("custom");
  await page.waitForTimeout(500);

  expect(await shards(page)).toEqual(moved(before, 0, 2));
  expect(await portViolations(page, EDGES)).toEqual([]);
});

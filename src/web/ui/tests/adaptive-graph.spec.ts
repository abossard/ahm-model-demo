import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { HealthModel } from "../src/model/types";
import { healthModel, installStubs } from "./fixture";
import { DENSE_SEED, denseModel, realAnbomovModel } from "./denseModel";

async function boot(page: Page): Promise<void> {
  await installStubs(page, { healthModelFails: false });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
}

async function bootMutable(page: Page, modelRef: { current: HealthModel }): Promise<void> {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: {
      get "hm-demo"() {
        return modelRef.current;
      },
    },
  });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
}

async function openHealthFilter(page: Page): Promise<void> {
  await page.getByTestId("health-filter-toggle").click();
  await expect(page.getByTestId("health-filter-popup")).toBeVisible();
}

async function closeHealthFilter(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("health-filter-popup")).toHaveCount(0);
}

async function transforms(page: Page): Promise<readonly [string, string][]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")].map((node) => [
      node.getAttribute("data-id") ?? "",
      (node as HTMLElement).style.transform,
    ]),
  );
}

type Position = { x: number; y: number };
type Viewport = { x: number; y: number; scale: number };

function parseTranslate(value: string): Position | null {
  const match = /translate\(([-.\d]+)px,\s*([-.\d]+)px\)/.exec(value);
  if (!match) {
    return null;
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function positions(page: Page): Promise<Map<string, Position>> {
  const entries = await transforms(page);
  return new Map(
    entries
      .map(([id, transform]) => [id, parseTranslate(transform)] as const)
      .filter((entry): entry is [string, Position] => Boolean(entry[1])),
  );
}

function movedBy(before: Map<string, Position>, after: Map<string, Position>, id: string): number {
  const start = before.get(id);
  const end = after.get(id);
  if (!start || !end) {
    return 0;
  }
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function pairwiseDistanceDelta(before: Map<string, Position>, after: Map<string, Position>): number {
  const ids = [...before.keys()].filter((id) => after.has(id));
  let maxDelta = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const leftBefore = before.get(ids[i]);
      const rightBefore = before.get(ids[j]);
      const leftAfter = after.get(ids[i]);
      const rightAfter = after.get(ids[j]);
      if (!leftBefore || !rightBefore || !leftAfter || !rightAfter) {
        continue;
      }
      const distanceBefore = Math.hypot(leftBefore.x - rightBefore.x, leftBefore.y - rightBefore.y);
      const distanceAfter = Math.hypot(leftAfter.x - rightAfter.x, leftAfter.y - rightAfter.y);
      maxDelta = Math.max(maxDelta, Math.abs(distanceAfter - distanceBefore));
    }

  }
  return maxDelta;
}

async function viewport(page: Page): Promise<Viewport> {
  return page.evaluate(() => {
    const viewportNode = document.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!viewportNode) throw new Error("Viewport not found");
    const match = /translate\(([-.\d]+)px,\s*([-.\d]+)px\)\s*scale\(([-.\d]+)\)/.exec(
      viewportNode.style.transform,
    );
    if (!match) throw new Error(`Viewport transform unavailable: ${viewportNode.style.transform}`);
    return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
  });
}

const OBSERVATION_WINDOW_MS = 600;

async function waitForStableLayout(
  page: Page,
  options: { threshold?: number; sampleMs?: number; consecutive?: number; timeoutMs?: number } = {},
): Promise<Map<string, Position>> {
  const threshold = options.threshold ?? 1;
  const sampleMs = options.sampleMs ?? 250;
  const consecutive = options.consecutive ?? 3;
  const timeoutMs = options.timeoutMs ?? 8000;
  const start = Date.now();
  let previous = await positions(page);
  let stableWindows = 0;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(sampleMs);
    const current = await positions(page);
    const sameIds = current.size === previous.size && [...current.keys()].every((id) => previous.has(id));
    const delta = sameIds
      ? Math.max(0, ...[...current.keys()].map((id) => movedBy(previous, current, id)))
      : Number.POSITIVE_INFINITY;
    if (delta <= threshold) {
      stableWindows += 1;
      if (stableWindows >= consecutive) {
        return current;
      }
    } else {
      stableWindows = 0;
    }
    previous = current;
  }

  throw new Error(`Layout did not settle within ${timeoutMs}ms`);
}

async function waitForStableViewport(
  page: Page,
  options: { threshold?: number; sampleMs?: number; consecutive?: number; timeoutMs?: number } = {},
): Promise<Viewport> {
  const threshold = options.threshold ?? 0.001;
  const sampleMs = options.sampleMs ?? 120;
  const consecutive = options.consecutive ?? 3;
  const timeoutMs = options.timeoutMs ?? 6000;
  const start = Date.now();
  let previous = await viewport(page);
  let stableWindows = 0;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(sampleMs);
    const current = await viewport(page);
    const delta = Math.max(
      Math.abs(current.x - previous.x),
      Math.abs(current.y - previous.y),
      Math.abs(current.scale - previous.scale),
    );
    if (delta <= threshold) {
      stableWindows += 1;
      if (stableWindows >= consecutive) return current;
    } else {
      stableWindows = 0;
    }
    previous = current;
  }

  throw new Error(`Viewport did not settle within ${timeoutMs}ms`);
}

async function chooseAdaptive(page: Page): Promise<void> {
  await page.getByTestId("layout-picker").selectOption("d3-force-adaptive");
}

async function dragNode(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(node).toBeVisible();
  const box = await node.boundingBox();
  if (!box) {
    throw new Error(`Cannot drag ${id}: no bounding box`);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

async function dragNodeWithEstablishedGesture(
  page: Page,
  id: string,
  dragDx: number,
  dragDy: number,
  targetSelector?: string,
): Promise<{
  readonly pointerDx: number;
  readonly pointerDy: number;
  readonly nodeDx: number;
  readonly nodeDy: number;
  readonly expectedDx: number;
  readonly expectedDy: number;
  readonly offsetDxDelta: number;
  readonly offsetDyDelta: number;
  readonly viewportDelta: number;
  readonly pointerInsideNodeAtEnd: boolean;
}> {
  await waitForStableLayout(page, { threshold: 0.001, sampleMs: 50, consecutive: 6 });
  await waitForStableViewport(page);
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const dragTarget = targetSelector
    ? node.locator(targetSelector)
    : node;
  await expect(dragTarget).toBeVisible();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const box = await dragTarget.boundingBox();
    const canvas = await page.locator(".react-flow").boundingBox();
    if (!box || !canvas) throw new Error(`Cannot read geometry for ${id}`);
    const center = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const reachable = await dragTarget.evaluate(
      (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
      center,
    );
    const insideCanvas = (point: Position) =>
      point.x > canvas.x + 64 && point.x < canvas.x + canvas.width - 64 &&
      point.y > canvas.y + 64 && point.y < canvas.y + canvas.height - 64;
    const end = { x: center.x + 20 + dragDx, y: center.y + 16 + dragDy };
    if (reachable && insideCanvas(center) && insideCanvas(end)) break;
    if (attempt === 5) throw new Error(`Drag target ${id} is intercepted`);
    const dx = Math.max(-300, Math.min(300, canvas.x + canvas.width / 2 - (20 + dragDx) / 2 - center.x));
    const dy = Math.max(-150, Math.min(150, canvas.y + canvas.height / 2 - (16 + dragDy) / 2 - center.y));
    const panStart = await page.evaluate(({ canvas, dx, dy }) => {
      const x = dx < 0 ? canvas.x + canvas.width - 20 : canvas.x + 20;
      const y = dy < 0 ? canvas.y + canvas.height - 30 : canvas.y + 20;
      return [
        { x, y },
        { x, y: canvas.y + canvas.height / 2 },
        { x: canvas.x + canvas.width / 2, y },
      ].find((point) => document.elementFromPoint(point.x, point.y)?.classList.contains("react-flow__pane"));
    }, { canvas, dx, dy });
    if (!panStart) throw new Error("No visible canvas background for panning");
    await page.mouse.move(panStart.x, panStart.y);
    await page.mouse.down();
    await page.mouse.move(panStart.x + dx, panStart.y + dy, { steps: 12 });
    await page.mouse.up();
    await waitForStableViewport(page);
  }

  const box = await dragTarget.boundingBox();
  if (!box) throw new Error(`Cannot drag ${id}: no bounding box`);
  const startX = Math.round(box.x + box.width / 2);
  const startY = Math.round(box.y + box.height / 2);
  const startPosition = (await positions(page)).get(id);
  if (!startPosition) throw new Error(`No starting position for ${id}`);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  try {
    await page.mouse.move(startX + 10, startY + 8, { steps: 1 });
    await page.mouse.move(startX + 20, startY + 16, { steps: 1 });
    await expect.poll(async () => {
      const current = (await positions(page)).get(id);
      if (!current) throw new Error(`Dragged node ${id} disappeared`);
      return Math.hypot(current.x - startPosition.x, current.y - startPosition.y);
    }).toBeGreaterThan(1);

    const anchor = (await positions(page)).get(id);
    const anchorBox = await dragTarget.boundingBox();
    if (!anchor || !anchorBox) throw new Error(`Cannot read drag anchor for ${id}`);
    const anchorX = startX + 20;
    const anchorY = startY + 16;
    const endX = anchorX + dragDx;
    const endY = anchorY + dragDy;
    const viewportBefore = await viewport(page);
    const expectedDx = dragDx / viewportBefore.scale;
    const expectedDy = dragDy / viewportBefore.scale;
    await page.mouse.move(endX, endY, { steps: 10 });
    await expect.poll(async () => {
      const current = (await positions(page)).get(id);
      if (!current) throw new Error(`Dragged node ${id} disappeared`);
      return Math.max(
        Math.abs(current.x - anchor.x - expectedDx),
        Math.abs(current.y - anchor.y - expectedDy),
      );
    }).toBeLessThanOrEqual(1);

    const held = (await positions(page)).get(id);
    const endBox = await dragTarget.boundingBox();
    if (!held || !endBox) throw new Error(`Cannot read held position for ${id}`);
    const viewportAfter = await viewport(page);
    return {
      pointerDx: expectedDx,
      pointerDy: expectedDy,
      nodeDx: held.x - anchor.x,
      nodeDy: held.y - anchor.y,
      expectedDx,
      expectedDy,
      offsetDxDelta: (
        endBox.x + endBox.width / 2 - endX -
        (anchorBox.x + anchorBox.width / 2 - anchorX)
      ) / viewportBefore.scale,
      offsetDyDelta: (
        endBox.y + endBox.height / 2 - endY -
        (anchorBox.y + anchorBox.height / 2 - anchorY)
      ) / viewportBefore.scale,
      viewportDelta: Math.max(
        Math.abs(viewportAfter.x - viewportBefore.x),
        Math.abs(viewportAfter.y - viewportBefore.y),
        Math.abs(viewportAfter.scale - viewportBefore.scale),
      ),
      pointerInsideNodeAtEnd:
        endX >= endBox.x - 1 &&
        endX <= endBox.x + endBox.width + 1 &&
        endY >= endBox.y - 1 &&
        endY <= endBox.y + endBox.height + 1,
    };
  } finally {
    await page.mouse.up();
  }
}

async function zoomCanvas(page: Page, wheelDeltaY: number): Promise<void> {
  const pane = page.locator(".react-flow__pane");
  await expect(pane).toBeVisible();
  const box = await pane.boundingBox();
  if (!box) {
    throw new Error("Cannot zoom graph: pane not visible");
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, wheelDeltaY);
}

async function zoomToHalf(page: Page): Promise<void> {
  await waitForStableViewport(page);
  for (let i = 0; i < 10; i += 1) {
    const current = await viewport(page);
    if (current.scale <= 0.5005) {
      return;
    }
    await zoomCanvas(page, Math.min(160, -500 * Math.log2(0.5 / current.scale)));
    await waitForStableViewport(page);
  }

  const current = await viewport(page);
  throw new Error(`Could not reach zoom 0.5 (current scale: ${current.scale})`);
}

async function maxAmbientMovementOverRafs(
  page: Page,
  rafSamples = 15,
): Promise<number> {
  const baseline = await positions(page);
  let maxMovement = 0;
  for (let i = 0; i < rafSamples; i += 1) {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const current = await positions(page);
    for (const id of baseline.keys()) {
      maxMovement = Math.max(maxMovement, movedBy(baseline, current, id));
    }
  }
  return maxMovement;
}

function hasPositiveAreaIntersection(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  const overlapX = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const overlapY = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return overlapX > 0 && overlapY > 0;
}

async function overlapCount(page: Page): Promise<number> {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node .entity-node")].map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  let count = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (hasPositiveAreaIntersection(boxes[i], boxes[j])) count += 1;
    }
  }
  return count;
}

test("adaptive layout and health controls are available", async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId("layout-picker").locator("option")).toHaveCount(8);
  await expect(page.getByTestId("layout-picker").locator('option[value="d3-force-adaptive"]')).toHaveText(
    "Live force directed",
  );

  await openHealthFilter(page);
  for (const state of ["Healthy", "Degraded", "Unhealthy", "Unknown"] as const) {
    await expect(page.getByRole("checkbox", { name: state, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("radio", { name: "Hide with edges" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Gray dot" })).toBeVisible();
  await closeHealthFilter(page);
});

test("health checkbox labels keep theme colors and exclude Standby", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  await expect(page.getByRole("checkbox", { name: "Standby" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Unknown", exact: true })).toBeChecked();

  const degradedSwatchLight = await page
    .locator(".graph-toolbar__health-option", { hasText: "Degraded" })
    .locator(".graph-toolbar__health-swatch")
    .evaluate((item) => getComputedStyle(item).backgroundColor);
  expect(degradedSwatchLight).toBe("rgb(194, 106, 0)");
  await closeHealthFilter(page);

  await page.getByTestId("theme-toggle").click();
  await openHealthFilter(page);
  const degradedSwatchDark = await page
    .locator(".graph-toolbar__health-option", { hasText: "Degraded" })
    .locator(".graph-toolbar__health-swatch")
    .evaluate((item) => getComputedStyle(item).backgroundColor);
  expect(degradedSwatchDark).toBe("rgb(253, 186, 116)");
});

test("hide mode removes deselected-state nodes and edges", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  await page.getByRole("checkbox", { name: "Degraded" }).click();
  await closeHealthFilter(page);

  await expect(page.locator('.react-flow__node[data-id="svc-b"]')).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
});

test("reselecting a health bucket restores a dot back to full card presentation", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  await page.getByRole("radio", { name: "Gray dot" }).click();
  await page.getByRole("checkbox", { name: "Degraded" }).click();
  await closeHealthFilter(page);

  const degradedNode = page.locator('.react-flow__node[data-id="svc-b"] .entity-node');
  await expect(degradedNode).toHaveAttribute("data-role", "dot");

  await openHealthFilter(page);
  await page.getByRole("checkbox", { name: "Degraded" }).click();
  await closeHealthFilter(page);

  await expect(degradedNode).toHaveAttribute("data-role", "card");
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node__row')).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node__pill-word')).toContainText("Degraded");
});

test("dot mode keeps deselected-state nodes as gray dots with muted edges", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  await page.getByRole("radio", { name: "Gray dot" }).click();
  await page.getByRole("checkbox", { name: "Degraded" }).click();
  await closeHealthFilter(page);

  const dot = page.locator('.react-flow__node[data-id="svc-b"] .entity-node[data-role="dot"]');
  await expect(dot).toBeVisible();
  await expect(dot).toHaveCSS("background-color", "rgb(138, 136, 134)");

  const edgeStrokes = await page
    .locator(".react-flow__edge .react-flow__edge-path")
    .evaluateAll((items) => items.map((item) => getComputedStyle(item).stroke));
  expect(edgeStrokes).toContain("rgb(96, 94, 92)");
});

test("adaptive layout publishes live frames", async ({ page }) => {
  await boot(page);
  await page.getByTestId("layout-picker").selectOption("d3-force-adaptive");

  const before = await transforms(page);
  await page.waitForTimeout(500);
  const after = await transforms(page);
  const moved = after.filter(([id, transform]) => {
    const previous = before.find(([beforeId]) => beforeId === id);
    return previous ? previous[1] !== transform : false;
  });
  expect(moved.length).toBeGreaterThan(0);
});

test("search reselects needed health state for hidden match", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  for (const state of ["Degraded", "Unhealthy", "Unknown"] as const) {
    await page.getByRole("checkbox", { name: state }).click();
  }
  await closeHealthFilter(page);
  await expect(page.locator('.react-flow__node[data-id="svc-c"]')).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("search-input").fill("Service C");
  await page.keyboard.press("Enter");

  await expect(page.locator('.react-flow__node[data-id="svc-c"]')).toBeVisible();
  await openHealthFilter(page);
  await expect(page.getByRole("checkbox", { name: "Unhealthy" })).toBeChecked();
});

test("refresh with unchanged model keeps adaptive layout stable", async ({ page }) => {
  const modelRef = { current: healthModel };
  await bootMutable(page, modelRef);
  await chooseAdaptive(page);

  await waitForStableLayout(page);
  const controlStart = await positions(page);
  const controlStartTransforms = new Map(await transforms(page));
  await page.waitForTimeout(OBSERVATION_WINDOW_MS);
  const controlEnd = await positions(page);
  const controlEndTransforms = new Map(await transforms(page));
  const controlDelta = pairwiseDistanceDelta(controlStart, controlEnd);
  expect(controlDelta).toBeLessThanOrEqual(1);
  expect(controlEndTransforms).toEqual(controlStartTransforms);

  const before = await positions(page);
  const beforeTransforms = new Map(await transforms(page));
  const refreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/health-model" &&
      response.request().method() === "GET" &&
      url.searchParams.get("model") === "hm-demo"
    );
  });
  await page.getByTestId("refresh-now").click();
  const response = await refreshResponse;
  expect(response.ok()).toBe(true);
  const served = (await response.json()) as HealthModel;
  expect(served.observedAt).toBe(healthModel.observedAt);
  await page.waitForTimeout(OBSERVATION_WINDOW_MS);
  const after = await positions(page);
  const afterTransforms = new Map(await transforms(page));
  const refreshDelta = pairwiseDistanceDelta(before, after);
  console.log(`unchanged-refresh controlDelta=${controlDelta.toFixed(4)} refreshDelta=${refreshDelta.toFixed(4)}`);

  expect(refreshDelta).toBeLessThanOrEqual(1);
  expect(afterTransforms).toEqual(beforeTransforms);
});

test("refresh with rewired relationships reheats adaptive layout", async ({ page }) => {
  const modelRef = { current: healthModel };
  await bootMutable(page, modelRef);
  await chooseAdaptive(page);

  await waitForStableLayout(page);
  const before = await positions(page);
  modelRef.current = {
    ...modelRef.current,
    observedAt: "2026-08-01T00:00:00Z",
    relationships: [
      { name: "r1", displayName: "reads", parentEntityName: "svc-a", childEntityName: "svc-c" },
      { name: "r2", displayName: "writes", parentEntityName: "svc-c", childEntityName: "svc-b" },
      { name: "r3", displayName: "queries", parentEntityName: "svc-a", childEntityName: "svc-d" },
      { name: "r4", displayName: "", parentEntityName: "svc-d", childEntityName: "svc-b" },
    ],
  };
  const refreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/health-model" &&
      response.request().method() === "GET" &&
      url.searchParams.get("model") === "hm-demo"
    );
  });
  await page.getByTestId("refresh-now").click();
  const response = await refreshResponse;
  expect(response.ok()).toBe(true);
  const served = (await response.json()) as HealthModel;
  expect(served.observedAt).toBe("2026-08-01T00:00:00Z");
  expect(served.relationships.map((item) => item.name)).toEqual(["r1", "r2", "r3", "r4"]);
  await page.waitForTimeout(OBSERVATION_WINDOW_MS);
  const after = await positions(page);

  expect(pairwiseDistanceDelta(before, after)).toBeGreaterThan(1);
});

test("adaptive drag moves card and dot nodes at different zoom levels", async ({ page }) => {
  await boot(page);
  await chooseAdaptive(page);

  await page.waitForTimeout(700);
  const beforeCardDrag = await positions(page);
  await dragNode(page, "svc-a", 120, 40);
  await page.waitForTimeout(250);
  const afterCardDrag = await positions(page);
  expect(movedBy(beforeCardDrag, afterCardDrag, "svc-a")).toBeGreaterThan(20);
  const neighborMoveAtDefaultZoom = movedBy(beforeCardDrag, afterCardDrag, "svc-b");
  expect(neighborMoveAtDefaultZoom).toBeGreaterThan(1);

  await zoomCanvas(page, -600);
  const beforeZoomedCardDrag = await positions(page);
  const zoomedCardFollow = await dragNodeWithEstablishedGesture(page, "svc-a", 140, -60);
  await page.waitForTimeout(250);
  const afterZoomedCardDrag = await positions(page);
  expect(zoomedCardFollow.pointerInsideNodeAtEnd).toBe(true);
  expect(movedBy(beforeZoomedCardDrag, afterZoomedCardDrag, "svc-a")).toBeGreaterThan(5);

  await openHealthFilter(page);
  await page.getByRole("radio", { name: "Gray dot" }).click();
  await page.getByRole("checkbox", { name: "Degraded" }).click();
  await closeHealthFilter(page);
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node[data-role="dot"]')).toBeVisible();

  const beforeDotDrag = await positions(page);
  await dragNode(page, "svc-b", 70, 35);
  await page.waitForTimeout(250);
  const afterDotDrag = await positions(page);
  expect(movedBy(beforeDotDrag, afterDotDrag, "svc-b")).toBeGreaterThan(8);
});

test("established native card drag keeps cursor-following delta at zoom 0.5 in reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page);
  await chooseAdaptive(page);
  await waitForStableLayout(page);
  await zoomToHalf(page);
  await waitForStableViewport(page);
  await waitForStableLayout(page);

  const cardFollow = await dragNodeWithEstablishedGesture(page, "svc-a", 50, 30);
  expect(cardFollow.viewportDelta).toBeLessThanOrEqual(0.001);
  expect(Math.abs(cardFollow.nodeDx - cardFollow.expectedDx)).toBeLessThanOrEqual(2);
  expect(Math.abs(cardFollow.nodeDy - cardFollow.expectedDy)).toBeLessThanOrEqual(2);
  expect(Math.abs(cardFollow.offsetDxDelta)).toBeLessThanOrEqual(2);
  expect(Math.abs(cardFollow.offsetDyDelta)).toBeLessThanOrEqual(2);
  expect(cardFollow.pointerInsideNodeAtEnd).toBe(true);
});

test("established native dot drag keeps cursor-following delta at zoom 0.5 in normal motion", async ({ page }) => {
  await boot(page);
  await chooseAdaptive(page);
  await waitForStableLayout(page);
  await zoomToHalf(page);
  await waitForStableViewport(page);
  await waitForStableLayout(page);
  await openHealthFilter(page);
  await page.getByRole("radio", { name: "Gray dot" }).click();
  await page.getByRole("checkbox", { name: "Degraded", exact: true }).click();
  await closeHealthFilter(page);
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node[data-role="dot"]')).toBeVisible();
  await waitForStableViewport(page);
  await waitForStableLayout(page);

  const dotFollow = await dragNodeWithEstablishedGesture(page, "svc-b", 50, 30, ".entity-node__dot-only");
  expect(dotFollow.viewportDelta).toBeLessThanOrEqual(0.001);
  expect(Math.abs(dotFollow.nodeDx - dotFollow.expectedDx)).toBeLessThanOrEqual(3);
  expect(Math.abs(dotFollow.nodeDy - dotFollow.expectedDy)).toBeLessThanOrEqual(3);
  expect(Math.abs(dotFollow.offsetDxDelta)).toBeLessThanOrEqual(3);
  expect(Math.abs(dotFollow.offsetDyDelta)).toBeLessThanOrEqual(3);
});

test("static layouts stay non-draggable after adaptive is available", async ({ page }) => {
  await boot(page);
  await page.getByTestId("layout-picker").selectOption("dagre-tb");
  const before = await positions(page);
  await dragNode(page, "svc-a", 140, 50);
  await page.waitForTimeout(150);
  const after = await positions(page);
  expect(movedBy(before, after, "svc-a")).toBeLessThanOrEqual(1);
});

test("reduced motion avoids ambient adaptive movement but still allows dragging", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page);
  await chooseAdaptive(page);

  const before = await positions(page);
  await page.waitForTimeout(500);
  const after = await positions(page);
  expect(pairwiseDistanceDelta(before, after)).toBeLessThanOrEqual(1);

  await dragNode(page, "svc-a", 100, 30);
  await page.waitForTimeout(100);
  const afterDrag = await positions(page);
  expect(movedBy(after, afterDrag, "svc-a")).toBeGreaterThan(10);
});

test("switching to reduced motion during an active adaptive session stops ambient frames and keeps direct dragging", async ({ page }) => {
  await boot(page);
  await chooseAdaptive(page);
  await openHealthFilter(page);
  await page.getByRole("radio", { name: "Gray dot" }).click();
  await page.getByRole("checkbox", { name: "Degraded" }).click();
  await closeHealthFilter(page);

  await waitForStableLayout(page);
  await dragNode(page, "svc-b", 90, 40);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  expect(reduced).toBe(true);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const maxAmbient = await maxAmbientMovementOverRafs(page, 15);
  expect(maxAmbient).toBeLessThanOrEqual(1);

  const beforeDrag = await positions(page);
  await dragNode(page, "svc-a", 100, 30);
  const afterDrag = await positions(page);
  expect(movedBy(beforeDrag, afterDrag, "svc-a")).toBeGreaterThan(10);
});

test("all deselected health buckets keep only Standby in hide mode", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  for (const state of ["Healthy", "Degraded", "Unhealthy", "Unknown"] as const) {
    await page.getByRole("checkbox", { name: state, exact: true }).click();
  }
  await closeHealthFilter(page);

  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="svc-e"] .entity-node[data-role="card"]')).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
});

test("all deselected health buckets keep excluded entities as dots in dot mode", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  await page.getByRole("radio", { name: "Gray dot" }).click();
  for (const state of ["Healthy", "Degraded", "Unhealthy", "Unknown"] as const) {
    await page.getByRole("checkbox", { name: state, exact: true }).click();
  }
  await closeHealthFilter(page);

  await expect(page.locator('.react-flow__node[data-id="svc-e"] .entity-node[data-role="card"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="svc-a"] .entity-node[data-role="dot"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node[data-role="dot"]')).toBeVisible();
});

test("all deselected health buckets on a no-Standby model produce an empty effective graph", async ({ page }) => {
  const modelRef: { current: HealthModel } = {
    current: {
      ...healthModel,
      entities: healthModel.entities.filter((entity) => entity.healthState !== "Deleted"),
      relationships: healthModel.relationships.filter(
        (relationship) => relationship.parentEntityName !== "svc-e" && relationship.childEntityName !== "svc-e",
      ),
    },
  };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await bootMutable(page, modelRef);
  await chooseAdaptive(page);
  await openHealthFilter(page);
  for (const state of ["Healthy", "Degraded", "Unhealthy", "Unknown"] as const) {
    await page.getByRole("checkbox", { name: state, exact: true }).click();
  }
  await closeHealthFilter(page);

  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await openHealthFilter(page);
  await expect(page.getByRole("checkbox", { name: "Healthy", exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("search result selection re-enables health buckets for relationship matches", async ({ page }) => {
  await boot(page);
  await openHealthFilter(page);
  for (const state of ["Degraded", "Unhealthy"] as const) {
    await page.getByRole("checkbox", { name: state, exact: true }).click();
  }
  await closeHealthFilter(page);

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("search-input").fill("writes");
  await page.keyboard.press("Enter");

  await openHealthFilter(page);
  await expect(page.getByRole("checkbox", { name: "Degraded" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Unhealthy" })).toBeChecked();
});

test("health popup supports keyboard focus and escape on narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const toggle = page.getByTestId("health-filter-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const popup = page.getByTestId("health-filter-popup");
  await expect(popup).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox", { name: "Healthy", exact: true })).toBeFocused();

  const bounds = await popup.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds) {
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
  }

  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test("health popup keeps semantics and checked states across keyboard dismissal", async ({ page }) => {
  await boot(page);
  const toggle = page.getByTestId("health-filter-toggle");
  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const popup = page.getByTestId("health-filter-popup");
  await expect(popup).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-controls", await popup.getAttribute("id"));

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press(" ");
  await expect(page.getByRole("checkbox", { name: "Degraded", exact: true })).not.toBeChecked();

  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await expect(page.getByRole("checkbox", { name: "Degraded", exact: true })).not.toBeChecked();
});

test("resizing keeps health controls reachable without resetting filter choices", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openHealthFilter(page);
  await page.getByRole("checkbox", { name: "Degraded", exact: true }).click();
  await closeHealthFilter(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await openHealthFilter(page);
  const popup = page.getByTestId("health-filter-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Degraded", exact: true })).not.toBeChecked();
  await closeHealthFilter(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await openHealthFilter(page);
  await expect(page.getByRole("checkbox", { name: "Degraded", exact: true })).not.toBeChecked();
  await closeHealthFilter(page);
});

test("settled mixed card-dot layouts keep nodes non-overlapping on six, dense and historical-22 fixtures", async ({ page }) => {
  const dense = denseModel(DENSE_SEED);
  const variedDense: HealthModel = {
    ...dense,
    entities: dense.entities.map((entity, index) => ({
      ...entity,
      healthState: index % 3 === 0 ? "Degraded" : "Healthy",
    })),
  };
  const historical = realAnbomovModel();
  const variedHistorical: HealthModel = {
    ...historical,
    entities: historical.entities.map((entity, index) => ({
      ...entity,
      healthState: index % 4 === 0 ? "Degraded" : "Healthy",
    })),
  };
  const fixtures: Array<{ readonly name: string; readonly model: HealthModel }> = [
    { name: "six", model: healthModel },
    { name: "dense", model: variedDense },
    { name: "historical-22", model: variedHistorical },
  ];

  for (const fixture of fixtures) {
    await test.step(fixture.name, async () => {
      await bootMutable(page, { current: fixture.model });
      await chooseAdaptive(page);
      await openHealthFilter(page);
      await page.getByRole("radio", { name: "Gray dot" }).click();
      await page.getByRole("checkbox", { name: "Degraded", exact: true }).click();
      await closeHealthFilter(page);
      await waitForStableLayout(page);
      expect(await overlapCount(page)).toBe(0);
    });
  }
});

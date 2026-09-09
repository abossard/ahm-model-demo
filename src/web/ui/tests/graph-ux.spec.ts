import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { healthModel, installStubs } from "./fixture";
import { SHARED_CLEARANCE, SHARED_DISTANCE, SHARED_RUN_TOLERANCE } from "../src/model/edgeRouting";
import {
  DENSE_BLOCKED_EDGE,
  DENSE_CROSSED_CARD,
  DENSE_SEED,
  REAL_SHARED_RUN_PAIRS,
  denseModel,
  realAnbomovModel,
} from "./denseModel";

const LAYOUT_IDS = [
  "dagre-tb",
  "dagre-bt",
  "dagre-lr",
  "dagre-rl",
  "elk-layered",
  "elk-radial",
  "d3-force",
];

interface Box {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boot(page: Page): Promise<void> {
  await installStubs(page, { healthModelFails: false });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
}

/** Layout-space geometry, read from the node transforms so viewport zoom cannot skew it. */
async function boxes(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")].map((node) => {
      const element = node as HTMLElement;
      const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform);
      return {
        id: element.getAttribute("data-id") ?? "",
        x: Number(match?.[1] ?? 0),
        y: Number(match?.[2] ?? 0),
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
    }),
  );
}

async function chooseLayout(page: Page, id: string): Promise<void> {
  await page.getByTestId("layout-picker").selectOption(id);
  await page.waitForTimeout(900);
}

function viewportTransform(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform,
  );
}

async function openSearch(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("search-overlay")).toBeVisible();
}

test("AC1 — the layout picker is a select offering the seven engines in order", async ({ page }) => {
  await boot(page);
  const picker = page.getByTestId("layout-picker");

  expect(await picker.evaluate((el) => el.tagName)).toBe("SELECT");
  expect(await picker.locator("option").evaluateAll((els) => els.map((el) => el.getAttribute("value")))).toEqual(
    LAYOUT_IDS,
  );
});

test("AC2 — switching layout repositions every node and flips the graph orientation", async ({ page }) => {
  await boot(page);
  const before = await boxes(page);

  await chooseLayout(page, "elk-radial");
  const radial = await boxes(page);
  expect(radial).toHaveLength(before.length);

  const moved = radial.filter((item) => {
    const previous = before.find((entry) => entry.id === item.id);
    return previous ? Math.hypot(item.x - previous.x, item.y - previous.y) > 20 : false;
  });
  expect(moved.length).toBeGreaterThanOrEqual(Math.ceil(before.length / 2));

  // Turning the hierarchy on its side must reorient the parent/child relation, not merely jitter it.
  const relation = async (): Promise<{ readonly below: boolean; readonly right: boolean }> => {
    const items = await boxes(page);
    const parent = items.find((item) => item.id === "svc-a") as Box;
    const child = items.find((item) => item.id === "svc-b") as Box;
    return {
      below: child.y >= parent.y + parent.height,
      right: child.x >= parent.x + parent.width,
    };
  };

  await chooseLayout(page, "dagre-tb");
  expect(await relation()).toEqual({ below: true, right: false });

  await chooseLayout(page, "dagre-lr");
  expect(await boxes(page)).toHaveLength(before.length);
  expect(await relation()).toEqual({ below: false, right: true });
});

test("AC5 — the sort control offers three keys and a reversible direction toggle", async ({ page }) => {
  await boot(page);
  const key = page.getByTestId("sort-key");
  const reverse = page.getByTestId("sort-reverse");

  expect(await key.evaluate((el) => el.tagName)).toBe("SELECT");
  expect(await key.locator("option").evaluateAll((els) => els.map((el) => el.getAttribute("value")))).toEqual([
    "name",
    "observed",
    "health",
  ]);
  await expect(reverse).toHaveAttribute("aria-pressed", "false");
  await reverse.click();
  await expect(reverse).toHaveAttribute("aria-pressed", "true");
});

test("AC5b — reversing the order mirrors the rank sequence on screen", async ({ page }) => {
  await boot(page);
  const rankOrder = async (): Promise<string[]> => {
    const items = await boxes(page);
    const top = Math.min(...items.map((item) => item.y));
    return items
      .filter((item) => item.y === top)
      .sort((left, right) => left.x - right.x)
      .map((item) => item.id);
  };

  const forward = await rankOrder();
  expect(forward.length).toBeGreaterThan(1);

  await page.getByTestId("sort-reverse").click();
  await page.waitForTimeout(900);
  expect(await rankOrder()).toEqual([...forward].reverse());
});

test("AC9 + AC10 + AC12 — collapsing hides the subtree behind a counted disclosure toggle", async ({ page }) => {
  await boot(page);
  const toggle = page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]');

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('.react-flow__node[data-id="svc-c"] [data-testid="collapse-toggle"]')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await toggle.getAttribute("aria-label")).toContain("3");
  await expect(page.locator('.react-flow__node[data-id="svc-a"] [data-testid="hidden-count"]')).toHaveText("3");

  for (const hidden of ["svc-b", "svc-c", "svc-d"]) {
    await expect(page.locator(`.react-flow__node[data-id="${hidden}"]`)).toHaveCount(0);
  }
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  await toggle.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
});

test("AC13 — Cmd/Ctrl+K opens an APG combobox over a listbox", async ({ page }) => {
  await boot(page);
  await openSearch(page);

  const input = page.getByTestId("search-input");
  await expect(input).toHaveAttribute("role", "combobox");
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await input.fill("Service");
  await expect(input).toHaveAttribute("aria-expanded", "true");

  const controls = await input.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  const listbox = page.locator(`#${controls}`);
  await expect(listbox).toHaveAttribute("role", "listbox");
  expect(await input.getAttribute("aria-activedescendant")).toBe(
    await listbox.locator('[role="option"]').first().getAttribute("id"),
  );
});

test("AC14 — search spans entities, relationships and signals in labelled groups", async ({ page }) => {
  await boot(page);
  await openSearch(page);
  await page.getByTestId("search-input").fill("e");

  for (const label of ["Entities", "Relationships", "Signals"]) {
    await expect(page.locator(`[role="group"][aria-label="${label}"]`)).toHaveCount(1);
  }

  await page.getByTestId("search-input").fill("queue");
  await expect(page.locator('[role="group"][aria-label="Signals"]')).toHaveCount(1);
  await expect(page.locator('[role="group"][aria-label="Entities"]')).toHaveCount(0);
});

test("AC15 — the matched substring is marked in every result", async ({ page }) => {
  await boot(page);
  await openSearch(page);
  await page.getByTestId("search-input").fill("erv");

  const marks = page.locator('[role="option"] mark');
  expect(await marks.count()).toBeGreaterThan(0);
  for (const text of await marks.allTextContents()) expect(text).toBe("erv");
});

test("AC16 — picking a result highlights the entity and moves the viewport", async ({ page }) => {
  await boot(page);
  const before = await viewportTransform(page);

  await openSearch(page);
  await page.getByTestId("search-input").fill("Service C");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="svc-c"] .entity-node')).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await page.waitForTimeout(1200);
  expect(await viewportTransform(page)).not.toBe(before);
});

test("AC17 — picking a hidden result expands its collapsed ancestors first", async ({ page }) => {
  await boot(page);
  await page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]').click();
  await expect(page.locator('.react-flow__node[data-id="svc-c"]')).toHaveCount(0);

  await openSearch(page);
  await page.getByTestId("search-input").fill("Service C");
  await page.keyboard.press("Enter");

  await expect(page.locator('.react-flow__node[data-id="svc-c"]')).toBeVisible();
});

test("AC18 — Escape closes the overlay and restores the previous focus", async ({ page }) => {
  await boot(page);
  const nodesBefore = await page.locator(".react-flow__node").count();

  await page.getByTestId("layout-picker").focus();
  await openSearch(page);
  await page.getByTestId("search-input").fill("Service");
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
    "layout-picker",
  );
  expect(await page.locator(".react-flow__node").count()).toBe(nodesBefore);
});

test("AC19 — an unmatched query shows an empty state instead of a silent listbox", async ({ page }) => {
  await boot(page);
  await openSearch(page);
  await page.getByTestId("search-input").fill("zzzz");

  await expect(page.locator('[role="option"]')).toHaveCount(0);
  const empty = page.getByTestId("search-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("zzzz");
});

test("AC20 — reduced motion snaps the viewport instead of animating it", async ({ page }) => {
  await boot(page);

  /**
   * Counts every distinct viewport transform painted while a layout change settles. Sampling two
   * arbitrary instants races the scheduler; observing each frame does not. An interpolated fit paints
   * many distinct values, a snap paints at most two (the value before and the value after).
   */
  const distinctFramesDuring = async (layoutId: string): Promise<number> => {
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as Record<string, unknown>).__seen = seen;
      const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
      const tick = (): void => {
        seen.add(viewport.style.transform);
        (window as unknown as Record<string, number>).__raf = requestAnimationFrame(tick);
      };
      tick();
    });

    await page.getByTestId("layout-picker").selectOption(layoutId);
    await page.waitForTimeout(1200);

    return page.evaluate(() => {
      cancelAnimationFrame((window as unknown as Record<string, number>).__raf);
      return ((window as unknown as Record<string, Set<string>>).__seen).size;
    });
  };

  expect(await distinctFramesDuring("dagre-lr")).toBeGreaterThan(2);

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await distinctFramesDuring("elk-layered")).toBeLessThanOrEqual(2);
});

test("AC21 — layout, collapse and search changes are announced politely", async ({ page }) => {
  await boot(page);
  const status = page.getByTestId("graph-announcement");
  await expect(status).toHaveAttribute("aria-live", "polite");

  await page.getByTestId("layout-picker").selectOption("elk-radial");
  await expect(status).toContainText("ELK radial");

  await page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]').click();
  await expect(status).toContainText("3 nodes hidden");

  await openSearch(page);
  await page.getByTestId("search-input").fill("Service B");
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Showing Service B");
});

/**
 * Verbatim copy of `PARENT_SECURITY_POLICY` in `src/web/app/config.py`. The Playwright preview server
 * serves no CSP header of its own, so without injecting the real policy this test would pass on an
 * unprotected page and prove nothing.
 */
const SERVED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
  "frame-src 'self'; frame-ancestors 'none'";

test("AC23 — the built app runs clean under the policy the server actually sends", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (/content security policy/i.test(error.message)) violations.push(error.message);
  });

  // Attach the production policy to the document, which the preview server omits.
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if ((headers["content-type"] ?? "").includes("text/html")) {
      headers["content-security-policy"] = SERVED_CSP;
    }
    await route.fulfill({ response, headers });
  });

  await boot(page);
  await chooseLayout(page, "elk-layered");
  await chooseLayout(page, "d3-force");
  await openSearch(page);
  await page.getByTestId("search-input").fill("Service");
  await page.keyboard.press("Escape");

  expect(violations).toEqual([]);
});

test("AC23b — the injected policy is real enough to block a violation", async ({ page }) => {
  // Guards the test above: if the header were not actually applied, this inline script would run and
  // the CSP proof would be vacuous.
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });

  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if ((headers["content-type"] ?? "").includes("text/html")) {
      headers["content-security-policy"] = SERVED_CSP;
    }
    await route.fulfill({ response, headers });
  });

  await boot(page);
  const ran = await page.evaluate(() => {
    const marker = "__csp_probe__";
    const script = document.createElement("script");
    script.textContent = `window.${marker} = true;`;
    document.head.appendChild(script);
    return Boolean((window as unknown as Record<string, boolean>)[marker]);
  });

  expect(ran).toBe(false);
  expect(violations.length).toBeGreaterThan(0);
});

test("AC24 — collapsing keeps the viewport where the user left it", async ({ page }) => {
  await boot(page);
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(760, 470, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const panned = await viewportTransform(page);

  await page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]').click();
  await page.waitForTimeout(900);
  expect(await viewportTransform(page)).toBe(panned);

  await page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]').click();
  await page.waitForTimeout(900);
  expect(await viewportTransform(page)).toBe(panned);

  await chooseLayout(page, "dagre-lr");
  expect(await viewportTransform(page)).not.toBe(panned);
});

test("AC25 — a technical-name match is still marked", async ({ page }) => {
  await boot(page);
  await openSearch(page);
  await page.getByTestId("search-input").fill("svc-c");

  const marks = page.locator('[role="option"] mark');
  expect(await marks.count()).toBeGreaterThan(0);
  for (const text of await marks.allTextContents()) expect(text.toLowerCase()).toBe("svc-c");
});

// The opener differs per path: the shortcut and the backdrop leave the layout picker focused, while
// clicking the toolbar button makes the button itself the element focused before the overlay opened.
for (const [dismissal, opener] of [
  ["escape", "layout-picker"],
  ["backdrop", "layout-picker"],
  ["toolbar-button", "search-open"],
] as const) {
  test(`AC26 — dismissing by ${dismissal} restores the previous focus`, async ({ page }) => {
    await boot(page);
    await page.getByTestId("layout-picker").focus();

    if (dismissal === "toolbar-button") {
      await page.getByTestId("search-open").click();
      await expect(page.getByTestId("search-overlay")).toBeVisible();
    } else {
      await openSearch(page);
    }
    await page.getByTestId("search-input").fill("Service");

    if (dismissal === "backdrop") {
      await page.getByTestId("search-backdrop").click({ position: { x: 6, y: 6 } });
    } else {
      await page.keyboard.press("Escape");
    }

    await expect(page.getByTestId("search-overlay")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      opener,
    );
  });
}

test("AC29 — the listbox owns only groups and options", async ({ page }) => {
  await boot(page);
  await openSearch(page);
  await page.getByTestId("search-input").fill("zzzz");

  const strays = await page.locator('[role="listbox"] > *').evaluateAll((els) =>
    els.map((el) => el.getAttribute("role")).filter((role) => role !== "group" && role !== "option"),
  );
  expect(strays).toEqual([]);
  await expect(page.getByTestId("search-empty")).toBeVisible();
});

test("AC31 — the Last-observed sort reverses on screen", async ({ page }) => {
  await boot(page);
  const rankOrder = async (): Promise<string[]> => {
    const items = await boxes(page);
    const top = Math.min(...items.map((item) => item.y));
    return items
      .filter((item) => item.y === top)
      .sort((left, right) => left.x - right.x)
      .map((item) => item.id);
  };

  await page.getByTestId("sort-key").selectOption("observed");
  await page.waitForTimeout(900);
  const forward = await rankOrder();
  expect(forward).toEqual(["svc-a", "svc-f", "svc-e"]);

  await page.getByTestId("sort-reverse").click();
  await page.waitForTimeout(900);
  expect(await rankOrder()).toEqual([...forward].reverse());
});

test("AC12b — a self-loop or an edge to an absent entity offers no collapse toggle", async ({ page }) => {
  // Degenerate relationships must not be mistaken for something worth collapsing.
  await installStubs(page, {
    healthModelFails: false,
    model: {
      ...healthModel,
      relationships: [
        ...healthModel.relationships,
        { name: "r5-self", displayName: null, parentEntityName: "svc-e", childEntityName: "svc-e" },
        { name: "r6-ghost", displayName: null, parentEntityName: "svc-f", childEntityName: "absent" },
      ],
    },
  });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");

  for (const name of ["svc-e", "svc-f"]) {
    await expect(
      page.locator(`.react-flow__node[data-id="${name}"] [data-testid="collapse-toggle"]`),
    ).toHaveCount(0);
  }
  // The real parent still has one.
  await expect(
    page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]'),
  ).toHaveCount(1);
});

test("AC16b — a relationship result frames both endpoints and a signal result frames its owner", async ({
  page,
}) => {
  await boot(page);

  await openSearch(page);
  await page.getByTestId("search-input").fill("reads");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  // `r1` is svc-a → svc-b, so the child is highlighted and both endpoints stay in view.
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node')).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await page.waitForTimeout(1200);
  const framed = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane") as HTMLElement;
    const rect = pane.getBoundingClientRect();
    return ["svc-a", "svc-b"].map((id) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
      const box = node.getBoundingClientRect();
      return box.right > rect.left && box.left < rect.right && box.bottom > rect.top;
    });
  });
  expect(framed).toEqual([true, true]);

  await openSearch(page);
  await page.getByTestId("search-input").fill("Queue");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  // The `queue` signal belongs to svc-b, so its owner is what gets highlighted.
  await expect(page.locator('.react-flow__node[data-id="svc-b"] .entity-node')).toHaveAttribute(
    "data-highlighted",
    "true",
  );
});

interface Ends {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceSide: string;
  readonly targetSide: string;
  readonly sourceGap: number;
  readonly targetGap: number;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/**
 * Where each painted edge actually starts and ends, read from the SVG path itself and compared with
 * the rendered card rectangles. A handle id or an edge type name would read correct while the
 * painted endpoint sat somewhere else, so nothing here looks at either.
 */
async function edgeEnds(page: Page): Promise<Ends[]> {
  return page.evaluate(() => {
    const cards = new Map(
      [...document.querySelectorAll(".react-flow__node")].map((node) => [
        (node as HTMLElement).getAttribute("data-id") ?? "",
        (node.querySelector(".entity-node") as HTMLElement).getBoundingClientRect(),
      ]),
    );
    const nearestSide = (point: DOMPoint, rect: DOMRect): readonly [string, number] => {
      const onX = point.x >= rect.left - 2 && point.x <= rect.right + 2;
      const onY = point.y >= rect.top - 2 && point.y <= rect.bottom + 2;
      const gaps: readonly (readonly [string, number])[] = [
        ["top", onX ? Math.abs(point.y - rect.top) : Number.POSITIVE_INFINITY],
        ["bottom", onX ? Math.abs(point.y - rect.bottom) : Number.POSITIVE_INFINITY],
        ["left", onY ? Math.abs(point.x - rect.left) : Number.POSITIVE_INFINITY],
        ["right", onY ? Math.abs(point.x - rect.right) : Number.POSITIVE_INFINITY],
      ];
      return gaps.reduce((best, item) => (item[1] < best[1] ? item : best));
    };

    return [...document.querySelectorAll(".react-flow__edge")].map((edge) => {
      const path = edge.querySelector("path.react-flow__edge-path") as unknown as SVGPathElement;
      const matrix = (path as SVGGraphicsElement).getScreenCTM() as DOMMatrix;
      const head = path.getPointAtLength(0);
      const tail = path.getPointAtLength(path.getTotalLength());
      const start = new DOMPoint(head.x, head.y).matrixTransform(matrix);
      const end = new DOMPoint(tail.x, tail.y).matrixTransform(matrix);
      const names = [...cards.keys()];
      const owner = (point: DOMPoint): string =>
        names.reduce((best, name) => {
          const rect = cards.get(name) as DOMRect;
          const here = Math.hypot(
            Math.max(rect.left - point.x, 0, point.x - rect.right),
            Math.max(rect.top - point.y, 0, point.y - rect.bottom),
          );
          const rectBest = cards.get(best) as DOMRect;
          const there = Math.hypot(
            Math.max(rectBest.left - point.x, 0, point.x - rectBest.right),
            Math.max(rectBest.top - point.y, 0, point.y - rectBest.bottom),
          );
          return here < there ? name : best;
        }, names[0] as string);

      const sourceName = owner(start);
      const targetName = owner(end);
      const [sourceSide, sourceGap] = nearestSide(start, cards.get(sourceName) as DOMRect);
      const [targetSide, targetGap] = nearestSide(end, cards.get(targetName) as DOMRect);
      return {
        id: edge.getAttribute("data-id") ?? "",
        source: sourceName,
        target: targetName,
        sourceSide,
        targetSide,
        sourceGap,
        targetGap,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      };
    });
  });
}

/**
 * An oracle that does not repeat any rule production uses. It states only what "leaves through the
 * side facing the other card" has to mean geometrically: the far endpoint lies beyond the near one
 * along the axis of the side it left through, so the path never has to travel back the way it came.
 * A side that fails this is pointing away from its partner, whatever decided it.
 */
function facesPartner(end: Ends): string[] {
  const broken: string[] = [];
  const forward: Readonly<Record<string, number>> = {
    right: end.endX - end.startX,
    left: end.startX - end.endX,
    bottom: end.endY - end.startY,
    top: end.startY - end.endY,
  };
  if ((forward[end.sourceSide] ?? -1) < -0.5) broken.push(`${end.id} leaves ${end.sourceSide} away from its target`);
  const back: Readonly<Record<string, number>> = {
    left: end.endX - end.startX,
    right: end.startX - end.endX,
    top: end.endY - end.startY,
    bottom: end.startY - end.endY,
  };
  if ((back[end.targetSide] ?? -1) < -0.5) broken.push(`${end.id} enters ${end.targetSide} away from its source`);
  return broken;
}

const EDGE_PAIRS: Readonly<Record<string, readonly [string, string]>> = {
  r1: ["svc-a", "svc-b"],
  r2: ["svc-b", "svc-c"],
  r3: ["svc-a", "svc-d"],
  r4: ["svc-d", "svc-c"],
};

async function edgePathShapes(page: Page): Promise<readonly string[]> {
  return page
    .locator(".react-flow__edge path.react-flow__edge-path")
    .evaluateAll((paths) => paths.map((path) => path.getAttribute("d") ?? ""));
}

async function nodeTransforms(page: Page): Promise<readonly string[]> {
  return page
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute("data-id")}:${(node as HTMLElement).style.transform}`).sort(),
    );
}

test("C3-1 — every edge leaves and enters on the boundary facing the other card", async ({ page }) => {
  await boot(page);

  const ends = await edgeEnds(page);
  expect(ends).toHaveLength(4);
  expect(ends.map((end) => [end.id, end.source, end.target])).toEqual(
    Object.entries(EDGE_PAIRS).map(([id, pair]) => [id, pair[0], pair[1]]),
  );

  for (const end of ends) {
    expect(facesPartner(end)).toEqual([]);
    // The endpoint sits on the painted card boundary, not somewhere near it.
    expect([end.id, end.sourceGap <= 1, end.targetGap <= 1]).toEqual([end.id, true, true]);
  }

  // No path re-enters a card body, its own source and target included.
  expect(await crossings(page)).toEqual([]);

  // A second render of the same graph must resolve every side identically rather than flickering.
  await chooseLayout(page, "elk-layered");
  await chooseLayout(page, "dagre-tb");
  const again = await edgeEnds(page);
  expect(again.map((end) => [end.id, end.sourceSide, end.targetSide])).toEqual(
    ends.map((end) => [end.id, end.sourceSide, end.targetSide]),
  );
});

test("C3-1b — all four card boundaries are used across the seven layouts", async ({ page }) => {
  await boot(page);
  const used = new Set<string>();
  const perLayout: Record<string, string[]> = {};

  for (const layoutId of LAYOUT_IDS) {
    await chooseLayout(page, layoutId);
    const ends = await edgeEnds(page);
    perLayout[layoutId] = ends.map((end) => `${end.id} ${end.sourceSide}->${end.targetSide}`);
    for (const end of ends) {
      used.add(end.sourceSide);
      used.add(end.targetSide);
    }
  }

  // Pinning either end to a fixed handle collapses this set, so nothing here is trivially true.
  expect([JSON.stringify(perLayout), ...[...used].sort()]).toEqual([
    JSON.stringify(perLayout),
    "bottom",
    "left",
    "right",
    "top",
  ]);
});

for (const layoutId of LAYOUT_IDS) {
  test(`C3-2 — ${layoutId} attaches every edge to the facing boundary and declares its route source`, async ({
    page,
  }) => {
    await boot(page);
    await chooseLayout(page, layoutId);

    await expect(page.locator(".react-flow__edge")).toHaveCount(4);
    const ends = await edgeEnds(page);

    for (const end of ends) {
      expect([layoutId, ...facesPartner(end)]).toEqual([layoutId]);
      expect([layoutId, end.id, end.sourceGap <= 1, end.targetGap <= 1]).toEqual([
        layoutId,
        end.id,
        true,
        true,
      ]);
    }

    // Every layout declares where its geometry came from, so wiring an engine route in, or losing
    // one, changes the painted class instead of degrading in silence.
    await expect(page.locator(".react-flow__edge.route-source-computed")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge.route-clear")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge.route-blocked")).toHaveCount(0);
    // `route-clear` has to mean clear of every card, endpoints included, or the class is decoration.
    expect([layoutId, ...(await crossings(page))]).toEqual([layoutId]);
  });
}

/**
 * Every sampled interior point of every edge, tested against every card. Both endpoint cards are
 * included: the attachment points themselves sit on a boundary and so are never interior, but any
 * segment that dives back under its own source or target is a crossing like any other.
 */
async function crossings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll(".react-flow__node")].map((node) => ({
      id: (node as HTMLElement).getAttribute("data-id") ?? "",
      rect: (node.querySelector(".entity-node") as HTMLElement).getBoundingClientRect(),
    }));

    const found: string[] = [];
    for (const edge of document.querySelectorAll(".react-flow__edge")) {
      const path = edge.querySelector("path.react-flow__edge-path") as unknown as SVGPathElement;
      const matrix = (path as SVGGraphicsElement).getScreenCTM() as DOMMatrix;
      const total = path.getTotalLength();
      const step = 0.5 / Math.hypot(matrix.a, matrix.b);
      for (let at = 0; at <= total; at += step) {
        const raw = path.getPointAtLength(at);
        const point = new DOMPoint(raw.x, raw.y).matrixTransform(matrix);
        for (const card of cards) {
          const { rect } = card;
          if (
            point.x > rect.left + 0.5 &&
            point.x < rect.right - 0.5 &&
            point.y > rect.top + 0.5 &&
            point.y < rect.bottom - 0.5
          ) {
            found.push(`${edge.getAttribute("data-id")} crosses ${card.id}`);
          }
        }
      }
    }
    return [...new Set(found)];
  });
}

interface SharedRun {
  readonly pair: string;
  readonly maxSharedRun: number;
}

async function sharedRuns(page: Page, includePointContacts = false): Promise<SharedRun[]> {
  return page.evaluate(({ clearance, distance, pointTolerance, includePointContacts }) => {
    const cards = [...document.querySelectorAll(".react-flow__node")].map((node) => ({
      rect: (() => {
        const box = (node.querySelector(".entity-node") as HTMLElement).getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      })(),
    }));
    const nearCard = (point: { x: number; y: number }): boolean =>
      cards.some(
        ({ rect }) =>
          point.x >= rect.left - clearance &&
          point.x <= rect.right + clearance &&
          point.y >= rect.top - clearance &&
          point.y <= rect.bottom + clearance,
      );
    type Sample = { x: number; y: number; dx: number; dy: number; at: number; near: boolean };
    const sampled = [...document.querySelectorAll(".react-flow__edge")].map((edge) => {
      const path = edge.querySelector("path.react-flow__edge-path") as unknown as SVGPathElement;
      const matrix = (path as SVGGraphicsElement).getScreenCTM() as DOMMatrix;
      const total = path.getTotalLength();
      const scale = Math.hypot(matrix.a, matrix.b);
      const style = getComputedStyle(path);
      const strokeWidth = Number.parseFloat(style.strokeWidth) * (style.vectorEffect === "non-scaling-stroke" ? 1 : scale);
      const step = 0.5 / scale;
      const out: Sample[] = [];
      for (let index = 0; index <= Math.ceil(total / step); index += 1) {
        const at = Math.min(total, index * step);
        const raw = path.getPointAtLength(at);
        const prev = path.getPointAtLength(Math.max(0, at - step));
        const next = path.getPointAtLength(Math.min(total, at + step));
        const point = new DOMPoint(raw.x, raw.y).matrixTransform(matrix);
        const before = new DOMPoint(prev.x, prev.y).matrixTransform(matrix);
        const after = new DOMPoint(next.x, next.y).matrixTransform(matrix);
        const length = Math.hypot(after.x - before.x, after.y - before.y) || 1;
        out.push({
          x: point.x,
          y: point.y,
          dx: (after.x - before.x) / length,
          dy: (after.y - before.y) / length,
          at: at * scale,
          near: nearCard(point),
        });
      }
      const cells = new Map<string, number[]>();
      for (let i = 1; i < out.length; i += 1) {
        const a = out[i - 1]!;
        const b = out[i]!;
        for (let x = Math.floor((Math.min(a.x, b.x) - distance) / distance);
          x <= Math.floor((Math.max(a.x, b.x) + distance) / distance); x += 1) {
          for (let y = Math.floor((Math.min(a.y, b.y) - distance) / distance);
            y <= Math.floor((Math.max(a.y, b.y) + distance) / distance); y += 1) {
            const key = `${x},${y}`;
            const entries = cells.get(key) ?? [];
            entries.push(i);
            cells.set(key, entries);
          }
        }
      }
      return { id: edge.getAttribute("data-id") ?? "", points: out, cells, strokeWidth };
    });

    const runs: SharedRun[] = [];
    for (let left = 0; left < sampled.length; left += 1) {
      for (let right = left + 1; right < sampled.length; right += 1) {
        const leftEdge = sampled[left]!;
        const rightEdge = sampled[right]!;
        const strokeContact = (leftEdge.strokeWidth + rightEdge.strokeWidth) / 2;
        let chain: { at: number; near: boolean; normal: number; angle: number; otherAt: number }[] = [];
        let maxSharedRun = 0;
        const finish = (): void => {
          let nearRun = 0;
          let nearMax = 0;
          let parallelRun = 0;
          let parallelMax = 0;
          let lastSign = 0;
          let crossings = 0;
          let normalMin = 0;
          let normalMax = 0;
          for (let i = 0; i < chain.length; i += 1) {
            const sample = chain[i]!;
            const previous = chain[i - 1];
            const length = previous ? sample.at - previous.at : 0;
            nearRun = sample.near && previous?.near ? nearRun + length : 0;
            nearMax = Math.max(nearMax, nearRun);
            // Float32 SVG samples introduce tiny tangent noise on straight tracks.
            parallelRun = sample.angle < 0.001 && previous && previous.angle < 0.001 ? parallelRun + length : 0;
            parallelMax = Math.max(parallelMax, parallelRun);
            normalMin = Math.min(normalMin, sample.normal);
            normalMax = Math.max(normalMax, sample.normal);
            const sign = Math.abs(sample.normal) > 0.01 ? Math.sign(sample.normal) : 0;
            if (sign && lastSign && sign !== lastSign) crossings += 1;
            if (sign) lastSign = sign;
          }
          // An isolated crossing must separate the painted strokes on both sides.
          // A sign change inside their combined half-widths is still a merged bend.
          const transverse = crossings === 1 && normalMin < -strokeContact && normalMax > strokeContact;
          if (!transverse || parallelMax > pointTolerance) maxSharedRun = Math.max(maxSharedRun, nearMax);
          chain = [];
        };
        for (const a of leftEdge.points) {
          let nearest: typeof chain[number] | undefined;
          let best = distance;
          for (const index of rightEdge.cells.get(`${Math.floor(a.x / distance)},${Math.floor(a.y / distance)}`) ?? []) {
            const from = rightEdge.points[index - 1]!;
            const to = rightEdge.points[index]!;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy);
            if (length === 0) continue;
            const angle = Math.abs(a.dx * dy - a.dy * dx) / length;
            if (angle >= 0.15) continue;
            const fraction = ((a.x - from.x) * dx + (a.y - from.y) * dy) / (length * length);
            if (fraction < 0 || fraction > 1) continue;
            const b = { x: from.x + fraction * dx, y: from.y + fraction * dy };
            const gap = Math.hypot(a.x - b.x, a.y - b.y);
            if (gap >= best) continue;
            best = gap;
            nearest = { at: a.at, near: a.near || nearCard(b),
              normal: a.dx * (b.y - a.y) - a.dy * (b.x - a.x), angle,
              otherAt: from.at + fraction * (to.at - from.at) };
          }
          const previous = chain[chain.length - 1];
          if (!nearest || (previous && Math.abs(nearest.otherAt - previous.otherAt) > distance * 2)) finish();
          if (nearest) chain.push(nearest);
        }
        finish();
        if (maxSharedRun > (includePointContacts ? 0 : pointTolerance)) runs.push({ pair: `${leftEdge.id}|${rightEdge.id}`, maxSharedRun });
      }
    }
    return runs.sort((a, b) => b.maxSharedRun - a.maxSharedRun);
  }, { clearance: SHARED_CLEARANCE, distance: SHARED_DISTANCE, pointTolerance: SHARED_RUN_TOLERANCE, includePointContacts });
}

for (const layoutId of LAYOUT_IDS) {
  test(`C3-3 — ${layoutId} routes every edge around every card, its own two included`, async ({ page }) => {
    await boot(page);
    await chooseLayout(page, layoutId);

    expect([layoutId, ...(await crossings(page))]).toEqual([layoutId]);
    // Rounded bends, so the corridor reads as a path rather than a hard staircase.
    const bends = await page
      .locator(".react-flow__edge path.react-flow__edge-path")
      .evaluateAll((paths) =>
        paths.map((path) => ((path.getAttribute("d") ?? "").match(/Q/g) ?? []).length),
      );
    expect(bends.some((count) => count > 0)).toBe(true);
  });
}

test("C10 oracle distinguishes point crossings from parallel runs and merged curves", async ({ page }) => {
  await page.setContent(`<div class="react-flow__node"><div class="entity-node"
    style="position:absolute;left:95px;top:80px;width:130px;height:10px"></div></div>
    <svg width="300" height="200" style="position:absolute;left:0;top:0">
      <g transform="translate(100 100)" stroke="green" stroke-width="1" fill="none">
        <g class="react-flow__edge" data-id="a"><path class="react-flow__edge-path" d="M 0,0 L 100,0"/></g>
        <g class="react-flow__edge" data-id="b"><path class="react-flow__edge-path" d="M 0,-4 L 100,4"/></g>
      </g>
    </svg>`);
  const measurements: { name: string; maximum: number }[] = [];
  for (const [name, a, b, scale, positive] of [
    ["shallow isolated crossing", "M 0,0 L 100,0", "M 0,-4 L 100,4", 1, false],
    ["recorded production rounded bend", "M 0,0 L 12,0 Q 24,0 24,12 L 24,24",
      "M 0,0.2 L 12.299999999999999,0.2 Q 24.2,0.2 24.2,12.1 L 24.2,24", 0.5, true],
    ["coincident", "M 0,0 L 100,0", "M 20,0 L 80,0", 1, true],
    ["antiparallel", "M 0,0 L 100,0", "M 80,0 L 20,0", 1, true],
    ["orthogonal point", "M 0,0 L 100,0", "M 50,-50 L 50,50", 1, false],
    ["near parallel", "M 0,0 L 100,0", "M 0,1.125 L 100,1.125", 1, true],
    ["separated parallel", "M 0,0 L 100,0", "M 0,3 L 100,3", 1, false],
    ["half zoom parallel", "M 0,0 L 100,0", "M 0,3 L 100,3", 0.5, true],
    ["quadratic merge", "M 0,0 Q 50,0 50,50", "M 0,1 Q 49,1 49,50", 1, true],
    ["cubic merge", "M 0,0 C 50,0 50,0 50,50", "M 0,1 C 49,1 49,1 49,50", 1, true],
    ["cross then shared tail", "M 0,0 L 100,0", "M 0,-4 L 50,4 L 60,1 L 100,1", 1, true],
  ] as const) {
    await page.locator("svg > g").evaluate((group, value) => group.setAttribute("transform", `translate(100 100) scale(${value})`), scale);
    await page.locator('[data-id="a"] path').evaluate((path, value) => path.setAttribute("d", value), a);
    await page.locator('[data-id="b"] path').evaluate((path, value) => path.setAttribute("d", value), b);
    const maximum = (await sharedRuns(page, true))[0]?.maxSharedRun ?? 0;
    measurements.push({ name, maximum });
    expect(maximum > SHARED_RUN_TOLERANCE, name).toBe(positive);
  }
  expect(measurements.find((entry) => entry.name === "half zoom parallel")?.maximum).toBeCloseTo(50, 0);
  expect(measurements.find((entry) => entry.name === "coincident")?.maximum).toBeCloseTo(60, 0);
  expect(measurements.find((entry) => entry.name === "antiparallel")?.maximum).toBeCloseTo(60, 0);
  expect(measurements.find((entry) => entry.name === "recorded production rounded bend")?.maximum).toBeCloseTo(21.739355087280273, 3);
  await test.info().attach("oracle-controls.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
});

/**
 * The independent inspection's counterexample, rebuilt deterministically: a valid 12-node /
 * 18-edge acyclic model whose `d3-force` layout produced one route the fixed corridor shapes could
 * not clear. It was painted through third-party card `n0` with the ordinary health stroke, so the
 * failure was invisible. Each layout runs the same model and reads the painted SVG.
 *
 * `elk-radial` is left out: elkjs's radial algorithm never returns on this model, with or without
 * the router change, so there is no layout to route. Seven-mode coverage stays on the repository
 * fixture in `C3-2` and `C3-3`.
 */
for (const layoutId of LAYOUT_IDS.filter((id) => id !== "elk-radial")) {
  test(`C3-3c — ${layoutId} routes the recorded dense counterexample clear of every card`, async ({
    page,
  }) => {
    await installStubs(page, { healthModelFails: false, model: denseModel(DENSE_SEED) });
    await page.goto("/");
    await page.waitForSelector(".react-flow__node .entity-node");
    await expect(page.locator(".react-flow__node")).toHaveCount(12);
    await expect(page.locator(".react-flow__edge")).toHaveCount(18);
    await chooseLayout(page, layoutId);

    // One assertion carrying both halves of the published counterevidence: the router's own verdict
    // and the picture. `route-blocked` alone would not prove the path is off the cards, and a clean
    // sample alone would not prove the router knew it.
    const blocked = await page
      .locator(".react-flow__edge.route-blocked")
      .evaluateAll((edges) => edges.map((edge) => `${edge.getAttribute("data-id")} blocked`));
    expect([layoutId, ...blocked, ...(await crossings(page))]).toEqual([layoutId]);

    if (layoutId === "d3-force") {
      // The exact edge and card the inspection published, so this specific miss cannot come back
      // hidden behind an otherwise green sweep.
      await expect(page.locator(`.react-flow__edge[data-id="${DENSE_BLOCKED_EDGE}"]`)).toHaveClass(
        /route-clear/,
      );
      expect(await crossings(page)).not.toContain(
        `${DENSE_BLOCKED_EDGE} crosses ${DENSE_CROSSED_CARD}`,
      );
    }
  });
}

test("C10 — real model edges do not merge into shared near-card corridors", async ({ page }) => {
  await installStubs(page, { healthModelFails: false, model: realAnbomovModel() });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__node")).toHaveCount(22);
  await expect(page.locator(".react-flow__edge")).toHaveCount(24);

  await page.getByTestId("edge-style-picker").selectOption("rounded");
  await page.getByTestId("connection-policy-picker").selectOption("with-layout");
  await chooseLayout(page, "dagre-tb");

  const runs = await sharedRuns(page);
  const byPair = new Map(runs.map((run) => [run.pair, run.maxSharedRun] as const));

  expect(REAL_SHARED_RUN_PAIRS.map(([left, right]) => [`${left}|${right}`, byPair.get(`${left}|${right}`) ?? 0])).toEqual([
    ["8da6b1cd-61e8-4206-9663-3cf7f6800221|r-app-hosting-aks", 0],
    ["r-ask-copilot-ai-inference|r-ask-copilot-app-hosting", 0],
  ]);
  expect(runs).toEqual([]);
  expect(await crossings(page)).toEqual([]);
  await page.locator('.react-flow__node[data-id="flow-ask-copilot"] .entity-node').click();
  await page.locator("#topology").screenshot({ path: test.info().outputPath("dagre-tb-selected-corridors.png") });
});

test("C10 — real model style and policy matrices stay clear without shared corridors", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await installStubs(page, { healthModelFails: false, model: realAnbomovModel() });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__edge")).toHaveCount(24);

  const failures: string[] = [];
  const sharedMaxima: { readonly case: string; readonly max: number; readonly runs: readonly SharedRun[];
    readonly edges: number; readonly endpoints: number; readonly blocked: readonly string[];
    readonly crossings: readonly string[]; readonly viewport: string }[] = [];
  const record = async (caseId: string): Promise<void> => {
    const blocked = await page
      .locator(".react-flow__edge.route-blocked")
      .evaluateAll((edges) => edges.map((edge) => `${edge.getAttribute("data-id")} blocked`));
    const ends = await edgeEnds(page);
    const crossingList = await crossings(page);
    const runs = await sharedRuns(page, true);
    sharedMaxima.push({ case: caseId, max: runs[0]?.maxSharedRun ?? 0, runs, edges: ends.length,
      endpoints: ends.length * 2, blocked, crossings: crossingList, viewport: await viewportTransform(page) });
    if (ends.length !== 24) failures.push(`${caseId} edges=${ends.length}`);
    if (ends.length * 2 !== 48) failures.push(`${caseId} boundary=${ends.length * 2}`);
    if ((runs[0]?.maxSharedRun ?? 0) > SHARED_RUN_TOLERANCE) failures.push(`${caseId} shared ${runs[0]?.pair} ${runs[0]?.maxSharedRun}px`);
    failures.push(...blocked.map((item) => `${caseId} ${item}`));
    failures.push(...crossingList.map((item) => `${caseId} ${item}`));
  };

  for (const style of ["rounded", "right-angle", "smooth"]) {
    await page.getByTestId("edge-style-picker").selectOption(style);
    for (const policy of ["with-layout", "free", "lr", "rl", "tb", "bt"]) {
      await page.getByTestId("connection-policy-picker").selectOption(policy);
      for (const layoutId of LAYOUT_IDS) {
        await chooseLayout(page, layoutId);
        await record(`${layoutId}/${style}/${policy}`);
        if (layoutId === "elk-layered" && policy === "with-layout" && style === "rounded") {
          await page.screenshot({ path: test.info().outputPath("elk-layered-separated-corridors.png") });
        }
      }
    }
  }

  await test.info().attach("painted-matrix.json", { body: JSON.stringify(sharedMaxima, null, 2), contentType: "application/json" });
  expect(sharedMaxima).toHaveLength(126);
  expect(sharedMaxima.filter((entry) => entry.case.endsWith("/with-layout"))).toHaveLength(21);
  expect(sharedMaxima.filter((entry) => entry.case.includes("/smooth/"))).toHaveLength(42);
  expect(sharedMaxima.filter((entry) => entry.max > SHARED_RUN_TOLERANCE)).toEqual([]);
  expect(failures).toEqual([]);
});

test("C3-3b — three parents reaching one child keep three separate paths", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    model: {
      ...healthModel,
      relationships: [
        ...healthModel.relationships,
        { name: "r7", displayName: "", parentEntityName: "svc-f", childEntityName: "svc-c" },
      ],
    },
  });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);

  expect(await crossings(page)).toEqual([]);

  const arrivals = await page.evaluate(() => {
    const rect = (document.querySelector('.react-flow__node[data-id="svc-c"] .entity-node') as HTMLElement).getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__edge")]
      .map((edge) => {
        const path = edge.querySelector("path.react-flow__edge-path") as unknown as SVGPathElement;
        const matrix = (path as SVGGraphicsElement).getScreenCTM() as DOMMatrix;
        const tail = path.getPointAtLength(path.getTotalLength());
        const end = new DOMPoint(tail.x, tail.y).matrixTransform(matrix);
        const near =
          end.x > rect.left - 2 && end.x < rect.right + 2 && end.y > rect.top - 2 && end.y < rect.bottom + 2;
        return near ? `${Math.round(end.x)},${Math.round(end.y)}` : null;
      })
      .filter((item): item is string => item !== null);
  });

  expect(arrivals).toHaveLength(3);
  expect(new Set(arrivals).size).toBe(3);
});

test("C9-2 — With layout attaches layered engines on their flow axis", async ({ page }) => {
  await boot(page);
  const expected: Readonly<Record<string, readonly [string, string]>> = {
    "dagre-tb": ["bottom", "top"],
    "dagre-bt": ["top", "bottom"],
    "dagre-lr": ["right", "left"],
    "dagre-rl": ["left", "right"],
    "elk-layered": ["bottom", "top"],
  };

  for (const layoutId of Object.keys(expected)) {
    await chooseLayout(page, layoutId);
    const [sourceSide, targetSide] = expected[layoutId] as readonly [string, string];
    expect(
      (await edgeEnds(page)).map((end) => `${layoutId}:${end.id}:${end.sourceSide}->${end.targetSide}`),
    ).toEqual(
      Object.keys(EDGE_PAIRS).map((id) => `${layoutId}:${id}:${sourceSide}->${targetSide}`),
    );
    expect([layoutId, ...(await crossings(page))]).toEqual([layoutId]);
  }
});

test("C9-3 and C9-4 — edge style and connection policy selectors redraw clear edges", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await boot(page);

  await expect(page.getByLabel("Edge style")).toHaveValue("rounded");
  await expect(page.getByLabel("Connection points")).toHaveValue("with-layout");
  expect(
    await page.getByTestId("edge-style-picker").locator("option").evaluateAll((options) =>
      options.map((option) => [option.getAttribute("value"), option.textContent]),
    ),
  ).toEqual([
    ["rounded", "Rounded orthogonal"],
    ["right-angle", "Right-angle"],
    ["smooth", "Smooth curves"],
  ]);
  expect(
    await page.getByTestId("connection-policy-picker").locator("option").evaluateAll((options) =>
      options.map((option) => [option.getAttribute("value"), option.textContent]),
    ),
  ).toEqual([
    ["with-layout", "With layout"],
    ["free", "Free"],
    ["lr", "Left to right"],
    ["rl", "Right to left"],
    ["tb", "Top to bottom"],
    ["bt", "Bottom to top"],
  ]);

  const styleShapes: Record<string, readonly string[]> = {};
  for (const style of ["rounded", "right-angle", "smooth"]) {
    await page.getByTestId("edge-style-picker").selectOption(style);
    await expect(page.getByTestId("graph-announcement")).toContainText("Edge style changed");
    for (const layoutId of LAYOUT_IDS) {
      await chooseLayout(page, layoutId);
      expect([style, layoutId, ...(await crossings(page))]).toEqual([style, layoutId]);
      await expect(page.locator(".react-flow__edge.route-clear")).toHaveCount(4);
      await expect(page.locator(".react-flow__edge.route-blocked")).toHaveCount(0);
    }
    styleShapes[style] = await edgePathShapes(page);
  }
  expect(styleShapes.rounded.some((path) => path.includes(" Q "))).toBe(true);
  expect(styleShapes["right-angle"].every((path) => !/[QC]/.test(path))).toBe(true);
  expect(styleShapes.smooth.some((path) => path.includes(" C "))).toBe(true);
  expect(new Set(Object.values(styleShapes).map((paths) => paths.join("|"))).size).toBe(3);

  const fixed: Readonly<Record<string, readonly [string, string]>> = {
    lr: ["right", "left"],
    rl: ["left", "right"],
    tb: ["bottom", "top"],
    bt: ["top", "bottom"],
  };
  for (const policy of ["with-layout", "free", "lr", "rl", "tb", "bt"]) {
    await page.getByTestId("connection-policy-picker").selectOption(policy);
    await expect(page.getByTestId("graph-announcement")).toContainText("Connection points changed");
    for (const layoutId of LAYOUT_IDS) {
      await chooseLayout(page, layoutId);
      const ends = await edgeEnds(page);
      const expected = fixed[policy];
      if (expected) {
        expect(ends.map((end) => `${policy}:${layoutId}:${end.sourceSide}->${end.targetSide}`)).toEqual(
          Object.keys(EDGE_PAIRS).map((id) => `${policy}:${layoutId}:${expected[0]}->${expected[1]}`),
        );
      }
      expect([policy, layoutId, ...(await crossings(page))]).toEqual([policy, layoutId]);
    }
  }
});

test("C9-5 and C9-6 — dropdown changes preserve graph state and remain usable when narrow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 460, height: 720 });
  await boot(page);
  await chooseLayout(page, "dagre-lr");
  await page.locator('.react-flow__node[data-id="svc-a"] .entity-node__name').click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();

  const beforeNodes = await nodeTransforms(page);
  const beforeViewport = await viewportTransform(page);
  const beforeStrokes = await page
    .locator(".react-flow__edge path.react-flow__edge-path")
    .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).stroke));
  const beforePaths = await edgePathShapes(page);

  await page.getByTestId("edge-style-picker").selectOption("smooth");
  await expect(page.getByTestId("entity-panel")).toBeVisible();
  expect(await nodeTransforms(page)).toEqual(beforeNodes);
  expect(await viewportTransform(page)).toBe(beforeViewport);
  expect(await edgePathShapes(page)).not.toEqual(beforePaths);

  const smoothPaths = await edgePathShapes(page);
  await page.getByTestId("connection-policy-picker").selectOption("tb");
  expect(await nodeTransforms(page)).toEqual(beforeNodes);
  expect(await viewportTransform(page)).toBe(beforeViewport);
  expect(await edgePathShapes(page)).not.toEqual(smoothPaths);
  expect(
    await page
      .locator(".react-flow__edge path.react-flow__edge-path")
      .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).stroke)),
  ).toEqual(beforeStrokes);
  await expect(page.getByRole("button", { name: "Search…" })).toBeVisible();
});

test("C3-4 — each edge carries the health colour of the entity it points at", async ({ page }) => {
  await boot(page);

  const strokes = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".react-flow__edge")].map((edge) => [
        edge.getAttribute("data-id") ?? "",
        getComputedStyle(edge.querySelector("path.react-flow__edge-path") as Element).stroke,
      ]),
    ),
  );

  // Degraded target, Unhealthy target, and the dashed Unknown state that is likeliest to fall
  // through a colour lookup and pick up the healthy stroke.
  expect(strokes.r1).toBe("rgb(194, 106, 0)");
  expect(strokes.r2).toBe("rgb(197, 15, 24)");
  expect(strokes.r3).toBe("rgb(138, 136, 134)");
  expect(new Set(Object.values(strokes)).size).toBeGreaterThan(1);
});

test("C3-5 — a card keeps every signal row and its existing selection behaviour", async ({ page }) => {
  await boot(page);
  const card = page.locator('.react-flow__node[data-id="svc-a"] .entity-node');

  const shape = await card.evaluate((element) => {
    const children = [...element.children];
    const header = element.querySelector(".entity-node__header") as HTMLElement;
    const rows = [...element.querySelectorAll(".entity-node__row")].map((row) => ({
      name: (row.querySelector(".entity-node__row-name") as HTMLElement).textContent,
      value: (row.querySelector(".entity-node__row-value") as HTMLElement).textContent,
      dots: row.querySelectorAll(".entity-node__dot").length,
    }));
    return {
      headerFirst: children.indexOf(header) === 0,
      headerBeforeRows: header.getBoundingClientRect().bottom <= (element.querySelector(".entity-node__row") as HTMLElement).getBoundingClientRect().top,
      rows,
    };
  });

  expect(shape.headerFirst).toBe(true);
  expect(shape.headerBeforeRows).toBe(true);
  expect(shape.rows).toEqual([
    { name: "CPU", value: "0.2", dots: 1 },
    { name: "Latency", value: "980", dots: 1 },
    { name: "Errors", value: "0", dots: 1 },
  ]);

  // A null value keeps its row and its status rather than dropping off the card.
  const nullRow = await page
    .locator('.react-flow__node[data-id="svc-d"] .entity-node__row')
    .evaluateAll((rows) =>
      rows.map((row) => ({
        name: (row.querySelector(".entity-node__row-name") as HTMLElement).textContent,
        value: (row.querySelector(".entity-node__row-value") as HTMLElement).textContent,
        dots: row.querySelectorAll(".entity-node__dot").length,
      })),
    );
  expect(nullRow).toEqual([{ name: "Heartbeat", value: "", dots: 1 }]);

  await card.click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();

  for (const key of ["Enter", " "]) {
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page.getByTestId("entity-panel")).toHaveCount(0);
    await card.focus();
    await page.keyboard.press(key);
    await expect(page.getByTestId("entity-panel")).toBeVisible();
  }
});

test("C3-6 — the collapse control is a header chevron with an accessible disclosure", async ({ page }) => {
  await boot(page);
  const toggle = page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]');

  // The full-width strip below the card is gone, not merely restyled.
  await expect(page.locator(".entity-node__collapse")).toHaveCount(0);

  const placement = await toggle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const header = (element.closest(".entity-node") as HTMLElement).querySelector(
      ".entity-node__header",
    ) as HTMLElement;
    const band = header.getBoundingClientRect();
    const card = (element.closest(".entity-node") as HTMLElement).getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      inHeaderBand: box.top >= band.top - 0.5 && box.bottom <= band.bottom + 0.5,
      insideCard: box.right <= card.right + 0.5 && box.bottom <= card.bottom + 0.5,
      cardWidth: card.width,
    };
  });

  expect(placement.width).toBeGreaterThanOrEqual(24);
  expect(placement.height).toBeGreaterThanOrEqual(24);
  expect(placement.width).toBeLessThan(placement.cardWidth / 2);
  expect(placement.inHeaderBand).toBe(true);
  expect(placement.insideCard).toBe(true);

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await toggle.getAttribute("aria-label")).toBe("Collapse Service A");

  // Keyboard operable, and its activation does not also open the detail panel.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("entity-panel")).toHaveCount(0);
  await expect(page.getByTestId("graph-announcement")).toContainText("3 nodes hidden");

  await page.keyboard.press(" ");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("entity-panel")).toHaveCount(0);

  // A card with nothing to collapse renders no control and reserves no gap for one.
  await expect(
    page.locator('.react-flow__node[data-id="svc-c"] [data-testid="collapse-toggle"]'),
  ).toHaveCount(0);
  const bare = await page
    .locator('.react-flow__node[data-id="svc-c"] .entity-node')
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      headerHeight: (element.querySelector(".entity-node__header") as HTMLElement).getBoundingClientRect().height,
      lastChildIsHeader: element.lastElementChild?.className === "entity-node__header",
    }));
  expect(bare.lastChildIsHeader).toBe(true);
  // The strip it replaced was at least 24px tall, so nothing of that size survives below the header.
  expect(bare.height - bare.headerHeight).toBeLessThan(24);
});

interface Placed {
  readonly id: string;
  readonly transform: string;
}

async function placements(page: Page): Promise<Placed[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")].map((node) => ({
      id: (node as HTMLElement).getAttribute("data-id") ?? "",
      transform: (node as HTMLElement).style.transform,
    })),
  );
}

function zoomOf(transform: string): string {
  return /scale\(([\d.]+)\)/.exec(transform)?.[1] ?? "";
}

test("C3-7 — collapsing anchors the toggled node and leaves unrelated nodes untouched", async ({ page }) => {
  await boot(page);
  const before = await placements(page);
  const zoomBefore = zoomOf(await viewportTransform(page));
  const toggle = page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]');

  await toggle.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.waitForTimeout(700);

  const collapsedNow = await placements(page);
  for (const node of collapsedNow) {
    expect([node.id, node.transform]).toEqual([
      node.id,
      (before.find((item) => item.id === node.id) as Placed).transform,
    ]);
  }
  expect(zoomOf(await viewportTransform(page))).toBe(zoomBefore);

  await toggle.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await page.waitForTimeout(700);

  const after = await placements(page);
  const moved = after.filter(
    (node) => (before.find((item) => item.id === node.id) as Placed).transform !== node.transform,
  );
  // The toggled node and every node that was never hidden stay exactly where they were, so the set
  // that moved is a strict subset of the graph.
  expect(moved.map((node) => node.id)).toEqual([]);
  expect(moved.length).toBeLessThan(after.length);
  expect(zoomOf(await viewportTransform(page))).toBe(zoomBefore);
});

for (const layoutId of LAYOUT_IDS) {
  test(`C3-7c — ${layoutId} restores every descendant to its own transform on expand`, async ({ page }) => {
    await boot(page);
    await chooseLayout(page, layoutId);
    await page.waitForTimeout(700);

    const before = await placements(page);
    const zoomBefore = zoomOf(await viewportTransform(page));
    const toggle = page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]');

    await toggle.click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.waitForTimeout(700);

    const collapsed = await placements(page);
    const movedWhileCollapsing = collapsed.filter(
      (node) => (before.find((item) => item.id === node.id) as Placed).transform !== node.transform,
    );
    expect([layoutId, ...movedWhileCollapsing.map((node) => node.id)]).toEqual([layoutId]);

    await toggle.click();
    await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
    await page.waitForTimeout(700);

    // Every returning descendant lands on the exact transform it had before it was hidden, and
    // nothing that stayed on screen is nudged to make room for it.
    const after = await placements(page);
    const moved = after.filter(
      (node) => (before.find((item) => item.id === node.id) as Placed).transform !== node.transform,
    );
    expect([layoutId, ...moved.map((node) => `${node.id} ${node.transform}`)]).toEqual([layoutId]);
    expect(after).toHaveLength(before.length);
    expect(zoomOf(await viewportTransform(page))).toBe(zoomBefore);
  });
}

test("C3-7d — a descendant returns to the position it left even when the graph changed meanwhile", async ({
  page,
}) => {
  await boot(page);
  const before = await placements(page);
  const outer = page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]');
  const inner = page.locator('.react-flow__node[data-id="svc-b"] [data-testid="collapse-toggle"]');

  // Collapsing svc-b cuts r2 without hiding anything, so the graph svc-a expands back into is not
  // the graph it collapsed from, and a fresh engine run would seat the descendants somewhere else.
  await inner.click();
  await outer.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.waitForTimeout(700);

  await outer.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await page.waitForTimeout(700);

  const after = await placements(page);
  const moved = after.filter(
    (node) => (before.find((item) => item.id === node.id) as Placed).transform !== node.transform,
  );
  expect(moved.map((node) => `${node.id} ${node.transform}`)).toEqual([]);
});

test("C3-7b — a collapsed parent keeps a shared child that another expanded parent still reaches", async ({
  page,
}) => {
  await boot(page);
  const toggle = page.locator('.react-flow__node[data-id="svc-b"] [data-testid="collapse-toggle"]');

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // svc-c survives through svc-a -> svc-d -> svc-c, that path keeps its edge, and only the
  // collapsed parent's own branch edge goes.
  await expect(page.locator('.react-flow__node[data-id="svc-c"]')).toHaveCount(1);
  const drawn = await page
    .locator(".react-flow__edge")
    .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("data-id")).sort());
  expect(drawn).toEqual(["r1", "r3", "r4"]);

  // Nothing is actually hidden, so no count is claimed.
  await expect(
    page.locator('.react-flow__node[data-id="svc-b"] [data-testid="hidden-summary"]'),
  ).toHaveCount(0);
});

test("C3-8 — a collapsed card keeps its signals and tallies exactly what it hides", async ({ page }) => {
  await boot(page);
  await page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]').click();

  const card = page.locator('.react-flow__node[data-id="svc-a"] .entity-node');
  const rows = await card.locator(".entity-node__row").evaluateAll((items) =>
    items.map((row) => ({
      name: (row.querySelector(".entity-node__row-name") as HTMLElement).textContent,
      value: (row.querySelector(".entity-node__row-value") as HTMLElement).textContent,
      dots: row.querySelectorAll(".entity-node__dot").length,
    })),
  );
  expect(rows).toEqual([
    { name: "CPU", value: "0.2", dots: 1 },
    { name: "Latency", value: "980", dots: 1 },
    { name: "Errors", value: "0", dots: 1 },
  ]);

  const summary = card.getByTestId("hidden-summary");
  await expect(summary).toBeVisible();
  await expect(card.getByTestId("hidden-count")).toHaveText("3");

  const chips = await summary.locator(".entity-node__hidden-chip").evaluateAll((items) =>
    items.map((chip) => [
      chip.getAttribute("data-state"),
      (chip.querySelector(".entity-node__hidden-chip-count") as HTMLElement).textContent,
    ]),
  );
  // svc-b, svc-c and svc-d are hidden in three distinct states, and the totals sum to the count.
  expect(chips).toEqual([
    ["Unhealthy", "1"],
    ["Degraded", "1"],
    ["Unknown", "1"],
  ]);
  expect(chips.reduce((sum, chip) => sum + Number(chip[1]), 0)).toBe(3);
  // A state with nothing hidden gets no chip at all.
  expect(chips.map((chip) => chip[0])).not.toContain("Healthy");

  // The summary states counts by status and claims no cause for them.
  const spoken = (await summary.getAttribute("aria-label")) ?? "";
  expect(spoken).toBe("3 hidden: 1 Unhealthy, 1 Degraded, 1 Unknown");
  expect(spoken.toLowerCase()).not.toMatch(/cause|because|due to|reason/);
});

interface CardGeometry {
  readonly id: string;
  readonly transform: string;
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly rows: number;
}

/** Layout-space card geometry, read from offset sizes so the viewport scale cannot skew it. */
async function cardGeometry(page: Page): Promise<CardGeometry[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")].map((node) => {
      const element = node as HTMLElement;
      const card = element.querySelector(".entity-node") as HTMLElement;
      const header = card.querySelector(".entity-node__header") as HTMLElement;
      return {
        id: element.getAttribute("data-id") ?? "",
        transform: element.style.transform,
        width: card.offsetWidth,
        height: card.offsetHeight,
        headerHeight: header.offsetHeight,
        rows: card.querySelectorAll(".entity-node__row").length,
      };
    }),
  );
}

function edgePaths(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge-path")].map(
      (path) => path.getAttribute("d") ?? "",
    ),
  );
}

/** The zooms the fresh cloud inspection sampled, plus the default fit measured at run time. */
const REQUIRED_ZOOMS: readonly number[] = [0.5, 0.88, 0.97, 1, 1.25];

function currentZoom(page: Page): Promise<number> {
  return viewportTransform(page).then((transform) => Number(zoomOf(transform)));
}

/**
 * Ordinary wheel input walked until the viewport reaches a requested zoom. React Flow reads the
 * same wheel events a user produces, so nothing here writes the transform directly; a target below
 * the engine's own floor simply stops there.
 */
async function wheelToZoom(page: Page, target: number): Promise<number> {
  const pane = (await page.locator(".react-flow__pane").boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  let zoom = await currentZoom(page);
  for (let step = 0; step < 80 && Math.abs(zoom - target) > 0.004; step += 1) {
    const wanted = -500 * Math.log2(target / zoom);
    await page.mouse.wheel(0, Math.max(-160, Math.min(160, wanted)));
    await page.waitForTimeout(60);
    const next = await currentZoom(page);
    if (next === zoom) break;
    zoom = next;
  }
  await page.waitForTimeout(200);
  return currentZoom(page);
}

interface Separation {
  readonly intersects: boolean;
  readonly toolbarBottom: number;
  readonly canvasTop: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly toolbarUsable: boolean;
}

/** The toolbar occupies its own row: a control surface that overlays the canvas can swallow a click. */
async function toolbarSeparation(page: Page): Promise<Separation> {
  return page.evaluate(() => {
    const toolbar = (document.querySelector(".graph-toolbar") as HTMLElement).getBoundingClientRect();
    const canvas = (document.querySelector(".react-flow") as HTMLElement).getBoundingClientRect();
    return {
      intersects:
        toolbar.left < canvas.right &&
        toolbar.right > canvas.left &&
        toolbar.top < canvas.bottom &&
        toolbar.bottom > canvas.top,
      toolbarBottom: toolbar.bottom,
      canvasTop: canvas.top,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      toolbarUsable: toolbar.width > 0 && toolbar.height > 0,
    };
  });
}

interface DisclosureProbe {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly insideCard: boolean;
  readonly insideHeader: boolean;
  readonly inHeaderDom: boolean;
  readonly fullyVisible: boolean;
  readonly hits: number;
  readonly samples: number;
  readonly missKinds: readonly string[];
  readonly overlapsToolbar: boolean;
  readonly overlapsOtherCards: number;
  readonly overlapsOtherToggles: number;
  readonly aria: string | null;
  readonly label: string | null;
}

/**
 * Every rendered disclosure, measured the way a pointer meets it: the transformed box from
 * `getBoundingClientRect`, full containment inside the painted card and its header band, and
 * `document.elementFromPoint` over the required 24 by 24 screen square. The authored CSS box reads
 * 26 at every zoom and DOM ancestry reads true while the box paints outside its card, so neither
 * stands in for these.
 */
async function disclosureProbes(page: Page): Promise<DisclosureProbe[]> {
  return page.evaluate(() => {
    const tolerance = 0.5;
    const view = (document.querySelector(".react-flow") as HTMLElement).getBoundingClientRect();
    const toolbar = (document.querySelector(".graph-toolbar") as HTMLElement).getBoundingClientRect();
    const cards = [...document.querySelectorAll(".react-flow__node .entity-node")].map(
      (card) => [card, card.getBoundingClientRect()] as const,
    );
    const toggles = [...document.querySelectorAll('[data-testid="collapse-toggle"]')];
    const hitsRect = (box: DOMRect, other: DOMRect): boolean =>
      box.left < other.right - 0.01 &&
      box.right > other.left + 0.01 &&
      box.top < other.bottom - 0.01 &&
      box.bottom > other.top + 0.01;

    return toggles.map((element) => {
      const box = element.getBoundingClientRect();
      const cardElement = element.closest(".entity-node") as HTMLElement;
      const card = cardElement.getBoundingClientRect();
      const header = (
        cardElement.querySelector(".entity-node__header") as HTMLElement
      ).getBoundingClientRect();
      const within = (outer: DOMRect): boolean =>
        box.left >= outer.left - tolerance &&
        box.right <= outer.right + tolerance &&
        box.top >= outer.top - tolerance &&
        box.bottom <= outer.bottom + tolerance;

      const reach = 11;
      const offsets: readonly (readonly [number, number])[] = [
        [0, 0],
        [reach, 0],
        [-reach, 0],
        [0, reach],
        [0, -reach],
        [reach, reach],
        [reach, -reach],
        [-reach, reach],
        [-reach, -reach],
      ];
      const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const found = offsets.map(([dx, dy]) =>
        document.elementFromPoint(centre.x + dx, centre.y + dy),
      );
      const missed = found.filter((hit) => hit !== element);

      return {
        id: cardElement.getAttribute("data-entity") ?? "",
        width: box.width,
        height: box.height,
        insideCard: within(card),
        insideHeader: within(header),
        inHeaderDom: element.closest(".entity-node__header") !== null,
        fullyVisible:
          card.left >= view.left - tolerance &&
          card.right <= view.right + tolerance &&
          card.top >= view.top - tolerance &&
          card.bottom <= view.bottom + tolerance,
        hits: found.length - missed.length,
        samples: found.length,
        missKinds: [
          ...new Set(
            missed.map((hit) =>
              hit === null
                ? "null"
                : `${hit.tagName}.${typeof hit.className === "string" ? hit.className.split(" ")[0] : ""}`,
            ),
          ),
        ],
        overlapsToolbar: hitsRect(box, toolbar),
        overlapsOtherCards: cards.filter(
          ([other, rect]) => other !== cardElement && hitsRect(box, rect),
        ).length,
        overlapsOtherToggles: toggles.filter(
          (other) => other !== element && hitsRect(box, other.getBoundingClientRect()),
        ).length,
        aria: element.getAttribute("aria-expanded"),
        label: element.getAttribute("aria-label"),
      };
    });
  });
}

interface ZoomReport {
  readonly zoom: number;
  readonly toggles: number;
  readonly smallestSide: number;
  readonly visible: number;
  readonly outsideCard: readonly string[];
  readonly outsideHeader: readonly string[];
  readonly notInHeaderDom: readonly string[];
  readonly intercepted: readonly string[];
  readonly underToolbar: readonly string[];
  readonly overCards: number;
  readonly overToggles: number;
  readonly ariaMissing: readonly string[];
}

async function zoomReport(page: Page, zoom: number): Promise<ZoomReport> {
  const probes = await disclosureProbes(page);
  const visible = probes.filter((probe) => probe.fullyVisible);
  return {
    zoom: Math.round(zoom * 1000) / 1000,
    toggles: probes.length,
    smallestSide: Math.min(...probes.map((probe) => Math.min(probe.width, probe.height))),
    visible: visible.length,
    outsideCard: probes.filter((probe) => !probe.insideCard).map((probe) => probe.id),
    outsideHeader: probes.filter((probe) => !probe.insideHeader).map((probe) => probe.id),
    notInHeaderDom: probes.filter((probe) => !probe.inHeaderDom).map((probe) => probe.id),
    intercepted: visible
      .filter((probe) => probe.hits < probe.samples)
      .map((probe) => `${probe.id}:${probe.hits}/${probe.samples}:${probe.missKinds.join("|")}`),
    underToolbar: visible.filter((probe) => probe.overlapsToolbar).map((probe) => probe.id),
    overCards: probes.reduce((total, probe) => total + probe.overlapsOtherCards, 0),
    overToggles: probes.reduce((total, probe) => total + probe.overlapsOtherToggles, 0),
    ariaMissing: probes
      .filter((probe) => probe.aria === null || (probe.label ?? "").length === 0)
      .map((probe) => probe.id),
  };
}

function expectSoundAt(report: ZoomReport, where: string): void {
  expect(report.outsideCard, `${where} outside card`).toEqual([]);
  expect(report.outsideHeader, `${where} outside header`).toEqual([]);
  expect(report.notInHeaderDom, `${where} outside header DOM`).toEqual([]);
  expect(report.intercepted, `${where} intercepted`).toEqual([]);
  expect(report.underToolbar, `${where} under toolbar`).toEqual([]);
  expect(report.ariaMissing, `${where} missing disclosure semantics`).toEqual([]);
  expect(report.overCards, `${where} overlapping other cards`).toBe(0);
  expect(report.overToggles, `${where} overlapping other toggles`).toBe(0);
  expect(report.smallestSide, `${where} smallest rendered side`).toBeGreaterThanOrEqual(24);
  expect(report.visible, `${where} fully visible toggles`).toBeGreaterThan(0);
}

test("C4-2 — the header disclosure keeps a contained 24px pointer target across ordinary wheel zoom", async ({
  page,
}) => {
  await boot(page);
  const geometryAtFit = await cardGeometry(page);
  const pathsAtFit = await edgePaths(page);
  expect(pathsAtFit).toHaveLength(4);

  const fitZoom = await currentZoom(page);
  for (const target of [fitZoom, ...REQUIRED_ZOOMS]) {
    const zoom = await wheelToZoom(page, target);
    expect(Math.abs(zoom - target), `wheel reached ${zoom} for ${target}`).toBeLessThanOrEqual(0.01);
    expectSoundAt(await zoomReport(page, zoom), `zoom ${target}`);
  }

  // The toolbar is a row of its own, so no zoom can park a card under it.
  const separation = await toolbarSeparation(page);
  expect(separation.intersects).toBe(false);
  expect(separation.toolbarUsable).toBe(true);
  expect(separation.toolbarBottom).toBeLessThanOrEqual(separation.canvasTop + 0.5);
  expect(separation.canvasHeight).toBeGreaterThan(400);

  // The retired full-width strip stays gone and the card layout the fix must not disturb is
  // byte-identical after all that zooming.
  await expect(page.locator(".entity-node__collapse")).toHaveCount(0);
  expect(await cardGeometry(page)).toEqual(geometryAtFit);
  expect(await edgePaths(page)).toEqual(pathsAtFit);

  const toggle = page.locator('.react-flow__node[data-id="svc-a"] [data-testid="collapse-toggle"]');
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await toggle.getAttribute("aria-label")).toBe("Collapse Service A");

  // Pointer activation at the perimeter of the required square, and the card's own selection
  // interaction still answers separately.
  await wheelToZoom(page, 0.5);
  const box = (await toggle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width / 2 + 11, box.y + box.height / 2 + 11);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("entity-panel")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await page.locator('.react-flow__node[data-id="svc-a"] .entity-node__name').click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();
});

test("C4-2b — a 22-node graph keeps every visible disclosure clickable from default fit through ordinary wheel zoom", async ({
  page,
}) => {
  // The deployed model's shape: 22 cards and 24 relationships, fitted below zoom 1 on first paint.
  await installStubs(page, { healthModelFails: false, model: denseModel(DENSE_SEED, 22, 24) });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__node")).toHaveCount(22);
  await expect(page.locator(".react-flow__edge")).toHaveCount(24);
  await page.waitForTimeout(600);

  const fitZoom = await currentZoom(page);
  expect(fitZoom).toBeLessThan(1);
  for (const target of [fitZoom, ...REQUIRED_ZOOMS]) {
    const zoom = await wheelToZoom(page, target);
    expectSoundAt(await zoomReport(page, zoom), `22-node zoom ${target}`);
  }

  const separation = await toolbarSeparation(page);
  expect(separation.intersects).toBe(false);
  expect(separation.canvasHeight).toBeGreaterThan(400);

  // A plain centre click at the zoom the overlay toolbar used to swallow entirely.
  const zoom = await wheelToZoom(page, 0.97);
  expect(Math.abs(zoom - 0.97)).toBeLessThanOrEqual(0.01);
  const probes = await disclosureProbes(page);
  const target = probes.find((probe) => probe.fullyVisible && probe.id === "n0") ??
    (probes.find((probe) => probe.fullyVisible) as DisclosureProbe);
  const toggle = page.locator(
    `.react-flow__node[data-id="${target.id}"] [data-testid="collapse-toggle"]`,
  );
  const box = (await toggle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("entity-panel")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).not.toHaveCount(22);

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".react-flow__node")).toHaveCount(22);
});

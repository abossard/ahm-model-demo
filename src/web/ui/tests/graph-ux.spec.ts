import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { healthModel, installStubs } from "./fixture";

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

test("AC23 — the built app loads with no Content Security Policy violation", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (/content security policy/i.test(error.message)) violations.push(error.message);
  });

  await boot(page);
  await chooseLayout(page, "elk-layered");
  await chooseLayout(page, "d3-force");

  expect(violations).toEqual([]);
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

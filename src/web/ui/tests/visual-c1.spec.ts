import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LAYOUT_CHOICES } from "../src/model/layout";
import type { HealthModel } from "../src/model/types";
import { healthModel, installStubs } from "./fixture";
import { DENSE_SEED, denseModel, realAnbomovModel } from "./denseModel";

const evidenceDir = resolve("../../../.playwright-mcp/visual-c1");
const longModel: HealthModel = {
  ...healthModel,
  entities: healthModel.entities.map((entity) => entity.name !== "svc-f" ? entity : {
    ...entity,
    displayName: "UnbrokenEntityName".repeat(12),
    signals: entity.signals.map((signal) => ({
      ...signal,
      displayName: "Full accessible signal name ".repeat(6),
      value: "LongUnbrokenMetricValue".repeat(10),
    })).concat(entity.signals.map((signal) => ({
      ...signal,
      name: "numeric",
      value: 1.2345678901234567e+200,
    }))),
  }),
};
const summaryModel: HealthModel = {
  ...healthModel,
  entities: [
    healthModel.entities[0],
    ...Array.from({ length: 50 }, (_, index) => ({
      ...healthModel.entities[index % healthModel.entities.length],
      name: `child-${index}`,
      displayName: `Child ${index}`,
    })),
  ],
  relationships: Array.from({ length: 50 }, (_, index) => ({
    name: `branch-${index}`, displayName: "", parentEntityName: "svc-a", childEntityName: `child-${index}`,
  })),
};

async function boot(page: Page, model = healthModel): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(model.entities.length);
}

async function settle(page: Page): Promise<void> {
  let previous = "";
  let quiet = 0;
  await expect.poll(async () => {
    const current = await page.locator(".react-flow__node").evaluateAll((nodes) =>
      JSON.stringify(nodes.map((node) => [
        node.getAttribute("data-id"), (node as HTMLElement).style.transform,
        (node as HTMLElement).offsetWidth, (node as HTMLElement).offsetHeight,
      ])),
    );
    quiet = current === previous ? quiet + 1 : 0;
    previous = current;
    return quiet;
  }, { timeout: 15_000, intervals: [150] }).toBeGreaterThanOrEqual(3);
}

async function cardReport(page: Page) {
  return page.evaluate(() => {
    const zoom = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const errors: string[] = [];
    const boxes: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
    const contains = (outer: DOMRect, inner: DOMRect) =>
      inner.left >= outer.left - zoom && inner.right <= outer.right + zoom &&
      inner.top >= outer.top - zoom && inner.bottom <= outer.bottom + zoom;
    for (const wrapper of document.querySelectorAll<HTMLElement>(".react-flow__node")) {
      const card = wrapper.querySelector<HTMLElement>(".entity-node")!;
      const rect = card.getBoundingClientRect();
      const id = wrapper.dataset.id!;
      boxes.push({ id, x: rect.x / zoom, y: rect.y / zoom, width: rect.width / zoom, height: rect.height / zoom });
      if (Math.abs(wrapper.offsetWidth - rect.width / zoom) > 1 ||
          Math.abs(wrapper.offsetHeight - rect.height / zoom) > 1) errors.push(`${id}: node/body dimensions differ`);
      if (card.dataset.role === "dot") {
        if (Math.abs(rect.width / zoom - 12) > 1e-3 || Math.abs(rect.height / zoom - 12) > 1e-3) errors.push(`${id}: dot not 12x12`);
        continue;
      }
      if (card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1) errors.push(`${id}: card scroll overflow`);
      for (const region of card.querySelectorAll<HTMLElement>(".entity-node__header, .entity-node__row, .entity-node__hidden")) {
        if (!contains(rect, region.getBoundingClientRect())) errors.push(`${id}: ${region.className} outside card`);
        if (region.scrollWidth > region.clientWidth + 1 || region.scrollHeight > region.clientHeight + 1) errors.push(`${id}: ${region.className} scroll overflow`);
      }
      for (const text of card.querySelectorAll<HTMLElement>(".entity-node__name, .entity-node__row-value, .entity-node__pill-word, .entity-node__hidden-count, .entity-node__hidden-word, .entity-node__hidden-chip-count")) {
        const range = document.createRange();
        range.selectNodeContents(text);
        const owner = text.closest(".entity-node__header, .entity-node__row, .entity-node__hidden")!;
        for (const fragment of range.getClientRects()) {
          if (!contains(text.getBoundingClientRect(), fragment) || !contains(owner.getBoundingClientRect(), fragment) || !contains(rect, fragment)) {
            errors.push(`${id}: ${text.className} text escapes bounds`);
          }
          for (const sibling of owner.children) {
            if (sibling === text || sibling.contains(text)) continue;
            const other = sibling.getBoundingClientRect();
            if (Math.min(fragment.right, other.right) - Math.max(fragment.left, other.left) > zoom &&
                Math.min(fragment.bottom, other.bottom) - Math.max(fragment.top, other.top) > zoom) errors.push(`${id}: ${text.className} intersects sibling`);
          }
        }
      }
      for (const name of card.querySelectorAll<HTMLElement>(".entity-node__row-name")) {
        if (name.scrollWidth > name.clientWidth + 1 && name.title !== name.textContent) errors.push(`${id}: ellipsized signal name inaccessible`);
      }
      const handles = wrapper.querySelectorAll<HTMLElement>(".react-flow__handle");
      if (handles.length !== 2) errors.push(`${id}: missing handles`);
      for (const handle of handles) {
        const handleRect = handle.getBoundingClientRect();
        const edgeY = handle.classList.contains("source") ? rect.bottom : rect.top;
        if (Math.abs((handleRect.y + handleRect.height / 2 - edgeY) / zoom) > 1) errors.push(`${id}: handle off painted boundary`);
      }
    }
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!, b = boxes[j]!;
        if (Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
            Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)) overlaps.push(`${a.id}/${b.id}`);
      }
    }
    if (boxes.some((box) => !Object.values(box).filter((value) => typeof value === "number").every(Number.isFinite))) errors.push("nonfinite geometry");
    return { errors: [...new Set(errors)], overlaps, boxes, zoom };
  });
}

async function capture(page: Page, name: string, focusEntity?: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  if (focusEntity) {
    const node = page.locator(`.react-flow__node[data-id="${focusEntity}"]`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = await node.boundingBox();
      const canvas = await page.locator(".react-flow").boundingBox();
      if (!box || !canvas) throw new Error(`Cannot frame ${focusEntity} for screenshot`);
      const dx = canvas.x + canvas.width / 2 - box.x - box.width / 2;
      const dy = canvas.y + canvas.height / 2 - box.y - box.height / 2;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) break;
      const start = await page.evaluate((canvas) => [
        { x: canvas.x + 12, y: canvas.y + 12 },
        { x: canvas.x + canvas.width - 12, y: canvas.y + canvas.height - 30 },
        { x: canvas.x + canvas.width / 2, y: canvas.y + 12 },
      ].find((point) => document.elementFromPoint(point.x, point.y)?.classList.contains("react-flow__pane")), canvas);
      if (!start) throw new Error("No unobstructed background for screenshot panning");
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 15 });
      await page.mouse.up();
      await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ));
    }
    const visible = await node.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const canvas = element.closest(".react-flow")!.getBoundingClientRect();
      return box.left >= canvas.left && box.right <= canvas.right &&
        box.top >= canvas.top && box.bottom <= canvas.bottom;
    });
    expect(visible, `${focusEntity} framed for screenshot`).toBe(true);
  }
  const report = await cardReport(page);
  await writeFile(resolve(evidenceDir, `${name}.json`), JSON.stringify({
    ...report, viewport: page.viewportSize(),
    bundle: await page.locator('script[type="module"]').getAttribute("src"),
    theme: await page.locator("html").getAttribute("data-theme"),
  }, null, 2));
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), fullPage: true });
}

async function expectContained(page: Page, state: string): Promise<void> {
  await settle(page);
  const report = await cardReport(page);
  expect(report.errors, `${state}: text and node containment`).toEqual([]);
  expect(report.overlaps, `${state}: card packing`).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  for (const [name, model] of [["existing-svc-f", healthModel], ["long-content", longModel]] as const) {
    test(`C1 contained ${name} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await boot(page, model);
      await settle(page);
      const report = await cardReport(page);
      console.log(`${name}/${theme}: ${JSON.stringify(report)}`);
      expect(report.errors).toEqual([]);
      expect(report.overlaps).toEqual([]);
      await capture(page, `${name}-desktop-${theme}`);
    });
  }

  test(`C1 desktop states ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    for (const layout of ["dagre-tb", "d3-force-adaptive"]) {
      await page.getByTestId("layout-picker").selectOption(layout);
      await expectContained(page, `${layout}/full`);
      await capture(page, `${layout}-full-desktop-${theme}`);
      await page.getByTestId("health-filter-toggle").click();
      const popup = page.getByTestId("health-filter-popup");
      await expect(popup).toBeVisible();
      const controls = await popup.locator("input").evaluateAll((inputs) => inputs.map((input) => {
        const rect = input.getBoundingClientRect();
        return {
          label: input.closest("label")?.textContent?.trim(),
          reachable: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input,
        };
      }));
      expect(controls.filter((control) => !control.reachable)).toEqual([]);
      await page.getByRole("radio", { name: "Hide with edges", exact: true }).check();
      await page.getByRole("checkbox", { name: "Degraded", exact: true }).uncheck();
      await expect(page.locator('.react-flow__node[data-id="svc-b"]')).toHaveCount(0);
      await expectContained(page, `${layout}/hide`);
      await capture(page, `${layout}-hide-desktop-${theme}`, layout === "d3-force-adaptive" ? "svc-a" : undefined);
      await page.getByRole("radio", { name: "Gray dot", exact: true }).check();
      await expect(page.locator('.react-flow__node[data-id="svc-b"] [data-role="dot"]')).toBeVisible();
      await expectContained(page, `${layout}/dot`);
      await capture(page, `${layout}-dot-desktop-${theme}`, layout === "d3-force-adaptive" ? "svc-a" : undefined);
      await page.getByRole("checkbox", { name: "Degraded", exact: true }).check();
      await page.keyboard.press("Escape");
      await expectContained(page, `${layout}/restored`);
      await page.getByRole("button", { name: "Collapse Service A", exact: true }).click();
      await expect(page.getByTestId("hidden-summary")).toBeVisible();
      await expectContained(page, `${layout}/collapsed`);
      await capture(page, `${layout}-collapsed-desktop-${theme}`, layout === "d3-force-adaptive" ? "svc-a" : undefined);
      await page.getByRole("button", { name: /^Expand Service A,/ }).click();
      await expectContained(page, `${layout}/expanded`);
    }
    const chrome = await page.evaluate(() => {
      const errors: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(".status-bar, .graph-toolbar, .journey")) {
        if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
          errors.push(`${element.className}: overflow`);
        }
        const bounds = element.getBoundingClientRect();
        for (const child of element.querySelectorAll<HTMLElement>("button, input, select, p")) {
          const rect = child.getBoundingClientRect();
          if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ||
              rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
            errors.push(`${element.className}: ${child.tagName} outside region`);
          }
        }
      }
      return errors;
    });
    expect(chrome).toEqual([]);
  });

  test(`C1 collapsed summary containment ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, summaryModel);
    await page.getByRole("button", { name: "Collapse Service A", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await expect(page.getByTestId("hidden-count")).toHaveText("50");
    await expectContained(page, "fifty-descendant summary");
    await capture(page, `summary-desktop-${theme}`);
  });
}

const fixtureShapes = [
  ["six", healthModel],
  ["dense", denseModel(DENSE_SEED)],
  ["historical-22", realAnbomovModel()],
] as const;

for (const [shape, original] of fixtureShapes) {
  const model: HealthModel = {
    ...original,
    entities: original.entities.map((entity, index) => ({
      ...entity,
      healthState: index % 3 === 1 ? "Degraded" : entity.healthState,
    })),
  };
  for (const choice of LAYOUT_CHOICES) {
    test(`C1 ${shape} packing and containment ${choice.id}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await boot(page, model);
      await page.getByTestId("layout-picker").selectOption(choice.id);
      await expectContained(page, `${shape}/${choice.id}/full`);
      await page.getByTestId("health-filter-toggle").click();
      await page.getByRole("radio", { name: "Gray dot", exact: true }).check();
      await page.getByRole("checkbox", { name: "Degraded", exact: true }).uncheck();
      await page.keyboard.press("Escape");
      await expectContained(page, `${shape}/${choice.id}/dot`);
      await page.getByTestId("health-filter-toggle").click();
      await page.getByRole("checkbox", { name: "Degraded", exact: true }).check();
      await page.keyboard.press("Escape");
      await expectContained(page, `${shape}/${choice.id}/restored`);
      const toggle = page.getByTestId("collapse-toggle").first();
      if (await toggle.count()) {
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expectContained(page, `${shape}/${choice.id}/collapsed`);
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expectContained(page, `${shape}/${choice.id}/expanded`);
      }
    });
  }
}

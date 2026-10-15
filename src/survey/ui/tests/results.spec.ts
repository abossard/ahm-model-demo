import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type Fixture = { statement: string; values: number[] };

async function showResults(page: Page, fixtures: Fixture[]) {
  const body = {
    code: "ABCDEF", version: 1, voting_started: true, scale: { min: 0, max: 100, step: 1 },
    questions: fixtures.map((fixture, index) => {
      const distribution = Array<number>(101).fill(0);
      for (const value of fixture.values) distribution[value] = (distribution[value] ?? 0) + 1;
      const count = fixture.values.length;
      return { id: `00000000-0000-4000-8000-00000000000${index}`, statement: fixture.statement, count,
        mean: count === 0 ? null : fixture.values.reduce((sum, value) => sum + value, 0) / count, distribution };
    }),
  };
  await page.route("**/api/surveys/ABCDEF/results", route => route.fulfill({ json: body }));
  await page.goto("/results/ABCDEF");
}

const repeat = (value: number, times: number) => Array<number>(times).fill(value);

const histogramCases = [
  { name: "centered", values: [...repeat(50, 11)], mean: "50.0", bins: [0, 0, 0, 0, 0, 11, 0, 0, 0, 0] },
  { name: "polarized with the same mean", values: [...repeat(0, 5), 50, ...repeat(100, 5)], mean: "50.0",
    bins: [5, 0, 0, 0, 0, 1, 0, 0, 0, 5] },
  { name: "extremes and 100", values: [...repeat(0, 6), 99, 99, 100, 100, 100], mean: "45.3",
    bins: [6, 0, 0, 0, 0, 0, 0, 0, 0, 5] },
  { name: "bin boundaries", values: [5, 5, 5, 9, 10, 19, 20, 89, 90, 99, 100], mean: "41.0",
    bins: [4, 2, 1, 0, 0, 0, 0, 0, 1, 3] },
  { name: "sixty sits in bin 60-69", values: repeat(60, 11), mean: "60.0", bins: [0, 0, 0, 0, 0, 0, 11, 0, 0, 0] },
];
const ranges = ["0-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80-89", "90-100"];

for (const { name, values, mean, bins } of histogramCases) {
  test(`more than ten answers show a ten-bin histogram: ${name}`, async ({ page }) => {
    await showResults(page, [{ statement: "Histogram statement", values }]);
    const card = page.locator("section.card").first();
    await expect(card.getByText("11 answered", { exact: true })).toBeVisible();
    await expect(card.getByText(`Mean agreement: ${mean} / 100`)).toBeVisible();
    const rows = await card.getByRole("table", { name: "Answer counts by score range for Histogram statement" })
      .locator("tbody tr").evaluateAll(trs => trs.map(tr => Array.from(tr.cells, cell => cell.textContent)));
    expect(rows).toEqual(ranges.map((range, index) => [range, String(bins[index])]));
    const heights = await card.locator("rect[data-range]").evaluateAll(nodes =>
      nodes.map(node => [node.getAttribute("data-range"), node.getBoundingClientRect().height] as const));
    const tallest = Math.max(...bins);
    const unit = Math.max(...heights.map(([, height]) => height)) / tallest;
    expect(heights.map(([range]) => range)).toEqual(ranges);
    heights.forEach(([, height], index) => expect(height).toBeCloseTo((bins[index] ?? 0) * unit, 1));
    const svg = card.locator("svg.histogram");
    for (const label of ["0", "50", "100"]) await expect(svg.locator(`text.axis`, { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
    await expect(card.getByText(/^Frequency scale: 0 to \d+ answers per range\./)).toBeVisible();
    const marker = await svg.locator("line[data-mean]").evaluate(node => {
      const axis = node.ownerSVGElement?.querySelector("line[data-axis]");
      if (!axis) throw new Error("Missing axis");
      const a = axis.getBoundingClientRect(); const m = node.getBoundingClientRect();
      return (m.left + m.width / 2 - a.left) / a.width;
    });
    expect(marker).toBeCloseTo(Number(mean) / 100, 2);
  });
}

const dotCases = [
  { name: "one saved 50", values: [50], scores: "Scores: 50", mean: "50.0" },
  { name: "ten identical answers", values: repeat(50, 10), scores: "Scores: 50 ×10", mean: "50.0" },
  { name: "endpoints", values: [0, 0, 100, 100, 100], scores: "Scores: 0 ×2, 100 ×3", mean: "60.0" },
  { name: "adjacent scores 45 to 54", values: [45, 46, 47, 48, 49, 50, 51, 52, 53, 54],
    scores: "Scores: 45, 46, 47, 48, 49, 50, 51, 52, 53, 54", mean: "49.5" },
];
const viewports = [{ name: "desktop", width: 1280 }, { name: "narrow", width: 320 }];

for (const { name, values, scores, mean } of dotCases) {
  for (const viewport of viewports) {
    test(`one to ten answers show one exact dot per answer: ${name} on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: 800 });
      await showResults(page, [{ statement: "Dot statement", values }]);
      const card = page.locator("section.card").first();
      await expect(card.getByText(`${values.length} answered`, { exact: true })).toBeVisible();
      await expect(card.getByText(`Mean agreement: ${mean} / 100`)).toBeVisible();
      await expect(card.getByText(scores, { exact: true })).toBeVisible();
      await expect(card.locator("svg.histogram")).toHaveCount(0);
      const geometry = await card.locator("svg.dots").evaluate(svg => {
        const box = svg.getBoundingClientRect();
        const axis = svg.querySelector("line[data-axis]")?.getBoundingClientRect();
        if (!axis) throw new Error("Missing axis");
        const dots = Array.from(svg.querySelectorAll("circle[data-value]"), dot => {
          const r = dot.getBoundingClientRect();
          return { value: Number(dot.getAttribute("data-value")), x: r.left + r.width / 2, y: r.top + r.height / 2,
            radius: r.width / 2, inside: r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom };
        });
        return { dots, axisLeft: axis.left, axisWidth: axis.width };
      });
      expect(geometry.dots.map(dot => dot.value).sort((a, b) => a - b)).toEqual([...values].sort((a, b) => a - b));
      for (const dot of geometry.dots) {
        expect(dot.inside).toBe(true);
        expect((dot.x - geometry.axisLeft) / geometry.axisWidth).toBeCloseTo(dot.value / 100, 2);
      }
      for (const [i, a] of geometry.dots.entries()) for (const b of geometry.dots.slice(i + 1))
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius * 2 - 0.01);
    });
  }
}

test("ten answers draw dots and the eleventh switches to the histogram", async ({ page }) => {
  await showResults(page, [{ statement: "Ten", values: repeat(30, 10) }, { statement: "Eleven", values: repeat(30, 11) }]);
  const [ten, eleven] = await page.locator("section.card").all();
  await expect(ten?.locator("circle[data-value]")).toHaveCount(10);
  await expect(ten?.locator("svg.histogram")).toHaveCount(0);
  await expect(eleven?.locator("circle[data-value]")).toHaveCount(0);
  await expect(eleven?.locator("svg.histogram")).toHaveCount(1);
});

const bandLabels = ["0-19", "20-39", "40-60", "61-80", "81-100"];
const comparisonCases = [
  { name: "worked 0, 50, 50, 100", values: [0, 50, 50, 100], n: 4, items: ["25% (1)", "0% (0)", "50% (2)", "0% (0)", "25% (1)"],
    shares: [25, 0, 50, 0, 25] },
  { name: "band edges", values: [19, 20, 39, 40, 60, 61, 80, 81], n: 8,
    items: ["12.5% (1)", "25% (2)", "25% (2)", "25% (2)", "12.5% (1)"], shares: [12.5, 25, 25, 25, 12.5] },
  { name: "single endpoint", values: [100], n: 1, items: ["0% (0)", "0% (0)", "0% (0)", "0% (0)", "100% (1)"],
    shares: [0, 0, 0, 0, 100] },
  { name: "thirds", values: [10, 30, 70], n: 3, items: ["33.3% (1)", "33.3% (1)", "0% (0)", "33.3% (1)", "0% (0)"],
    shares: [100 / 3, 100 / 3, 0, 100 / 3, 0] },
];

for (const { name, values, n, items, shares } of comparisonCases) {
  test(`comparison row uses its own denominator and a common signed axis: ${name}`, async ({ page }) => {
    await showResults(page, [{ statement: "Other statement", values: repeat(90, 20) },
      { statement: "Compared statement", values }]);
    const overview = page.getByRole("region", { name: "Comparison across questions" });
    await expect(overview.getByText(/derived from the 0-100 slider/)).toBeVisible();
    const row = overview.getByRole("listitem").filter({ hasText: "Compared statement" }).first();
    await expect(row.getByText(`n = ${n}`, { exact: true })).toBeVisible();
    const list = row.getByRole("list", { name: "Derived score bands for Compared statement" });
    expect(await list.getByRole("listitem").allInnerTexts()).toEqual(bandLabels.map((band, i) => `${band}: ${items[i]}`));
    const geometry = await row.locator("svg.comparison").evaluate(svg => {
      const rect = (selector: string) => svg.querySelector(selector)?.getBoundingClientRect();
      const axis = rect("line[data-axis]"); const zero = rect("line[data-zero]");
      if (!axis || !zero) throw new Error("Missing axis");
      const bands = Array.from(svg.querySelectorAll("rect[data-band]"), node => {
        const box = node.getBoundingClientRect();
        return { band: node.getAttribute("data-band"), width: box.width, center: box.left + box.width / 2, left: box.left, right: box.right };
      });
      return { axisWidth: axis.width, zeroX: zero.left + zero.width / 2, bands };
    });
    geometry.bands.forEach((band, i) => {
      expect(band.band).toBe(bandLabels[i]);
      expect(band.width / geometry.axisWidth * 200).toBeCloseTo(shares[i] ?? 0, 0);
    });
    const middle = geometry.bands[2];
    expect(middle?.center).toBeCloseTo(geometry.zeroX, 0);
    expect(geometry.bands[1]?.right).toBeCloseTo(middle?.left ?? 0, 0);
    expect(geometry.bands[3]?.left).toBeCloseTo(middle?.right ?? 0, 0);
  });
}

test("questions without answers show an explicit empty state, never a fabricated mean or fill", async ({ page }) => {
  await showResults(page, [{ statement: "Nobody yet", values: [] }, { statement: "Some people", values: [0, 50, 50, 100] }]);
  const card = page.locator("section.card").first();
  await expect(card.getByText("No answers yet")).toBeVisible();
  await expect(card.locator("svg")).toHaveCount(0);
  await expect(card.getByText(/Mean agreement/)).toHaveCount(0);
  const row = page.getByRole("region", { name: "Comparison across questions" }).getByRole("listitem")
    .filter({ hasText: "Nobody yet" }).first();
  await expect(row.getByText("No answers: n = 0", { exact: true })).toBeVisible();
  await expect(row.locator("rect")).toHaveCount(0);
  await expect(row.getByRole("list")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/NaN|Infinity/);
  await expect(page.locator("section.card").nth(1).locator("svg.dots")).toBeVisible();
});

for (const [label, size] of [["desktop", { width: 1280, height: 900 }], ["narrow", { width: 320, height: 700 }]] as const) {
  test(`charts stay readable and contained on ${label}: contrast, long text, no overflow`, async ({ page }) => {
    await page.setViewportSize(size);
    const longStatement = `${"Extraordinarily".repeat(8)} long statement `.repeat(3);
    await showResults(page, [{ statement: longStatement, values: [...repeat(0, 5), ...repeat(50, 10), ...repeat(100, 5)] },
      { statement: "Few", values: repeat(50, 10) }]);
    await expect(page.locator("svg.histogram")).toBeVisible();
    const report = await page.evaluate(() => {
      const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const lum = (css: string) => {
        const m = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
        return 0.2126 * channel(m[0] ?? 0) + 0.7152 * channel(m[1] ?? 0) + 0.0722 * channel(m[2] ?? 0);
      };
      const ratio = (css: string) => 1.05 / (lum(css) + 0.05);
      const shapes = Array.from(document.querySelectorAll("rect[data-range], rect[data-band], svg.dots circle"),
        node => ratio(getComputedStyle(node).fill));
      const texts = Array.from(document.querySelectorAll("svg text"), node => ratio(getComputedStyle(node).fill));
      return { shapes, texts, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(Math.min(...report.shapes)).toBeGreaterThanOrEqual(3);
    expect(Math.min(...report.texts)).toBeGreaterThanOrEqual(4.5);
    expect(report.overflow).toBeLessThanOrEqual(0);
    await expect(page.getByText("Colors show direction only", { exact: false })).toBeVisible();
  });
}

for (const width of [320, 360, 414]) test(`narrow chart labels are rendered at a readable on-screen size: ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 700 });
  await showResults(page, [{ statement: "Many", values: [...repeat(0, 5), ...repeat(50, 10), ...repeat(100, 5)] },
    { statement: "Few", values: [45, 46, 47, 48, 49, 50, 51, 52, 53, 54] }]);
  await expect(page.locator("svg.histogram")).toBeVisible();
  const sizes = await page.evaluate(() => Array.from(document.querySelectorAll("svg text"), node => {
    const box = node.getBoundingClientRect();
    return { text: node.textContent, scaled: parseFloat(getComputedStyle(node).fontSize) * (box.width / (node as SVGTextElement).getBBox().width) };
  }));
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size.scaled, size.text ?? "").toBeGreaterThanOrEqual(11.5);
});

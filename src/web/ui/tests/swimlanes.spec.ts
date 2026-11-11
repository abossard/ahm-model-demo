import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SUBSCRIPTION_A, healthModel, installStubs } from "./fixture";
import { MODEL_QUERY } from "./workspaceHelpers";
import { SESSION_ID, explainEvents, explainResult, installWorkspace, sessionSummary, taskOf } from "./workspaceStub";
import { openView } from "./views";
import { calmModel, denseIncidentModel, diffViewModel, incidentModel } from "./viewModels";
import { layerOf } from "../src/model/layerOf";
import { layoutSwimlanes } from "../src/model/swimlanes";
import type { HealthModel } from "../src/model/types";

test.use({ viewport: { width: 1440, height: 900 } });

const LANES = ["root", "flows", "systems", "resources", "context"] as const;

async function show(page: Page, model: HealthModel = incidentModel(), query = ""): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await openView(page, "swimlanes", query === "" ? "/" : `/?${query}`);
  await page.getByTestId("swimlanes-view").waitFor();
  await page.waitForTimeout(300);
}

const swimCard = (page: Page, name: string): Locator => page.locator(`[data-testid="swim-card"][data-entity="${name}"]`);
const swimFold = (page: Page, owner: string): Locator => page.locator(`[data-testid="swim-fold"][data-owner="${owner}"]`);
const transform = (page: Page): Promise<string> => page.evaluate(() => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform);

interface Rect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Layout-space rectangles of every card and chip, and every line crossing a card: the paths are sampled every 3 px in the
 * same space, so zoom and pan cannot skew it. A line ends on the border of its own two cards, so the cards are shrunk by 2 px.
 */
async function crossings(page: Page): Promise<{ readonly cards: readonly Rect[]; readonly through: readonly string[]; readonly lines: number }> {
  return page.evaluate(() => {
    const cards: Rect[] = [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
      .filter((node) => node.querySelector('[data-testid="swim-card"], [data-testid="swim-fold"]'))
      .map((node) => {
        const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform);
        return { id: node.getAttribute("data-id") ?? "", x: Number(match?.[1]), y: Number(match?.[2]), width: node.offsetWidth, height: node.offsetHeight };
      });
    const through: string[] = [];
    const paths = [...document.querySelectorAll<SVGPathElement>(".react-flow__edge-path")];
    for (const path of paths) {
      const length = path.getTotalLength();
      const edge = path.closest(".react-flow__edge")?.getAttribute("data-id") ?? "";
      for (let at = 0; at <= length; at += 3) {
        const point = path.getPointAtLength(at);
        const hit = cards.find((card) => point.x > card.x + 2 && point.x < card.x + card.width - 2 && point.y > card.y + 2 && point.y < card.y + card.height - 2);
        if (hit) {
          through.push(`${edge} through ${hit.id}`);
          break;
        }
      }
    }
    return { cards, through, lines: paths.length };
  });
}

test.describe("lanes", () => {
  test("draws a lane band per layer with the entities that belong in it, and a card for each", async ({ page }) => {
    await show(page);
    await expect(page.getByTestId("swim-lane")).toHaveCount(5);
    for (const [index, kind] of LANES.entries()) await expect(page.getByTestId("swim-lane").nth(index)).toHaveAttribute("data-lane", kind);
    await expect(page.getByTestId("swim-card")).toHaveCount(17);
    const members = async (kind: string): Promise<string[]> => (await page.locator(`[data-testid="swim-card"][data-lane="${kind}"]`).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-entity") ?? ""))).sort();
    expect(await members("root")).toEqual(["hm-contosodemo"]);
    expect(await members("flows")).toEqual(["flow-run-agent-tasks", "flow-send-health-reports", "flow-view-health-model"]);
    expect(await members("systems")).toEqual(["system-agent-runtime", "system-ai-inference", "system-app-hosting", "system-session-store"]);
    expect(await members("resources")).toEqual(["container-app", "foundry-account", "hosted-agent", "session-storage"]);
    expect(await members("context")).toEqual(["2cfe8745-bb71-b592-3736-7d3343a007dc", "81db2f7a-697d-c4ed-5d5f-251344a971fe", "discover-app-insights", "discovered-app-topology", "platform-context"]);
    await expect(page.getByTestId("swim-lane").nth(3)).toContainText("Azure resources");
    await expect(page.getByTestId("swimlanes-summary")).toContainText("17 entities in 5 lanes");
  });

  test("draws a card as wide as its content needs: name, state, impact and signal rows with their values", async ({ page }) => {
    await show(page);
    const storage = swimCard(page, "session-storage");
    await expect(storage).toContainText("Session Storage");
    await expect(storage).toContainText("Unhealthy");
    await expect(storage).toContainText("Availability");
    await expect(storage).toContainText("91.4");
    await expect(swimCard(page, "system-session-store").getByTestId("impact-chip")).toContainText("Limited impact");
    const widths = await page.getByTestId("swim-card").evaluateAll((cards) => new Set(cards.map((card) => Math.round(card.getBoundingClientRect().width))).size);
    expect(widths).toBeGreaterThan(3);
    expect(await page.locator(".swim-card__name").evaluateAll((names) => names.filter((name) => name.scrollWidth > name.clientWidth + 1).length)).toBe(0);
  });

  test("keeps the lane of an entity when the Health filter hides others", async ({ page }) => {
    await show(page);
    await page.getByTestId("health-filter-toggle").click();
    await page.getByRole("checkbox", { name: "Healthy", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("swim-card")).toHaveCount(10);
    await expect(swimCard(page, "session-storage")).toHaveAttribute("data-lane", "resources");
    await expect(swimCard(page, "foundry-account")).toHaveCount(0);
  });

  test("puts a part added by a diff where its place in the graph says: a queue under a system is a resource, a webhook with no parent is context", async ({ page }) => {
    const proposed = diffViewModel().proposed;
    await show(page, { ...incidentModel(), entities: proposed.entities, relationships: proposed.relationships });
    await expect(swimCard(page, "report-queue")).toHaveAttribute("data-lane", "resources");
    await expect(swimCard(page, "pager-webhook")).toHaveAttribute("data-lane", "context");
    await expect(swimCard(page, "discovered-app-topology")).toHaveCount(0);
  });
});

test.describe("lines", () => {
  test.describe.configure({ timeout: 90_000 });

  for (const [name, make] of [["incident", incidentModel], ["calm", calmModel], ["dense", denseIncidentModel]] as const) {
    test(`no line crosses a card in the ${name} model, and every relationship has a line`, async ({ page }) => {
      const model = make();
      await show(page, model);
      const found = await crossings(page);
      expect(found.through).toEqual([]);
      expect(found.cards.length).toBeGreaterThan(10);
      const folded = await page.getByTestId("swim-fold").count();
      expect(found.lines).toBeGreaterThanOrEqual(folded > 0 ? 60 : model.relationships.length);
    });
  }

  test("still crosses no card when chips are open", async ({ page }) => {
    await show(page, denseIncidentModel());
    for (const owner of await page.getByTestId("swim-fold").evaluateAll((chips) => chips.slice(0, 4).map((chip) => chip.getAttribute("data-owner") ?? ""))) {
      await swimFold(page, owner).click();
      await page.waitForTimeout(150);
    }
    expect((await crossings(page)).through).toEqual([]);
  });

  test("labels the lines with the relationships' names, and the Labels toggle turns them off", async ({ page }) => {
    await show(page);
    await expect(page.locator(".react-flow__edge-textwrapper, .react-flow__edge-text").first()).toBeVisible();
    expect(await page.locator(".react-flow__edge-text").count()).toBeGreaterThan(10);
    await page.getByTestId("swim-labels").click();
    await expect(page.locator(".react-flow__edge-text")).toHaveCount(0);
  });
});

test.describe("selection and keyboard", () => {
  test("opens the entity details from a card by pointer and by keyboard", async ({ page }) => {
    await show(page);
    await swimCard(page, "session-storage").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await swimCard(page, "hosted-agent").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("entity-name")).toHaveText("Foundry Hosted Agent");
    await expect(swimCard(page, "hosted-agent")).toHaveClass(/is-selected/);
  });

  test("moves between cards with Tab, lane by lane and left to right, and never stops on a line", async ({ page }) => {
    await show(page);
    const expected = await page.evaluate(() => {
      const order = ["root", "flows", "systems", "resources", "context"];
      return [...document.querySelectorAll<HTMLElement>('[data-testid="swim-card"]')]
        .map((card) => ({ id: card.getAttribute("data-entity") ?? "", lane: order.indexOf(card.getAttribute("data-lane") ?? ""), x: card.getBoundingClientRect().x }))
        .sort((a, b) => a.lane - b.lane || a.x - b.x)
        .map((card) => card.id);
    });
    await swimCard(page, expected[0] as string).focus();
    const visited: string[] = [expected[0] as string];
    for (let step = 1; step < expected.length; step += 1) {
      await page.keyboard.press("Tab");
      visited.push(await page.evaluate(() => document.activeElement?.getAttribute("data-entity") ?? `other:${document.activeElement?.tagName}`));
    }
    expect(visited).toEqual(expected);
    expect(await page.locator(".react-flow__edge[tabindex]").count()).toBe(0);
  });

  test("rings the search result and brings it into view", async ({ page }) => {
    await show(page);
    await page.getByTestId("search-open").click();
    await page.getByTestId("search-input").fill("Web Container App");
    await page.keyboard.press("Enter");
    await expect(swimCard(page, "container-app")).toHaveAttribute("data-highlighted", "true");
    await expect(swimCard(page, "container-app")).toBeInViewport();
  });

  test("marks the chain of an Explain result, numbered from its last entity", async ({ page }) => {
    await installStubs(page, { healthModelFails: false });
    await installWorkspace(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" }, result: explainResult() }), script: { events: explainEvents(), outcome: { status: "done", result: explainResult() } } }],
    });
    await openView(page, "swimlanes", `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    for (const [name, step] of [["svc-a", "1"], ["svc-b", "2"], ["svc-c", "3"]] as const) await expect(swimCard(page, name)).toHaveAttribute("data-step", step);
    await expect(page.getByTestId("chain-step")).toHaveCount(3);
    await expect(swimCard(page, "svc-d")).not.toHaveAttribute("data-step", /.+/);
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("chain-step")).toHaveCount(0);
    expect(healthModel.entities.length).toBeGreaterThan(0);
  });

  test("tells the view's own lines in the legend", async ({ page }) => {
    await show(page);
    await expect(page.getByTestId("legend")).toContainText("Lane = layer");
    await expect(page.getByTestId("legend")).toContainText("Line colour = what the child contributes");
  });
});

test.describe("a dense model", () => {
  test.describe.configure({ timeout: 90_000 });

  test("opens on the first problem, with a Fit that shows all of it", async ({ page }) => {
    await show(page, denseIncidentModel());
    await expect(page.getByTestId("swimlanes-view")).toHaveAttribute("data-dense", "true");
    await expect(page.getByTestId("swimlanes-summary")).toContainText("Zoomed to");
    await expect(page.getByTestId("swimlanes-summary")).toContainText("Fit shows all 81 entities");
    const problem = page.locator('[data-testid="swim-card"][data-entity^="res-"][data-state="Unhealthy"]').first();
    await expect(problem).toBeInViewport();
    const zoomedIn = await page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1]));
    expect(zoomedIn).toBeGreaterThan(0.6);

    await page.getByTestId("swim-fit").click();
    await page.waitForTimeout(900);
    const fitted = await page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1]));
    expect(fitted).toBeLessThan(zoomedIn);
    await expect(page.getByTestId("swim-lane").last()).toBeInViewport();
    await expect(page.getByTestId("swim-lane").first()).toBeInViewport();
    await expect(page.getByTestId("swimlanes-summary")).toContainText("81 entities in 5 lanes");
  });

  test("is far narrower than one row per lane: the width of the picture stays under 3600 px", async ({ page }) => {
    await show(page, denseIncidentModel());
    const width = await page.getByTestId("swim-lane").first().evaluate((lane) => (lane as HTMLElement).offsetWidth);
    expect(width).toBeLessThan(3600);
    expect(await page.getByTestId("swim-card").count()).toBeLessThan(81);
  });

  test("folds healthy parts into chips that open by pointer and close by keyboard", async ({ page }) => {
    await show(page, denseIncidentModel());
    const owner = (await page.getByTestId("swim-fold").first().getAttribute("data-owner")) as string;
    const before = await page.getByTestId("swim-card").count();
    await expect(swimFold(page, owner)).toHaveAttribute("aria-expanded", "false");
    await swimFold(page, owner).click();
    await expect(swimFold(page, owner)).toHaveAttribute("aria-expanded", "true");
    expect(await page.getByTestId("swim-card").count()).toBeGreaterThan(before);
    await swimFold(page, owner).focus();
    await page.keyboard.press("Enter");
    await expect(swimFold(page, owner)).toHaveAttribute("aria-expanded", "false");
    expect(await page.getByTestId("swim-card").count()).toBe(before);
  });

  test("fades the lines that do not lead to the selected entity", async ({ page }) => {
    await show(page, denseIncidentModel());
    const opacities = (): Promise<number[]> => page.locator(".react-flow__edge-path").evaluateAll((paths) => paths.map((path) => Number(getComputedStyle(path).opacity)));
    expect((await opacities()).filter((value) => value < 1).length).toBeGreaterThan(20);
    await page.locator('[data-testid="swim-card"][data-entity^="res-"][data-state="Unhealthy"]').first().click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    const faded = (await opacities()).filter((value) => value < 1).length;
    expect(faded).toBeGreaterThan(20);
    expect((await opacities()).filter((value) => value === 1).length).toBeGreaterThan(2);
  });

  test("search brings an entity behind a chip into view by opening the chip", async ({ page }) => {
    await show(page, denseIncidentModel());
    const model = denseIncidentModel();
    const folded = layoutSwimlanes({ entities: model.entities, relationships: model.relationships, layering: layerOf(model.entities, model.relationships) }, { signals: true, labels: null, open: new Set(), keep: new Set() }).folds.flatMap((fold) => fold.members);
    const hidden = folded.find((name) => name.startsWith("res-")) as string;
    await expect(swimCard(page, hidden)).toHaveCount(0);
    await page.getByTestId("search-open").click();
    await page.getByTestId("search-input").fill(hidden.slice("res-".length));
    await page.keyboard.press("Enter");
    await expect(swimCard(page, hidden)).toBeVisible();
    await expect(swimCard(page, hidden)).toBeInViewport();
    await expect(swimCard(page, hidden)).toHaveAttribute("data-highlighted", "true");
  });
});

test.describe("the view of the screen", () => {
  test("fits the graph when the view opens and again when the Session workspace opens", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, model: incidentModel() });
    await installWorkspace(page, { sessions: [sessionSummary({ taskCount: 0 })], tasks: [] });
    await openView(page, "swimlanes", `/?${MODEL_QUERY}`);
    await page.getByTestId("swimlanes-view").waitFor();
    await page.waitForTimeout(400);
    const before = await transform(page);
    await expect(swimCard(page, "hm-contosodemo")).toBeInViewport();
    await expect(page.getByTestId("swim-lane").last()).toBeInViewport();
    await page.getByTestId("workspace-toggle").click();
    await expect(page.getByTestId("session-workspace")).toBeVisible();
    await page.waitForTimeout(900);
    expect(await transform(page)).not.toBe(before);
    await expect(swimCard(page, "hm-contosodemo")).toBeInViewport();
    await expect(swimCard(page, "container-app")).toBeInViewport();
  });

  test("moves to the new fit at once when motion is reduced", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await show(page);
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    await page.getByTestId("swim-fit").click();
    await page.waitForTimeout(60);
    const soon = await transform(page);
    await page.waitForTimeout(800);
    expect(await transform(page)).toBe(soon);
  });
});

/** Verbatim policy of the app, read from the declaration graph-ux.spec.ts keeps. */
function servedPolicy(): string {
  const spec = readFileSync(fileURLToPath(new URL("./graph-ux.spec.ts", import.meta.url)), "utf8");
  const declaration = /const SERVED_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/.exec(spec);
  if (!declaration) throw new Error("SERVED_CSP is no longer a plain string expression in graph-ux.spec.ts");
  return [...declaration[1]!.matchAll(/"([^"]*)"/g)].map((piece) => piece[1]).join("");
}

test("runs under the policy the server sends: no inline style string, no violation, while the view is used", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = servedPolicy();
    await route.fulfill({ response, headers });
  });
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  await show(page, denseIncidentModel());
  await swimFold(page, (await page.getByTestId("swim-fold").first().getAttribute("data-owner")) as string).click();
  await page.locator('[data-testid="swim-card"][data-entity^="res-"][data-state="Unhealthy"]').first().click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await page.getByTestId("swim-signals").click();
  await page.getByTestId("swim-labels").click();
  await page.getByTestId("swim-fit").click();
  expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
  expect(violations).toEqual([]);
  expect(await page.getByTestId("swimlanes-view").evaluate((view) => view.querySelectorAll("[style*='expression'], style").length)).toBe(0);
});

/** The WCAG contrast of every text the view draws against the colour it sits on. */
async function contrasts(page: Page): Promise<readonly { readonly what: string; readonly ratio: number }[]> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] | null => {
      const rgb = /^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/.exec(value);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
      const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value);
      return srgb ? [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])] : null;
    };
    const luminance = ([r, g, b]: readonly number[]): number => {
      const channel = (value: number): number => {
        const unit = (value as number) / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r as number) + 0.7152 * channel(g as number) + 0.0722 * channel(b as number);
    };
    const backgroundOf = (element: Element): [number, number, number, number] => {
      for (let current: Element | null = element; current; current = current.parentElement) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color && color[3] > 0.5) return color;
      }
      return [255, 255, 255, 1];
    };
    const out: { what: string; ratio: number }[] = [];
    const selectors = [".swim-card__name", ".swim-card__state", ".swim-card__row-name", ".swim-card__row-value", ".swim-card__chip", ".swim-card__summary", ".swim-fold", ".swim-lane__name", ".swim-lane__count"];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const color = parse(getComputedStyle(element).color);
        if (!color) continue;
        const light = Math.max(luminance(color), luminance(backgroundOf(element)));
        const dark = Math.min(luminance(color), luminance(backgroundOf(element)));
        out.push({ what: `${selector} ${element.textContent?.slice(0, 24) ?? ""}`, ratio: (light + 0.05) / (dark + 0.05) });
      }
    }
    return out;
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`draws every text at a contrast of at least 4.5 in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await show(page);
    const found = await contrasts(page);
    expect(found.length).toBeGreaterThan(60);
    expect(found.filter((item) => item.ratio < 4.5).map((item) => `${item.what}: ${item.ratio.toFixed(2)}`)).toEqual([]);
  });
}

test("draws differently in the two themes", async ({ page }) => {
  const backgrounds: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await show(page);
    backgrounds.push(await swimCard(page, "container-app").evaluate((card) => getComputedStyle(card).backgroundColor));
  }
  expect(backgrounds[1]).not.toBe(backgrounds[0]);
});

// Screenshots for looking at, off unless VIZ_SHOTS is set:  VIZ_SHOTS=1 npx playwright test tests/swimlanes.spec.ts -g screenshots
const OUT = fileURLToPath(new URL("../../../../.playwright-mcp/viz-app/", import.meta.url));

test.describe("screenshots", () => {
  test.skip(!process.env["VIZ_SHOTS"], "set VIZ_SHOTS=1 to take the screenshots");
  test.describe.configure({ timeout: 90_000 });

  const proposed = diffViewModel().proposed;
  const SHOTS: readonly (readonly [string, () => HealthModel, boolean])[] = [
    ["incident", incidentModel, false],
    ["dense", denseIncidentModel, true],
    ["diff", () => ({ ...incidentModel(), entities: proposed.entities, relationships: proposed.relationships }), false],
    ["calm", calmModel, false],
  ];
  for (const scheme of ["light", "dark"] as const) {
    for (const [name, make, fit] of SHOTS) {
      test(`${name} ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await show(page, make());
        await page.waitForTimeout(900);
        await page.screenshot({ path: `${OUT}swimlanes-${name}-${scheme}.png` });
        if (fit) {
          await page.getByTestId("swim-fit").click();
          await page.waitForTimeout(900);
          await page.screenshot({ path: `${OUT}swimlanes-${name}-fit-${scheme}.png` });
        }
      });
    }
  }
});

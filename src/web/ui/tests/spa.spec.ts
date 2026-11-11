import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  SUBSCRIPTION_A,
  SUBSCRIPTION_B,
  healthModel,
  installStubs,
  modelCatalog,
  paymentsHealthModel,
  reportResponse,
} from "./fixture";
import { openView } from "./views";

const STATE_PALETTE: Readonly<
  Record<string, { readonly border: string; readonly fill: string; readonly word: string }>
> = {
  // A Healthy card is neutral; only the states that need attention are tinted.
  "svc-a": { border: "rgb(209, 209, 209)", fill: "rgb(255, 255, 255)", word: "Healthy" },
  "svc-b": { border: "rgb(219, 117, 0)", fill: "rgb(251, 242, 231)", word: "Degraded" },
  "svc-c": { border: "rgb(186, 13, 22)", fill: "rgb(250, 236, 235)", word: "Unhealthy" },
  "svc-d": { border: "rgb(200, 198, 196)", fill: "rgb(246, 246, 245)", word: "Unknown" },
  "svc-e": { border: "rgb(134, 97, 197)", fill: "rgb(244, 240, 251)", word: "Standby" },
};

/** What the picker shows for one model: its name and group, then the short subscription hint. */
function optionText(model: (typeof modelCatalog.models)[number]): string {
  return `${model.name} (${model.resourceGroup}) ${model.subscriptionId.slice(0, 8)}`;
}

const MODEL_OPTIONS = '[data-testid^="model-picker-option-"]';

function validRelationships(): readonly { parent: string; child: string; label: string | null }[] {
  const names = new Set(healthModel.entities.map((entity) => entity.name));
  return healthModel.relationships
    .filter((rel) => names.has(rel.parentEntityName) && names.has(rel.childEntityName))
    .map((rel) => ({ parent: rel.parentEntityName, child: rel.childEntityName, label: rel.displayName }));
}

async function bootTopology(page: Page): Promise<void> {
  await installStubs(page, { healthModelFails: false });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
}

test("shell is one document with a single script and no server-rendered state", async ({ page }) => {
  const shell = await page.request.get("/");
  expect(shell.status()).toBe(200);
  const html = await shell.text();

  const scriptSrcCount = (html.match(/<script\b[^>]*\bsrc=/g) ?? []).length;
  expect(scriptSrcCount).toBe(1);

  for (const entity of healthModel.entities) {
    expect(html, `shell must not server-render ${entity.displayName}`).not.toContain(entity.displayName);
  }

  await openView(page, "zoom");
  const domScriptSrc = await page.evaluate(() => document.querySelectorAll("script[src]").length);
  expect(domScriptSrc).toBe(1);
});

test("AC1 — one React Flow node per entity and one edge per valid relationship", async ({ page }) => {
  await bootTopology(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await expect(page.locator(".react-flow__edge")).toHaveCount(validRelationships().length);
});

test("AC2 — every parent node sits above its children", async ({ page }) => {
  await bootTopology(page);
  for (const rel of validRelationships()) {
    const parent = await page.locator(`.react-flow__node[data-id="${rel.parent}"]`).boundingBox();
    const child = await page.locator(`.react-flow__node[data-id="${rel.child}"]`).boundingBox();
    expect(parent, `parent box ${rel.parent}`).not.toBeNull();
    expect(child, `child box ${rel.child}`).not.toBeNull();
    const parentBottom = (parent?.y ?? 0) + (parent?.height ?? 0);
    expect(parentBottom, `${rel.parent} above ${rel.child}`).toBeLessThanOrEqual(child?.y ?? 0);
  }
});

test("AC3 — each card carries the portal state design and pill word", async ({ page }) => {
  await bootTopology(page);
  for (const [name, pair] of Object.entries(STATE_PALETTE)) {
    const card = page.locator(`.react-flow__node[data-id="${name}"] .entity-node`);
    const style = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderTopLeftRadius,
        width: cs.borderTopWidth,
        border: cs.borderTopColor,
        fill: cs.backgroundColor,
      };
    });
    expect(style.radius, `${name} radius`).toBe("8px");
    expect(style.width, `${name} border width`).toBe("2px");
    expect(style.border, `${name} border color`).toBe(pair.border);
    expect(style.fill, `${name} fill`).toBe(pair.fill);
    const word = await card.locator(".entity-node__pill-word").textContent();
    expect(word?.trim(), `${name} pill word`).toBe(pair.word);
  }
});

test("AC4 — Unknown card border is dashed, Healthy is solid", async ({ page }) => {
  await bootTopology(page);
  const styleOf = (name: string) =>
    page
      .locator(`.react-flow__node[data-id="${name}"] .entity-node`)
      .evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(await styleOf("svc-d")).toBe("dashed");
  expect(await styleOf("svc-a")).toBe("solid");
});

test("AC5 — signal rows render each signal name and its distinct value", async ({ page }) => {
  await bootTopology(page);
  const rows = page.locator(`.react-flow__node[data-id="svc-a"] .entity-node__row`);
  await expect(rows).toHaveCount(3);
  const texts = (await rows.allTextContents()).join(" | ");
  for (const fragment of ["CPU", "0.2", "Latency", "980", "Errors", "0"]) {
    expect(texts, `row text should contain ${fragment}`).toContain(fragment);
  }
});

test("AC6 — activating a node opens the detail panel by pointer and keyboard", async ({ page }) => {
  await bootTopology(page);

  const pointerRequest = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/api/entities/svc-a" && req.method() === "GET",
  );
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  const pointerParams = new URL((await pointerRequest).url()).searchParams;
  expect([
    pointerParams.get("model"),
    pointerParams.get("resourceGroup"),
    pointerParams.get("subscription"),
  ]).toEqual(["hm-demo", "rg-demo", SUBSCRIPTION_A]);
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service A");

  const keyboardRequest = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/api/entities/svc-e" && req.method() === "GET",
  );
  await page.locator(`.react-flow__node[data-id="svc-e"] .entity-node`).focus();
  await page.keyboard.press("Enter");
  await keyboardRequest;
  await expect(page.getByTestId("entity-name")).toHaveText("Service E (retired)");
});

test("AC7 — edges are labelled only where a display name exists", async ({ page }) => {
  await bootTopology(page);
  const labels = (await page.locator(".react-flow__edge-text").allTextContents())
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .sort();
  const expected = validRelationships()
    .map((rel) => rel.label ?? "")
    .filter((label) => label.length > 0)
    .sort();
  expect(labels).toEqual(expected);
});

test("edges carry no arrowhead marker", async ({ page }) => {
  await bootTopology(page);
  const paths = page.locator(".react-flow__edge .react-flow__edge-path");
  await expect(paths).toHaveCount(validRelationships().length);
  const markers = await paths.evaluateAll((els) =>
    els.map((el) => ({
      attr: el.getAttribute("marker-end"),
      computed: getComputedStyle(el).markerEnd,
    })),
  );
  for (const marker of markers) {
    expect(marker.attr, "no marker-end attribute").toBeNull();
    expect(marker.computed, "no computed marker-end").toBe("none");
  }
  await expect(page.locator(".react-flow__arrowclosed")).toHaveCount(0);
});

test("each edge is stroked with its child entity health colour", async ({ page }) => {
  await bootTopology(page);
  const expected: Readonly<Record<string, string>> = {
    r1: "rgb(194, 106, 0)",
    r2: "rgb(197, 15, 24)",
    r3: "rgb(138, 136, 134)",
    r4: "rgb(197, 15, 24)",
  };
  for (const [id, colour] of Object.entries(expected)) {
    const stroke = await page
      .locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`)
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(stroke, `edge ${id} stroke`).toBe(colour);
  }
});

test("cards of different heights on the same rank are top aligned", async ({ page }) => {
  await bootTopology(page);
  // svc-f has no relationship and goes on a shelf of its own, so it is not on this rank.
  const boxes = await Promise.all(
    ["svc-a", "svc-e"].map((name) =>
      page.locator(`.react-flow__node[data-id="${name}"]`).boundingBox(),
    ),
  );
  const heights = boxes.map((box) => box?.height ?? 0);
  expect(new Set(heights).size, "rank 0 cards must differ in height").toBeGreaterThan(1);
  const tops = boxes.map((box) => box?.y ?? 0);
  for (const top of tops) {
    expect(Math.abs(top - (tops[0] ?? 0)), `top alignment ${tops.join(",")}`).toBeLessThanOrEqual(1);
  }
});

test("report submission posts the exact body and shows the receipt", async ({ page }) => {
  await openReportForm(page);

  await page.selectOption("#report-state", { label: "Degraded" });
  await page.selectOption("#report-value", { label: "0.5" });
  await page.selectOption("#report-expiry", { label: "15" });
  await page.selectOption("#report-reason", { label: "Maintenance window" });

  const postRequest = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/entities/svc-a/health-reports" && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Send report" }).click();
  const posted = await postRequest;
  expect([...new URL(posted.url()).searchParams]).toEqual([
    ["model", "hm-demo"],
    ["resourceGroup", "rg-demo"],
    ["subscription", SUBSCRIPTION_A],
  ]);
  const body = posted.postDataJSON();

  expect(body).toEqual({
    signalName: "web-ui-health-report",
    healthState: "Degraded",
    value: 0.5,
    expiresInMinutes: 15,
    reasonPreset: "maintenance",
  });

  await expect(page.getByTestId("report-id")).toHaveText(reportResponse.reportId);
  await expect(page.getByTestId("report-expires")).toHaveText(reportResponse.expiresAt);
});

test("empty custom reason blocks submission and announces the error", async ({ page }) => {
  await openReportForm(page);

  let postCount = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/health-reports")) postCount += 1;
  });

  await page.selectOption("#report-reason", { label: "Custom reason" });
  await page.getByRole("button", { name: "Send report" }).click();

  const textarea = page.locator("#report-custom-reason");
  const describedBy = await textarea.getAttribute("aria-describedby");
  expect(describedBy).toBe("report-custom-reason-error");
  await expect(textarea).toHaveAttribute("aria-invalid", "true");
  const errorText = (await page.locator(`#${describedBy}`).textContent())?.trim() ?? "";
  expect(errorText.length).toBeGreaterThan(0);

  await page.waitForTimeout(200);
  expect(postCount).toBe(0);
});

test("health-model failure shows error and retry recovers the topology", async ({ page }) => {
  const state = { healthModelFails: true };
  await installStubs(page, state);
  await openView(page, "zoom");

  await expect(page.getByTestId("status-error")).toBeVisible();
  await expect(page.getByTestId("status-error-message")).toHaveText(
    "The health model service is unavailable.",
  );
  await expect(page.getByTestId("status-last-observed")).toHaveText("Not updated yet");

  state.healthModelFails = false;
  await page.getByTestId("status-retry").click();

  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
});

const SELECTED_KEY = `${SUBSCRIPTION_A}/rg-demo/hm-demo`;

function modelNamed(name: string): (typeof modelCatalog.models)[number] {
  return modelCatalog.models.find((item) => item.name === name)!;
}

test("AC8 — the status bar lists every discoverable model with the active one selected", async ({ page }) => {
  await bootTopology(page);

  const picker = page.getByTestId("model-picker-search");
  await expect(picker).toBeVisible();
  await picker.click();
  const options = page.locator(MODEL_OPTIONS);
  await expect(options).toHaveCount(modelCatalog.models.length);
  // Two subscriptions are listed, so the options are grouped by subscription with the default one
  // first, and sorted by name inside each group.
  await expect(options).toHaveText(
    ["hm-demo", "hm-payments", "hm-eu"].map((name) => optionText(modelNamed(name))),
  );
  for (const subscription of [SUBSCRIPTION_A, SUBSCRIPTION_B]) {
    await expect(
      page.getByRole("group", { name: `Subscription ${subscription.slice(0, 8)}` }),
    ).toHaveCount(1);
  }
  await expect(page.getByTestId("model-picker")).toHaveValue(SELECTED_KEY);
  await expect(page.getByTestId("model-picker-selected")).toContainText("hm-demo (rg-demo)");
  await expect(page.getByTestId("model-name")).toHaveText(healthModel.model.name);
});

test("model picker search filters by model, group and subscription, then restores full list", async ({ page }) => {
  await bootTopology(page);
  const search = page.getByTestId("model-picker-search");
  await search.click();
  const options = page.locator(MODEL_OPTIONS);

  await search.fill("eu");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(optionText(modelNamed("hm-eu")));

  await search.fill("RG-DEMO");
  await expect(options).toHaveCount(2);
  // Only one subscription is left, so the group headings go away.
  await expect(page.getByRole("listbox", { name: "Health model" }).getByRole("group")).toHaveCount(0);

  await search.fill(SUBSCRIPTION_B.slice(0, 8));
  await expect(options).toHaveCount(1);

  await search.fill("");
  await expect(options).toHaveCount(modelCatalog.models.length);
});

test("model picker no-results keeps the selected model unchanged", async ({ page }) => {
  await bootTopology(page);
  const search = page.getByTestId("model-picker-search");
  await search.click();
  await search.fill("no-such-model");
  await expect(page.getByTestId("model-picker-empty")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toHaveValue(SELECTED_KEY);
  await expect(page.getByTestId("model-picker-selected")).toContainText("hm-demo (rg-demo)");
  await expect(page.getByTestId("model-name")).toHaveText(healthModel.model.name);
});

test("model picker renders a capped, filterable list for a few hundred models", async ({ page }) => {
  const many = Array.from({ length: 300 }, (_, index) => ({
    ...modelCatalog.models[0]!,
    name: `hm-${String(index).padStart(3, "0")}`,
    id: `/many/${index}`,
    subscriptionId: index % 2 === 0 ? SUBSCRIPTION_A : SUBSCRIPTION_B,
  }));
  await installStubs(page, {
    catalog: {
      models: many,
      default: { name: "hm-000", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A },
    },
  });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");

  const search = page.getByTestId("model-picker-search");
  await search.click();
  await expect(page.locator(MODEL_OPTIONS)).toHaveCount(50);
  await expect(page.getByTestId("model-picker-capped")).toHaveText(
    "Showing 50 of 300. Type to narrow the list.",
  );

  await search.fill("hm-299");
  await expect(page.locator(MODEL_OPTIONS)).toHaveCount(1);
  await expect(page.getByTestId("model-picker-capped")).toHaveCount(0);
});

test("deep-linked unavailable selection shows a fallback notice", async ({ page }) => {
  await installStubs(page, {});
  await openView(page, "zoom", `/?model=hm-missing&resourceGroup=rg-missing&subscription=${SUBSCRIPTION_A}`);
  await expect(page.getByTestId("model-picker")).toHaveValue(SELECTED_KEY);
  await expect(page.getByTestId("model-picker-unavailable-selection")).toContainText(
    "Requested hm-missing (rg-missing) is unavailable.",
  );
});

test("a deep link to the right model in the wrong subscription is unavailable", async ({ page }) => {
  await installStubs(page, {});
  await openView(page, "zoom", `/?model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_B}`);
  await expect(page.getByTestId("model-picker")).toHaveValue(SELECTED_KEY);
  await expect(page.getByTestId("model-picker-unavailable-selection")).toContainText(
    "Requested hm-demo (rg-demo) is unavailable.",
  );
});

test("model picker keyboard navigation selects entries and does not break graph search shortcut", async ({
  page,
}) => {
  await installStubs(page, {
    modelsByName: {
      "hm-demo": healthModel,
      "hm-payments": paymentsHealthModel,
    },
  });
  await openView(page, "zoom");
  const search = page.getByTestId("model-picker-search");
  await search.focus();
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByTestId("model-picker-selected")).toContainText(
    "hm-payments (rg-demo)",
  );
  await expect(page.getByTestId("model-name")).toHaveText(
    paymentsHealthModel.model.name,
  );

  await search.fill("no-such-model");
  await search.press("Escape");
  await expect(search).toHaveValue("");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await search.press(`${modifier}+k`);
  await expect(page.getByTestId("search-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
});

test("Escape closes the model picker list", async ({ page }) => {
  await bootTopology(page);
  const search = page.getByTestId("model-picker-search");
  await search.click();
  await expect(page.getByRole("listbox", { name: "Health model" })).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("listbox", { name: "Health model" })).toHaveCount(0);
});

test("theme toggle persists an explicit choice across reload", async ({ page }) => {
  await bootTopology(page);
  await page.getByTestId("theme-toggle").click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
});

test("theme follows system on revisit until an explicit choice is saved", async ({ page }) => {
  await page.addInitScript(() => {
    const marker = "health-pulse-theme-cleared";
    if (!window.sessionStorage.getItem(marker)) {
      window.localStorage.removeItem("health-pulse-theme");
      window.sessionStorage.setItem(marker, "1");
    }
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await bootTopology(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");

  await page.getByTestId("theme-toggle").click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
});

test("first frame follows system theme without inline script", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("health-pulse-theme");
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await bootTopology(page);
  const initial = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(initial).not.toBe("rgb(255, 255, 255)");
});

test("theme toggle still works when local storage writes are blocked", async ({ page }) => {
  await page.addInitScript(() => {
    const fail = () => {
      throw new Error("blocked");
    };
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: () => null,
        setItem: fail,
        removeItem: fail,
        clear: fail,
        key: () => null,
        length: 0,
      },
      configurable: true,
    });
  });
  await bootTopology(page);
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByTestId("theme-toggle").click();
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(after).not.toBe(before);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme keeps graph and controls at accessible contrast`, async ({ page }) => {
    await bootTopology(page);
    const current = await page.evaluate(() => document.documentElement.dataset.theme);
    if (current !== theme) {
      await page.getByTestId("theme-toggle").click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(theme);
    }
    await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await page.getByTestId("report-open").click();
    await expect(page.getByTestId("report-submit")).toBeVisible();

    const ratios = await page.evaluate(() => {
      const parse = (value: string): [number, number, number] => {
        const parts = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      };
      const channel = (input: number): number => {
        const normalized = input / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: [number, number, number]): number =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const contrast = (front: string, back: string): number => {
        const a = luminance(parse(front));
        const b = luminance(parse(back));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const card = document.querySelector(".entity-node") as HTMLElement;
      const cardName = card.querySelector(".entity-node__name") as HTMLElement;
      const rowValue = card.querySelector(".entity-node__row-value") as HTMLElement;
      const pill = document.querySelector('[data-testid="health-badge"]') as HTMLElement;
      const button = document.querySelector('[data-testid="report-submit"]') as HTMLElement;
      const quickSend = document.querySelector(
        '[data-testid="quick-send-Healthy"]',
      ) as HTMLElement;
      const cardStyle = getComputedStyle(card);
      const cardNameStyle = getComputedStyle(cardName);
      const rowStyle = getComputedStyle(rowValue);
      const pillStyle = getComputedStyle(pill);
      const buttonStyle = getComputedStyle(button);
      const quickStyle = getComputedStyle(quickSend);
      return {
        cardText: contrast(cardNameStyle.color, cardStyle.backgroundColor),
        rowText: contrast(rowStyle.color, cardStyle.backgroundColor),
        statePill: contrast(pillStyle.color, pillStyle.backgroundColor),
        buttonText: contrast(buttonStyle.color, buttonStyle.backgroundColor),
        quickSendText: contrast(quickStyle.color, quickStyle.backgroundColor),
      };
    });

    expect(ratios.cardText).toBeGreaterThanOrEqual(4.5);
    expect(ratios.rowText).toBeGreaterThanOrEqual(4.5);
    expect(ratios.statePill).toBeGreaterThanOrEqual(4.5);
    expect(ratios.buttonText).toBeGreaterThanOrEqual(4.5);
    expect(ratios.quickSendText).toBeGreaterThanOrEqual(4.5);
  });
}

test("AC9 — choosing a model refetches it, closes the entity panel and redraws the topology", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: { "hm-demo": healthModel, "hm-payments": paymentsHealthModel },
  });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");

  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  await expect(page.getByTestId("entity-details")).toBeVisible();

  const refetch = page.waitForRequest(
    (req) => req.url().includes("/api/health-model?") && req.url().includes("model=hm-payments"),
  );
  await page.getByTestId("model-picker-search").click();
  await page.getByRole("option", { name: "hm-payments (rg-demo)" }).click();
  const url = new URL((await refetch).url());
  expect(url.searchParams.get("model")).toBe("hm-payments");
  expect(url.searchParams.get("resourceGroup")).toBe("rg-demo");
  expect(url.searchParams.get("subscription")).toBe(SUBSCRIPTION_A);

  await expect(page.getByTestId("entity-details")).toHaveCount(0);
  await expect(page.getByTestId("model-name")).toHaveText(paymentsHealthModel.model.name);
  await expect(page.locator(".react-flow__node")).toHaveCount(paymentsHealthModel.entities.length);
});

test("AC10 — the selected model round-trips through the URL on reload", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: { "hm-demo": healthModel, "hm-payments": paymentsHealthModel },
  });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.getByTestId("model-picker-search").click();
  await page.getByRole("option", { name: "hm-payments (rg-demo)" }).click();
  await expect(page.getByTestId("model-name")).toHaveText(paymentsHealthModel.model.name);

  const shared = page.url();
  expect(new URL(shared).search).toBe(
    `?model=hm-payments&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}&view=zoom`,
  );

  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/health-model?") || req.url().endsWith("/api/health-model")) {
      requests.push(req.url());
    }
  });
  await page.goto(shared);
  await page.waitForSelector(".react-flow__node .entity-node");

  expect(requests.length).toBeGreaterThan(0);
  const first = new URL(requests[0]!);
  expect(first.searchParams.get("model")).toBe("hm-payments");
  expect(first.searchParams.get("resourceGroup")).toBe("rg-demo");
  expect(first.searchParams.get("subscription")).toBe(SUBSCRIPTION_A);
  await expect(page.locator(".react-flow__node")).toHaveCount(paymentsHealthModel.entities.length);
});

const QUICK_SEND_COLOURS: Readonly<Record<string, string>> = {
  Healthy: "rgb(47, 122, 31)",
  Degraded: "rgb(138, 75, 0)",
  Unhealthy: "rgb(155, 17, 30)",
  Unknown: "rgb(95, 93, 91)",
};

async function openReportForm(page: Page): Promise<void> {
  await bootTopology(page);
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await page.getByTestId("report-open").click();
  await expect(page.getByTestId("quick-send")).toBeVisible();
}

test("quick-send offers one button per health state in its own colour", async ({ page }) => {
  await openReportForm(page);
  const buttons = page.locator(`[data-testid="quick-send"] button`);
  await expect(buttons).toHaveCount(healthModel.reportOptions.healthStates.length);

  for (const [state, colour] of Object.entries(QUICK_SEND_COLOURS)) {
    const button = page.locator(`[data-testid="quick-send-${state}"]`);
    await expect(button).toHaveText(state);
    const background = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background, `${state} quick-send background`).toBe(colour);
  }
});

test("a quick-send click posts its state with the form's current value, expiry and reason", async ({
  page,
}) => {
  await openReportForm(page);
  await page.selectOption("#report-value", { label: "0.5" });
  await page.selectOption("#report-expiry", { label: "15" });
  await page.selectOption("#report-reason", { label: "Maintenance window" });

  const postRequest = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/entities/svc-a/health-reports" && req.method() === "POST",
  );
  await page.getByTestId("quick-send-Unhealthy").click();

  expect((await postRequest).postDataJSON()).toEqual({
    signalName: "web-ui-health-report",
    healthState: "Unhealthy",
    value: 0.5,
    expiresInMinutes: 15,
    reasonPreset: "maintenance",
  });
  await expect(page.getByTestId("report-id")).toHaveText(reportResponse.reportId);
});

test("quick-send obeys the custom reason validation", async ({ page }) => {
  await openReportForm(page);
  let postCount = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/health-reports")) postCount += 1;
  });

  await page.selectOption("#report-reason", { label: "Custom reason" });
  await page.getByTestId("quick-send-Healthy").click();

  await expect(page.locator("#report-custom-reason")).toHaveAttribute("aria-invalid", "true");
  await page.waitForTimeout(200);
  expect(postCount).toBe(0);
});

test("the refresh button issues exactly one health-model request", async ({ page }) => {
  await bootTopology(page);
  let requests = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/health-model") requests += 1;
  });
  await page.getByTestId("refresh-now").click();
  await page.waitForTimeout(300);
  expect(requests).toBe(1);
});

test("an in-flight refresh shows the indicator and keeps the topology rendered", async ({ page }) => {
  await bootTopology(page);
  let release: (() => void) | null = null;
  await page.route("**/api/health-model*", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(healthModel),
    });
  });

  await page.getByTestId("refresh-now").click();
  await expect(page.getByTestId("refresh-indicator")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await expect(page.getByTestId("topology-placeholder")).toHaveCount(0);

  release?.();
  await expect(page.getByTestId("refresh-indicator")).toBeHidden();
});

test("an accepted report counts down from 10 and then refreshes the model", async ({ page }) => {
  await page.clock.install();
  await openReportForm(page);

  let reloads = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/health-model") reloads += 1;
  });

  await page.getByTestId("quick-send-Degraded").click();
  await expect(page.getByTestId("report-id")).toHaveText(reportResponse.reportId);
  await expect(page.getByTestId("refresh-countdown")).toHaveText("10");

  await page.clock.runFor("00:03");
  await expect(page.getByTestId("refresh-countdown")).toHaveText("7");
  expect(reloads, "no reload before the countdown ends").toBe(0);

  await page.clock.runFor("00:07");
  await expect(page.getByTestId("refresh-countdown")).toBeHidden();
  await expect.poll(() => reloads).toBe(1);
});

test("switching models does not leave the previous model on screen while loading", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: { "hm-demo": healthModel, "hm-payments": paymentsHealthModel },
  });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.getByTestId("model-name")).toHaveText(healthModel.model.name);

  let release: (() => void) | null = null;
  await page.route("**/api/health-model*", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(paymentsHealthModel),
    });
  });

  await page.getByTestId("model-picker-search").click();
  await page.getByRole("option", { name: "hm-payments (rg-demo)" }).click();
  await expect(page.getByTestId("refresh-indicator")).toBeVisible();
  await expect(page.getByTestId("model-name")).not.toHaveText(healthModel.model.name);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.getByTestId("topology-placeholder")).toBeVisible();

  release?.();
  await expect(page.getByTestId("model-name")).toHaveText(paymentsHealthModel.model.name);
  await expect(page.locator(".react-flow__node")).toHaveCount(paymentsHealthModel.entities.length);
});

test("an unrecognised health state does not unmount the app", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const exotic = JSON.parse(JSON.stringify(healthModel)) as typeof healthModel;
  (exotic.entities[0] as { healthState: string }).healthState = "Rebooting";
  (exotic.reportOptions as { healthStates: string[] }).healthStates = [
    ...healthModel.reportOptions.healthStates,
    "Rebooting",
  ];

  await installStubs(page, { healthModelFails: false, model: exotic });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  await page.getByTestId("report-open").click();

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator(`[data-testid="quick-send"] button`)).toHaveCount(
    exotic.reportOptions.healthStates.length,
  );
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

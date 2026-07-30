import { expect, type Page, test } from "@playwright/test";

const model = {
  model: {
    id: "model-id",
    name: "hm-ahm-demo",
    location: "northeurope",
    provisioningState: "Succeeded",
    healthState: "Healthy",
  },
  observedAt: "2026-07-30T09:00:00Z",
  entities: [
    {
      name: "container-app",
      displayName: "Python Container App",
      healthState: "Healthy",
      impact: "Standard",
      canvasPosition: { x: 300, y: 470 },
      discoveredBy: null,
      parents: [],
      children: ["postgres"],
      unlinked: false,
      latestEvaluationAt: "2026-07-30T08:59:00Z",
      latestTransitionAt: null,
      signals: [],
      report: { eligible: true, signalName: "web-ui-health-report" },
    },
    {
      name: "postgres",
      displayName: "PostgreSQL Flexible Server",
      healthState: "Unhealthy",
      impact: "Standard",
      canvasPosition: { x: 140, y: 650 },
      discoveredBy: null,
      parents: ["container-app"],
      children: [],
      unlinked: false,
      latestEvaluationAt: "2026-07-30T08:59:00Z",
      latestTransitionAt: "2026-07-30T08:50:00Z",
      signals: [],
      report: { eligible: true, signalName: "web-ui-health-report" },
    },
    {
      name: "retired-node",
      displayName: "Retired Node",
      healthState: "Deleted",
      impact: "Standard",
      canvasPosition: { x: 460, y: 650 },
      discoveredBy: null,
      parents: [],
      children: [],
      unlinked: true,
      latestEvaluationAt: null,
      latestTransitionAt: null,
      signals: [],
      report: { eligible: false, signalName: "web-ui-health-report" },
    },
  ],
  relationships: [
    { parentEntityName: "container-app", childEntityName: "postgres" },
  ],
  reportOptions: {
    signalName: "web-ui-health-report",
    healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"],
    values: [null, 0, 0.5, 1],
    expiries: [1, 5, 15, 30, 60, 120],
    reasonPresets: [
      { value: "demo-test", label: "Demo test" },
      { value: "investigating", label: "Investigating" },
      { value: "maintenance", label: "Maintenance window" },
      { value: "recovery", label: "Recovery confirmed" },
      { value: "custom", label: "Custom reason" },
    ],
  },
};

async function loadHealthPulse(page: Page) {
  await page.route("**/api/health-model", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(model),
    }),
  );
  await page.goto("/");
  await expect(page.locator(".entity-surface").first()).toBeVisible();
}

function card(page: Page, entity: string) {
  return page.locator(".entity-surface").filter({
    has: page.locator(`.entity-name:text-is("${entity}")`),
  });
}

test("a single click on a state button sends one complete report", async ({
  page,
}) => {
  await loadHealthPulse(page);

  const submitted: Array<Record<string, unknown>> = [];
  await page.route("**/api/entities/postgres/health-reports", (route) => {
    submitted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        status: "accepted",
        reportId: "11111111-2222-3333-4444-555555555555",
        entityName: "postgres",
        signalName: "web-ui-health-report",
        requestedState: "Healthy",
        submittedAt: "2026-07-30T09:00:00Z",
        expiresAt: "2026-07-30T09:30:00Z",
      }),
    });
  });

  const postgres = card(page, "postgres");
  await postgres
    .locator('.quick-report-button[data-health-state="Healthy"]')
    .click();

  await expect(postgres.locator(".quick-report-status")).toContainText(
    "Accepted as 11111111-2222-3333-4444-555555555555",
  );
  expect(submitted).toEqual([
    {
      signalName: "web-ui-health-report",
      healthState: "Healthy",
      value: 1,
      reasonPreset: "demo-test",
      expiresInMinutes: 30,
    },
  ]);
});

test("the options panel changes value, reason and expiry before sending", async ({
  page,
}) => {
  await loadHealthPulse(page);

  const submitted: Array<Record<string, unknown>> = [];
  await page.route("**/api/entities/container-app/health-reports", (route) => {
    submitted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        status: "accepted",
        reportId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        entityName: "container-app",
        signalName: "web-ui-health-report",
        requestedState: "Degraded",
        submittedAt: "2026-07-30T09:00:00Z",
        expiresAt: "2026-07-30T10:00:00Z",
      }),
    });
  });

  const app = card(page, "container-app");
  const toggle = app.locator(".quick-report-options");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const panel = app.locator(".quick-report-panel");
  await expect(panel).toBeVisible();
  await expect(app.locator(".quick-report-preview")).toContainText(
    "A single click sends:",
  );
  await panel.locator(".quick-report-value").selectOption("0");
  await panel.locator(".quick-report-reason").selectOption("maintenance");
  await panel.locator(".quick-report-expiry").selectOption("60");
  await expect(app.locator(".quick-report-preview")).toContainText(
    "reason maintenance, expires in 60 minutes",
  );

  await app
    .locator('.quick-report-button[data-health-state="Degraded"]')
    .click();

  expect(submitted).toEqual([
    {
      signalName: "web-ui-health-report",
      healthState: "Degraded",
      value: 0,
      reasonPreset: "maintenance",
      expiresInMinutes: 60,
    },
  ]);
});

test("state buttons carry a label and an icon, and Deleted entities offer none", async ({
  page,
}) => {
  await loadHealthPulse(page);

  for (const entity of ["container-app", "postgres"]) {
    const buttons = card(page, entity).locator(".quick-report-button");
    await expect(buttons).toHaveCount(3);
    for (const state of ["Healthy", "Degraded", "Unhealthy"]) {
      const button = card(page, entity).locator(
        `.quick-report-button[data-health-state="${state}"]`,
      );
      await expect(button.locator(".quick-report-text")).toHaveText(state);
      await expect(button.locator(".quick-report-icon")).not.toHaveText("");
      await expect(button).toBeEnabled();
    }
  }

  const retired = card(page, "retired-node");
  for (const state of ["Healthy", "Degraded", "Unhealthy"]) {
    await expect(
      retired.locator(`.quick-report-button[data-health-state="${state}"]`),
    ).toBeDisabled();
  }
  await expect(retired.locator(".quick-report-options")).toBeDisabled();
  await expect(retired.locator(".quick-report-status")).toContainText(
    "not reportable",
  );
});

test("quick report buttons stay usable at desktop, tablet and phone widths", async ({
  page,
}) => {
  for (const [label, width, height] of [
    ["1440", 1440, 900],
    ["768", 768, 1024],
    ["390", 390, 844],
  ] as Array<[string, number, number]>) {
    await page.setViewportSize({ width, height });
    await loadHealthPulse(page);
    await expect(
      card(page, "postgres").locator(".quick-report-button"),
    ).toHaveCount(3);
    await page.screenshot({
      path: `../../artifacts/health-report-ui/quick-report-${label}.png`,
      fullPage: true,
    });
  }
});

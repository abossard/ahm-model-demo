import { expect, type Page } from "@playwright/test";
import type { Capture } from "./capture";

/** Build the orders workload through the local app and leave its receipt open for the tour. */
export async function captureBuilder(page: Page, capture: Capture): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Create new health model" }).click();
  const builder = page.frameLocator('iframe[title="Health model builder"]');
  await builder.getByRole("checkbox", { name: "Include the entire rg-local resource group" }).check();
  await builder.getByLabel("Model name prefix").fill("orders-health");
  const selection = builder.getByRole("status").filter({ hasText: "1 resource group and 0 individual resources selected" });
  await capture.step("resources", selection, { shot: builder.locator("main.builder") });
  await builder.getByRole("button", { name: "Analyze resources" }).click();

  const workload = builder.getByRole("region", { name: "Proposed health model" });
  const cpu = workload.getByRole("list", { name: "Signals to create" }).getByRole("listitem")
    .filter({ hasText: "orders-api · CpuPercentage" });
  await expect(cpu).toContainText("Observed 12%");
  await capture.step("evidence", cpu.getByText(/Unhealthy when above/), { shot: cpu });
  await builder.getByRole("button", { name: "Confirm and suggest models" }).click();
  await builder.getByRole("radio", { name: /^Workload operation/ }).check();
  await builder.getByRole("button", { name: "Preview selected model" }).click();
  const diagram = builder.getByRole("figure", { name: /^Designer layout/ });
  await diagram.getByRole("button", { name: "Complete an order, User flow" }).click();
  const dependency = diagram.getByText("Depends on Order processing.", { exact: true });
  await capture.step("design", dependency, { shot: diagram });

  await builder.getByRole("button", { name: "Create health model", exact: true }).click();
  const confirm = builder.getByRole("button", { name: "Confirm creation in Azure" });
  await confirm.scrollIntoViewIfNeeded();
  await capture.clip("build-model", async () => {
    await confirm.click();
    await expect(builder.getByRole("heading", { name: "Health model created" })).toBeVisible();
    const tour = builder.getByRole("button", { name: "Tour this model" });
    await expect(tour).toBeEnabled();
    await tour.scrollIntoViewIfNeeded();
  });
  const receipt = builder.getByText(/^The model and its Designer layout are saved in/);
  await capture.step("created", receipt, { shot: builder.locator("main.builder") });
}

import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "@playwright/test";
import { captureBuilder } from "./builder";
import { Capture } from "./capture";
import { captureTour } from "./tour";

test("record the orders model from builder to first healthy signal", async ({ page }, testInfo) => {
  const staging = testInfo.outputPath("guide");
  await mkdir(path.join(staging, "media"), { recursive: true });
  const capture = new Capture(page, staging);
  await test.step("Build the orders model", () => captureBuilder(page, capture));
  await test.step("Inspect its first signal readings", () => captureTour(page, capture));
  await capture.finish();
  // Keep the last complete guide until the walkthrough and all GIF encodes succeed.
  const published = fileURLToPath(new URL("../../../../docs/onboarding/tour/", import.meta.url));
  await cp(staging, published, { recursive: true });
});

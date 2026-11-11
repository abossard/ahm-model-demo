import type { Page } from "@playwright/test";
import type { ViewId } from "../src/model/views";

/**
 * Opens the app in one view by its address, as a link would. Specs that assert on a particular
 * drawing open it explicitly, so a change of the default view never changes what they measure.
 */
export async function openView(page: Page, id: ViewId, path = "/"): Promise<void> {
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}view=${id}`);
}

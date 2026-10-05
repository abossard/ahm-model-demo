import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import jsQR from "jsqr";

async function create(page: Page, statements = ["First statement", "Second statement"]) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Join", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Create a survey" }).click();
  for (const [index, statement] of statements.entries()) {
    await page.getByRole("button", { name: "Add statement", exact: true }).click();
    await page.getByRole("textbox", { name: `Statement ${index + 1}`, exact: true }).fill(statement);
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("p[role=status]")).toContainText("Saved version 1");
  const privateLink = await page.getByRole("textbox", { name: /Private editing URL/ }).inputValue();
  const code = privateLink.split("/edit/")[1]?.split("#")[0];
  if (!code) throw new Error("Missing survey code");
  return { code, privateLink };
}

test("author create, labelled preview, drag order, private recovery and independently decoded QR", async ({ page }) => {
  const survey = await create(page, ["<b>Plain text</b>", "Other statement", "Last statement"]);
  await expect(page.getByRole("slider")).toHaveCount(3);
  await expect(page.getByRole("slider").first()).toBeDisabled();
  await expect(page.locator(".slider b")).toHaveCount(0);
  const ids = await page.locator("[data-question-id]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-question-id")));
  const handle = await page.getByRole("button", { name: "Drag statement 1", exact: true }).boundingBox();
  if (!handle) throw new Error("Missing handle");
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 100, handle.y + 100);
  await page.getByRole("button", { name: "Drag statement 1", exact: true })
    .dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  expect(await page.locator("[data-question-id]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-question-id")))).toEqual(ids);
  await page.getByRole("button", { name: "Drag statement 1", exact: true }).dragTo(page.locator(".question").last());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("p[role=status]")).toContainText("Saved version 2");
  await page.reload();
  await expect(page.locator("p[role=status]")).toContainText("Saved version 2");
  expect(await page.locator("[data-question-id]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-question-id"))))
    .toEqual([ids[1], ids[2], ids[0]]);
  await page.goto(survey.privateLink);
  await expect(page.getByRole("heading", { name: `Edit ${survey.code}` })).toBeVisible();
  await expect(page).toHaveURL(`/edit/${survey.code}`);
  const image = page.getByRole("img", { name: `QR code to join survey ${survey.code}` });
  await expect(image).toBeVisible();
  const pixels = await image.evaluate(async node => {
    if (!(node instanceof HTMLImageElement)) throw new Error("Not an image");
    await node.decode();
    const canvas = document.createElement("canvas");
    canvas.width = node.naturalWidth; canvas.height = node.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas");
    ctx.drawImage(node, 0, 0);
    return { data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
      width: canvas.width, height: canvas.height };
  });
  expect(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data)
    .toBe(`http://127.0.0.1:4174/join/${survey.code}`);
  await page.goto("/");
  await expect(page.getByRole("link", { name: `Edit ${survey.code}` })).toBeVisible();
});

test("untouched midpoint, intentional 50, keyboard endpoints, reset and public aggregates", async ({ page, browser }) => {
  const { code } = await create(page);
  await page.goto(`/join/${code.toLowerCase()}`);
  const sliders = page.getByRole("slider");
  await expect(sliders).toHaveCount(2);
  await expect(sliders.first()).toHaveValue("50");
  await expect(page.getByText("Unanswered (50)", { exact: true })).toHaveCount(2);
  const publicContext = await browser.newContext();
  const results = await publicContext.newPage();
  await results.goto(`http://127.0.0.1:4174/results/${code}`);
  await expect(results.getByText("0 answered", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await sliders.nth(1).focus();
  await page.keyboard.press("End");
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await page.reload();
  await expect(sliders.first()).toHaveValue("50");
  await expect(sliders.nth(1)).toHaveValue("100");
  await expect(page.getByText("Answer: 50", { exact: true })).toBeVisible();
  await results.reload();
  await expect(results.getByText("1 answered", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Reset/Delete answer" }).first().click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await page.getByRole("link", { name: "Results", exact: true }).click();
  await expect(page).toHaveURL(`/results/${code}`);
  await expect(page.getByText("0 answered", { exact: true })).toHaveCount(1);
  await expect(page.getByText("1 answered", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Mean agreement: 100.0 / 100")).toBeVisible();
  await publicContext.close();
});

test("slow autosave cannot resurrect reset and failed/lost saves keep one ballot on retry", async ({ page }) => {
  const { code } = await create(page);
  await page.goto(`/join/${code}`);
  await expect(page.getByRole("slider")).toHaveCount(2);
  let first = true;
  await page.route(`**/api/surveys/${code}/ballot`, async route => {
    if (route.request().method() !== "PUT" || !first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  await page.getByRole("slider").first().focus();
  await page.keyboard.press("End");
  await expect(page.locator("p[role=status]")).toHaveText("Saving...");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Reset/Delete answer" }).first().click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByText("Unanswered (50)", { exact: true })).toHaveCount(2);
  await page.unrouteAll();
  let lost = true;
  await page.route(`**/api/surveys/${code}/ballot`, async route => {
    if (route.request().method() === "PUT" && lost) {
      lost = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(page.getByRole("alert").first()).toContainText("Connection lost");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await page.goto(`/results/${code}`);
  await expect(page.getByText("1 answered", { exact: true })).toHaveCount(1);
});

test("author denied storage keeps private URL; response denied storage never sends a ballot", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  const { code, privateLink } = await create(page);
  await expect(page.getByRole("alert").first()).toContainText("Keep your private editing URL");
  await page.goto(privateLink);
  await expect(page.getByRole("textbox", { name: /Private editing URL/ })).toHaveValue(privateLink);
  let writes = 0;
  page.on("request", request => { if (request.method() === "PUT" && request.url().endsWith("/ballot")) writes += 1; });
  await page.goto(`/join/${code}`);
  await expect(page.getByRole("alert").first()).toContainText("Response storage is unavailable");
  expect(writes).toBe(0);
});

test("narrow touch viewport scrolls long survey and pointer changes only selected slider", async ({ page }) => {
  const { code } = await create(page, Array.from({ length: 12 }, (_, i) => `Statement number ${i + 1}`));
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto(`/join/${code}`);
  await expect(page.getByRole("slider")).toHaveCount(12);
  const first = page.getByRole("slider").first();
  const box = await first.boundingBox();
  if (!box) throw new Error("Missing slider");
  await page.mouse.click(box.x + box.width * .75, box.y + box.height / 2);
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await expect(page.getByRole("slider").nth(1)).toHaveValue("50");
  await page.getByRole("link", { name: "Results", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
});

test("malformed and stale author records recover without crash or overwriting storage", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("survey.authors.v1", "{broken"));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("damaged");
  await expect(page.getByRole("link", { name: "Create a survey" })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("survey.authors.v1",
    JSON.stringify([{ code: "ZZZZZY", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }])));
  await page.reload();
  await page.getByRole("link", { name: "Edit ZZZZZY" }).click();
  await expect(page.getByRole("alert")).toContainText("Survey not found");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});

test("wrong private URL does not replace a remembered authorized author key", async ({ page }) => {
  const { code, privateLink } = await create(page);
  await page.goto(`/edit/${code}#key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  await expect(page.getByRole("alert")).toContainText("private editing key is not valid");
  await page.goto("/");
  await expect(page.getByRole("link", { name: `Edit ${code}` })).toHaveAttribute("href", privateLink);
});

test("author can recover saved wording when a first vote locks an unsaved draft", async ({ page, browser }) => {
  const { code } = await create(page);
  await page.getByRole("textbox", { name: "Statement 1", exact: true }).fill("Unsaved changed wording");
  const respondentContext = await browser.newContext();
  const respondent = await respondentContext.newPage();
  await respondent.goto(`http://127.0.0.1:4174/join/${code}`);
  await respondent.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(respondent.locator("p[role=status]")).toHaveText("Saved");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("wording is locked");
  await page.getByRole("button", { name: "Reload saved definition", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Statement 1", exact: true })).toHaveValue("First statement");
  await page.getByRole("button", { name: "Add statement", exact: true }).click();
  await page.getByRole("textbox", { name: "Statement 3", exact: true }).fill("Allowed new statement");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("p[role=status]")).toContainText("Saved version 2");
  await respondentContext.close();
});

test("first-save lost reply retains original author capability and survey", async ({ page }) => {
  let createdCode = "";
  let first = true;
  const keys: string[] = [];
  await page.route("**/api/surveys", async route => {
    keys.push(route.request().headers().authorization ?? "");
    if (first) {
      first = false;
      const response = await route.fetch();
      const value: unknown = await response.json();
      if (typeof value === "object" && value && "code" in value && typeof value.code === "string")
        createdCode = value.code;
      await route.abort();
    } else await route.continue();
  });
  await page.goto("/create");
  await page.getByRole("button", { name: "Add statement", exact: true }).click();
  await page.getByRole("textbox", { name: "Statement 1", exact: true }).fill("Creation retry");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Connection lost");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("p[role=status]")).toContainText("Saved version 1");
  await expect(page).toHaveURL(`/edit/${createdCode}`);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("response rejoin retains ballot; cleared storage and fresh browser may create another", async ({ page, browser }) => {
  const { code } = await create(page);
  await page.goto(`/join/${code}`);
  await page.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await page.goto("/");
  await page.getByRole("textbox", { name: "Survey code", exact: true }).fill(code.toLowerCase());
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByText("Answer: 50", { exact: true })).toBeVisible();
  await page.evaluate(code => localStorage.removeItem(`survey.response.v1.${code}`), code);
  await page.reload();
  await expect(page.getByText("Unanswered (50)", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(`http://127.0.0.1:4174/join/${code}`);
  await fresh.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(fresh.locator("p[role=status]")).toHaveText("Saved");
  await fresh.goto(`http://127.0.0.1:4174/results/${code}`);
  await expect(fresh.getByText("3 answered", { exact: true })).toBeVisible();
  await context.close();
});

test("a failed reset and pending Results keep edits until Retry commits", async ({ page }) => {
  const { code } = await create(page);
  await page.goto(`/join/${code}`);
  await page.getByRole("button", { name: "Use 50 as my answer" }).first().click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  let fail = true;
  await page.route(`**/api/surveys/${code}/ballot`, async route => {
    if (route.request().method() === "PUT" && fail) {
      await route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ error: { message: "Storage is unavailable. Retry." } }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Reset/Delete answer" }).first().click();
  await expect(page.getByRole("alert").first()).toContainText("Storage is unavailable");
  await page.getByRole("link", { name: "Results", exact: true }).click();
  await expect(page).toHaveURL(`/join/${code}`);
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("p[role=status]")).toHaveText("Saved");
  await page.getByRole("link", { name: "Results", exact: true }).click();
  await expect(page.getByText("0 answered", { exact: true })).toHaveCount(2);
});

test("real touch scrolling stays vertical and does not answer an untouched slider", async ({ page, browser }) => {
  const { code } = await create(page, Array.from({ length: 10 }, (_, i) => `Touch statement ${i}`));
  const context = await browser.newContext({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
  const touch = await context.newPage();
  await touch.goto(`http://127.0.0.1:4174/join/${code}`);
  await expect(touch.getByRole("slider")).toHaveCount(10);
  const slider = await touch.getByRole("slider").first().boundingBox();
  if (!slider) throw new Error("Missing touch slider");
  const session = await context.newCDPSession(touch);
  const x = slider.x + slider.width * .2;
  const y = slider.y + slider.height / 2;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let delta = 20; delta <= 160; delta += 20)
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - delta }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => touch.evaluate(() => window.scrollY)).toBeGreaterThan(50);
  await expect(touch.getByText("Unanswered (50)", { exact: true })).toHaveCount(10);
  await touch.getByRole("slider").first().scrollIntoViewIfNeeded();
  const control = await touch.getByRole("slider").first().boundingBox();
  if (!control) throw new Error("Missing touch control");
  await touch.touchscreen.tap(control.x + control.width * .75, control.y + control.height / 2);
  await expect(touch.locator("p[role=status]")).toHaveText("Saved");
  await expect(touch.getByText("Unanswered (50)", { exact: true })).toHaveCount(9);
  await context.close();
});

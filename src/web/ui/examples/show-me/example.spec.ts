import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`an inline button and a walkthrough share the same destinations at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/examples/show-me/");
    const chat = page.getByRole("complementary", { name: "Assistant" });
    const dialog = page.getByRole("dialog", { name: "Database migration" });
    const releaseHistory = page.getByRole("region", { name: "Release history" });
    await expect(dialog).toBeHidden();
    await expect(releaseHistory).toBeHidden();
    await chat.locator('[data-show-me-id="check/migration"]').click();
    await expect(dialog).toHaveAttribute("data-show-me-highlight", "amber");
    await expect(dialog).toHaveAccessibleDescription("Required for release");
    await expect(dialog).toHaveCSS("outline-style", "solid");
    await expect(page.getByRole("note")).toBeInViewport();
    await expect(dialog).toBeInViewport();
    await expect(chat).toBeInViewport();

    // The user can still act on the reply while details are open.
    const choices = chat.getByRole("group", { name: "Where next?" });
    await expect(choices.getByRole("button")).toHaveCount(2);
    await choices.getByRole("button", { name: "See release history" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#history$/);
    await expect(releaseHistory).toHaveAttribute("data-show-me-highlight", "violet");
    await expect(releaseHistory).toHaveAccessibleDescription("Latest run");
    await expect(page.getByRole("note")).toBeInViewport();
    await expect(dialog).toBeHidden();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Preflight checks" })).toBeVisible();
    await expect(page.locator("[data-show-me-highlight]")).toHaveCount(0);

    await chat.getByRole("button", { name: "Walk through the checks" }).click();
    await expect(dialog).toBeVisible();
    await chat.getByRole("button", { name: "Next · Release history" }).click();
    await expect(releaseHistory).toHaveAccessibleDescription("Latest run");
    await chat.getByRole("button", { name: "Finish walkthrough" }).click();
    await expect(page.locator("[data-show-me-annotation]")).toHaveCount(0);
    await expect(chat).toBeInViewport();
  });
}

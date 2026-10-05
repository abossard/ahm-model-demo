import { expect, test } from "@playwright/test";

test("@live-readonly renders the current deployment shell and model controls", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status-bar")).toBeVisible();
  await expect(page.getByTestId("model-name")).toBeVisible();
  await expect(page.getByTestId("journey")).toBeVisible();
  await expect(page.getByTestId("journey-description")).toContainText(
    "enqueues first, then writes PostgreSQL, then peeks",
  );
  await expect(page.getByTestId("journey-hosting")).toContainText(
    "PostgreSQL Flexible Server",
  );
});

test("@live-readonly opens the assistant iframe through same-origin /agent", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await page.getByTestId("chat-toggle").click();
  const frame = page.getByTestId("chat-frame");
  await expect(frame).toBeVisible();
  const src = await frame.getAttribute("src");
  expect(src).toBe("/agent?embed=1");
  const embedded = page.frameLocator('[data-testid="chat-frame"]');
  await expect
    .poll(
      async () =>
        embedded.locator("html").evaluate((node) => node.dataset.agentReady ?? ""),
      { timeout: 30_000 },
    )
    .toBe("true");
  await expect(embedded.getByRole("textbox").first()).toBeVisible({
    timeout: 30_000,
  });
  const agentRequests = requests.filter((url) => new URL(url).pathname.startsWith("/agent"));
  expect(agentRequests.length).toBeGreaterThan(0);
  for (const url of agentRequests) {
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
  }
});

test.fixme(
  "@live-mutation request journey exercise remains pending explicit mutation authorization and cleanup protocol",
  async () => {
    test.fixme(
      true,
      "Pending: mutation scenario must assert pre/post journey state and explicit restoration workflow before enabling live writes.",
    );
  },
);

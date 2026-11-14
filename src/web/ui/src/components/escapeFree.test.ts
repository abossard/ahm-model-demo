import { afterEach, describe, expect, it } from "vitest";
import { escapeIsFree } from "./escapeFree";

describe("an Escape that nothing else takes", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    { name: "nothing is open", html: "", prevented: false, free: true },
    { name: "a Fluent overlay closed with it", html: "", prevented: true, free: false },
    { name: "a move is being reordered", html: '<div class="is-reordering"></div>', prevented: false, free: false },
    { name: "an overlay in its exit motion is still in the page", html: '<div role="dialog"></div>', prevented: false, free: true },
  ])("is free or not when $name", ({ html, prevented, free }) => {
    document.body.innerHTML = html;
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    if (prevented) event.preventDefault();

    expect(escapeIsFree(event)).toBe(free);
  });
});

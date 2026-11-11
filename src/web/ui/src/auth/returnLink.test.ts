import { beforeEach, describe, expect, it } from "vitest";
import { rememberReturn, takeReturn } from "./returnLink";

beforeEach(() => window.sessionStorage.clear());

describe("the address kept through a sign-in redirect", () => {
  it.each([
    "?model=hm-demo&resourceGroup=rg&subscription=11111111-1111-1111-1111-111111111111",
    "?model=hm-demo&resourceGroup=rg&subscription=s&session=c4c19c774d06&task=2",
  ])("gives back %s once", (search) => {
    rememberReturn(window.sessionStorage, search);
    expect(takeReturn(window.sessionStorage)).toBe(search);
    expect(takeReturn(window.sessionStorage)).toBeNull();
  });

  it.each([
    { name: "nothing was kept", kept: null },
    { name: "the address had no query", kept: "" },
    { name: "what was kept is not a query", kept: "https://evil.example/?x=1" },
    { name: "what was kept carries a fragment", kept: "?model=a#token=1" },
  ])("gives back nothing when $name", ({ kept }) => {
    if (kept !== null) window.sessionStorage.setItem("health-pulse-return-query", kept);
    if (kept === "") rememberReturn(window.sessionStorage, "?model=old");
    if (kept === "") rememberReturn(window.sessionStorage, "");
    expect(takeReturn(window.sessionStorage)).toBeNull();
  });

  it("gives back nothing when storage throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => rememberReturn(broken, "?model=a")).not.toThrow();
    expect(takeReturn(broken)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { clockTime, pingLine, pushPing } from "./logic";

describe("hello logic", () => {
  it.each([
    [0, "Nothing sent yet."],
    [1, "One ping counted by the server."],
    [7, "7 pings counted by the server."],
  ])("pingLine(%i)", (pings, line) => expect(pingLine(pings)).toBe(line));

  it.each([
    [0, "00:00:00 UTC"],
    [Date.UTC(2026, 0, 1, 13, 5, 9), "13:05:09 UTC"],
  ])("clockTime(%i)", (epoch, text) => expect(clockTime(epoch)).toBe(text));

  it("keeps the newest four, newest first", () => {
    const rows = [1, 2, 3, 4, 5].reduce(
      (all, n) => pushPing(all, { at: n, roundTripMs: n, serverTime: n }),
      [] as ReturnType<typeof pushPing>,
    );
    expect(rows.map((row) => row.at)).toEqual([5, 4, 3, 2]);
  });
});

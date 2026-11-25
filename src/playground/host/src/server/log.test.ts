import { describe, expect, it } from "vitest";
import { createLog } from "./log";
import type { Level } from "./log";

describe("createLog", () => {
  it.each<[Level, Level, boolean]>([
    ["debug", "info", false],
    ["info", "info", true],
    ["error", "warn", true],
  ])("a %s line at level %s is written: %s", (level, min, written) => {
    const lines: string[] = [];
    createLog("svc", min, (line) => lines.push(line), () => new Date(0))(level, "wire", { sid: "s" });
    expect(lines.map((line) => JSON.parse(line))).toEqual(written ? [{ t: "1970-01-01T00:00:00.000Z", level, svc: "svc", msg: "wire", sid: "s" }] : []);
  });
});

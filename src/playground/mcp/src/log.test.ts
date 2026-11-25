import { describe, expect, it } from "vitest";
import { createLogger } from "./log";

describe("createLogger", () => {
  it.each([
    { level: "debug" as const, call: "debug" as const, lines: 1 },
    { level: "info" as const, call: "debug" as const, lines: 0 },
    { level: "info" as const, call: "warn" as const, lines: 1 },
    { level: "error" as const, call: "warn" as const, lines: 0 },
  ])("level $level, call $call writes $lines lines", ({ level, call, lines }) => {
    const out: string[] = [];
    createLogger("svc", level, (line) => out.push(line), () => 0)[call]("tool", { tool: "x" });
    expect(out).toHaveLength(lines);
  });

  it("writes one JSON object with t, level, svc, msg and the fields", () => {
    const out: string[] = [];
    createLogger("playground-mcp", "debug", (line) => out.push(line), () => 0).info("tool", { trace: "t1", ms: 3 });
    expect(JSON.parse(out[0]!)).toEqual({ t: "1970-01-01T00:00:00.000Z", level: "info", svc: "playground-mcp", msg: "tool", trace: "t1", ms: 3 });
  });
});

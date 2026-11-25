import { describe, expect, it } from "vitest";
import { sha256 } from "../../server/views";
import { sha256Hex, uiResourceUri } from "./mount";

describe("sha256Hex", () => {
  it.each(["abc", "", "héllo wörld ✓", "x".repeat(300_000)])("equals the digest the host server files %j under", async (text) => {
    expect(await sha256Hex(text)).toBe(sha256(text));
  });
});

describe("uiResourceUri", () => {
  it.each([
    ["a tool with a View", { name: "t", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://playground/hello.html" } } }, "ui://playground/hello.html"],
    ["a tool with no View", { name: "t", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }, undefined],
    ["a tool with no meta", { name: "t", inputSchema: { type: "object" } }, undefined],
    ["no tool", undefined, undefined],
  ])("reads %s", (_name, tool, expected) => {
    expect(uiResourceUri(tool as never)).toBe(expected);
  });
});

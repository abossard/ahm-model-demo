import { describe, expect, it } from "vitest";
import { audienceOf, isModelVisible, seedFromSchema } from "./schemaSeed";

const player = { id: "p-1", handle: "Neon Pilot" };

describe("seedFromSchema", () => {
  it.each([
    ["the player is filled in", { type: "object", properties: { player: { type: "object" } }, required: ["player"] }, { player }],
    ["optional fields are left out", { type: "object", properties: { name: { type: "string" } } }, {}],
    ["a string starts empty", { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, { text: "" }],
    ["a number starts at its minimum", { type: "object", properties: { from: { type: "integer", minimum: 1 } }, required: ["from"] }, { from: 1 }],
    ["a negative minimum starts at zero", { type: "object", properties: { v: { type: "integer", minimum: -1 } }, required: ["v"] }, { v: 0 }],
    ["an enum starts at its first value", { type: "object", properties: { a: { enum: ["hit", "stand"] } }, required: ["a"] }, { a: "hit" }],
    ["a union skips null", { type: "object", properties: { t: { anyOf: [{ type: "null" }, { type: "string" }] } }, required: ["t"] }, { t: "" }],
    ["a list starts empty", { type: "object", properties: { path: { type: "array" } }, required: ["path"] }, { path: [] }],
    ["a default wins", { type: "object", properties: { n: { type: "number", default: 7 } }, required: ["n"] }, { n: 7 }],
    ["nested objects", { type: "object", properties: { o: { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] } }, required: ["o"] }, { o: { b: false } }],
    ["not a schema", null, {}],
  ])("%s", (_name, schema, expected) => {
    expect(seedFromSchema(schema, player)).toEqual(expected);
  });
});

describe("audienceOf", () => {
  it.each([
    ["model and app", { ui: { visibility: ["model", "app"] } }, ["model", "app"], true],
    ["app only", { ui: { visibility: ["app"] } }, ["app"], false],
    ["model only", { ui: { visibility: ["model"] } }, ["model"], true],
    ["no meta means both", undefined, ["model", "app"], true],
    ["junk means both", { ui: { visibility: ["x"] } }, ["model", "app"], true],
  ])("%s", (_name, meta, audience, model) => {
    expect(audienceOf(meta)).toEqual(audience);
    expect(isModelVisible(meta)).toBe(model);
  });
});

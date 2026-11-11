import { describe, expect, it } from "vitest";
import { inlineParts, splitAnswer } from "./agentText";

describe("splitAnswer", () => {
  it.each([
    { name: "one sentence", text: "Service C is Unhealthy because its queue is full.", answer: "Service C is Unhealthy because its queue is full.", evidence: "" },
    { name: "two sentences", text: "Service C is Unhealthy. The queue holds 42 items.", answer: "Service C is Unhealthy.", evidence: "The queue holds 42 items." },
    { name: "a dot inside a setting", text: "It is Unknown because resourceHealth.enabled = Disabled. Nothing else reports.", answer: "It is Unknown because resourceHealth.enabled = Disabled.", evidence: "Nothing else reports." },
    { name: "a number with a decimal", text: "CPU is 0.2 of the limit. Latency is high.", answer: "CPU is 0.2 of the limit.", evidence: "Latency is high." },
    { name: "a full stop inside inline code", text: "Check `a. b` first. Then wait.", answer: "Check `a. b` first.", evidence: "Then wait." },
    { name: "a sentence ended by a bracket", text: "It is Unknown (`resourceHealth.enabled = Disabled`). The path is not queryable.", answer: "It is Unknown (`resourceHealth.enabled = Disabled`).", evidence: "The path is not queryable." },
    { name: "a question", text: "Why? Because.", answer: "Why?", evidence: "Because." },
    { name: "no end mark", text: "No end mark", answer: "No end mark", evidence: "" },
    { name: "surrounding space", text: "  Padded.  More.  ", answer: "Padded.", evidence: "More." },
    { name: "nothing", text: "", answer: "", evidence: "" },
  ])("splits $name", ({ text, answer, evidence }) => {
    expect(splitAnswer(text)).toEqual({ answer, evidence });
  });
});

describe("inlineParts", () => {
  it.each([
    { name: "plain text", text: "Nothing special here.", expected: [{ text: "Nothing special here.", code: false }] },
    { name: "backticked code", text: "Set `a = b` now", expected: [{ text: "Set ", code: false }, { text: "a = b", code: true }, { text: " now", code: false }] },
    { name: "a dotted setting", text: "because resourceHealth.enabled is off", expected: [{ text: "because ", code: false }, { text: "resourceHealth.enabled", code: true }, { text: " is off", code: false }] },
    { name: "a resource path", text: "path /subscriptions/0000/resourceGroups/rg/providers/x/y is not queryable", expected: [{ text: "path ", code: false }, { text: "/subscriptions/0000/resourceGroups/rg/providers/x/y", code: true }, { text: " is not queryable", code: false }] },
    { name: "a GUID", text: "id 123e4567-e89b-12d3-a456-426614174000 was seen", expected: [{ text: "id ", code: false }, { text: "123e4567-e89b-12d3-a456-426614174000", code: true }, { text: " was seen", code: false }] },
    { name: "a name with a dot and no camelCase", text: "It ended.Then", expected: [{ text: "It ended.Then", code: false }] },
    { name: "nothing", text: "", expected: [] },
  ])("cuts $name", ({ text, expected }) => {
    expect(inlineParts(text)).toEqual(expected);
  });
});

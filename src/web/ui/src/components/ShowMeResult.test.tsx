import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { finishedAnnouncement } from "../model/tasks";
import type { Task } from "../model/types";
import type { ShowMeAction } from "../showMe";
import { ResultLink, ResultText, ShowMeResult } from "./ShowMeResult";

const action: ShowMeAction = { handle: "node-detail", id: "db", highlight: { label: "Orders database" } };
function answer(text: string, showMe?: Readonly<Record<string, ShowMeAction>>): Task {
  return {
    id: "turn", seq: 1, sessionId: "topic", type: "explain", status: "done", instruction: "", createdAt: "",
    target: { name: "model", subscriptionId: "sub", resourceGroup: "rg" },
    ...(showMe && { showMeHandles: [{ name: "node-detail", description: "Open details", idDescription: "Entity name" }] }),
    result: { kind: "explain", entity: "db", state: "Unhealthy", summary: text, causes: [], ...(showMe && { showMe }) },
  };
}

describe("saved Show me results", () => {
  it.each([
    { name: "a marker amid text", text: "See [[show:1]] for its state.", map: { "1": action }, shown: "See Show me for its state.", buttons: 1 },
    { name: "successive references", text: "[[show:1]][[show:1]]", map: { "1": action }, shown: "Show meShow me", buttons: 2 },
    { name: "a missing action", text: "See [[show:2]]", map: { "1": action }, shown: "See Destination unavailable", buttons: 0 },
    { name: "a literal marker in a legacy answer", text: "See [[show:1]]", map: undefined, shown: "See [[show:1]]", buttons: 0 },
  ])("renders $name in place", ({ text, map, shown, buttons }) => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(
      <ShowMeResult task={answer(text, map)}><ResultText text={text} renderText={(part) => part} /></ShowMeResult>,
    ), "text/html");
    expect(doc.body.textContent).toBe(shown);
    expect(doc.querySelectorAll("button")).toHaveLength(buttons);
    if (buttons) expect(doc.querySelector("button")?.getAttribute("aria-label")).toBe("Show me – Orders database");
  });

  it.each([
    { name: "a structured reference in a legacy result", map: undefined, expected: "See [[show:1]]Show me", handle: "graph" },
    { name: "a stored tool action", map: { "1": action }, expected: "See Show me", handle: "node-detail" },
    { name: "an action never offered to the agent", map: { "1": { handle: "graph", id: "node/other" } },
      expected: "See Destination unavailableShow me", handle: "graph" },
  ])("renders one grounded button for $name", ({ map, expected, handle }) => {
    const text = "See [[show:1]]";
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(
      <ShowMeResult task={answer(text, map)}>
        <ResultText text={text} renderText={part => part} />
        <ResultLink text={text} action={{ handle: "graph", id: "node/db" }} />
      </ShowMeResult>,
    ), "text/html");
    expect(doc.body.textContent).toBe(expected);
    const buttons = doc.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.dataset.showMeHandle).toBe(handle);
    expect(buttons[0]!.dataset.showMeId).toBe(handle === "graph" ? "node/db" : "db");
  });

  it.each([
    { text: "Look at [[show:1]] the database.", expected: "Answer ready. Look at the database." },
    { text: "The database is unavailable [[show:1]]. See details.", expected: "Answer ready. The database is unavailable." },
  ])("reads prose without marker syntax in ‘$text’", ({ text, expected }) => {
    expect(finishedAnnouncement(answer(text, { "1": action }), null)).toBe(expected);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffViewModel } from "../../tests/viewModels";
import { useStore } from "./store";
import { workspaceShowMe } from "./workspaceShowMe";

const view = diffViewModel();
const task = { sessionId: "topic-a", seq: 2, target: view.target };

describe("Show me in a saved diff", () => {
  beforeEach(() => {
    useStore.setState({
      sessionId: task.sessionId, taskSeq: task.seq, diff: { kind: "success", value: view },
      selectedChanges: ["c3"], workspaceOpen: true,
    });
    document.body.innerHTML = '<main data-show-me-comparison></main><section role="list"><div data-show-me-change="c4"></div></section>';
  });

  afterEach(() => {
    document.body.replaceChildren();
    useStore.setState(useStore.getInitialState(), true);
  });

  it.each([
    { name: "another Session", id: "change/c4", current: { sessionId: "topic-b" } },
    { name: "another Task", id: "comparison", current: { taskSeq: 1 } },
    { name: "another target model", id: "comparison",
      current: { diff: { kind: "success" as const, value: { ...view, target: { ...view.target, name: "other" } } } } },
    { name: "a stale change id", id: "change/removed", current: {} },
    { name: "a Task still loading", id: "change/c4", current: { diff: { kind: "loading" as const } } },
    { name: "an empty comparison", id: "comparison", current: { diff: { kind: "success" as const, value: { ...view, changes: [] } } } },
  ])("declines $name before navigating", async ({ id, current }) => {
    useStore.setState(current);
    const showChange = vi.fn();
    const registry = workspaceShowMe(useStore, task, new Set(["panel"]), showChange);
    expect(await registry.execute({ handle: "panel", id })).toBe("unavailable");
    expect(showChange).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({ workspaceOpen: true, workspaceTarget: null, selectedChanges: ["c3"], compare: false });
  });

  it("moves the annotation from a saved change to comparison, and clears it when comparison closes", async () => {
    const details = document.querySelector("[data-show-me-change]")!;
    const comparison = document.querySelector("[data-show-me-comparison]")!;
    const showChange = vi.fn(() => details);
    const registry = workspaceShowMe(useStore, task, new Set(["panel"]), showChange);
    expect(await registry.execute({ handle: "panel", id: "change/c4" })).toBe("shown");
    expect(showChange).toHaveBeenCalledExactlyOnceWith("c4");
    expect(details.hasAttribute("data-show-me-highlight")).toBe(true);
    expect(await registry.execute({ handle: "panel", id: "comparison" })).toBe("shown");
    expect(details.hasAttribute("data-show-me-highlight")).toBe(false);
    expect(comparison.hasAttribute("data-show-me-highlight")).toBe(true);
    expect(useStore.getState()).toMatchObject({ compare: true, workspaceOpen: true, selectedChanges: ["c3"] });
    useStore.getState().setCompare(false);
    expect(comparison.hasAttribute("data-show-me-highlight")).toBe(false);
    expect(useStore.getState().workspaceTarget).toBeNull();
  });
});

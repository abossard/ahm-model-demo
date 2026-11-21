import { afterEach, describe, expect, it, vi } from "vitest";
import { createShowMe, type ShowMeAction, type ShowMeHandle } from "./index";

const node = { name: "node-detail", description: "Open a node", idDescription: "A valid node id" };
const map = { name: "map", description: "Open the map", idDescription: "" };

afterEach(() => document.body.replaceChildren());

function mount(): HTMLElement {
  return document.body.appendChild(document.createElement("section"));
}

function pendingTarget() {
  let resolve!: (target: Element) => void;
  const promise = new Promise<Element>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Show me handles", () => {
  it("describes offered handles without invoking or exposing their callbacks", () => {
    const open = vi.fn(() => null);
    const registry = createShowMe([{ ...node, open }, { ...map, open }]);
    expect(registry.describe()).toEqual([node, map]);
    registry.describe().pop();
    expect(registry.describe()).toHaveLength(2);
    expect(open).not.toHaveBeenCalled();
    expect(createShowMe([]).describe()).toEqual([]);
  });

  it.each([
    [{ ...node, name: "" }], [node, node], [{ ...node, description: " " }],
    [{ ...node, idDescription: "x".repeat(257) }],
  ])("rejects ambiguous or unusable descriptors", (...descriptors) => {
    expect(() => createShowMe(descriptors.map(d => ({ ...d, open: () => null })))).toThrow();
  });

  it.each([
    null, {}, { handle: "__proto__" }, { handle: "removed" },
    { handle: "node-detail" }, { handle: "node-detail", id: " " },
    { handle: "node-detail", id: "x".repeat(257) }, { handle: "map", id: "wrong" },
    { handle: "map", highlight: null }, { handle: "map", highlight: { label: "x".repeat(121) } },
    { handle: "map", highlight: { color: "red" } }, { handle: "map", highlight: { style: "color:red" } },
  ])("rejects an unavailable or malformed action %j before navigation", async (action) => {
    const open = vi.fn(() => mount());
    const registry = createShowMe([{ ...node, open }, { ...map, open }]);
    expect(await registry.execute(action as ShowMeAction)).toBe("unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it.each<ShowMeHandle["open"]>([
    () => null, () => document.createElement("div"), () => { throw new Error("Missing target"); },
    () => { const target = mount(); target.hidden = true; return target; },
    () => Promise.reject(new Error("Navigation failed")),
  ])("handles a stale destination", async open => {
    const registry = createShowMe([{ ...node, open }]);
    expect(await registry.execute({ handle: node.name, id: "deleted" })).toBe("unavailable");
    expect(document.querySelector("[data-show-me-highlight]")).toBeNull();
  });

  it("marks a mounted target and attaches a plain-text annotation to its accessible description", async () => {
    const target = mount();
    target.setAttribute("aria-describedby", "existing");
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const open = vi.fn(() => target);
    const registry = createShowMe([{ ...node, open }]);
    const label = "<em>orders</em>";
    expect(await registry.execute({ handle: node.name, id: "orders", highlight: { color: "amber", label } })).toBe("shown");
    expect(open).toHaveBeenCalledWith("orders", expect.any(AbortSignal));
    expect(scroll).toHaveBeenCalledOnce();
    expect(target.dataset.showMeHighlight).toBe("amber");
    const note = document.querySelector("[data-show-me-annotation]")!;
    expect(note.textContent).toBe(label);
    expect(note.children.length).toBe(0);
    expect(target.getAttribute("aria-describedby")).toBe(`existing ${note.id}`);

    target.setAttribute("aria-describedby", `existing ${note.id} added`);
    registry.clear();
    expect(target.getAttribute("aria-describedby")).toBe("existing added");
    expect(note.isConnected).toBe(false);
    expect(target.hasAttribute("data-show-me-highlight")).toBe(false);
    registry.clear();
  });

  it("supersedes a pending navigation and replaces annotations on subsequent clicks", async () => {
    const old = mount();
    const current = mount();
    const deferred = pendingTarget();
    const registry = createShowMe([
      { ...node, open: () => deferred.promise }, { ...map, open: () => current },
    ]);
    const pending = registry.execute({ handle: node.name, id: "old" });
    expect(await registry.execute({ handle: map.name, highlight: { label: "Current" } })).toBe("shown");
    deferred.resolve(old);
    expect(await pending).toBe("superseded");
    expect(old.hasAttribute("data-show-me-highlight")).toBe(false);
    expect(current.dataset.showMeHighlight).toBe("blue");
    expect(document.querySelectorAll("[data-show-me-annotation]")).toHaveLength(1);
    expect(await registry.execute({ handle: map.name, highlight: { color: "violet" } })).toBe("shown");
    expect(document.querySelector("[data-show-me-annotation]")).toBeNull();
    expect(current.dataset.showMeHighlight).toBe("violet");
    registry.clear();
  });

  it("removes the caption when a virtual list unmounts its destination", async () => {
    const row = mount();
    const registry = createShowMe([{ ...map, open: () => row }]);
    await registry.execute({ handle: map.name, highlight: { label: "Signal" } });
    row.remove();
    await vi.waitFor(() => expect(document.querySelector("[data-show-me-annotation]")).toBeNull());
    expect(row.hasAttribute("data-show-me-highlight")).toBe(false);
  });

  it("aborts a pending open when its surface closes", async () => {
    const deferred = pendingTarget();
    const open = vi.fn((_id: string | undefined, _signal: AbortSignal) => deferred.promise);
    const registry = createShowMe([{ ...map, open }]);
    const pending = registry.execute({ handle: map.name });
    registry.clear();
    expect(open.mock.calls[0]?.[1].aborted).toBe(true);
    deferred.resolve(mount());
    expect(await pending).toBe("superseded");
    expect(document.querySelector("[data-show-me-highlight]")).toBeNull();
  });
});

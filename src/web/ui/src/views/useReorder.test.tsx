import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inOrder } from "../model/customOrder";
import type { ReorderWorld } from "../model/reorder";
import { useStore } from "../store/store";
import { useReorder } from "./useReorder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL = { id: null, name: "hm", resourceGroup: "rg", subscriptionId: "sub", location: null, provisioningState: null };
const NAMES = ["a", "b", "c", "held"];
const WIDTH = 100;

/** A view as small as one can be: the children of `r` in a row, each `WIDTH` wide; `held` keeps its place. */
function Row({ offered = true }: { readonly offered?: boolean }): JSX.Element {
  const reorder = useReorder({ labelOf: (id) => `Card ${id}`, whyFixed: (id) => (id === "held" ? "Card held keeps its place." : null) });
  const row = inOrder(NAMES, reorder.order);
  const world: ReorderWorld = {
    rows: [row],
    rects: new Map(row.map((name, index) => [name, { x: index * WIDTH, y: 0, width: WIDTH, height: 40 }] as const)),
    parents: new Map(row.filter((name) => name !== "held").map((name) => [name, ["r"]] as const)),
  };
  reorder.offer(offered ? world : null);
  return (
    <div data-testid="row" {...reorder.root}>
      {row.map((name) => (
        <button key={name} data-entity={name} className={reorder.move?.id === name ? "is-dragging" : undefined} onPointerDown={(event) => reorder.onPointerDown(name, event, (client) => client)}>
          {name}
        </button>
      ))}
      {reorder.move?.pointer ? <span data-testid="ghost" data-blocked={reorder.move.candidate === null ? "true" : undefined} /> : null}
    </div>
  );
}

describe("useReorder", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState({ ...useStore.getInitialState(), selected: MODEL }, true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const draw = (offered = true): Promise<void> => act(async () => root.render(<Row offered={offered} />));
  const card = (name: string): HTMLElement => host.querySelector(`[data-entity="${name}"]`) as HTMLElement;
  const shown = (): string[] => [...host.querySelectorAll("[data-entity]")].map((item) => item.textContent ?? "");
  const moving = (): string | undefined => (host.querySelector('[data-testid="row"]') as HTMLElement).dataset["moving"];
  const press = (name: string, key: string): Promise<void> => act(async () => void card(name).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  const point = (type: string, x: number, y = 20, target: EventTarget = window): Promise<void> =>
    act(async () => void target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })));
  const chains = (): unknown => useStore.getState().customOrders["sub/rg/hm"]?.chains;

  it.each([
    ["Right twice, then Enter, takes the last place", ["m", "ArrowRight", "ArrowRight", "Enter"], ["b", "c", "a", "held"], "custom", "Card a moved. The order is now Custom."],
    ["Down is the next place too, and Space drops", ["M", "ArrowDown", " "], ["b", "a", "c", "held"], "custom", "Card a moved. The order is now Custom."],
    ["Enter where it was picked up keeps nothing", ["m", "Enter"], ["a", "b", "c", "held"], "shortest", "Card a stays where it is."],
    ["Escape puts it back", ["m", "ArrowRight", "Escape"], ["a", "b", "c", "held"], "shortest", "Move cancelled."],
    ["Tab puts it back", ["m", "ArrowRight", "Tab"], ["a", "b", "c", "held"], "shortest", "Move cancelled."],
    ["an arrow with nowhere to go stays", ["m", "ArrowLeft"], ["a", "b", "c", "held"], "shortest", "No further place."],
  ] as const)("with the keyboard: %s", async (_name, keys, order, sortKey, said) => {
    await draw();
    for (const key of keys) await press("a", key);

    expect(shown()).toEqual(order);
    expect(useStore.getState().sortKey).toBe(sortKey);
    expect(useStore.getState().announcement).toBe(said);
    if (sortKey === "custom") expect(chains()).toEqual([{ of: "r", names: order.filter((name) => name !== "held") }]);
  });

  it("says where a picked up thing is, shows the order a drop would keep as it goes, and what the place is", async () => {
    await draw();
    await press("b", "m");
    expect(moving()).toBe("keyboard");
    expect(useStore.getState().announcement).toBe("Card b picked up. Arrow keys choose a place, Enter drops it, Escape puts it back. Place 2 of 3.");

    await press("b", "ArrowRight");
    expect(shown()).toEqual(["a", "c", "b", "held"]);
    expect(useStore.getState().announcement).toBe("Place 3 of 3.");
    expect(useStore.getState().sortKey).toBe("shortest");
    expect((host.querySelector('[data-testid="row"]') as HTMLElement).dataset["movingTo"]).toBe("2");
  });

  it.each([
    ["a thing that holds its place says why", true, "held", "Card held keeps its place."],
    ["nothing is picked up where the view offers no drag", false, "a", ""],
  ] as const)("M: %s", async (_name, offered, name, said) => {
    await draw(offered);
    await press(name, "m");

    expect(moving()).toBeUndefined();
    expect(useStore.getState().announcement).toBe(said);
  });

  it.each([
    ["dropped over another thing takes its place", [250], ["b", "c", "a", "held"], "custom"],
    ["dropped far from the row stays", [250, 5000], ["a", "b", "c", "held"], "shortest"],
    ["moved less than a drag is a click", [52], ["a", "b", "c", "held"], "shortest"],
  ] as const)("with the pointer: a thing %s", async (_name, path, order, sortKey) => {
    await draw();
    await point("pointerdown", 50, 20, card("a"));
    for (const x of path) await point("pointermove", x);
    await point("pointerup", path[path.length - 1] as number);

    expect(shown()).toEqual(order);
    expect(useStore.getState().sortKey).toBe(sortKey);
    expect(moving()).toBeUndefined();
  });

  it("with the pointer: a copy follows, blocked where no place would take the thing, and Escape puts it back", async () => {
    await draw();
    await point("pointerdown", 50, 20, card("a"));
    await point("pointermove", 150);
    expect(moving()).toBe("pointer");
    expect(card("a").className).toBe("is-dragging");
    expect(shown()).toEqual(["b", "a", "c", "held"]);
    expect((host.querySelector('[data-testid="ghost"]') as HTMLElement).dataset["blocked"]).toBeUndefined();

    await point("pointermove", 5000);
    expect((host.querySelector('[data-testid="ghost"]') as HTMLElement).dataset["blocked"]).toBe("true");
    expect(shown()).toEqual(["a", "b", "c", "held"]);

    await point("pointermove", 150);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await point("pointerup", 150);
    expect(shown()).toEqual(["a", "b", "c", "held"]);
    expect(useStore.getState().sortKey).toBe("shortest");
    expect(useStore.getState().announcement).toBe("Move cancelled.");
  });

  it("a second move builds on the order the first one left", async () => {
    await draw();
    for (const key of ["m", "ArrowRight", "Enter"]) await press("a", key);
    for (const key of ["m", "ArrowLeft", "Enter"]) await press("c", key);

    expect(shown()).toEqual(["b", "c", "a", "held"]);
    expect(chains()).toEqual([{ of: "r", names: ["b", "c", "a"] }]);
  });

  it("draws the view's own order again when the Order is no longer Custom, and the viewer's when it is", async () => {
    await draw();
    for (const key of ["m", "ArrowRight", "Enter"]) await press("a", key);
    await act(async () => useStore.getState().setSortKey("shortest"));
    expect(shown()).toEqual(["a", "b", "c", "held"]);

    await act(async () => useStore.getState().setSortKey("custom"));
    expect(shown()).toEqual(["b", "a", "c", "held"]);
  });

  it.each(["shortest", "name"] as const)("a drag while the Order is %s keeps the orders kept for other parents and switches to Custom", async (sortKey) => {
    const kept = { of: "other", names: ["x", "y"] };
    useStore.setState({ customOrders: { "sub/rg/hm": { chains: [kept], places: {} } }, sortKey });
    await draw();
    for (const key of ["m", "ArrowRight", "Enter"]) await press("a", key);

    expect(useStore.getState().sortKey).toBe("custom");
    expect(chains()).toEqual([kept, { of: "r", names: ["b", "a", "c"] }]);
  });
});

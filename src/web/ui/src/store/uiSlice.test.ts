import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../model/types";
import { healthModel } from "../../tests/fixture";
import { actions, useStore } from "./store";
import { REFRESH_COUNTDOWN_SECONDS } from "./uiSlice";

vi.mock("./api", () => ({
  fetchModelCatalog: vi.fn(() => new Promise(() => {})),
  fetchHealthModel: vi.fn(() => new Promise(() => {})),
  fetchEntityDetail: vi.fn(() => new Promise(() => {})),
  postHealthReport: vi.fn(() => new Promise(() => {})),
}));

const OTHER_MODEL: ModelRef = {
  id: null,
  name: "other",
  resourceGroup: "group",
  subscriptionId: "sub",
  location: null,
  provisioningState: null,
};

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
});

describe("ui state edge controls", () => {
  it("defaults to smooth paths and layout-aligned connection points", () => {
    const initial = useStore.getState();
    expect({
      layoutId: initial.layoutId,
      edgeStyle: initial.edgeStyle,
      connectionPolicy: initial.connectionPolicy,
      selectedHealth: initial.selectedHealth,
      excludedEntityMode: initial.excludedEntityMode,
    }).toEqual({
      layoutId: "dagre-tb",
      edgeStyle: "smooth",
      connectionPolicy: "with-layout",
      selectedHealth: ["Healthy", "Degraded", "Unhealthy", "Unknown"],
      excludedEntityMode: "hide",
    });
  });

  it("starts on the shortest connections, with the direction toggle left unreversed", () => {
    const initial = useStore.getState();

    expect({ sortKey: initial.sortKey, sortReversed: initial.sortReversed }).toEqual({
      sortKey: "shortest",
      sortReversed: false,
    });
  });

  it.each(["rounded", "right-angle", "smooth"] as const)(
    "preserves an explicit %s selection through layout, policy and model changes",
    (edgeStyle) => {
      actions.setEdgeStyle(edgeStyle);
      actions.setLayout("dagre-lr");
      actions.setConnectionPolicy("bt");
      actions.chooseModel(OTHER_MODEL);
      expect(useStore.getState().edgeStyle).toBe(edgeStyle);
    },
  );

  it("changes only the selected edge control in populated UI state", () => {
    useStore.setState({
      edgeStyle: "rounded",
      layoutId: "dagre-lr",
      selectedName: "svc-a",
      collapsed: ["svc-b"],
      searchOpen: true,
      highlightedName: "svc-a",
      focusNames: ["svc-a", "svc-b"],
      focusSeq: 2,
    });
    const before = useStore.getState();
    actions.setEdgeStyle("smooth");
    expect(useStore.getState()).toEqual({ ...before, edgeStyle: "smooth" });
    actions.setConnectionPolicy("bt");
    expect(useStore.getState()).toEqual({ ...before, edgeStyle: "smooth", connectionPolicy: "bt" });
  });
});

describe("ui state collections", () => {
  it.each([
    { start: [], name: "a", expected: ["a"] },
    { start: ["a"], name: "a", expected: [] },
    { start: ["a"], name: "b", expected: ["a", "b"] },
  ])("toggleCollapse($name) turns $start into $expected", ({ start, name, expected }) => {
    useStore.setState({ collapsed: start });
    actions.toggleCollapse(name);
    expect(useStore.getState().collapsed).toEqual(expected);
  });

  it.each([
    { start: ["a", "b", "c"], dropped: ["b"], expected: ["a", "c"] },
    { start: ["a", "b"], dropped: ["x", "a", "b"], expected: [] },
    { start: ["a"], dropped: [], expected: ["a"] },
  ])("expandMany($dropped) turns $start into $expected", ({ start, dropped, expected }) => {
    useStore.setState({ collapsed: start });
    actions.expandMany(dropped);
    expect(useStore.getState().collapsed).toEqual(expected);
  });

  it.each([
    { start: ["Healthy"], toggled: "Degraded", expected: ["Healthy", "Degraded"] },
    { start: ["Healthy", "Degraded"], toggled: "Healthy", expected: ["Degraded"] },
  ] as const)(
    "toggleSelectedHealth($toggled) turns $start into $expected",
    ({ start, toggled, expected }) => {
      useStore.setState({ selectedHealth: start });
      actions.toggleSelectedHealth(toggled);
      expect(useStore.getState().selectedHealth).toEqual(expected);
    },
  );

  it("setSelectedHealth drops duplicates", () => {
    actions.setSelectedHealth(["Healthy", "Healthy", "Unknown"]);
    expect(useStore.getState().selectedHealth).toEqual(["Healthy", "Unknown"]);
  });

  it("focusEntities records the highlight and advances the sequence on every call", () => {
    actions.focusEntities({ highlight: "a", names: ["a", "b"] });
    actions.focusEntities({ highlight: "b", names: ["b"] });
    const { highlightedName, focusNames, focusSeq } = useStore.getState();
    expect({ highlightedName, focusNames, focusSeq }).toEqual({
      highlightedName: "b",
      focusNames: ["b"],
      focusSeq: 2,
    });
  });
});

describe("ui state theme", () => {
  it.each([
    { action: "initializeTheme", explicit: false },
    { action: "setTheme", explicit: true },
  ] as const)("$action records the theme as explicit=$explicit", ({ action, explicit }) => {
    actions[action]("dark");
    const { theme, themeExplicit } = useStore.getState();
    expect({ theme, themeExplicit }).toEqual({ theme: "dark", themeExplicit: explicit });
  });
});

describe("refresh countdown", () => {
  it.each([
    { start: 3, expected: 2 },
    { start: 1, expected: 0 },
    { start: 0, expected: 0 },
  ])("a tick from $start leaves $expected", ({ start, expected }) => {
    useStore.setState({ refreshCountdown: start });
    actions.tickRefreshCountdown();
    expect(useStore.getState().refreshCountdown).toBe(expected);
  });

  it("starts from the report countdown length", () => {
    expect(REFRESH_COUNTDOWN_SECONDS).toBe(10);
  });
});

/** A viewer's storage, in memory: newer Node versions put a global `localStorage` of their own in front of jsdom's, and it is not usable without a file. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

describe("ui state views", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens in the default view with no chip open", () => {
    const initial = useStore.getState();
    expect([initial.view, initial.openChips]).toEqual(["cause", []]);
  });

  it.each([
    ["?view=zoom", "zoom"],
    ["?view=zoom&session=s1", "zoom"],
    ["", "cause"],
    ["?view=nonsense", "cause"],
  ] as const)("takes the view %j from a link as %s", (search, expected) => {
    actions.initializeView(search);
    expect(useStore.getState().view).toBe(expected);
  });

  it("changes the view and remembers it for this viewer, where a link without a view then opens it", () => {
    actions.setView("zoom");
    expect(useStore.getState().view).toBe("zoom");
    expect(window.localStorage.getItem("health-pulse-view")).toBe("zoom");
    useStore.setState(useStore.getInitialState(), true);
    actions.initializeView("");
    expect(useStore.getState().view).toBe("zoom");
  });

  it("falls back to the remembered view when a link names none that exists", () => {
    window.localStorage.setItem("health-pulse-view", "zoom");
    actions.initializeView("?view=nonsense");
    expect(useStore.getState().view).toBe("zoom");
  });

  it("closes every chip when another model is chosen", () => {
    actions.toggleChip("a|healthy");
    actions.chooseModel(OTHER_MODEL);
    expect(useStore.getState().openChips).toEqual([]);
  });

  it("opens and closes a chip, and opens several at once without repeating one", () => {
    actions.toggleChip("a|healthy");
    expect(useStore.getState().openChips).toEqual(["a|healthy"]);
    actions.openChipsFor(["a|healthy", "b|healthy"]);
    expect(useStore.getState().openChips).toEqual(["a|healthy", "b|healthy"]);
    actions.toggleChip("a|healthy");
    expect(useStore.getState().openChips).toEqual(["b|healthy"]);
  });
});

describe("custom order", () => {
  const MODEL: ModelRef = { id: null, name: "hm", resourceGroup: "rg", subscriptionId: "sub", location: null, provisioningState: null };
  const OTHER: ModelRef = { ...MODEL, name: "other" };
  const ORDER = { chains: [{ of: "r", names: ["b", "a"] }], places: {} } as const;
  const PLACES = { chains: [{ of: "r", names: ["b", "a"] }], places: { "elk-radial": { a: { x: 1, y: 2 } } } } as const;

  // The test environment has no storage of its own: this is a browser's, as far as the store can tell.
  const kept = new Map<string, string>();
  beforeEach(() => {
    kept.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) },
    });
    useStore.setState({ ...useStore.getInitialState(), selected: MODEL }, true);
  });

  it("is chosen by the first drag, which keeps the order for the open model", () => {
    expect(useStore.getState().sortKey).toBe("shortest");

    actions.commitCustomOrder(ORDER);

    expect(useStore.getState().sortKey).toBe("custom");
    expect(useStore.getState().customOrders).toEqual({ "sub/rg/hm": ORDER });
  });

  it("is kept when another order is chosen, so choosing Custom again brings it back", () => {
    actions.commitCustomOrder(ORDER);
    actions.setSortKey("name");
    actions.setSortKey("custom");

    expect(useStore.getState().customOrders["sub/rg/hm"]).toEqual(ORDER);
  });

  it("is one per model, whatever view or layout it was given in", () => {
    actions.commitCustomOrder(ORDER);
    actions.commitCustomOrder(PLACES);
    useStore.setState({ selected: OTHER });
    actions.commitCustomOrder({ chains: [{ of: "", names: ["x", "y"] }], places: {} });

    expect(Object.keys(useStore.getState().customOrders).sort()).toEqual(["sub/rg/hm", "sub/rg/other"]);
    expect(useStore.getState().customOrders["sub/rg/hm"]).toEqual(PLACES);
  });

  it("is forgotten by a reset, chains and places alike, which leaves Custom for the shortest connections and keeps the other models' orders", () => {
    actions.commitCustomOrder(PLACES);
    useStore.setState({ selected: OTHER });
    actions.commitCustomOrder(ORDER);
    useStore.setState({ selected: MODEL });
    actions.resetCustomOrder();

    expect(useStore.getState().customOrders).toEqual({ "sub/rg/other": ORDER });
    expect(useStore.getState().sortKey).toBe("shortest");
  });

  it("is not forgotten by a reset of an order that is not there, and a reset leaves an explicit order as it is", () => {
    actions.resetCustomOrder();
    expect(useStore.getState().sortKey).toBe("shortest");
    actions.commitCustomOrder(ORDER);
    actions.setSortKey("name");
    actions.resetCustomOrder();

    expect(useStore.getState().sortKey).toBe("name");
    expect(useStore.getState().customOrders).toEqual({});
  });

  it("needs a model: with none open a drag is not kept", () => {
    useStore.setState({ selected: null });
    actions.commitCustomOrder(ORDER);

    expect(useStore.getState().customOrders).toEqual({});
    expect(useStore.getState().sortKey).toBe("shortest");
  });

  it("survives a state change pushed to the model on screen", () => {
    actions.commitCustomOrder(ORDER);
    useStore.setState({ model: { kind: "success", value: { ...healthModel, observedAt: "2026-07-30T16:06:00Z" } } });

    expect(useStore.getState().customOrders["sub/rg/hm"]).toEqual(ORDER);
    expect(useStore.getState().sortKey).toBe("custom");
  });

  it("is kept in this browser and back, with Custom still chosen, after a reload", async () => {
    actions.commitCustomOrder(ORDER);
    vi.resetModules();
    const { useStore: reloaded } = await import("./store");

    expect(reloaded.getState().sortKey).toBe("custom");
    expect(reloaded.getState().customOrders).toEqual({ "sub/rg/hm": ORDER });
  });

  it("is gone after a reload once it is reset", async () => {
    actions.commitCustomOrder(ORDER);
    actions.resetCustomOrder();
    vi.resetModules();
    const { useStore: reloaded } = await import("./store");

    expect(reloaded.getState().sortKey).toBe("shortest");
    expect(reloaded.getState().customOrders).toEqual({});
  });

  it("reads an order kept per family of layouts, as before every view shared one, as the model's order", async () => {
    kept.set("ahm.customOrders.v1", JSON.stringify({ "sub/rg/hm#hierarchy": { kind: "ranks", ranks: [["r"], ["b", "a"]] }, "sub/rg/hm#force": { kind: "slots", slots: { a: { x: 1, y: 2 } } } }));
    kept.set("ahm.sortKey.v1", "custom");
    vi.resetModules();
    const { useStore: reloaded } = await import("./store");

    expect(reloaded.getState().customOrders).toEqual({ "sub/rg/hm": { chains: [{ of: "#hierarchy:1", names: ["b", "a"] }], places: { force: { a: { x: 1, y: 2 } } } } });
    expect(reloaded.getState().sortKey).toBe("custom");
  });

  it("starts with nothing when the stored text is not an order, or storage refuses", async () => {
    kept.set("ahm.customOrders.v2", "{nope");
    kept.set("ahm.sortKey.v1", "sideways");
    vi.resetModules();
    const { useStore: reloaded } = await import("./store");

    expect(reloaded.getState().customOrders).toEqual({});
    expect(reloaded.getState().sortKey).toBe("shortest");
  });
});

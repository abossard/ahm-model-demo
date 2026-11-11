import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../model/types";
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

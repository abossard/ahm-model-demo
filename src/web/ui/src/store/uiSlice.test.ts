import { describe, expect, it } from "vitest";
import { chooseModel } from "./catalogSlice";
import { setConnectionPolicy, setEdgeStyle, setLayout, uiReducer } from "./uiSlice";

describe("uiReducer edge controls", () => {
  it("defaults to smooth paths and layout-aligned connection points", () => {
    const initial = uiReducer(undefined, { type: "init" });
    expect({
      layoutId: initial.layoutId,
      edgeStyle: initial.edgeStyle,
      connectionPolicy: initial.connectionPolicy,
    }).toEqual({
      layoutId: "dagre-tb",
      edgeStyle: "smooth",
      connectionPolicy: "with-layout",
    });
  });

  it.each(["rounded", "right-angle", "smooth"] as const)(
    "preserves an explicit %s selection through layout, policy and model changes",
    (edgeStyle) => {
      const selected = uiReducer(undefined, setEdgeStyle(edgeStyle));
      const changed = [
        setLayout("dagre-lr"),
        setConnectionPolicy("bt"),
        chooseModel({ name: "other", resourceGroup: "group", id: null, location: null, provisioningState: null }),
      ].reduce(uiReducer, selected);
      expect(changed.edgeStyle).toBe(edgeStyle);
    },
  );

  it("changes only the selected edge control in populated UI state", () => {
    const before = {
      ...uiReducer(undefined, { type: "init" }),
      edgeStyle: "rounded" as const,
      layoutId: "dagre-lr" as const,
      panelOpen: true,
      collapsed: ["svc-b"],
      searchOpen: true,
      highlightedName: "svc-a",
      focusNames: ["svc-a", "svc-b"],
      focusSeq: 2,
    };
    expect(uiReducer(before, setEdgeStyle("smooth"))).toEqual({ ...before, edgeStyle: "smooth" });
    expect(uiReducer(before, setConnectionPolicy("bt"))).toEqual({ ...before, connectionPolicy: "bt" });
  });
});

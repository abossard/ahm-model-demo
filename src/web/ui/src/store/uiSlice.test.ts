import { describe, expect, it } from "vitest";
import { setConnectionPolicy, setEdgeStyle, setLayout, uiReducer } from "./uiSlice";

describe("uiReducer edge routing controls", () => {
  it("keeps the two edge controls in UI state beside layout", () => {
    const initial = uiReducer(undefined, { type: "init" });

    expect({
      layoutId: initial.layoutId,
      edgeStyle: initial.edgeStyle,
      connectionPolicy: initial.connectionPolicy,
    }).toEqual({
      layoutId: "dagre-tb",
      edgeStyle: "rounded",
      connectionPolicy: "with-layout",
    });

    const changed = [setLayout("dagre-lr"), setEdgeStyle("smooth"), setConnectionPolicy("bt")].reduce(
      uiReducer,
      initial,
    );

    expect({
      layoutId: changed.layoutId,
      edgeStyle: changed.edgeStyle,
      connectionPolicy: changed.connectionPolicy,
    }).toEqual({
      layoutId: "dagre-lr",
      edgeStyle: "smooth",
      connectionPolicy: "bt",
    });
  });
});

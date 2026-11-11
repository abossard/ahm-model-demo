import { describe, expect, it } from "vitest";
import { searchFromLocation } from "./selection";
import { DEFAULT_VIEW, VIEWS, VIEW_STORAGE_KEY, persistView, readStoredView, viewFromSearch, type ViewId } from "./views";

const MODEL = { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-1" };
const BASE = "model=hm-a&resourceGroup=rg-a&subscription=sub-1";

describe("viewFromSearch", () => {
  it.each([
    ["", null, DEFAULT_VIEW],
    ["?view=zoom", null, "zoom"],
    [`?${BASE}&view=zoom&session=s1`, null, "zoom"],
    ["?view=", null, DEFAULT_VIEW],
    ["?view=icicle", null, DEFAULT_VIEW],
    ["?view=ZOOM", null, DEFAULT_VIEW],
    ["?model=x", null, DEFAULT_VIEW],
    ["", "zoom", "zoom"],
    ["?view=zoom", "zoom", "zoom"],
    ["", "nonsense", DEFAULT_VIEW],
    ["?view=nonsense", "zoom", "zoom"],
    ["?view=zoom", "swimlanes-not-built", "zoom"],
  ] as readonly (readonly [string, string | null, ViewId])[])("reads %j with %j remembered as %s", (search, stored, expected) => {
    expect(viewFromSearch(search, stored)).toBe(expected);
  });

  it("opens in the Cause path view", () => {
    expect(DEFAULT_VIEW).toBe("cause");
  });

  it("names every built view once, each with a hint, in the order of the design gallery", () => {
    const order = ["swimlanes", "tidy", "cause", "zoom", "outline", "coverage"];
    const ids = VIEWS.map((view) => view.id);
    expect(ids).toEqual(order.filter((id) => ids.includes(id as never)));
    for (const view of VIEWS) expect(view.description.length).toBeGreaterThan(10);
  });
});

describe("remembering the view", () => {
  const store = (initial: Record<string, string> = {}): Storage => {
    const items = new Map(Object.entries(initial));
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) } as unknown as Storage;
  };
  const broken = (): Storage => { throw new Error("blocked"); };

  it("reads what was stored, and nothing when storage is blocked", () => {
    expect(readStoredView(() => store({ [VIEW_STORAGE_KEY]: "zoom" }))).toBe("zoom");
    expect(readStoredView(() => store())).toBeNull();
    expect(readStoredView(broken)).toBeNull();
  });

  it("stores the choice, and carries on when storage is blocked", () => {
    const target = store();
    persistView("zoom", () => target);
    expect(target.getItem(VIEW_STORAGE_KEY)).toBe("zoom");
    expect(() => persistView("zoom", broken)).not.toThrow();
  });
});

describe("searchFromLocation with a view", () => {
  it.each([
    [DEFAULT_VIEW, null, `?${BASE}`],
    ["zoom", null, `?${BASE}&view=zoom`],
    ["coverage", null, `?${BASE}&view=coverage`],
    ["zoom", { session: "s1", task: 2 }, `?${BASE}&view=zoom&session=s1&task=2`],
    [DEFAULT_VIEW, { session: "s1", task: null }, `?${BASE}&session=s1`],
  ] as readonly (readonly [ViewId, { session: string; task: number | null } | null, string])[])(
    "writes view %s with workspace %j as %s",
    (view, workspace, expected) => {
      expect(searchFromLocation(MODEL, workspace ?? { session: null, task: null }, view)).toBe(expected);
    },
  );

  it("round-trips the view through the address bar", () => {
    for (const view of VIEWS) {
      expect(viewFromSearch(searchFromLocation(MODEL, { session: null, task: null }, view.id))).toBe(view.id);
    }
  });
});

import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareMode } from "../model/compare";
import { useStore } from "../store/store";
import type { ViewDefinition, ViewProps } from "../views/types";
import { diffViewModel } from "../../tests/viewModels";
import { CompareView } from "./CompareView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Compare around the selected view", () => {
  let host: HTMLDivElement;
  let root: Root;
  const drawn: ViewProps[] = [];

  function Probe(props: ViewProps): JSX.Element {
    drawn.push(props);
    return <div data-testid="probe" data-side={props.compare?.side} />;
  }
  const definition = (compareMode: CompareMode): ViewDefinition => ({ id: "tidy", label: "Probe", description: "Probe", Component: Probe, compareMode });
  const view = diffViewModel();
  const names = (items: readonly { readonly name: string }[]): string[] => items.map((item) => item.name);

  beforeEach(() => {
    drawn.length = 0;
    useStore.setState(useStore.getInitialState(), true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function draw(mode: CompareMode): Promise<void> {
    await act(async () =>
      root.render(<CompareView view={view} definition={definition(mode)} selectedName="svc-a" highlightedName={null} chainNames={["a", "b"]} onActivate={vi.fn()} />),
    );
  }

  it.each([
    { mode: "split" as const, sides: ["base", "proposed"] },
    { mode: "merged" as const, sides: ["merged"] },
  ])("draws a $mode view once for each of $sides", async ({ mode, sides }) => {
    await draw(mode);
    expect(drawn.map((props) => props.compare?.side)).toEqual(sides);
    expect([...host.querySelectorAll('[data-testid="probe"]')].map((item) => (item as HTMLElement).dataset["side"])).toEqual(sides);
    for (const side of sides) expect(host.querySelector(`[data-testid="compare-side-${side}"] [data-testid="probe"]`)).not.toBeNull();
    expect(host.querySelector('[data-testid="compare-view"]')?.getAttribute("data-mode")).toBe(mode);
  });

  it("gives a split view each side's own entities and the marks that exist on that side, on one arrangement", async () => {
    await draw("split");
    const [base, proposed] = drawn as [ViewProps, ViewProps];
    expect(names(base.entities)).toEqual(names(view.base.entities));
    expect(names(proposed.entities)).toEqual(names(view.proposed.entities));
    expect(base.badges?.get("discovered-app-topology")).toBe("removed");
    expect(base.badges?.has("report-queue")).toBe(false);
    expect(proposed.badges?.get("report-queue")).toBe("added");
    expect(proposed.badges?.has("discovered-app-topology")).toBe(false);
    expect(names(base.compare?.basis.entities ?? [])).toEqual(names(proposed.compare?.basis.entities ?? []));
    expect(base.compare?.union).toBe(proposed.compare?.union);
  });

  it("gives a merged view everything either side has, with every mark", async () => {
    await draw("merged");
    const [merged] = drawn as [ViewProps];
    expect(names(merged.entities)).toEqual(expect.arrayContaining(["report-queue", "discovered-app-topology", "container-app"]));
    expect([merged.badges?.get("report-queue"), merged.badges?.get("discovered-app-topology"), merged.badges?.get("container-app")]).toEqual(["added", "removed", "changed"]);
  });

  it.each(["split", "merged"] as const)("passes the selection and the chain of the %s view on, and marks the entities of the ticked changes", async (mode) => {
    useStore.setState({ selectedChanges: ["c1"] });
    await draw(mode);
    for (const props of drawn) {
      expect(props.selectedName).toBe("svc-a");
      expect(props.chainNames).toEqual(["a", "b"]);
      expect([...(props.marked ?? [])]).toEqual(["report-queue"]);
    }
  });

  it("counts what the diff adds, changes and removes, and leaves Compare from its bar", async () => {
    await draw("split");
    const text = (id: string): string | null | undefined => host.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect([text("compare-count-added"), text("compare-count-changed"), text("compare-count-removed")]).toEqual(["2 entities added", "2 changed", "1 removed"]);
    useStore.setState({ compare: true });
    await act(async () => (host.querySelector('[data-testid="compare-exit"]') as HTMLButtonElement).click());
    expect(useStore.getState().compare).toBe(false);
  });
});

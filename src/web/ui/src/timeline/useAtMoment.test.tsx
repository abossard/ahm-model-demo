import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore, type Store } from "../store/store";
import { selectMomentMinute, selectedMoment } from "../store/timelineSlice";
import { useAtMoment } from "./useAtMoment";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;
const T = Date.parse("2026-11-11T12:00:00Z");
const renders: Record<string, (number | null)[]> = { exact: [], minute: [] };

function Reader({ name, selector }: { readonly name: string; readonly selector: (state: Store) => number | null }): JSX.Element {
  const value = useAtMoment(selector);
  renders[name]?.push(value);
  return <output data-reader={name}>{String(value)}</output>;
}

describe("useAtMoment", () => {
  let host: HTMLDivElement;
  let root: Root;
  const shown = (name: string): string | null => host.querySelector(`[data-reader="${name}"]`)?.textContent ?? null;
  const select = (t: number | null): Promise<void> => act(async () => useStore.setState({ timelinePinned: t }));

  beforeEach(async () => {
    useStore.setState(useStore.getInitialState(), true);
    renders.exact = [];
    renders.minute = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <>
          <Reader name="exact" selector={selectedMoment} />
          <Reader name="minute" selector={selectMomentMinute} />
        </>,
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it.each([
    { name: "now", moves: [null], exact: "null", minute: "null" },
    { name: "a moment that was selected", moves: [T + 5000], exact: String(T + 5000), minute: String(T) },
    { name: "the newest of the moments a drag went through", moves: [T, T + 20_000, T + 2 * MINUTE + 1], exact: String(T + 2 * MINUTE + 1), minute: String(T + 2 * MINUTE) },
    { name: "now again, after a moment", moves: [T, T + MINUTE, null], exact: "null", minute: "null" },
    { name: "a moment selected again after returning to now", moves: [T, null, T + MINUTE], exact: String(T + MINUTE), minute: String(T + MINUTE) },
  ])("every reader shows $name", async ({ moves, exact, minute }) => {
    for (const t of moves) await select(t);

    expect([shown("exact"), shown("minute")]).toEqual([exact, minute]);
  });

  it("a reader renders when what it reads changed, not with every move of the moment", async () => {
    await select(T);
    const before = renders.minute?.length ?? 0;

    for (let step = 1; step <= 10; step += 1) await select(T + step * 1000);

    expect(shown("exact")).toBe(String(T + 10_000));
    expect((renders.minute?.length ?? 0) - before).toBe(0);
  });

  it("moves that arrive together are drawn once, with the newest", async () => {
    await select(T);
    const before = renders.exact?.length ?? 0;

    await act(async () => {
      for (let step = 1; step <= 20; step += 1) useStore.setState({ timelinePinned: T + step * 1000 });
    });

    expect(shown("exact")).toBe(String(T + 20_000));
    expect((renders.exact?.length ?? 0) - before).toBeLessThanOrEqual(2);
  });

  it("a reader that leaves while a moment is drawn does not stop the others from following", async () => {
    await select(T);
    await act(async () => {
      useStore.setState({ timelinePinned: T + 1000 });
      root.render(<Reader name="exact" selector={selectedMoment} />);
    });

    await select(T + 5000);
    await select(T + 9000);

    expect(shown("exact")).toBe(String(T + 9000));
    expect(shown("minute")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { createChanges } from "./changes";

const never = new AbortController().signal;

describe("changes", () => {
  it("wakes every waiter of the table with the version, and only that table", async () => {
    const changes = createChanges();
    const a1 = changes.next("c1", Date.now() + 5000, never);
    const a2 = changes.next("c1", Date.now() + 5000, never);
    const other = changes.next("c2", Date.now() + 30, never);
    changes.publish("c1", 7);
    expect(await Promise.all([a1, a2])).toEqual([7, 7]);
    expect(await other).toBeNull();
  });

  it.each([
    { name: "the deadline passes", arrange: () => ({ deadline: Date.now() + 20, signal: never, abort: () => {} }) },
    { name: "the deadline is already past", arrange: () => ({ deadline: Date.now() - 1, signal: never, abort: () => {} }) },
    {
      name: "the signal aborts",
      arrange: () => {
        const ctl = new AbortController();
        return { deadline: Date.now() + 5000, signal: ctl.signal, abort: () => ctl.abort() };
      },
    },
    { name: "the signal is aborted already", arrange: () => ({ deadline: Date.now() + 5000, signal: AbortSignal.abort(), abort: () => {} }) },
  ])("resolves null when $name", async ({ arrange }) => {
    const { deadline, signal, abort } = arrange();
    const waiting = createChanges().next("c1", deadline, signal);
    abort();
    expect(await waiting).toBeNull();
  });

  it("forgets a waiter that gave up, so a later publish has nobody to wake", async () => {
    const changes = createChanges();
    const ctl = new AbortController();
    const gone = changes.next("c1", Date.now() + 5000, ctl.signal);
    ctl.abort();
    await gone;
    changes.publish("c1", 2);
    expect(await changes.next("c1", Date.now() + 20, never)).toBeNull();
  });
});

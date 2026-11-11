import { describe, expect, it } from "vitest";
import { orderSessions } from "./sessions";
import type { SessionSummary } from "./types";

const session = (id: string, createdAt: string, lastTaskAt: string | null): SessionSummary => ({
  id,
  title: id,
  createdAt,
  taskCount: lastTaskAt === null ? 0 : 1,
  lastTaskAt,
});

describe("orderSessions", () => {
  it.each([
    {
      name: "the time of the last Task over the time of creation",
      sessions: [
        session("old", "2026-11-10T23:28:51.676994Z", "2026-11-11T00:14:59.002324Z"),
        session("new", "2026-11-11T00:23:23.461249Z", null),
        session("mid", "2026-11-10T23:30:00Z", "2026-11-11T00:20:00Z"),
      ],
      expected: ["new", "mid", "old"],
    },
    {
      name: "real timestamps with microseconds",
      sessions: [session("a", "2026-11-11T00:23:23.461249Z", "2026-11-11T00:23:39.722048Z"), session("b", "2026-11-11T00:23:23.461249Z", "2026-11-11T00:23:41.000001Z")],
      expected: ["b", "a"],
    },
    {
      name: "equal times in the order given",
      sessions: [session("x", "2026-11-11T00:00:00Z", null), session("y", "2026-11-11T00:00:00Z", null)],
      expected: ["x", "y"],
    },
    {
      name: "a time that is not a date last",
      sessions: [session("bad", "yesterday", null), session("ok", "2026-11-11T00:00:00Z", null)],
      expected: ["ok", "bad"],
    },
    { name: "no Sessions", sessions: [], expected: [] },
  ])("puts $name", ({ sessions, expected }) => {
    expect(orderSessions(sessions).map((item) => item.id)).toEqual(expected);
  });

  it("leaves the list it was given alone", () => {
    const given = [session("a", "2026-11-10T00:00:00Z", null), session("b", "2026-11-11T00:00:00Z", null)];
    orderSessions(given);
    expect(given.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

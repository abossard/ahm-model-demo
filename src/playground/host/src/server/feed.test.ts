import { describe, expect, it } from "vitest";
import { toDebugEvent } from "@playground/contracts";
import { createFeed, frame } from "./feed";

const build = (sid: string, message: unknown = { jsonrpc: "2.0", method: "ping", id: 1 }) => (seq: number) =>
  toDebugEvent({ seq, at: seq, sid, hop: "host-server", from: "host", to: "server" }, message);

function client() {
  const out = { written: [] as string[], ended: false };
  return { out, write: (chunk: string) => void out.written.push(chunk), end: () => void (out.ended = true) };
}
const ids = (written: string[]) => written.filter((chunk) => chunk.startsWith("id:")).map((chunk) => Number(/^id: (\d+)/.exec(chunk)![1]));

describe("feed", () => {
  it("numbers events per tab and sends them to the open streams", () => {
    const feed = createFeed();
    const a = client();
    feed.open("tab-aaaaaaaa", a);
    feed.record("tab-aaaaaaaa", build("tab-aaaaaaaa"));
    feed.record("tab-bbbbbbbb", build("tab-bbbbbbbb"));
    feed.record("tab-aaaaaaaa", build("tab-aaaaaaaa"));
    expect(ids(a.out.written)).toEqual([1, 2]);
    expect(a.out.written[0]).toMatch(/^id: 1\nevent: wire\ndata: \{.*\}\n\n$/);
  });

  it.each([
    ["no Last-Event-ID", 0, [1, 2, 3, 4]],
    ["the middle", 2, [3, 4]],
    ["the last", 4, []],
  ])("replays after %s", (_name, last, expected) => {
    const feed = createFeed();
    for (let i = 0; i < 4; i++) feed.record("tab-aaaaaaaa", build("tab-aaaaaaaa"));
    const late = client();
    feed.open("tab-aaaaaaaa", late, last);
    expect(ids(late.out.written)).toEqual(expected);
  });

  it("keeps the last events of a tab", () => {
    const feed = createFeed({ ringSize: 3 });
    for (let i = 0; i < 5; i++) feed.record("tab-aaaaaaaa", build("tab-aaaaaaaa"));
    const late = client();
    feed.open("tab-aaaaaaaa", late);
    expect(ids(late.out.written)).toEqual([3, 4, 5]);
  });

  it("pairs a reply with its request", () => {
    const feed = createFeed();
    const request = (seq: number) => toDebugEvent({ seq, at: 10, sid: "s", hop: "host-server", from: "host", to: "server" },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "hello_show" } });
    const reply = (seq: number) => toDebugEvent({ seq, at: 42, sid: "s", hop: "host-server", from: "server", to: "host" }, { jsonrpc: "2.0", id: 7, result: {} });
    feed.record("tab-aaaaaaaa", request);
    const paired = feed.record("tab-aaaaaaaa", reply);
    expect(paired).toMatchObject({ method: "tools/call", tool: "hello_show", durationMs: 32 });
  });

  it("drops the least recently active tab beyond the limit and ends its streams", () => {
    let t = 0;
    const feed = createFeed({ maxTabs: 2, now: () => ++t });
    const first = client();
    feed.open("tab-aaaaaaaa", first);
    feed.record("tab-bbbbbbbb", build("tab-bbbbbbbb"));
    feed.record("tab-cccccccc", build("tab-cccccccc"));
    expect(first.out.ended).toBe(true);
    expect(feed.stats().tabs).toBe(2);
  });

  it.each([
    ["quiet and unwatched", false, 700_000, 0],
    ["quiet but watched", true, 700_000, 1],
    ["unwatched but recent", false, 1_000, 1],
  ])("heartbeat: a tab that is %s", (_name, watched, later, left) => {
    let t = 0;
    const feed = createFeed({ now: () => t });
    feed.record("tab-aaaaaaaa", build("tab-aaaaaaaa"));
    const c = client();
    if (watched) feed.open("tab-aaaaaaaa", c);
    t = later;
    feed.heartbeat();
    expect(feed.stats().tabs).toBe(left);
    if (watched) expect(c.out.written.at(-1)).toBe(": ping\n\n");
  });

  it("stops writing to a client that detached", () => {
    const feed = createFeed();
    const c = client();
    feed.open("tab-aaaaaaaa", c)();
    feed.record("tab-aaaaaaaa", build("tab-aaaaaaaa"));
    expect(c.out.written).toEqual([]);
  });

  it("frames one event", () => {
    expect(frame(build("s")(9))).toMatch(/^id: 9\nevent: wire\n/);
  });
});

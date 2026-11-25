import { describe, expect, it } from "vitest";
import type { CareerEvent } from "@playground/contracts";
import { createCareers } from "./careers";
import { createMemoryStore } from "./store/memory";
import { ADA } from "./testing";

describe("careers", () => {
  it.each([
    { name: "a new player", events: [] as CareerEvent[], unlocked: 1 },
    { name: "a ping", events: [{ type: "hello_ping" }] as CareerEvent[], unlocked: 2 },
    { name: "three lab exhibits", events: [{ type: "lab_exhibit", exhibit: "call_tool" }, { type: "lab_exhibit", exhibit: "log" }, { type: "lab_exhibit", exhibit: "theme" }] as CareerEvent[], unlocked: 3 },
    { name: "the same exhibit three times", events: [{ type: "lab_exhibit", exhibit: "log" }, { type: "lab_exhibit", exhibit: "log" }, { type: "lab_exhibit", exhibit: "log" }] as CareerEvent[], unlocked: 1 },
    { name: "the cheat", events: [{ type: "cheat" }] as CareerEvent[], unlocked: 5 },
  ])("$name unlocks layer $unlocked", async ({ events, unlocked }) => {
    const careers = createCareers(createMemoryStore());
    for (const event of events) await careers.advance(ADA.id, event);
    expect((await careers.get(ADA)).unlocked).toBe(unlocked);
  });

  it("survives a restart: a second instance reads the same store", async () => {
    const store = createMemoryStore();
    await createCareers(store).advance(ADA.id, { type: "checkers_capture" });
    expect((await createCareers(store).get(ADA)).unlocked).toBe(4);
  });

  it("keeps the stored handle current and counts pings", async () => {
    const store = createMemoryStore();
    const careers = createCareers(store);
    await careers.advance(ADA.id, { type: "hello_ping" });
    await careers.advance(ADA.id, { type: "hello_ping" });
    await careers.get({ ...ADA, handle: "New Name" });
    const doc = await store.get<{ handle: string }>("players", ADA.id, ADA.id);
    expect(doc?.body.handle).toBe("New Name");
    expect(await careers.pings({ ...ADA, handle: "New Name" })).toBe(2);
  });

  it("writes nothing when an event changes nothing", async () => {
    const store = createMemoryStore();
    const careers = createCareers(store);
    await careers.advance(ADA.id, { type: "cheat" });
    const before = (await store.get("players", ADA.id, ADA.id))!.version;
    await careers.advance(ADA.id, { type: "cheat" });
    expect((await store.get("players", ADA.id, ADA.id))!.version).toBe(before);
  });
});

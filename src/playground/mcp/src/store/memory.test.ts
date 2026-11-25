import { describe, expect, it } from "vitest";
import { TTL_SECONDS } from "../ports";
import type { Kind } from "../ports";
import { checkStore, watchStore } from "./check";
import { createMemoryStore } from "./memory";

describe("memory store", () => {
  it("passes the store contract", async () => {
    expect(await checkStore(createMemoryStore())).toBeNull();
  });

  it.each(["tables", "runs", "players"] as Kind[])("%s expires after its TTL, read as absent", async (kind) => {
    let now = 1000;
    const store = createMemoryStore(() => now);
    await store.update(kind, "pk", "id", () => ({ n: 1 }));
    now += TTL_SECONDS[kind] * 1000;
    expect(await store.get(kind, "pk", "id")).not.toBeNull();
    now += 1;
    expect(await store.get(kind, "pk", "id")).toBeNull();
    expect(await store.list(kind, "pk", 10)).toEqual([]);
  });

  it("keeps a copy: changing a returned body does not change the store", async () => {
    const store = createMemoryStore();
    const written = await store.update<{ list: number[] }>("tables", "pk", "id", () => ({ list: [1] }));
    written!.body.list.push(2);
    const read = await store.get<{ list: number[] }>("tables", "pk", "id");
    read!.body.list.push(3);
    expect((await store.get<{ list: number[] }>("tables", "pk", "id"))!.body.list).toEqual([1]);
  });

  it("does not leak the caller's object into the store", async () => {
    const store = createMemoryStore();
    const body = { list: [1] };
    await store.update("tables", "pk", "id", () => body);
    body.list.push(2);
    expect((await store.get<typeof body>("tables", "pk", "id"))!.body.list).toEqual([1]);
  });

  it.each([
    { name: "versions", pk: "g", expectIds: ["b", "a"] },
    { name: "other partitions", pk: "h", expectIds: ["c"] },
  ])("lists $name newest first within one partition", async ({ pk, expectIds }) => {
    const store = createMemoryStore(() => 5);
    await store.update("tables", "g", "a", () => 1);
    await store.update("tables", "g", "b", () => 2);
    await store.update("tables", "h", "c", () => 3);
    expect((await store.list("tables", pk, 10)).map((doc) => doc.id)).toEqual(expectIds);
  });

  it("limits the list", async () => {
    const store = createMemoryStore();
    for (const id of ["a", "b", "c"]) await store.update("tables", "g", id, () => id);
    expect((await store.list("tables", "g", 2)).map((doc) => doc.id)).toEqual(["c", "b"]);
  });
});

describe("store check", () => {
  it("names the first failing case", async () => {
    const store = createMemoryStore();
    const broken = { ...store, remove: async () => {}, get: async () => null };
    expect(await checkStore(broken)).toMatch(/^create then get: /);
  });

  it("reports an error as the check, retries, and clears when the store recovers", async () => {
    const real = createMemoryStore();
    let failing = 2;
    const flaky = {
      ...real,
      update: ((...args: Parameters<typeof real.update>) => {
        if (failing-- > 0) return Promise.reject(Object.assign(new Error("403 forbidden"), { code: 403 }));
        return real.update(...args);
      }) as typeof real.update,
    };
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      const stop = watchStore(flaky, (state) => {
        seen.push(state.check);
        if (state.ready) {
          stop();
          resolve();
        }
      }, 5);
    });
    await done;
    expect(seen[0]).toBe("running");
    expect(seen[1]).toMatch(/403/);
    expect(seen.at(-1)).toBe("passed");
  });
});

import { describe, expect, it } from "vitest";
import type { ContainerLike } from "./cosmos";
import { cosmosStore, StoreBusy } from "./cosmos";
import { checkStore } from "./check";

interface Row {
  doc: Record<string, unknown>;
  etag: number;
}

// A container that behaves like Cosmos for the calls the adapter makes: etags, 404 on read, 409 and 412.
function fakeContainer(options: { failReplace?: number; failCreate?: number } = {}): ContainerLike & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  let failReplace = options.failReplace ?? 0;
  let failCreate = options.failCreate ?? 0;
  const key = (pk: string, id: string) => `${pk}/${id}`;
  return {
    rows,
    item: (id, pk) => ({
      read: async () => {
        const row = rows.get(key(pk, id));
        return row ? { resource: structuredClone(row.doc), etag: String(row.etag), statusCode: 200 } : { statusCode: 404 };
      },
      replace: async (doc, { accessCondition }) => {
        if (failReplace > 0) {
          failReplace--;
          const seen = rows.get(key(pk, id))!;
          rows.set(key(pk, id), { doc: seen.doc, etag: seen.etag + 1 });
        }
        const row = rows.get(key(pk, id));
        if (!row || String(row.etag) !== accessCondition.condition) throw Object.assign(new Error("precondition"), { code: 412 });
        rows.set(key(pk, id), { doc: structuredClone(doc) as Record<string, unknown>, etag: row.etag + 1 });
      },
      delete: async () => {
        if (!rows.delete(key(pk, id))) throw Object.assign(new Error("gone"), { code: 404 });
      },
    }),
    items: {
      create: async (doc) => {
        const { id, pk } = doc as { id: string; pk: string };
        if (failCreate > 0 || rows.has(key(pk, id))) {
          failCreate = Math.max(0, failCreate - 1);
          throw Object.assign(new Error("conflict"), { code: 409 });
        }
        rows.set(key(pk, id), { doc: structuredClone(doc) as Record<string, unknown>, etag: 1 });
      },
      query: (spec, { partitionKey }) => ({
        fetchAll: async () => {
          const limit = spec.parameters.find((p) => p.name === "@n")!.value as number;
          const found = [...rows.values()]
            .map((row) => row.doc)
            .filter((doc) => doc["pk"] === partitionKey)
            .sort((a, b) => (b["updatedAt"] as number) - (a["updatedAt"] as number));
          return { resources: found.slice(0, limit) };
        },
      }),
    },
  };
}

function storeOver(container: ContainerLike) {
  let now = 0;
  const store = cosmosStore({
    containers: { tables: container, runs: container, players: container },
    now: () => ++now,
    sleep: async () => {},
    random: () => 0,
  });
  return store;
}

describe("cosmos store", () => {
  it("passes the store contract against a container of the same behaviour", async () => {
    expect(await checkStore(storeOver(fakeContainer()))).toBeNull();
  });

  it.each([
    { name: "a replace loses the race once", container: () => fakeContainer({ failReplace: 1 }), runs: 2 },
    { name: "a create loses the race once", container: () => fakeContainer({ failCreate: 1 }), runs: 2 },
  ])("starts over when $name", async ({ container, runs }) => {
    const store = storeOver(container());
    await store.update<number>("tables", "g", "seed", () => 1);
    let calls = 0;
    const doc = await store.update<number>("tables", "g", "seed", (body) => {
      calls++;
      return (body ?? 0) + 1;
    });
    const created = await store.update<number>("tables", "g", "fresh", () => 5);
    expect(calls).toBeLessThanOrEqual(runs);
    expect(doc?.body).toBe(2);
    expect(created?.body).toBe(5);
  });

  it("gives up with StoreBusy after six rounds", async () => {
    const store = storeOver(fakeContainer({ failReplace: 99 }));
    await store.update<number>("tables", "g", "x", () => 1);
    await expect(store.update<number>("tables", "g", "x", (body) => (body ?? 0) + 1)).rejects.toBeInstanceOf(StoreBusy);
  });

  it("returns the document it read when the change writes nothing", async () => {
    const store = storeOver(fakeContainer());
    await store.update<number>("tables", "g", "x", () => 1);
    expect((await store.update<number>("tables", "g", "x", (body) => body))?.version).toBe(1);
    expect((await store.update<number>("tables", "g", "none", () => null))).toBeNull();
  });

  it("lets a failure other than a conflict through", async () => {
    const container = fakeContainer();
    container.items.create = async () => {
      throw Object.assign(new Error("forbidden"), { code: 403 });
    };
    await expect(storeOver(container).update<number>("tables", "g", "x", () => 1)).rejects.toThrow("forbidden");
  });

  it("removing a missing document is fine", async () => {
    await expect(storeOver(fakeContainer()).remove("tables", "g", "nope")).resolves.toBeUndefined();
  });
});

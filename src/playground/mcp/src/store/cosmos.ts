import { CosmosClient } from "@azure/cosmos";
import type { TokenCredential } from "@azure/identity";
import type { Logger } from "../log";
import { TTL_SECONDS } from "../ports";
import type { Doc, Kind, Store } from "../ports";

// The public key of the Cosmos emulator. Not a secret.
export const EMULATOR_KEY = "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

export class StoreBusy extends Error {
  constructor() {
    super("The document kept changing under the writer.");
  }
}

interface Stored<T> {
  id: string;
  pk: string;
  version: number;
  updatedAt: number;
  body: T;
}

// The part of a Cosmos container this adapter uses, so a test can stand in for it.
export interface ContainerLike {
  item(id: string, pk: string): {
    read(): Promise<{ resource?: unknown; etag?: string; statusCode?: number }>;
    replace(doc: unknown, options: { accessCondition: { type: string; condition: string } }): Promise<unknown>;
    delete(): Promise<unknown>;
  };
  items: {
    create(doc: unknown): Promise<unknown>;
    query(
      spec: { query: string; parameters: { name: string; value: string | number }[] },
      options: { partitionKey: string },
    ): { fetchAll(): Promise<{ resources: unknown[] }> };
  };
}

export interface CosmosStoreOptions {
  containers: Record<Kind, ContainerLike>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const ROUNDS = 6;

function codeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function toDoc<T>(stored: Stored<T>): Doc<T> {
  return { id: stored.id, pk: stored.pk, version: stored.version, updatedAt: stored.updatedAt, body: stored.body };
}

export function cosmosStore(options: CosmosStoreOptions): Store {
  const { containers } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  async function read<T>(kind: Kind, pk: string, id: string): Promise<{ stored: Stored<T> | null; etag: string }> {
    try {
      const response = await containers[kind].item(id, pk).read();
      if (response.statusCode === 404 || response.resource === undefined) return { stored: null, etag: "" };
      return { stored: response.resource as Stored<T>, etag: response.etag ?? "" };
    } catch (error) {
      if (codeOf(error) === 404) return { stored: null, etag: "" };
      throw error;
    }
  }

  return {
    async get<T>(kind: Kind, pk: string, id: string) {
      const { stored } = await read<T>(kind, pk, id);
      return stored ? toDoc(stored) : null;
    },

    async update<T>(kind: Kind, pk: string, id: string, change: (body: T | null) => T | null) {
      for (let round = 0; round < ROUNDS; round++) {
        const { stored, etag } = await read<T>(kind, pk, id);
        const body = stored ? stored.body : null;
        const next = change(body);
        if (next === null || next === body) return stored ? toDoc(stored) : null;
        const doc: Stored<T> = { id, pk, version: (stored?.version ?? 0) + 1, updatedAt: now(), body: next };
        try {
          if (stored) {
            await containers[kind].item(id, pk).replace(doc, { accessCondition: { type: "IfMatch", condition: etag } });
          } else {
            await containers[kind].items.create(doc);
          }
          return toDoc(doc);
        } catch (error) {
          const code = codeOf(error);
          if (code !== 409 && code !== 412) throw error;
          await sleep(10 + random() * 50);
        }
      }
      throw new StoreBusy();
    },

    async list<T>(kind: Kind, pk: string, limit: number) {
      const { resources } = await containers[kind].items
        .query(
          {
            query: "SELECT TOP @n * FROM c WHERE c.pk = @pk ORDER BY c.updatedAt DESC",
            parameters: [{ name: "@n", value: limit }, { name: "@pk", value: pk }],
          },
          { partitionKey: pk },
        )
        .fetchAll();
      return (resources as Stored<T>[]).map(toDoc);
    },

    async remove(kind, pk, id) {
      try {
        await containers[kind].item(id, pk).delete();
      } catch (error) {
        if (codeOf(error) !== 404) throw error;
      }
    },
  };
}

export interface CosmosConnection {
  endpoint: string;
  database: string;
  log: Logger;
  // Exactly one of the two: the emulator takes a key, Azure takes the managed identity.
  key?: string;
  credential?: TokenCredential;
}

const KINDS: Kind[] = ["tables", "runs", "players"];

export async function createCosmosStore(connection: CosmosConnection): Promise<Store> {
  const emulator = connection.key !== undefined;
  const client = new CosmosClient({
    endpoint: connection.endpoint,
    ...(emulator
      ? { key: connection.key!, connectionPolicy: { enableEndpointDiscovery: false } }
      : { aadCredentials: connection.credential! }),
  });
  const database = client.database(connection.database);
  if (emulator) {
    await client.databases.createIfNotExists({ id: connection.database });
    for (const kind of KINDS) {
      await database.containers.createIfNotExists({
        id: kind,
        partitionKey: { paths: ["/pk"] },
        defaultTtl: TTL_SECONDS[kind],
        indexingPolicy: { includedPaths: [{ path: "/updatedAt/?" }], excludedPaths: [{ path: "/*" }] },
      });
    }
    connection.log.info("store.emulator", { database: connection.database });
  }
  const containers = Object.fromEntries(KINDS.map((kind) => [kind, database.container(kind) as unknown as ContainerLike])) as Record<
    Kind,
    ContainerLike
  >;
  return cosmosStore({ containers });
}

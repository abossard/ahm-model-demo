import { DefaultAzureCredential } from "@azure/identity";
import type { Config } from "../config";
import type { Logger } from "../log";
import type { Store } from "../ports";
import { createCosmosStore, EMULATOR_KEY } from "./cosmos";
import { createMemoryStore } from "./memory";

export async function createStore(config: Config, log: Logger): Promise<Store> {
  if (config.store === "memory") return createMemoryStore();
  if (config.store === "emulator") {
    return createCosmosStore({ endpoint: config.cosmosEndpoint, database: config.cosmosDatabase, key: EMULATOR_KEY, log });
  }
  return createCosmosStore({
    endpoint: config.cosmosEndpoint,
    database: config.cosmosDatabase,
    credential: new DefaultAzureCredential(),
    log,
  });
}

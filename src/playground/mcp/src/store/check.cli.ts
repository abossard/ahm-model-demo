import { loadConfig } from "../config";
import { createStore } from "./create";
import { checkStore } from "./check";
import { createLogger } from "../log";

const config = loadConfig(process.env, "");
const store = await createStore(config, createLogger("playground-mcp", config.logLevel));
const problem = await checkStore(store);
process.stdout.write(problem === null ? `store ${config.store}: passed\n` : `store ${config.store}: ${problem}\n`);
process.exit(problem === null ? 0 : 1);

import { randomInt } from "node:crypto";
import { createServer as listen } from "node:http";
import { DefaultAzureCredential } from "@azure/identity";
import { createCareers } from "./careers";
import { createChanges } from "./changes";
import { ConfigError, loadConfig } from "./config";
import { createDealer } from "./dealer";
import { blackjack } from "./games/blackjack";
import { checkers } from "./games/checkers";
import { fakeDealer } from "./games/fakeDealer";
import { trader } from "./games/trader";
import { createApp } from "./http";
import { createAzureLlm } from "./llm/azure";
import { createBrokenLlm } from "./llm/broken";
import { createFakeLlm } from "./llm/fake";
import { createLogger, describeError } from "./log";
import { createMcpServer } from "./server";
import { watchStore } from "./store/check";
import type { StoreCheckState } from "./store/check";
import { createStore } from "./store/create";
import { createTables } from "./tables";
import { loadViews } from "./views";

const SVC = "playground-mcp";
const DEFAULT_VIEWS_DIR = new URL("../../views/dist", import.meta.url).pathname;

try {
  const config = loadConfig(process.env, DEFAULT_VIEWS_DIR);
  const log = createLogger(SVC, config.logLevel);
  const startedAt = Date.now();

  const store = await createStore(config, log);
  const changes = createChanges();
  const careers = createCareers(store);
  const clock = { now: () => Date.now(), seed: () => randomInt(0, 2 ** 32) };
  const llm =
    config.llm === "fake"
      ? createFakeLlm(fakeDealer)
      : config.llm === "broken"
        ? createBrokenLlm()
        : createAzureLlm({
            endpoint: config.dealerEndpoint,
            deployment: config.dealerDeployment,
            credential: new DefaultAzureCredential(),
            log,
          });
  const dealer = createDealer({ store, changes, careers, clock, rules: blackjack, llm, log });
  const tables = createTables({
    store, changes, clock, careers, dealer,
    rules: { checkers, trader, blackjack },
    fast: config.fast,
    longPollMs: config.longPollMs,
  });

  const views = loadViews(config.viewsDir);
  if (views.missing.length > 0) log.error("error", { where: "views", dir: config.viewsDir, missing: views.missing });

  let storeState: StoreCheckState = { ready: false, check: "running" };
  watchStore(store, (state) => {
    if (state.check !== storeState.check) log.info("store.check", { check: state.check });
    storeState = state;
  });

  const toolContext = { tables, careers, clock, log, countdownMs: 400 };
  const app = createApp({
    createServer: () => createMcpServer(toolContext, views),
    health: () => ({
      store: { driver: config.store, ...storeState },
      llm: dealer.status(),
      views: Object.keys(views.docs),
      missingViews: views.missing,
    }),
    log,
    startedAt,
  });

  const server = listen(app).listen(config.port, () => {
    log.info("start", { port: config.port, store: config.store, llm: llm.name, fast: config.fast, viewsDir: config.viewsDir });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${describeError(error)}\n`);
  }
  process.exit(1);
}

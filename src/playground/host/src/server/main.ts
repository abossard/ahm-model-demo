import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { ConfigError, readConfig } from "./config";
import { createFeed } from "./feed";
import { createLog } from "./log";

const SVC = "playground-host";
const here = dirname(fileURLToPath(import.meta.url));

try {
  const config = readConfig(process.env, join(here, "../../dist"));
  const log = createLog(SVC, config.logLevel);
  const feed = createFeed();
  const app = createApp({ config, log, feed });
  setInterval(() => feed.heartbeat(), 15_000).unref();
  app.listen(config.port, () => log("info", "start", { port: config.port, mcpUrl: config.mcpUrl, webDir: config.webDir }));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${SVC}: ${error.message}\n`);
  process.exit(1);
}

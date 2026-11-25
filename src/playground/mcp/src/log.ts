import type { LogLevel } from "./config";

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(
  svc: string,
  level: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => number = Date.now,
): Logger {
  const at = (target: LogLevel) => (msg: string, fields: Fields = {}) => {
    if (RANK[target] < RANK[level]) return;
    write(JSON.stringify({ t: new Date(now()).toISOString(), level: target, svc, msg, ...fields }));
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

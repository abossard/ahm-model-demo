export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;
export type Log = (level: Level, msg: string, fields?: Fields) => void;

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// One JSON line per call. Container Apps ships stdout to the log workspace.
export function createLog(svc: string, min: Level, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`), now: () => Date = () => new Date()): Log {
  return (level, msg, fields = {}) => {
    if (RANK[level] < RANK[min]) return;
    write(JSON.stringify({ t: now().toISOString(), level, svc, msg, ...fields }));
  };
}

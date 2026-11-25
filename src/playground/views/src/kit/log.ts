export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface LogRecord extends LogFields {
  t: string;
  level: LogLevel;
  view: string;
  msg: string;
}

// A calculation: one structured record, the same shape as the server log lines.
export function logRecord(view: string, level: LogLevel, msg: string, fields: LogFields, now: number): LogRecord {
  return { ...fields, t: new Date(now).toISOString(), level, view, msg };
}

let view = "view";

// Called once by `launch`. Every record of this View carries its name.
export function setLogView(name: string): void {
  view = name;
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  console[level](JSON.stringify(logRecord(view, level, msg, fields, Date.now())));
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

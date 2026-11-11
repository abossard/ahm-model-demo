import type { ActivityEvent } from "./types";

export type ActivityIcon = "status" | "text" | "tool" | "toolOk" | "toolFailed" | "result" | "error";
export type ActivityTone = "neutral" | "success" | "danger";

export interface ActivityPresentation {
  readonly icon: ActivityIcon;
  readonly tone: ActivityTone;
  readonly title: string;
  readonly detail: string | null;
  /** What a screen reader is told when the event arrives; null keeps the step silent. */
  readonly announcement: string | null;
}

const DETAIL_LIMIT = 2000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function clip(value: string): string {
  return value.length <= DETAIL_LIMIT ? value : `${value.slice(0, DETAIL_LIMIT)}...`;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function problems(payload: ActivityEvent["payload"]): string | null {
  const list = payload["problems"];
  return Array.isArray(list) && list.length > 0 ? list.map(String).join("\n") : null;
}

export function presentActivity(event: ActivityEvent): ActivityPresentation {
  const { kind, summary, payload } = event;
  switch (kind) {
    case "status":
      return { icon: "status", tone: "neutral", title: summary, detail: null, announcement: summary };
    case "text": {
      const full = text(payload["text"]);
      return {
        icon: "text",
        tone: "neutral",
        title: summary,
        detail: full !== null && full.trim() !== summary ? clip(full) : null,
        announcement: null,
      };
    }
    case "tool_call": {
      const args = text(payload["arguments"]);
      return {
        icon: "tool",
        tone: "neutral",
        title: summary,
        detail: args === null ? null : clip(prettyJson(args)),
        announcement: null,
      };
    }
    case "tool_result": {
      const ok = payload["ok"] !== false;
      return {
        icon: ok ? "toolOk" : "toolFailed",
        tone: ok ? "success" : "danger",
        title: summary,
        detail: problems(payload),
        announcement: null,
      };
    }
    case "result":
      return { icon: "result", tone: "success", title: summary, detail: null, announcement: summary };
    case "error":
      return {
        icon: "error",
        tone: "danger",
        title: summary,
        detail: problems(payload) ?? text(payload["message"]),
        announcement: `Task failed: ${summary}`,
      };
  }
}

const KINDS: readonly string[] = ["status", "text", "tool_call", "tool_result", "result", "error"];

/** An event as it arrives on the stream, or null when the frame is not an Activity event. */
export function parseActivityEvent(data: unknown): ActivityEvent | null {
  let value: unknown = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { seq, ts, kind, summary, payload } = record;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (typeof ts !== "string" || typeof summary !== "string") return null;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  const body = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  return { seq, ts, kind: kind as ActivityEvent["kind"], summary, payload: body as ActivityEvent["payload"] };
}

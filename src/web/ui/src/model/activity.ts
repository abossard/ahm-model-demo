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

const BARE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/;

/** A step titled with a bare tool name ("submit_result") reads as the step it is ("Submit result"); any other title stays. */
export function plainStep(title: string): string {
  if (!BARE_IDENTIFIER.test(title)) return title;
  const words = title.replace(/[_-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A tool step in three tenses: while it runs, when it worked, when it did not. */
interface Tenses {
  readonly doing: string;
  readonly done: string;
  readonly failed: string;
}

function tenses(doing: string, done: string, failed: string): Tenses {
  return { doing, done, failed };
}

function count(value: string | undefined, one: string, many: string): string {
  return value === "1" ? `1 ${one}` : `${value ?? "some"} ${many}`;
}

// The titles the app gives tool calls (activity.py), in the words of what the assistant is doing for the user.
const TOOLS: readonly (readonly [RegExp, (match: RegExpMatchArray) => Tenses])[] = [
  [/^Load skill\b/, () => tenses("Loading the analysis method", "Loaded the analysis method", "Could not load the analysis method")],
  [/^Read skill resource\b/, () => tenses("Reading the analysis guidance", "Read the analysis guidance", "Could not read the analysis guidance")],
  [/^Run shell\b/, () => tenses("Running a helper script", "Ran a helper script", "A helper script failed")],
  [
    /^Submit result \((explain|diff),\s*(\d+) \w+\)/,
    (match) =>
      match[1] === "explain"
        ? tenses("Writing the answer", "Wrote the answer", "The answer was not accepted")
        : tenses("Writing the proposed changes", `Wrote ${count(match[2], "proposed change", "proposed changes")}`, "The proposed changes were not accepted"),
  ],
  [/^Submit result\b/, () => tenses("Writing the result", "Wrote the result", "The result was not accepted")],
  [/^List health models\b/, () => tenses("Listing the health models", "Listed the health models", "Could not list the health models")],
  [
    /^Get health model(?: (\S+))?$/,
    (match) => {
      const name = match[1] ? ` ${match[1]}` : "";
      return tenses(`Reading the health model${name}`, `Read the health model${name}`, `Could not read the health model${name}`);
    },
  ],
  [
    /^Inspect health model(?: (\S+))?(?: \((.*)\))?$/,
    (match) => {
      const name = match[1] ? ` ${match[1]}` : "";
      const from = match[2]?.match(/entity ([^\s,)]+)/)?.[1];
      const walk = match[2]?.match(/walk ([^,)]+)/)?.[1];
      const where = from ? `, starting at ${from}${walk ? ` (${walk})` : ""}` : "";
      return tenses(`Reading the health model${name}${where}`, `Read the health model${name}${where}`, `Could not read the health model${name}`);
    },
  ],
  [/^List metric definitions\b/, () => tenses("Looking up which metrics exist", "Looked up which metrics exist", "Could not look up the metrics")],
  [
    /^Query metrics(?: (.+))?$/,
    (match) => {
      const metric = match[1] ? ` ${match[1]}` : "";
      return tenses(`Reading the metric${metric}`, `Read the metric${metric}`, `Could not read the metric${metric}`);
    },
  ],
  [
    /^Run log query(?: on (.+))?$/,
    (match) => {
      const table = match[1] ? ` in ${match[1]}` : "";
      return tenses(`Querying the logs${table}`, `Queried the logs${table}`, `The log query${table} failed`);
    },
  ],
  [
    /^List resources(?: in (.+))?$/,
    (match) => {
      const group = match[1] ? ` in ${match[1]}` : "";
      return tenses(`Listing the resources${group}`, `Listed the resources${group}`, `Could not list the resources${group}`);
    },
  ],
  [/^List activity log\b/, () => tenses("Checking what changed in Azure", "Checked what changed in Azure", "Could not check what changed in Azure")],
  [
    /^Clone repository(?: (.+))?$/,
    (match) => {
      const name = match[1] ? ` ${match[1]}` : "";
      return tenses(`Reading the repository${name}`, `Read the repository${name}`, `Could not read the repository${name}`);
    },
  ],
];

// The app ends a tool result's title with how it went: "<step>: ok, 1.2 KB", "<step>: failed, ...", "<step>: accepted".
const RESULT_TITLE = /^(.*?): (ok|failed|accepted|rejected)\b(.*)$/;

function tenseOf(step: string): Tenses | null {
  for (const [pattern, make] of TOOLS) {
    const match = step.match(pattern);
    if (match) return make(match);
  }
  return null;
}

/** The title of a tool call, as what the assistant is doing. */
function callTitle(summary: string): string {
  return tenseOf(summary)?.doing ?? plainStep(summary);
}

/** The title of a tool result, as how that step went. */
function resultTitle(summary: string): string {
  const parsed = RESULT_TITLE.exec(summary);
  if (parsed === null) return plainStep(summary);
  const tense = tenseOf(parsed[1] ?? "");
  if (tense === null) return plainStep(parsed[1] ?? summary);
  if (parsed[2] === "ok" || parsed[2] === "accepted") return tense.done;
  // A rejected result says how many problems it had, which is what the user wants to know first.
  const problems = /(\d+) problems?/.exec(parsed[3] ?? "")?.[1];
  return problems === undefined ? tense.failed : `${tense.failed} (${count(problems, "problem", "problems")})`;
}

const STATUSES: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
  [/^(?:Agent|Task) started$/, () => "The assistant started working"],
  [/^Agent finished$/, () => "The assistant finished"],
  [/^Agent stopped early \((.+)\)$/, (match) => `The assistant stopped early (${match[1]})`],
];

function statusTitle(summary: string, payload: ActivityEvent["payload"]): string {
  for (const [pattern, make] of STATUSES) {
    const match = summary.match(pattern);
    if (match) return make(match);
  }
  // The service is busy and the app asks again: which try this is and when the next one comes.
  const { attempt, of, waitSeconds } = payload;
  if (/^The assistant is busy, trying again\b/.test(summary) && typeof attempt === "number" && typeof of === "number") {
    const next = typeof waitSeconds === "number" ? `, next try in ${waitSeconds} s` : "";
    return `${summary.replace(/\.$/, "")} (try ${attempt} of ${of}${next})`;
  }
  return summary;
}

function resultEventTitle(summary: string): string {
  const match = summary.match(/^Result accepted \((explain|diff),\s*(\d+) \w+\)$/);
  if (match === null) return summary;
  return match[1] === "explain" ? "The answer is ready" : `The proposed changes are ready (${match[2]})`;
}

/** What a step says about itself that only an engineer needs: the tool, the title the app gave it and the arguments. */
function toolDetail(event: ActivityEvent, title: string): string | null {
  const name = text(event.payload["name"]);
  const args = text(event.payload["arguments"]);
  const size = typeof event.payload["size"] === "number" ? (event.payload["size"] as number) : null;
  const lines = [
    name === null ? null : `Tool: ${name}`,
    event.summary !== title ? `Step: ${event.summary}` : null,
    size === null ? null : `Size of the answer: ${size} bytes`,
    problems(event.payload),
    args === null ? null : `Arguments:\n${clip(prettyJson(args))}`,
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join("\n");
}

export function presentActivity(event: ActivityEvent): ActivityPresentation {
  const { kind, payload } = event;
  switch (kind) {
    case "status": {
      const title = statusTitle(event.summary, payload);
      return { icon: "status", tone: "neutral", title, detail: null, announcement: title };
    }
    case "text": {
      const full = text(payload["text"]);
      return {
        icon: "text",
        tone: "neutral",
        title: event.summary,
        detail: full !== null && full.trim() !== event.summary ? clip(full) : null,
        announcement: null,
      };
    }
    case "tool_call": {
      const title = callTitle(event.summary);
      return { icon: "tool", tone: "neutral", title, detail: toolDetail(event, title), announcement: null };
    }
    case "tool_result": {
      const ok = payload["ok"] !== false;
      const title = resultTitle(event.summary);
      return {
        icon: ok ? "toolOk" : "toolFailed",
        tone: ok ? "success" : "danger",
        title,
        detail: toolDetail(event, title),
        announcement: null,
      };
    }
    case "result": {
      const title = resultEventTitle(event.summary);
      return { icon: "result", tone: "success", title, detail: null, announcement: title };
    }
    case "error":
      return {
        icon: "error",
        tone: "danger",
        title: event.summary,
        detail: problems(payload) ?? text(payload["message"]),
        announcement: `The assistant stopped: ${event.summary}`,
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

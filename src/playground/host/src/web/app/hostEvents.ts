import type { HostEvent } from "./wireApi";

export interface HostLogEntry {
  id: number;
  at: number;
  type: HostEvent["type"];
  view: string;
  text: string;
  // A https link the visitor can confirm, for a `link` entry.
  link: string | null;
  // The raw payload, for the visitor who wants to see it.
  detail: unknown;
}

export const HOST_LOG_LIMIT = 100;

// A calculation: only https links open. Anything else the host refuses.
export function safeLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function preview(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// A calculation: what the host says about a request a View made of it, in the voice of the page.
export function describeHostEvent(event: HostEvent): { text: string; link: string | null; detail: unknown } {
  switch (event.type) {
    case "ready": return { text: "The View finished its handshake. The host sent it the tool input.", link: null, detail: null };
    case "size": return { text: `The View asked for ${Math.round(event.height)} px of height.`, link: null, detail: null };
    case "career": return { text: `A tool result carried the career: layer ${event.career.unlocked} open.`, link: null, detail: event.career };
    case "message": return { text: `The View sent the model a message: "${preview(event.text)}"`, link: null, detail: event.text };
    case "context": return { text: `The View updated the model context: ${preview(event.value)}`, link: null, detail: event.value };
    case "link": {
      const link = safeLink(event.url);
      return {
        text: link ? `The View asked to open ${link}. Nothing opens until you confirm.` : `The View asked to open ${preview(event.url, 80)}. The host refuses: only https links open.`,
        link, detail: event.url,
      };
    }
    case "display": return { text: `The View asked for ${event.mode} display.`, link: null, detail: null };
    case "log": return { text: `The View logged at ${event.level}: ${preview(event.data)}`, link: null, detail: event.data };
    case "error": return { text: `The host could not run the View: ${event.message}`, link: null, detail: null };
  }
}

// A calculation: the log with one more entry. A run of size requests keeps only the last, and the log keeps its newest `limit`.
export function pushEntry(log: readonly HostLogEntry[], entry: HostLogEntry, limit = HOST_LOG_LIMIT): HostLogEntry[] {
  const last = log.at(-1);
  const base = last && last.type === "size" && entry.type === "size" && last.view === entry.view ? log.slice(0, -1) : log;
  return [...base, entry].slice(-limit);
}

// The one line the page writes to the console for something it did. Same shape as the wire core's `[wire]` lines.
export function hostLine(topic: string, fields: Record<string, unknown> = {}): string {
  const rest = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return ["[host]", topic, ...rest].join(" ");
}

export function logHost(topic: string, fields: Record<string, unknown> = {}): void {
  console.debug(hostLine(topic, fields), fields);
}

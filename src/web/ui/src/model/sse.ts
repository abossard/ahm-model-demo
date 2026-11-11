/** One event of a text/event-stream: the frame between two blank lines. */
export interface SseFrame {
  /** The `event:` name; `message` when the frame names none. */
  readonly event: string;
  readonly data: string;
  /** The last `id:` seen on the stream so far, which a reconnect sends back as `Last-Event-ID`. */
  readonly id: string | null;
}

export interface SseParser {
  /** Feeds the next piece of text and returns the frames it completed. A piece may end anywhere, even between a CR and its LF. */
  readonly push: (chunk: string) => readonly SseFrame[];
  /** The reconnect delay in milliseconds the last `retry:` field asked for, even one that came alone, or null. */
  readonly retry: () => number | null;
}

/** A pure line parser for the wire format of the Activity timeline: `id:`, `event:`, `data:`, `retry:` and `:` comments. */
export function createSseParser(): SseParser {
  let pending = "";
  let event = "";
  let data: string[] = [];
  let hasData = false;
  let retry: number | null = null;
  let lastId: string | null = null;

  const field = (line: string, frames: SseFrame[]): void => {
    if (line === "") {
      if (hasData) frames.push({ event: event === "" ? "message" : event, data: data.join("\n"), id: lastId });
      event = "";
      data = [];
      hasData = false;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") event = value;
    else if (name === "data") {
      data.push(value);
      hasData = true;
    } else if (name === "id") {
      if (!value.includes("\0")) lastId = value;
    } else if (name === "retry" && /^[0-9]+$/.test(value)) retry = Number(value);
  };

  return {
    retry: () => retry,
    push: (chunk) => {
      const frames: SseFrame[] = [];
      pending += chunk;
      // A trailing CR may be the first half of a CRLF, so it waits for the next piece.
      const complete = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      const rest = pending.slice(complete.length);
      const lines = complete.split(/\r\n|\n|\r/);
      pending = lines.pop() + rest;
      for (const line of lines) field(line, frames);
      return frames;
    },
  };
}

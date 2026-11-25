export interface SseState {
  pending: string;
}

export const SSE_START: SseState = { pending: "" };

// A calculation: text chunks in, the `data:` payload of each complete event out.
// Chunks may split an event, a line or a CRLF anywhere. Comments and events with no data are dropped.
export function readSse(state: SseState, chunk: string): { state: SseState; payloads: string[] } {
  const raw = state.pending + chunk;
  // A trailing CR may be the first half of a CRLF, so it waits for the next chunk.
  const hold = raw.endsWith("\r") ? "\r" : "";
  const parts = raw.slice(0, raw.length - hold.length).replace(/\r\n?/g, "\n").split("\n\n");
  const pending = (parts.pop() ?? "") + hold;
  const payloads: string[] = [];
  for (const block of parts) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) payloads.push(data.join("\n"));
  }
  return { state: { pending }, payloads };
}

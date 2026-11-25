import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { classify, toDebugEvent } from "@playground/contracts";
import type { Party } from "@playground/contracts";
import type { Wire } from "./wire";

export function mintTrace(random: Uint8Array = crypto.getRandomValues(new Uint8Array(6))): string {
  return `t-${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// The browser's recorder numbers all its events in one sequence, however many Views are open.
const counters = new WeakMap<Wire, number>();
function nextSeq(wire: Wire): number {
  const seq = (counters.get(wire) ?? 0) + 1;
  counters.set(wire, seq);
  return seq;
}

export interface Tap extends Transport {
  // The trace minted for a request of the View, while that request is open.
  traceOf(rpcId: string | number): string | undefined;
  // The trace the host's own messages to the View carry from now on (tool input, tool result).
  setEntryTrace(trace: string | null): void;
}

export interface TapOptions {
  wire: Wire;
  viewId: string;
  now?: () => number;
}

interface Open {
  trace: string;
  progressToken: string | number | undefined;
}

// Wraps the transport between a View and its AppBridge and records every message in both directions
// the moment it is sent or received, as the bridge hands it to the transport. It changes nothing.
export function tap(inner: Transport, { wire, viewId, now = Date.now }: TapOptions): Tap {
  const open = new Map<string | number, Open>();
  const progress = new Map<string | number, string>();
  let entry: string | null = null;
  let onmessage: Transport["onmessage"];

  function traceFor(from: Party, message: JSONRPCMessage): string | null {
    const seen = classify(message);
    const params = (message as { params?: { progressToken?: unknown } }).params;
    if (from === "view") {
      if (seen.kind !== "request" || seen.rpcId === null) return null;
      const trace = mintTrace();
      const meta = (message as { params?: { _meta?: { progressToken?: unknown } } }).params?._meta;
      const token = meta?.progressToken;
      open.set(seen.rpcId, { trace, progressToken: typeof token === "string" || typeof token === "number" ? token : undefined });
      if (typeof token === "string" || typeof token === "number") progress.set(token, trace);
      return trace;
    }
    if ((seen.kind === "response" || seen.kind === "error") && seen.rpcId !== null) {
      const found = open.get(seen.rpcId);
      open.delete(seen.rpcId);
      if (found?.progressToken !== undefined) progress.delete(found.progressToken);
      return found?.trace ?? null;
    }
    if (seen.method === "notifications/progress") {
      const token = params?.progressToken;
      return typeof token === "string" || typeof token === "number" ? (progress.get(token) ?? null) : null;
    }
    return seen.method?.startsWith("ui/notifications/tool-") ? entry : null;
  }

  function record(from: Party, to: Party, message: JSONRPCMessage): void {
    try {
      wire.record(toDebugEvent({
        seq: nextSeq(wire), at: now(), sid: wire.sid, hop: "view-host", from, to, view: viewId, trace: traceFor(from, message),
      }, message));
    } catch (error) {
      // The wire is a witness. A failure to record never changes what the View and the host say to each other.
      console.error("[wire] could not record a message", error);
    }
  }

  return {
    start: () => inner.start(),
    close: () => inner.close(),
    send(message: JSONRPCMessage, options?: TransportSendOptions) {
      record("host", "view", message);
      return inner.send(message, options);
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
      inner.onmessage = handler && (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
        record("view", "host", message);
        handler(message, extra);
      });
    },
    get onclose() {
      return inner.onclose;
    },
    set onclose(handler) {
      inner.onclose = handler;
    },
    get onerror() {
      return inner.onerror;
    },
    set onerror(handler) {
      inner.onerror = handler;
    },
    get sessionId() {
      return inner.sessionId;
    },
    get setProtocolVersion() {
      return inner.setProtocolVersion?.bind(inner);
    },
    traceOf: (rpcId) => open.get(rpcId)?.trace,
    setEntryTrace(trace) {
      entry = trace;
    },
  };
}

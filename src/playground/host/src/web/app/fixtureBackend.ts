// A stand-in for the wire core, for `?fixture` and for a checkout where the core has not landed. It replays
// drawer/fixture.json, answers tool calls with canned results and mounts a placeholder View whose button does the layer's job.
import {
  advanceCareer, createPairing, LAB_EXHIBITS, NEW_CAREER, toDebugEvent, TOOLS, toolMeta, TRACE_META_KEY,
  type Career, type CareerEvent, type DebugEvent, type Party, type Player, type ToolName,
} from "@playground/contracts";
import { z } from "zod";
import fixtureEvents from "../drawer/fixture.json";
import type { Backend } from "./backend";
import { viewOf } from "./entry";
import type { McpClient, MountedView, MountOptions, ToolInfo, ToolResult, Wire } from "./wireApi";

const FIXTURE_PLAYER: Player = { id: "p-fixture0001", handle: "Velvet Pilot" };
const LIMIT = 2000;

function createFixtureWire(seed: readonly DebugEvent[]): Wire {
  let events: readonly DebugEvent[] = seed;
  let buffer: DebugEvent[] = [];
  let paused = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const pair = createPairing();
  for (const event of seed) pair(event);
  return {
    sid: "sid-fixture-01",
    events: () => events,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    record(event) {
      const paired = pair(event);
      if (paused) {
        buffer.push(paired);
        return;
      }
      events = [...events, paired].slice(-LIMIT);
      notify();
    },
    setPaused(next) {
      paused = next;
      if (!next && buffer.length > 0) {
        events = [...events, ...buffer].slice(-LIMIT);
        buffer = [];
        notify();
      }
    },
    clear() {
      events = [];
      buffer = [];
      notify();
    },
  };
}

const toolInfos: ToolInfo[] = (Object.keys(TOOLS) as ToolName[]).map((name) => ({
  name,
  title: TOOLS[name].title,
  description: TOOLS[name].description,
  inputSchema: z.toJSONSchema(TOOLS[name].input),
  _meta: toolMeta(name),
}));

const JOB: Record<string, (career: Career) => CareerEvent> = {
  hello_show: () => ({ type: "hello_ping" }),
  lab_open: (career) => ({ type: "lab_exhibit", exhibit: LAB_EXHIBITS[career.lab.length % LAB_EXHIBITS.length]! }),
  checkers_open: () => ({ type: "checkers_capture" }),
  trader_open: () => ({ type: "trader_profit" }),
  blackjack_open: () => ({ type: "blackjack_win" }),
};

export function createFixtureBackend(): Backend {
  const wire = createFixtureWire(fixtureEvents as unknown as DebugEvent[]);
  let seq = 1000;
  let rpc = 100;
  let server: Career = NEW_CAREER;

  const say = (hop: "view-host" | "host-server", from: Party, to: Party, message: unknown, view: string | null, trace: string | null) => {
    seq += 1;
    wire.record(toDebugEvent({ seq, at: Date.now(), sid: wire.sid, hop, from, to, view, trace,
      http: hop === "host-server" ? { method: "POST", path: "/mcp", status: 200, contentType: "text/event-stream", streamed: true } : null }, message));
  };

  async function call(name: string, args: Record<string, unknown>, trace: string, view: string | null = null): Promise<{ result: ToolResult; career: Career | null }> {
    rpc += 1;
    const id = rpc;
    say("host-server", "host", "server", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { [TRACE_META_KEY]: trace } } }, view, trace);
    await new Promise((resolve) => setTimeout(resolve, 90));
    let career: Career | null = null;
    let structured: Record<string, unknown> = { ok: true };
    if (name === "career_get") structured = { career: server };
    if (name === "career_cheat") {
      server = advanceCareer(server, { type: "cheat" });
      career = server;
      structured = { career: server, notice: null };
    }
    const result: ToolResult = { structuredContent: structured, _meta: { [TRACE_META_KEY]: trace, ...(career ? { "playground/career": career } : {}) } };
    say("host-server", "server", "host", { jsonrpc: "2.0", id, result }, view, trace);
    return { result, career };
  }

  const client: McpClient = { listTools: async () => ({ tools: toolInfos }) };
  const core: Backend["core"] = {
    async callTool(_client, _wire, name, args, trace = `tr-${Date.now().toString(36)}`) {
      const { result, career } = await call(name, args as Record<string, unknown>, trace);
      return { output: result.structuredContent as never, career, result };
    },
    async mountView(options: MountOptions): Promise<MountedView> {
      const { frame, tool, onHost } = options;
      const view = `${viewOf(tool)}-fx`;
      frame.srcdoc = placeholder(viewOf(tool), tool);
      const press = async () => {
        const trace = `tr-${Date.now().toString(36)}`;
        const next = advanceCareer(server, (JOB[tool] ?? JOB.hello_show!)(server));
        say("view-host", "view", "host", { jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "app_job", arguments: {}, _meta: { [TRACE_META_KEY]: trace } } }, view, trace);
        const { result } = await call("app_job", {}, trace, view);
        say("view-host", "host", "view", { jsonrpc: "2.0", id: rpc, result }, view, trace);
        if (next !== server) {
          server = next;
          onHost({ type: "career", career: next });
        }
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source === frame.contentWindow && event.data?.type === "press") void press();
      };
      window.addEventListener("message", onMessage);
      queueMicrotask(() => {
        onHost({ type: "ready" });
        onHost({ type: "size", height: 300 });
      });
      return {
        viewId: view,
        setTheme: (theme) => frame.contentWindow?.postMessage({ type: "theme", theme }, "*"),
        viewTools: async () => [],
        callViewTool: async () => ({ isError: true, content: "The placeholder View offers no tools." }),
        close: async () => window.removeEventListener("message", onMessage),
      };
    },
  };
  return { fixture: true, wire, player: FIXTURE_PLAYER, connect: async () => client, core };
}

function placeholder(view: string, tool: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px system-ui;background:#161A22;color:#F2EDE2;display:grid;place-items:center;height:300px">
<main style="text-align:center"><p style="margin:0 0 4px;color:#A9A294">Placeholder ${view} View, opened by ${tool}</p>
<button style="font:inherit;padding:10px 18px;border:2px solid #FF9A1F;background:#FF9A1F;color:#0D0F14;font-weight:600;cursor:pointer" onclick="parent.postMessage({type:'press'},'*')">Do the layer's job</button></main>
<script>addEventListener('message',e=>{if(e.data&&e.data.type==='theme'){document.body.style.background=e.data.theme==='light'?'#F2EDE2':'#161A22';document.body.style.color=e.data.theme==='light'?'#0D0F14':'#F2EDE2'}})</script>`;
}

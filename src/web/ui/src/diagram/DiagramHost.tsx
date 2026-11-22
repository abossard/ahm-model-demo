import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorized } from "../store/api";
import { useStore } from "../store/store";
import type { DiagramData } from "./data";

const TOOL = "show_health_model_diagram";
const UI = "io.modelcontextprotocol/ui";
let viewUrl: Promise<string> | undefined;

// Only the digest of this deployment's HTML is cached. Each iframe gets its own bridge and data.
async function resolveView(): Promise<string> {
  const client = new Client({ name: "Health Pulse", version: "1" }, {
    capabilities: { extensions: { [UI]: { mimeTypes: [RESOURCE_MIME_TYPE] } } },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/builder/mcp", location.origin), {
      fetch: (url, init) => authorized(String(url), init),
    }));
    const {tools} = await client.listTools();
    const tool = tools.find(entry => entry.name === TOOL);
    const uri = (tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
    if (!uri || !client.getServerCapabilities()?.extensions?.[UI]) throw new Error("The diagram View is unavailable.");
    const [resource, result] = await Promise.all([
      client.readResource({uri}), client.callTool({name: TOOL, arguments: {}}),
    ]);
    const html = resource.contents.find(item => item.uri === uri && item.mimeType === RESOURCE_MIME_TYPE);
    if (result.isError || !html || !("text" in html)) throw new Error("The diagram View could not be read.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html.text)));
    return "/diagram/view/" + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    await client.close().catch(() => {});
  }
}

export default function DiagramHost({ diagram }: { diagram: DiagramData }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const connected = useRef<AppBridge | null>(null);
  const latest = useRef(diagram);
  const theme = useStore(state => state.theme);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"opening" | "ready" | "error">("opening");
  const [height, setHeight] = useState(220);

  useEffect(() => {
    latest.current = diagram;
    const bridge = connected.current;
    if (bridge) void bridge.sendToolResult({content: [], structuredContent: {diagram}}).catch(() => {
      if (connected.current === bridge) setStatus("error");
    });
  }, [diagram]);

  useEffect(() => {
    const iframe = frame.current;
    const child = iframe?.contentWindow;
    if (!iframe || !child) return;
    let closed = false;
    const bridge = new AppBridge(null, {name: "Health Pulse", version: "1"}, {}, {hostContext: {theme: useStore.getState().theme}});
    const timer = window.setTimeout(() => { if (!closed) setStatus("error"); }, 30000);
    bridge.onsizechange = ({height}) => {
      if (!closed && height !== undefined && Number.isFinite(height)) setHeight(Math.max(32, Math.min(1800, Math.ceil(height))));
    };
    bridge.oninitialized = () => {
      if (closed) return;
      connected.current = bridge;
      bridge.setHostContext({theme: useStore.getState().theme});
      void bridge.sendToolResult({content: [], structuredContent: {diagram: latest.current}}).then(() => {
        if (!closed) { window.clearTimeout(timer); setStatus("ready"); }
      }).catch(() => { if (!closed) setStatus("error"); });
    };
    async function connect() {
      viewUrl ??= resolveView().catch(error => { viewUrl = undefined; throw error; });
      const url = await viewUrl;
      if (closed) return;
      await bridge.connect(new PostMessageTransport(child!, child!));
      if (!closed) iframe!.src = url;
    }
    void connect().catch(() => { if (!closed) setStatus("error"); });
    return () => {
      closed = true;
      window.clearTimeout(timer);
      connected.current = null;
      void bridge.close().catch(() => {});
    };
  }, [attempt]);

  useEffect(() => { connected.current?.setHostContext({theme}); }, [theme]);

  return <div className="diagram-host" data-testid="diagram-host">
    {status === "opening" && <p role="status">Opening dependency map…</p>}
    {status === "error" && <p role="status">The dependency map couldn’t open. <button type="button" onClick={() => {
      viewUrl = undefined; setStatus("opening"); setAttempt(value => value + 1);
    }}>Try again</button></p>}
    <iframe key={attempt} title="Interactive health model diagram" ref={frame} sandbox="allow-scripts" referrerPolicy="no-referrer"
      style={{display: status === "ready" ? "block" : "none", width: "100%", height, border: 0}} />
  </div>;
}

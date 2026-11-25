import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, VIEW_MIME, VIEW_PATH } from "@playground/contracts";
import type { Career, ToolName } from "@playground/contracts";
import { callTool, callWithTrace, careerOf } from "./mcp";
import { mintTrace, tap } from "./tap";
import type { Wire } from "./wire";

export type HostEvent =
  | { type: "ready" } | { type: "size"; height: number } | { type: "career"; career: Career }
  | { type: "message"; text: string } | { type: "context"; value: unknown } | { type: "link"; url: string }
  | { type: "display"; mode: "inline" | "fullscreen" } | { type: "log"; level: string; data: unknown }
  | { type: "error"; message: string };

export interface MountOptions {
  client: Client;
  wire: Wire;
  frame: HTMLIFrameElement;
  tool: ToolName;
  args: Record<string, unknown>;
  theme: "light" | "dark";
  onHost(event: HostEvent): void;
}

export interface Mounted {
  viewId: string;
  setTheme(theme: "light" | "dark"): void;
  viewTools(): Promise<Tool[]>;
  callViewTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

const HOST_INFO = { name: "MCP App Playground", version: "1" };
const TEARDOWN_MS = 500;

// A calculation: lowercase hex SHA-256 of the text, the name the host server files a View document under.
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function uiResourceUri(tool: Tool | undefined): string | undefined {
  const uri = (tool?._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
  return typeof uri === "string" ? uri : undefined;
}

const toolLists = new WeakMap<Client, Promise<Tool[]>>();
function listTools(client: Client): Promise<Tool[]> {
  let cached = toolLists.get(client);
  if (!cached) {
    cached = (async () => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    })();
    cached.catch(() => toolLists.delete(client));
    toolLists.set(client, cached);
  }
  return cached;
}

// One View in one frame: finds its document through the MCP client, connects an AppBridge to the frame through the tap,
// and answers the View's requests. The frame navigates last, so the bridge is listening when the View starts.
export async function mountView({ client, wire, frame, tool, args, theme, onHost }: MountOptions): Promise<Mounted> {
  const tools = await listTools(client);
  const uri = uiResourceUri(tools.find((entry) => entry.name === tool));
  if (!uri) throw new Error(`${tool} has no View.`);
  const resource = await client.readResource({ uri });
  const document = resource.contents.find((item) => item.uri === uri && item.mimeType === VIEW_MIME && "text" in item);
  if (!document || !("text" in document)) throw new Error(`The View ${uri} could not be read.`);
  const digest = await sha256Hex(document.text);

  const viewId = `${TOOLS[tool].view ?? tool}-${mintTrace().slice(2, 6)}`;
  let hostContext: McpUiHostContext = { theme, displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] };
  const bridge = new AppBridge(client, HOST_INFO, {
    openLinks: {}, serverTools: {}, serverResources: {}, logging: {},
    message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} },
  }, { hostContext });
  const transport = tap(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!), { wire, viewId });

  bridge.onsizechange = ({ height }) => {
    if (height !== undefined && Number.isFinite(height)) onHost({ type: "size", height });
  };
  bridge.onmessage = async ({ content }) => {
    const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    onHost({ type: "message", text });
    return {};
  };
  bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
    onHost({ type: "context", value: structuredContent ?? content });
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    if (!/^https:\/\//i.test(url)) return { isError: true };
    onHost({ type: "link", url });
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    const next = mode === "fullscreen" ? "fullscreen" : "inline";
    hostContext = { ...hostContext, displayMode: next };
    onHost({ type: "display", mode: next });
    return { mode: next };
  };
  bridge.onloggingmessage = ({ level, data }) => onHost({ type: "log", level, data });
  bridge.oninitialized = () => {
    onHost({ type: "ready" });
    void (async () => {
      const trace = mintTrace();
      transport.setEntryTrace(trace);
      await bridge.sendToolInput({ arguments: args });
      const { result, career } = await callTool(client, wire, tool, args as never, trace);
      if (career) onHost({ type: "career", career });
      await bridge.sendToolResult(result);
    })().catch((error: unknown) => onHost({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  };

  console.debug(`[wire] mount view=${viewId} tool=${tool} sid=${wire.sid}`);
  await bridge.connect(transport);
  // connect() installs its own forwarder when the bridge has a client, so this goes after it.
  bridge.oncalltool = async (params, extra) => {
    const trace = transport.traceOf(extra.requestId) ?? mintTrace();
    const token = params._meta?.progressToken;
    const result = await callWithTrace(client, params, trace, token === undefined ? {} : {
      // The bridge sends any notification, but its type lists only the UI ones.
      onprogress: (progress) => void (extra.sendNotification as (n: { method: string; params: unknown }) => Promise<void>)({
        method: "notifications/progress", params: { ...progress, progressToken: token },
      }),
    });
    const career = careerOf(result);
    if (career) onHost({ type: "career", career });
    return result;
  };
  frame.src = `${VIEW_PATH}/${digest}`;

  return {
    viewId,
    setTheme(next) {
      hostContext = { ...hostContext, theme: next };
      bridge.setHostContext(hostContext);
    },
    viewTools: async () => (await bridge.listTools({})).tools,
    callViewTool: (name, toolArgs) => bridge.callTool({ name, arguments: toolArgs }) as Promise<CallToolResult>,
    async close() {
      await bridge.teardownResource({}, { timeout: TEARDOWN_MS }).catch(() => {});
      await bridge.close().catch(() => {});
    },
  };
}

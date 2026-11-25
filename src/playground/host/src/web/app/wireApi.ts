// The wire core of WP3 (`src/web/wire`) as the architecture file writes it. WP4 codes against these shapes only,
// so the page also runs on the fixture backend when the core is absent.
import type { Career, DebugEvent, Player, ToolInput, ToolName, ToolOutput } from "@playground/contracts";

export interface Wire {
  sid: string;
  events(): readonly DebugEvent[];
  subscribe(listener: () => void): () => void;
  record(event: DebugEvent): void;
  setPaused(paused: boolean): void;
  clear(): void;
}

export type HostEvent =
  | { type: "ready" }
  | { type: "size"; height: number }
  | { type: "career"; career: Career }
  | { type: "message"; text: string }
  | { type: "context"; value: unknown }
  | { type: "link"; url: string }
  | { type: "display"; mode: "inline" | "fullscreen" }
  | { type: "log"; level: string; data: unknown }
  | { type: "error"; message: string };

export interface ToolInfo {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: unknown;
  _meta?: Record<string, unknown> | undefined;
}

export interface ToolResult {
  isError?: boolean | undefined;
  content?: unknown;
  structuredContent?: unknown;
  _meta?: Record<string, unknown> | undefined;
}

// The part of the SDK `Client` the page reads from.
export interface McpClient {
  listTools(): Promise<{ tools: ToolInfo[] }>;
}

export interface MountedView {
  viewId: string;
  setTheme(theme: "light" | "dark"): void;
  viewTools(): Promise<ToolInfo[]>;
  callViewTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface MountOptions {
  client: McpClient;
  wire: Wire;
  frame: HTMLIFrameElement;
  tool: ToolName;
  args: Record<string, unknown>;
  theme: "light" | "dark";
  onHost(event: HostEvent): void;
}

export interface WireCore {
  createWire(): Wire;
  connect(wire: Wire): Promise<McpClient>;
  callTool<N extends ToolName>(
    client: McpClient, wire: Wire, name: N, args: ToolInput<N>, trace?: string,
  ): Promise<{ output: ToolOutput<N>; career: Career | null; result: ToolResult }>;
  mountView(options: MountOptions): Promise<MountedView>;
  getPlayer(): Player;
}

import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CAREER_META_KEY, Career, LONG_POLL_CLIENT_TIMEOUT_MS, MCP_PATH, SID_HEADER, TOOLS, TRACE_META_KEY } from "@playground/contracts";
import type { ToolInput, ToolName, ToolOutput } from "@playground/contracts";
import { z } from "zod";
import { mintTrace } from "./tap";
import type { Wire } from "./wire";

// The SDK's default validator compiles schemas with eval, which the page policy forbids, and the other one is not installed.
// The host does not check a tool's output against its schema here: callTool parses it with the contract's zod schema.
const acceptAll: jsonSchemaValidator = { getValidator: () => (data) => ({ valid: true, data: data as never, errorMessage: undefined }) };

// zod compiles its parsers with new Function by default, which the page policy forbids.
z.config({ jitless: true });

const UI_EXTENSION = "io.modelcontextprotocol/ui";

// One MCP client per tab. Every request carries the tab's sid, so the host server files it under the tab.
export async function connect(wire: Wire): Promise<Client> {
  const client = new Client({ name: "MCP App Playground", version: "1" }, {
    capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [RESOURCE_MIME_TYPE] } } },
    jsonSchemaValidator: acceptAll,
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_PATH, location.origin), {
    requestInit: { headers: { [SID_HEADER]: wire.sid } },
  }));
  return client;
}

export interface CallOptions {
  onprogress?: NonNullable<RequestOptions["onprogress"]>;
  signal?: AbortSignal;
}

// A call with the trace in its `_meta`, which is how the host server and the MCP server learn which click it belongs to.
export function callWithTrace(
  client: Client,
  params: { name: string; arguments?: Record<string, unknown> | undefined; _meta?: Record<string, unknown> | undefined },
  trace: string,
  { onprogress, signal }: CallOptions = {},
): Promise<CallToolResult> {
  const { progressToken: _ignored, ...meta } = params._meta ?? {};
  return client.callTool(
    { name: params.name, arguments: params.arguments ?? {}, _meta: { ...meta, [TRACE_META_KEY]: trace } },
    undefined,
    {
      ...(onprogress ? { onprogress } : {}),
      ...(signal ? { signal } : {}),
      ...(params.name === "wait_for_change" ? { timeout: LONG_POLL_CLIENT_TIMEOUT_MS } : {}),
    },
  ) as Promise<CallToolResult>;
}

// A calculation: the career a tool result carries in its `_meta`, if it carries one.
export function careerOf(result: CallToolResult): Career | null {
  const parsed = Career.safeParse(result._meta?.[CAREER_META_KEY]);
  return parsed.success ? parsed.data : null;
}

function errorText(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "The tool failed.";
}

export async function callTool<N extends ToolName>(
  client: Client,
  _wire: Wire,
  name: N,
  args: ToolInput<N>,
  trace: string = mintTrace(),
): Promise<{ output: ToolOutput<N>; career: Career | null; result: CallToolResult }> {
  const result = await callWithTrace(client, { name, arguments: args as Record<string, unknown> }, trace);
  if (result.isError) throw new Error(errorText(result));
  const output = TOOLS[name].output.parse(result.structuredContent) as ToolOutput<N>;
  return { output, career: careerOf(result), result };
}

import type { App } from "@modelcontextprotocol/ext-apps";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolInput, ToolName, ToolOutput } from "@playground/contracts";
import { errorText, log } from "./log";

// The part of `App` the kit calls, so a test can pass a fixture.
export type KitApp = Pick<App, "callServerTool" | "updateModelContext">;

export const CALL_TIMEOUT_MS = 30_000;

export function textOf(result: CallToolResult): string {
  const block = result.content?.find((item) => item.type === "text");
  return block && "text" in block ? block.text : "";
}

// A calculation: the typed output of a result, or the reason it has none.
export function outputOf<N extends ToolName>(result: CallToolResult, name?: N): ToolOutput<N> {
  if (result.isError) throw new Error(textOf(result) || "The server could not complete the call.");
  if (!result.structuredContent) throw new Error(`The server answered ${name ?? "the call"} without structured content.`);
  return result.structuredContent as ToolOutput<N>;
}

export async function call<N extends ToolName>(
  app: KitApp,
  name: N,
  args: ToolInput<N>,
  options: Pick<RequestOptions, "signal" | "timeout" | "onprogress"> = {},
): Promise<ToolOutput<N>> {
  const started = performance.now();
  try {
    const result = await app.callServerTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS, ...options });
    const output = outputOf(result, name);
    log.debug("call", { tool: name, ms: Math.round(performance.now() - started), outcome: "ok" });
    return output;
  } catch (error) {
    log.warn("call", { tool: name, ms: Math.round(performance.now() - started), outcome: "error", error: errorText(error) });
    throw error;
  }
}

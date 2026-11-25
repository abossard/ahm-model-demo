import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolInput, ToolName, ToolOutput } from "@playground/contracts";
import type { KitApp } from "./call";

type Answers = { [N in ToolName]?: (args: ToolInput<N>) => ToolOutput<N> | Promise<ToolOutput<N>> };

export interface FixtureApp extends KitApp {
  calls: { name: string; arguments: Record<string, unknown> | undefined }[];
  contexts: unknown[];
}

export function asResult(output: unknown): CallToolResult {
  return { content: [{ type: "text", text: "ok" }], structuredContent: output as Record<string, unknown> };
}

// An `App` that answers from recorded outputs, so a View and the kit run without a host.
export function fixtureApp(answers: Answers): FixtureApp {
  const calls: FixtureApp["calls"] = [];
  const contexts: unknown[] = [];
  return {
    calls,
    contexts,
    async callServerTool(params) {
      calls.push({ name: params.name, arguments: params.arguments });
      const answer = answers[params.name as ToolName] as ((args: unknown) => unknown) | undefined;
      if (!answer) return { isError: true, content: [{ type: "text", text: `No fixture for ${params.name}.` }] };
      return asResult(await answer(params.arguments));
    },
    async updateModelContext(params) {
      contexts.push(params);
      return {};
    },
  };
}

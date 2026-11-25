import type { Logger } from "../log";
import { DEALER_OUTPUT_SCHEMA } from "../ports";
import type { DealerLlm, DealerOutput } from "../ports";

const SCOPE = "https://cognitiveservices.azure.com/.default";
const API_VERSION = "2024-10-21";

export interface AzureLlmOptions {
  endpoint: string;
  deployment: string;
  credential: { getToken(scope: string): Promise<{ token: string } | null> };
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

export function parseOutput(content: unknown): DealerOutput {
  const parsed: unknown = typeof content === "string" ? JSON.parse(content) : null;
  const { cards, action, say } = (parsed ?? {}) as Record<string, unknown>;
  if (!Array.isArray(cards) || !cards.every((card) => typeof card === "string")) throw new Error("reply has no cards array");
  if (action !== "hit" && action !== "stand") throw new Error("reply has no action");
  if (typeof say !== "string") throw new Error("reply has no say");
  return { cards, action, say };
}

export function createAzureLlm(options: AzureLlmOptions): DealerLlm {
  const call = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const url = `${options.endpoint}/openai/deployments/${options.deployment}/chat/completions?api-version=${API_VERSION}`;

  return {
    name: "azure",
    async ask(request, prompt, signal) {
      const started = now();
      try {
        const token = await options.credential.getToken(SCOPE);
        if (!token) throw new Error("no token for the dealer model");
        const response = await call(url, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
          body: JSON.stringify({
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            response_format: { type: "json_schema", json_schema: { name: "dealer", strict: true, schema: DEALER_OUTPUT_SCHEMA } },
            max_completion_tokens: 2000,
            reasoning_effort: "low",
          }),
        });
        if (!response.ok) throw new Error(`dealer model answered ${response.status}`);
        const body = (await response.json()) as {
          model?: string;
          choices?: { message?: { content?: unknown } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const output = parseOutput(body.choices?.[0]?.message?.content);
        const ms = now() - started;
        options.log.info("llm", {
          kind: request.kind, ok: true, ms,
          promptTokens: body.usage?.prompt_tokens ?? null, completionTokens: body.usage?.completion_tokens ?? null,
        });
        return { output, model: body.model ?? options.deployment, ms };
      } catch (error) {
        options.log.warn("llm", { kind: request.kind, ok: false, ms: now() - started, error: String(error) });
        throw error;
      }
    },
  };
}

import { describe, expect, it } from "vitest";
import { createLogger } from "../log";
import type { DealerRequest } from "../ports";
import { createAzureLlm, parseOutput } from "./azure";

const REQUEST: DealerRequest = { id: "r1", kind: "decide", hand: ["TS", "6H"], total: 16, soft: false, players: [18], hits: 0 };
const PROMPT = { system: "sys", user: "usr" };
const GOOD = { cards: [], action: "hit", say: "Hit me." };

function llmWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const llm = createAzureLlm({
    endpoint: "https://acct.openai.azure.com",
    deployment: "gpt-54-mini",
    credential: { getToken: async () => ({ token: "tok" }) },
    log: createLogger("t", "debug", () => {}),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as typeof fetch,
  });
  return { llm, calls };
}

const completion = (content: unknown, extra: object = {}) =>
  new Response(JSON.stringify({ model: "gpt-54-mini-2026", choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 4 }, ...extra }));

describe("azure dealer", () => {
  it("posts the strict structured-output request with the bearer token", async () => {
    const { llm, calls } = llmWith(() => completion(JSON.stringify(GOOD)));
    const reply = await llm.ask(REQUEST, PROMPT, AbortSignal.timeout(1000));
    expect(reply).toMatchObject({ output: GOOD, model: "gpt-54-mini-2026" });
    expect(calls[0]!.url).toBe("https://acct.openai.azure.com/openai/deployments/gpt-54-mini/chat/completions?api-version=2024-10-21");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "usr" }],
      response_format: { type: "json_schema", json_schema: { name: "dealer", strict: true } },
      max_completion_tokens: 2000,
      reasoning_effort: "low",
    });
  });

  it.each([
    { name: "a 429", respond: () => new Response("slow down", { status: 429 }), message: "429" },
    { name: "a 403", respond: () => new Response("no", { status: 403 }), message: "403" },
    { name: "content that is not JSON", respond: () => completion("not json"), message: "JSON" },
    { name: "no content", respond: () => completion(null), message: "cards" },
    { name: "cards that are not strings", respond: () => completion(JSON.stringify({ ...GOOD, cards: [1] })), message: "cards" },
    { name: "an unknown action", respond: () => completion(JSON.stringify({ ...GOOD, action: "fold" })), message: "action" },
    { name: "a missing say", respond: () => completion(JSON.stringify({ cards: [], action: "stand" })), message: "say" },
    { name: "a network failure", respond: () => Promise.reject(new Error("ECONNRESET")), message: "ECONNRESET" },
  ])("rejects $name", async ({ respond, message }) => {
    const { llm } = llmWith(respond);
    await expect(llm.ask(REQUEST, PROMPT, AbortSignal.timeout(1000))).rejects.toThrow(message);
  });

  it("passes the abort signal to the request", async () => {
    const { llm, calls } = llmWith(() => completion(JSON.stringify(GOOD)));
    const signal = AbortSignal.timeout(1000);
    await llm.ask(REQUEST, PROMPT, signal);
    expect(calls[0]!.init.signal).toBe(signal);
  });

  it.each([
    { content: JSON.stringify({ cards: ["AS"], action: "stand", say: "" }), ok: true },
    { content: "{}", ok: false },
    { content: 5, ok: false },
  ])("parseOutput of $content", ({ content, ok }) => {
    if (ok) expect(parseOutput(content)).toEqual({ cards: ["AS"], action: "stand", say: "" });
    else expect(() => parseOutput(content)).toThrow();
  });
});

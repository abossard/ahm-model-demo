import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CAREER_META_KEY, LAB_NOTES_URI, TOOLS, TOOL_NAMES, VIEWS, VIEW_MIME, VIEW_NAMES, toolMeta,
} from "@playground/contracts";
import type { ToolName, ToolInput } from "@playground/contracts";
import { blackjack } from "./games/blackjack";
import { checkers } from "./games/checkers";
import { fakeDealer } from "./games/fakeDealer";
import { trader } from "./games/trader";
import { createBrokenLlm } from "./llm/broken";
import { createFakeLlm } from "./llm/fake";
import { ADA, BEN, startTestServer } from "./testing";
import type { TestServer } from "./testing";

let server: TestServer;
let a: Client;
let b: Client;

beforeAll(async () => {
  server = await startTestServer({ rules: { checkers, trader, blackjack }, llm: createFakeLlm(fakeDealer) });
  a = await server.connect("sid-ada-0001");
  b = await server.connect("sid-ben-0001");
});
afterAll(async () => {
  await server.close();
});

type Out = Record<string, any>;

async function call<N extends ToolName>(client: Client, name: N, args: ToolInput<N>) {
  const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
  return { out: (result.structuredContent ?? {}) as Out, result };
}

describe("transport", () => {
  it("serves /healthz with the store, the model and the views", async () => {
    const body = (await (await fetch(`${server.url}/healthz`)).json()) as Out;
    expect(body).toMatchObject({ ok: true, svc: "playground-mcp", store: { driver: "memory", ready: true, check: "passed" }, llm: { driver: "fake" } });
    expect(body.views).toEqual(VIEW_NAMES);
  });

  it.each(["GET", "DELETE"])("answers %s /mcp with 405 and a JSON-RPC error", async (method) => {
    const response = await fetch(`${server.url}/mcp`, { method });
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });

  it.each([
    { name: "malformed JSON", body: "{nope", status: 400 },
    { name: "a body over 256 KB", body: JSON.stringify({ pad: "x".repeat(300_000) }), status: 413 },
  ])("answers $name with $status", async ({ body, status }) => {
    const response = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: expect.any(Object) });
  });

  it("advertises tools, resources, logging and the MCP Apps extension", () => {
    const caps = a.getServerCapabilities() as Record<string, any>;
    expect(caps["tools"]).toBeDefined();
    expect(caps["resources"]).toBeDefined();
    expect(caps["logging"]).toBeDefined();
    expect(caps["extensions"]["io.modelcontextprotocol/ui"]).toEqual({ mimeTypes: [VIEW_MIME] });
  });
});

describe("tools/list", () => {
  it("lists every tool of the contract, each with its ui meta and read-only hint", async () => {
    const { tools } = await a.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(28);
    for (const tool of tools) {
      const name = tool.name as ToolName;
      expect(tool._meta?.["ui"]).toEqual(toolMeta(name).ui);
      expect(tool.annotations?.readOnlyHint).toBe(TOOLS[name].readOnly);
      expect(tool.outputSchema).toBeDefined();
    }
  });
});

describe("resources", () => {
  it.each(VIEW_NAMES)("reads the %s View as an app document", async (name) => {
    const { contents } = await a.readResource({ uri: VIEWS[name] });
    expect(contents[0]).toMatchObject({ uri: VIEWS[name], mimeType: VIEW_MIME, text: `<html><body>${name} view</body></html>` });
  });

  it("lists the five Views and the lab notes", async () => {
    const { resources } = await a.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([...Object.values(VIEWS), LAB_NOTES_URI].sort());
  });

  it("reads the lab notes as markdown", async () => {
    const { contents } = await a.readResource({ uri: LAB_NOTES_URI });
    expect(contents[0]).toMatchObject({ mimeType: "text/markdown" });
  });
});

describe("career and the hello and lab tools", () => {
  it("puts the caller's career in _meta on every call, and the hello flow unlocks layer 2", async () => {
    const shown = await call(a, "hello_show", { player: ADA, name: "Lee" });
    expect(shown.out["greeting"]).toBe("Hello, Lee.");
    expect(shown.result._meta?.[CAREER_META_KEY]).toMatchObject({ unlocked: 1 });
    const pinged = await call(a, "hello_ping", { player: ADA });
    expect(pinged.out["pings"]).toBe(1);
    expect(pinged.result._meta?.[CAREER_META_KEY]).toMatchObject({ unlocked: 2 });
    expect((await call(a, "career_get", { player: ADA })).out["career"]).toMatchObject({ unlocked: 2 });
  });

  it.each([
    { code: "nonsense", unlocked: 2, notice: "bad_code" },
    { code: "opencity", unlocked: 5, notice: null },
  ])("career_cheat with $code", async ({ code, unlocked, notice }) => {
    const { out } = await call(b, "career_cheat", { player: { id: `p-cheat-${code.length}-${notice ? "no" : "ok"}`, handle: "Cheater" }, code });
    expect(out["notice"]?.code ?? null).toBe(notice);
    expect(out["career"].unlocked).toBe(notice ? 1 : unlocked);
  });

  it("opens the lab, echoes, and records three distinct exhibits as the job of layer 2", async () => {
    const player = { id: "p-labrat-0001", handle: "Lab Rat" };
    expect((await call(a, "lab_open", { player })).out["exhibits"]).toHaveLength(10);
    expect((await call(a, "lab_echo", { player, text: "hello" })).out).toMatchObject({ text: "hello", length: 5 });
    for (const exhibit of ["call_tool", "log", "theme", "log"] as const) await call(a, "lab_checkpoint", { player, exhibit });
    const career = (await call(a, "career_get", { player })).out["career"];
    expect(career).toMatchObject({ unlocked: 3, lab: ["call_tool", "log", "theme"] });
  });

  it("reports progress notifications for a countdown when asked", async () => {
    const progress: number[] = [];
    const result = await a.callTool({ name: "lab_countdown", arguments: { player: ADA, from: 3 } }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    });
    expect(result.structuredContent).toEqual({ ticks: 3 });
    expect(progress).toEqual([1, 2, 3]);
  });
});

describe("checkers over HTTP", () => {
  it("plays against the bot, and a stale version gets a notice, not an error", async () => {
    const created = await call(a, "checkers_create", { player: ADA, opponent: "bot" });
    let snapshot = created.out["snapshot"];
    expect(created.out["notice"]).toBeNull();
    expect(snapshot).toMatchObject({ game: "checkers", version: 1, view: { you: "black", status: "playing" } });
    const id: string = snapshot.tableId;

    for (let turn = 0; turn < 4; turn++) {
      const move = snapshot.view.legal[0];
      const { out } = await call(a, "checkers_move", { player: ADA, tableId: id, version: snapshot.version, from: move.from, path: move.path });
      expect(out["notice"]).toBeNull();
      expect(out["snapshot"].version).toBeGreaterThan(snapshot.version);
      snapshot = out["snapshot"];
    }

    const stale = await call(a, "checkers_move", { player: ADA, tableId: id, version: 1, from: 0, path: [4] });
    expect(stale.result.isError).toBeFalsy();
    expect(stale.out["notice"].code).toBe("stale");
    expect(stale.out["snapshot"].version).toBe(snapshot.version);

    const opened = await call(a, "checkers_open", { player: ADA, tableId: id });
    expect(opened.out["snapshot"].version).toBe(snapshot.version);
    expect(opened.out["lobby"].map((row: Out) => row["tableId"])).toContain(id);
    expect((await call(a, "table_list", { game: "checkers" })).out["tables"].map((row: Out) => row["tableId"])).toContain(id);
  });

  it("two players: B joins A's table and A's wait_for_change returns B's move", async () => {
    const created = await call(a, "checkers_create", { player: ADA, opponent: "human" });
    const id: string = created.out["snapshot"].tableId;
    const joined = await call(b, "checkers_join", { player: BEN, tableId: id });
    expect(joined.out["snapshot"].view.you).toBe("white");
    const sinceVersion = joined.out["snapshot"].version;

    const black = (await call(a, "checkers_open", { player: ADA, tableId: id })).out["snapshot"];
    const move = black.view.legal[0];
    const waiting = call(b, "wait_for_change", { player: BEN, tableId: id, sinceVersion });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await call(a, "checkers_move", { player: ADA, tableId: id, version: black.version, from: move.from, path: move.path });
    const woke = (await waiting).out;
    expect(woke["changed"]).toBe(true);
    expect(woke["snapshot"].version).toBeGreaterThan(sinceVersion);
    expect(woke["snapshot"].view.turn).toBe("white");
  });

  it("answers an unknown table with a null snapshot and table_gone", async () => {
    const { out, result } = await call(a, "checkers_join", { player: ADA, tableId: "cdoesnotex" });
    expect(result.isError).toBeFalsy();
    expect(out).toMatchObject({ snapshot: null, notice: { code: "table_gone" } });
  });
});

describe("Drift Ledger over HTTP", () => {
  it("starts a run, jumps, and lists the scores", async () => {
    const player = { id: "p-trader-0001", handle: "Star Trader" };
    const opened = await call(a, "trader_open", { player });
    expect(opened.out["snapshot"]).toMatchObject({ game: "trader", tableId: player.id, view: { status: "running", day: 1 } });
    const route = opened.out["snapshot"].view.routes.find((r: Out) => r["reachable"]);
    const jumped = await call(a, "trader_travel", { player, to: route.to });
    expect(jumped.out["notice"]).toBeNull();
    expect(jumped.out["snapshot"].view.location).toBe(route.to);
    expect((await call(a, "trader_open", { player })).out["snapshot"].view.location).toBe(route.to);
    expect((await call(a, "trader_scores", {})).out["scores"][0]).toMatchObject({ handle: "Star Trader" });
    expect((await call(a, "trader_new_run", { player })).out["snapshot"].view.day).toBe(1);
  });
});

describe("blackjack over HTTP", () => {
  it("plays a round with the fake dealer: bet, shuffle, stand, dealer plays, settled", async () => {
    const player = { id: "p-jack-00001", handle: "Black Jack" };
    const created = await call(a, "blackjack_create", { player, title: "High Table" });
    const id: string = created.out["snapshot"].tableId;
    expect(created.out["snapshot"].view).toMatchObject({ phase: "betting", title: "High Table" });

    await call(a, "blackjack_bet", { player, tableId: id, amount: 50 });
    const phase = async (want: string[]) => {
      for (let i = 0; i < 60; i++) {
        const { out } = await call(a, "blackjack_open", { player, tableId: id });
        if (want.includes(out["snapshot"].view.phase)) return out["snapshot"];
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`never reached ${want}`);
    };
    let snapshot = await phase(["players", "settled"]);
    if (snapshot.view.phase === "players") {
      expect(snapshot.view.dealer.cards).toContain("??");
      await call(a, "blackjack_act", { player, tableId: id, action: "stand" });
      snapshot = await phase(["settled"]);
    }
    expect(snapshot.view.phase).toBe("settled");
    expect(snapshot.view.misdeal).toBe(false);
    expect(snapshot.view.dealerLog.length).toBeGreaterThan(0);
    expect(snapshot.view.dealer.cards).not.toContain("??");
  });
});

describe("a dealer that always fails", () => {
  it("ends the round as a misdeal and returns the bet", async () => {
    const misdealing = await startTestServer({ rules: { checkers, trader, blackjack }, llm: createBrokenLlm() });
    try {
      const client = await misdealing.connect();
      const player = { id: "p-misdeal-001", handle: "Unlucky" };
      const id: string = (await call(client, "blackjack_create", { player })).out["snapshot"].tableId;
      await call(client, "blackjack_bet", { player, tableId: id, amount: 100 });
      let view: Out = {};
      for (let i = 0; i < 80 && view["phase"] !== "settled"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        view = (await call(client, "blackjack_open", { player, tableId: id })).out["snapshot"].view;
      }
      expect(view).toMatchObject({ phase: "settled", misdeal: true });
      expect(view["seats"][0]).toMatchObject({ outcome: "misdeal", delta: 0, chips: 1000 });
    } finally {
      await misdealing.close();
    }
  });
});

describe("a store that cannot serve", () => {
  it("is an error result, never a protocol error", async () => {
    const broken = await startTestServer({
      rules: { checkers: { ...checkers, create: () => { throw new Error("store down"); } }, trader, blackjack },
      llm: createFakeLlm(fakeDealer),
    });
    try {
      const client = await broken.connect();
      const result = await client.callTool({ name: "checkers_create", arguments: { player: ADA, opponent: "bot" } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "The table store is not ready. Try again." }]);
      expect(broken.logs.some((line) => JSON.parse(line).outcome === "error")).toBe(true);
    } finally {
      await broken.close();
    }
  });
});

describe("logging", () => {
  it("writes one tool line with the sid, the trace, the player and the outcome", async () => {
    const trace = "trace-abc-123";
    await a.callTool({ name: "career_get", arguments: { player: ADA }, _meta: { "playground/trace": trace } });
    const lines = server.logs.map((line) => JSON.parse(line)).filter((line) => line.msg === "tool" && line.trace === trace);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "career_get", sid: "sid-ada-0001", player: ADA.id, outcome: "ok", level: "info", svc: "playground-mcp" });
    expect(typeof lines[0].ms).toBe("number");
  });
});

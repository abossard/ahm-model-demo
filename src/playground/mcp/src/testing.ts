// Stand-ins for the rules and the clock, so the tables, the dealer and the server are tested without WP1's games.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIEW_NAMES } from "@playground/contracts";
import type { Card, GameId, Player } from "@playground/contracts";
import { createCareers } from "./careers";
import { createChanges } from "./changes";
import { createDealer } from "./dealer";
import { createApp } from "./http";
import { createLogger } from "./log";
import { createMcpServer } from "./server";
import { createMemoryStore } from "./store/memory";
import { createTables } from "./tables";
import type { TablesDeps } from "./tables";
import { loadViews } from "./views";
import type { BlackjackRules, DealerLlm, Clock, DealerFailure, DealerReply, DealerRequest, GameRules, PlayerEvent, Step } from "./ports";

export interface CounterState {
  n: number;
  owner: string;
  options: Record<string, unknown>;
  dueAt: number | null;
  request: DealerRequest | null;
  resolved: { requestId: string; result: string; attempts: number }[];
}

// Actions "bump", "win", "arm" (with `at`) and "ask" do something. Any other type is a rule that does not apply.
export interface CounterAction {
  type: string;
  at?: number;
}

const noEvents: PlayerEvent[] = [];

// The view is whatever the test wants to see: tables treats it as opaque.
export function counterRules(game: GameId): GameRules<CounterState, CounterAction, any> {
  return {
    game,
    seats: 2,
    create: (by, options, _now, seed) => ({ n: seed % 1000, owner: by.id, options, dueAt: null, request: null, resolved: [] }),
    apply(state, action, by): Step<CounterState> {
      switch (action.type) {
        case "bump":
          return { state: { ...state, n: state.n + 1 }, notice: null, events: noEvents };
        case "win":
          return { state: { ...state, n: state.n + 1 }, notice: null, events: [{ playerId: by.id, event: { type: "blackjack_win" } }] };
        case "arm":
          return { state: { ...state, dueAt: action.at ?? null }, notice: null, events: noEvents };
        case "ask":
          return { state: { ...state, request: askRequest(state.n) }, notice: null, events: noEvents };
        default:
          return { state, notice: { code: "illegal_move", message: "Nothing like that." }, events: noEvents };
      }
    },
    tick(state, now): Step<CounterState> {
      if (state.dueAt === null || now < state.dueAt) return { state, notice: null, events: noEvents };
      return { state: { ...state, n: state.n + 1000, dueAt: null }, notice: null, events: noEvents };
    },
    nextDeadline: (state) => state.dueAt,
    view: (state, viewer) => ({ n: state.n, viewer: viewer?.id ?? null, title: String(state.options["title"] ?? game) }),
    lobby: (state) => ({ title: String(state.options["title"] ?? game), seatsTaken: 1, seatsTotal: 2, status: state.n >= 1000 ? "over" : "open" }),
  };
}

function askRequest(n: number): DealerRequest {
  return { id: `r${n}`, kind: "shuffle", count: 3, remaining: {} as Record<Card, number>, previous: [] };
}

// A blackjack table of one counter: `ask` puts a dealer request in the state, `resolve` settles it.
export function counterBlackjack(): BlackjackRules<CounterState> {
  const base = counterRules("blackjack");
  return {
    ...base,
    pending: (state) => state.request,
    prompt: (request) => ({ system: "You are the dealer.", user: `Request ${request.id}.` }),
    validate: (_request, output) => (output.say === "bad" ? ["say is bad"] : []),
    resolve(state, requestId, reply: DealerReply | DealerFailure, attempts): Step<CounterState> {
      if (state.request?.id !== requestId) return { state, notice: null, events: noEvents };
      const result = typeof reply === "string" ? reply : reply.output.say === "bad" ? "invalid" : "ok";
      const events: PlayerEvent[] = result === "ok" ? [{ playerId: state.owner, event: { type: "blackjack_win" } }] : [];
      return {
        state: { ...state, request: null, resolved: [...state.resolved, { requestId, result, attempts }] },
        notice: null,
        events,
      };
    },
  };
}

export function fixedClock(start = 1_000_000): Clock & { advance(ms: number): void; set(ms: number): void } {
  let at = start;
  let seed = 41;
  return { now: () => at, seed: () => ++seed, advance: (ms) => void (at += ms), set: (ms) => void (at = ms) };
}

export const ADA: Player = { id: "p-aaaaaaaaaaaaaaaa", handle: "Ada Rook" };
export const BEN: Player = { id: "p-bbbbbbbbbbbbbbbb", handle: "Ben Dealer" };

export interface TestServer {
  url: string;
  logs: string[];
  connect(sid?: string): Promise<Client>;
  close(): Promise<void>;
}

// The whole server on a random port, over the memory store, with the rules and the dealer the test brings.
export async function startTestServer(options: {
  rules: TablesDeps["rules"];
  llm: DealerLlm;
  countdownMs?: number;
  longPollMs?: number;
  fast?: boolean;
}): Promise<TestServer> {
  const logs: string[] = [];
  const log = createLogger("playground-mcp", "debug", (line) => logs.push(line));
  const store = createMemoryStore();
  const changes = createChanges();
  const careers = createCareers(store);
  const clock: Clock = { now: Date.now, seed: () => Math.floor(Math.random() * 2 ** 32) };
  const dealer = createDealer({ store, changes, careers, clock, rules: options.rules.blackjack, llm: options.llm, log });
  const tables = createTables({
    store, changes, clock, careers, dealer, rules: options.rules, fast: options.fast ?? true, longPollMs: options.longPollMs ?? 300,
  });
  const dir = mkdtempSync(join(tmpdir(), "views-"));
  for (const name of VIEW_NAMES) writeFileSync(join(dir, `${name}.html`), `<html><body>${name} view</body></html>`);
  const views = loadViews(dir);
  const context = { tables, careers, clock, log, countdownMs: options.countdownMs ?? 20 };
  const app = createApp({
    createServer: () => createMcpServer(context, views),
    health: () => ({ store: { driver: "memory", ready: true, check: "passed" }, llm: dealer.status(), views: Object.keys(views.docs), missingViews: views.missing }),
    log,
    startedAt: Date.now(),
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  return {
    url,
    logs,
    async connect(sid = "test-sid-0001") {
      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { "x-playground-sid": sid } } }));
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

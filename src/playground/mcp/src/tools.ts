import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CAREER_META_KEY, CHEAT_CODE, LAB_EXHIBITS, SID_HEADER, TOOLS, TOOL_NAMES, TRACE_META_KEY, toolMeta,
} from "@playground/contracts";
import type { Notice, ToolName } from "@playground/contracts";
import type { z } from "zod";
import type { Careers } from "./careers";
import { describeError } from "./log";
import type { Logger } from "./log";
import type { Clock } from "./ports";
import type { TableResult, Tables } from "./tables";

export interface ToolContext {
  tables: Tables;
  careers: Careers;
  clock: Clock;
  log: Logger;
  countdownMs: number;
}

type Args<N extends ToolName> = z.infer<(typeof TOOLS)[N]["input"]>;

interface Call {
  signal: AbortSignal;
  progress(progress: number, total: number): Promise<void>;
}

interface Reply {
  output: Record<string, unknown>;
  text: string;
  table?: string;
  version?: number;
  notice?: Notice | null;
}

const NOT_READY = "The table store is not ready. Try again.";

function tableReply(result: TableResult, text: string, extra: Record<string, unknown> = {}): Reply {
  return {
    output: { ...extra, snapshot: result.snapshot, notice: result.notice },
    text: result.notice?.message ?? text,
    ...(result.snapshot ? { table: result.snapshot.tableId, version: result.snapshot.version } : {}),
    notice: result.notice,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type Handlers = { [N in ToolName]: (args: Args<N>, call: Call) => Promise<Reply> };

function handlersOf({ tables, careers, clock, countdownMs }: ToolContext): Handlers {
  const live = (game: "checkers" | "blackjack", action: unknown, text: string) => async (a: { player: Args<"career_get">["player"]; tableId: string }) =>
    tableReply(await tables.act(game, a.tableId, action, a.player), text);

  return {
    career_get: async (a) => ({ output: { career: await careers.get(a.player) }, text: "Here is your career." }),
    career_cheat: async (a) => {
      const ok = a.code.trim() === CHEAT_CODE;
      const notice: Notice | null = ok ? null : { code: "bad_code", message: "That code does nothing." };
      const career = ok ? await careers.advance(a.player.id, { type: "cheat" }) : await careers.get(a.player);
      return { output: { career, notice }, text: notice?.message ?? "Every layer is open.", notice };
    },

    hello_show: async (a) => ({
      output: { greeting: `Hello, ${a.name || a.player.handle}.`, serverTime: clock.now(), pings: await careers.pings(a.player) },
      text: "Said hello.",
    }),
    hello_ping: async (a) => {
      await careers.advance(a.player.id, { type: "hello_ping" });
      return { output: { pings: await careers.pings(a.player), serverTime: clock.now() }, text: "Counted the press." };
    },

    lab_open: async (a) => ({ output: { exhibits: [...LAB_EXHIBITS], done: (await careers.get(a.player)).lab }, text: "The lab is open." }),
    lab_echo: async (a) => ({ output: { text: a.text, length: a.text.length, serverTime: clock.now() }, text: "Echoed the text." }),
    lab_countdown: async (a, call) => {
      for (let tick = 1; tick <= a.from && !call.signal.aborted; tick++) {
        await sleep(countdownMs, call.signal);
        if (!call.signal.aborted) await call.progress(tick, a.from);
      }
      return { output: { ticks: a.from }, text: "Counted down." };
    },
    lab_checkpoint: async (a) => ({
      output: { done: (await careers.advance(a.player.id, { type: "lab_exhibit", exhibit: a.exhibit })).lab },
      text: "Noted the exhibit.",
    }),

    table_list: async (a) => ({ output: { tables: await tables.list(a.game) }, text: "Listed the tables." }),
    wait_for_change: async (a, call) => {
      const result = await tables.wait(a.tableId, a.sinceVersion, a.player, call.signal);
      return {
        output: { changed: result.changed, snapshot: result.snapshot, notice: result.notice },
        text: result.changed ? "The table changed." : "No change yet.",
        table: a.tableId,
        ...(result.snapshot ? { version: result.snapshot.version } : {}),
        notice: result.notice,
      };
    },

    checkers_open: async (a) => {
      const { lobby, ...result } = await tables.open("checkers", a.player, a.tableId);
      return tableReply(result, "Opened checkers.", { lobby });
    },
    checkers_create: async (a) => tableReply(await tables.create("checkers", a.player, { opponent: a.opponent }), "Created a table."),
    checkers_join: (a) => live("checkers", { type: "join" }, "Joined the table.")(a),
    checkers_move: async (a) =>
      tableReply(await tables.act("checkers", a.tableId, { type: "move", from: a.from, path: a.path }, a.player, a.version), "Moved."),
    checkers_resign: (a) => live("checkers", { type: "resign" }, "Resigned.")(a),

    trader_open: async (a) => {
      const { lobby: _lobby, ...result } = await tables.open("trader", a.player);
      return tableReply(result, "Opened the run.");
    },
    trader_buy: async (a) => tableReply(await tables.act("trader", a.player.id, { type: "buy", good: a.good, qty: a.qty }, a.player), "Bought."),
    trader_sell: async (a) => tableReply(await tables.act("trader", a.player.id, { type: "sell", good: a.good, qty: a.qty }, a.player), "Sold."),
    trader_travel: async (a) => tableReply(await tables.act("trader", a.player.id, { type: "travel", to: a.to }, a.player), "Jumped."),
    trader_refuel: async (a) => tableReply(await tables.act("trader", a.player.id, { type: "refuel", units: a.units }, a.player), "Refuelled."),
    trader_new_run: async (a) => tableReply(await tables.create("trader", a.player, {}), "Started a new run."),
    trader_scores: async () => ({ output: { scores: await tables.scores() }, text: "Listed the top pilots." }),

    blackjack_open: async (a) => {
      const { lobby, ...result } = await tables.open("blackjack", a.player, a.tableId);
      return tableReply(result, "Opened blackjack.", { lobby });
    },
    blackjack_create: async (a) =>
      tableReply(await tables.create("blackjack", a.player, a.title ? { title: a.title } : {}), "Opened a table."),
    blackjack_sit: (a) => live("blackjack", { type: "sit" }, "Took a seat.")(a),
    blackjack_leave: (a) => live("blackjack", { type: "leave" }, "Left the seat.")(a),
    blackjack_bet: async (a) => tableReply(await tables.act("blackjack", a.tableId, { type: "bet", amount: a.amount }, a.player), "Bet placed."),
    blackjack_act: async (a) =>
      tableReply(await tables.act("blackjack", a.tableId, { type: "act", action: a.action }, a.player), "Played the hand."),
  };
}

interface Extra {
  signal: AbortSignal;
  _meta?: Record<string, unknown> | undefined;
  requestInfo?: { headers: Record<string, string | string[] | undefined> } | undefined;
  sendNotification(notification: { method: "notifications/progress"; params: Record<string, unknown> }): Promise<void>;
}

export function registerTools(server: McpServer, context: ToolContext): void {
  const handlers = handlersOf(context);
  const { log, careers } = context;

  for (const name of TOOL_NAMES) {
    const spec = TOOLS[name];
    const handler = handlers[name] as (args: unknown, call: Call) => Promise<Reply>;

    const run = async (args: { player?: Args<"career_get">["player"] }, extra: Extra) => {
      const started = Date.now();
      const token = extra._meta?.["progressToken"];
      const trace = extra._meta?.[TRACE_META_KEY];
      const sid = extra.requestInfo?.headers[SID_HEADER];
      const call: Call = {
        signal: extra.signal,
        progress: async (progress, total) => {
          if (typeof token === "string" || typeof token === "number") {
            await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total } });
          }
        },
      };
      const fields = { tool: name, sid: Array.isArray(sid) ? sid[0] : sid, trace, player: args.player?.id };
      try {
        const reply = await handler(args, call);
        const career = args.player ? await careers.get(args.player) : null;
        log.info("tool", {
          ...fields, ms: Date.now() - started, table: reply.table, version: reply.version,
          outcome: reply.notice ? `notice:${reply.notice.code}` : "ok",
        });
        return {
          structuredContent: reply.output,
          content: [{ type: "text" as const, text: reply.text }],
          ...(career ? { _meta: { [CAREER_META_KEY]: career } } : {}),
        };
      } catch (error) {
        log.error("tool", { ...fields, ms: Date.now() - started, outcome: "error", error: describeError(error) });
        return { isError: true, content: [{ type: "text" as const, text: NOT_READY }] };
      }
    };

    registerAppTool(
      server,
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input.shape,
        outputSchema: spec.output.shape,
        annotations: { readOnlyHint: spec.readOnly },
        _meta: toolMeta(name),
      },
      run as never,
    );
  }
}

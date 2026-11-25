import type { Careers } from "./careers";
import { describeError } from "./log";
import type { Logger } from "./log";
import { DEALER_LIMITS } from "./ports";
import type { BlackjackRules, Changes, Clock, DealerFailure, DealerLlm, DealerReply, PlayerEvent, Store } from "./ports";

export interface LlmStatus {
  driver: string;
  lastOk: number | null;
  lastError: string | null;
}

export interface Dealer {
  // Starts the runner for a table unless one is active. The promise settles when the table has no request left.
  kick(tableId: string): Promise<void>;
  status(): LlmStatus;
}

export interface DealerDeps {
  store: Store;
  changes: Changes;
  careers: Careers;
  clock: Clock;
  rules: BlackjackRules<any>;
  llm: DealerLlm;
  log: Logger;
  limits?: { attempts: number; timeoutMs: number; perMinute: number };
}

const MAX_REQUESTS_PER_KICK = 40;

export function createDealer(deps: DealerDeps): Dealer {
  const { store, changes, careers, clock, rules, llm, log } = deps;
  const limits = deps.limits ?? {
    attempts: DEALER_LIMITS.attemptsPerRequest,
    timeoutMs: DEALER_LIMITS.timeoutMs,
    perMinute: DEALER_LIMITS.perMinute,
  };
  const running = new Map<string, Promise<void>>();
  const recent: number[] = [];
  const status: LlmStatus = { driver: llm.name, lastOk: null, lastError: null };

  function underMinuteCap(): boolean {
    const now = clock.now();
    while (recent.length > 0 && recent[0]! <= now - 60_000) recent.shift();
    if (recent.length >= limits.perMinute) return false;
    recent.push(now);
    return true;
  }

  async function serve(tableId: string): Promise<boolean> {
    const doc = await store.get<unknown>("tables", "blackjack", tableId);
    const request = doc ? rules.pending(doc.body) : null;
    if (!request) return false;

    const prompt = rules.prompt(request);
    let outcome: DealerReply | DealerFailure = "unavailable";
    let lastReply: DealerReply | null = null;
    let attempts = 0;
    let rejected: string[] = [];
    for (let attempt = 1; attempt <= limits.attempts; attempt++) {
      if (!underMinuteCap()) {
        outcome = lastReply ?? "unavailable";
        log.warn("dealer", { table: tableId, kind: request.kind, attempt, ok: false, why: "per-minute cap" });
        break;
      }
      attempts = attempt;
      const user = rejected.length > 0 ? `${prompt.user}\n\nYour last reply was rejected: ${rejected.join("; ")}` : prompt.user;
      try {
        const reply = await llm.ask(request, { system: prompt.system, user }, AbortSignal.timeout(limits.timeoutMs));
        rejected = rules.validate(request, reply.output);
        log.info("dealer", { table: tableId, kind: request.kind, attempt, ok: rejected.length === 0, ms: reply.ms, problems: rejected });
        if (rejected.length === 0) {
          outcome = reply;
          status.lastOk = clock.now();
          break;
        }
        lastReply = reply;
        outcome = reply;
      } catch (error) {
        outcome = lastReply ?? "unavailable";
        status.lastError = describeError(error);
        log.warn("dealer", { table: tableId, kind: request.kind, attempt, ok: false, error: status.lastError });
      }
    }

    const last: { events: PlayerEvent[]; wrote: boolean } = { events: [], wrote: false };
    const updated = await store.update<unknown>("tables", "blackjack", tableId, (body) => {
      last.events = [];
      last.wrote = false;
      if (body === null) return null;
      const step = rules.resolve(body, request.id, outcome, Math.max(1, attempts), clock.now());
      last.events = step.events;
      last.wrote = step.state !== body;
      return step.state;
    });
    if (!updated || !last.wrote) return false;
    changes.publish(tableId, updated.version);
    for (const { playerId, event } of last.events) await careers.advance(playerId, event);
    return true;
  }

  async function run(tableId: string): Promise<void> {
    try {
      for (let served = 0; served < MAX_REQUESTS_PER_KICK; served++) {
        if (!(await serve(tableId))) return;
      }
    } catch (error) {
      log.error("error", { where: "dealer", table: tableId, error: describeError(error) });
    } finally {
      running.delete(tableId);
    }
  }

  return {
    kick(tableId) {
      const active = running.get(tableId);
      if (active) return active;
      const started = run(tableId);
      running.set(tableId, started);
      return started;
    },
    status: () => ({ ...status }),
  };
}

import { describe, expect, it } from "vitest";
import { createCareers } from "./careers";
import { createChanges } from "./changes";
import { createDealer } from "./dealer";
import { createLogger } from "./log";
import type { DealerLlm, DealerOutput, DealerRequest } from "./ports";
import { createMemoryStore } from "./store/memory";
import { ADA, counterBlackjack, fixedClock } from "./testing";
import type { CounterState } from "./testing";

const GOOD: DealerOutput = { cards: ["AS", "KS", "2D"], action: "stand", say: "ok" };
const BAD: DealerOutput = { cards: [], action: "stand", say: "bad" };

type Step = DealerOutput | "throw" | "hang";

function scripted(steps: Step[]): DealerLlm & { asked: { user: string }[] } {
  const asked: { user: string }[] = [];
  return {
    name: "scripted",
    asked,
    async ask(_request: DealerRequest, prompt, signal) {
      asked.push({ user: prompt.user });
      const step = steps[asked.length - 1] ?? "throw";
      if (step === "throw") throw new Error("model unreachable");
      if (step === "hang") {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return { output: step as DealerOutput, model: "scripted", ms: 5 };
    },
  };
}

async function setup(steps: Step[], limits?: { attempts: number; timeoutMs: number; perMinute: number }) {
  const store = createMemoryStore();
  const clock = fixedClock();
  const changes = createChanges(clock.now);
  const careers = createCareers(store);
  const llm = scripted(steps);
  const rules = counterBlackjack();
  const logs: string[] = [];
  const dealer = createDealer({ store, changes, careers, clock, rules, llm, log: createLogger("t", "debug", (l) => logs.push(l)), ...(limits ? { limits } : {}) });
  const state: CounterState = { ...rules.create(ADA, {}, clock.now(), 1), request: { id: "r1", kind: "shuffle", count: 3, remaining: {} as never, previous: [] } };
  await store.update("tables", "blackjack", "b000000001", () => state);
  const read = async () => (await store.get<CounterState>("tables", "blackjack", "b000000001"))!;
  return { dealer, llm, store, changes, careers, clock, read, logs };
}

describe("dealer runner", () => {
  it.each([
    { name: "a valid first reply", steps: [GOOD] as Step[], result: "ok", attempts: 1, asks: 1 },
    { name: "an invalid reply, then a valid one", steps: [BAD, GOOD] as Step[], result: "ok", attempts: 2, asks: 2 },
    { name: "two invalid replies", steps: [BAD, BAD] as Step[], result: "invalid", attempts: 2, asks: 2 },
    { name: "a transport failure twice", steps: ["throw", "throw"] as Step[], result: "unavailable", attempts: 2, asks: 2 },
    { name: "a failure, then a valid reply", steps: ["throw", GOOD] as Step[], result: "ok", attempts: 2, asks: 2 },
    { name: "an invalid reply, then a failure", steps: [BAD, "throw"] as Step[], result: "invalid", attempts: 2, asks: 2 },
  ])("settles $name as $result after $asks asks", async ({ steps, result, attempts, asks }) => {
    const { dealer, llm, read } = await setup(steps);
    await dealer.kick("b000000001");
    const doc = await read();
    expect(doc.body.request).toBeNull();
    expect(doc.body.resolved).toEqual([{ requestId: "r1", result, attempts }]);
    expect(llm.asked).toHaveLength(asks);
    expect(doc.version).toBe(2);
  });

  it("tells the model why the last reply was rejected, on the second attempt only", async () => {
    const { dealer, llm } = await setup([BAD, GOOD]);
    await dealer.kick("b000000001");
    expect(llm.asked[0]!.user).toBe("Request r1.");
    expect(llm.asked[1]!.user).toContain("Your last reply was rejected: say is bad");
  });

  it("times out a model that hangs, and settles as unavailable", async () => {
    const { dealer, read } = await setup(["hang", "hang"], { attempts: 2, timeoutMs: 20, perMinute: 60 });
    await dealer.kick("b000000001");
    expect((await read()).body.resolved[0]).toMatchObject({ result: "unavailable", attempts: 2 });
  });

  it("settles as unavailable without asking once the minute's cap is spent", async () => {
    const { dealer, llm, read } = await setup([GOOD], { attempts: 2, timeoutMs: 1000, perMinute: 0 });
    await dealer.kick("b000000001");
    expect(llm.asked).toHaveLength(0);
    expect((await read()).body.resolved[0]).toMatchObject({ result: "unavailable", attempts: 1 });
  });

  it("publishes the commit and advances the careers of the events", async () => {
    const { dealer, changes, careers, clock } = await setup([GOOD]);
    const woken = changes.next("b000000001", clock.now() + 5000, new AbortController().signal);
    await dealer.kick("b000000001");
    expect(await woken).toBe(2);
    expect((await careers.get(ADA)).completed).toBe(true);
  });

  it("runs one runner per table: a second kick shares the first", async () => {
    const { dealer, llm } = await setup([GOOD, GOOD]);
    const first = dealer.kick("b000000001");
    const second = dealer.kick("b000000001");
    expect(second).toBe(first);
    await first;
    expect(llm.asked).toHaveLength(1);
  });

  it("does nothing for a table with no pending request, or none at all", async () => {
    const { dealer, llm, read } = await setup([GOOD]);
    await dealer.kick("b000000001");
    await dealer.kick("b000000001");
    await dealer.kick("bmissing000");
    expect(llm.asked).toHaveLength(1);
    expect((await read()).version).toBe(2);
  });

  it("reports the model's last success and last error", async () => {
    const { dealer } = await setup(["throw", "throw"]);
    await dealer.kick("b000000001");
    expect(dealer.status()).toMatchObject({ driver: "scripted", lastOk: null, lastError: "Error: model unreachable" });
  });
});

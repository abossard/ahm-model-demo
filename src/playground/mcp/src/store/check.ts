import { describeError } from "../log";
import type { Doc, Store } from "../ports";

const PK = "selfcheck";

interface Probe {
  n: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Case = { name: string; run: (store: Store, id: (suffix: string) => string) => Promise<string | null> };

const CASES: Case[] = [
  {
    name: "create then get",
    async run(store, id) {
      const created = await store.update<Probe>("tables", PK, id("a"), () => ({ n: 1 }));
      const read = await store.get<Probe>("tables", PK, id("a"));
      return created?.version === 1 && read?.version === 1 && read.body.n === 1 ? null : "created document not read back";
    },
  },
  {
    name: "update bumps the version by one",
    async run(store, id) {
      await store.update<Probe>("tables", PK, id("b"), () => ({ n: 1 }));
      const next = await store.update<Probe>("tables", PK, id("b"), (body) => ({ n: (body?.n ?? 0) + 1 }));
      return next?.version === 2 && next.body.n === 2 ? null : `version ${next?.version}, expected 2`;
    },
  },
  {
    name: "an unchanged change writes nothing",
    async run(store, id) {
      await store.update<Probe>("tables", PK, id("c"), () => ({ n: 1 }));
      const same = await store.update<Probe>("tables", PK, id("c"), (body) => body);
      const nothing = await store.update<Probe>("tables", PK, id("c"), () => null);
      return same?.version === 1 && nothing?.version === 1 ? null : "an unchanged change wrote";
    },
  },
  {
    name: "two interleaved updates both land",
    async run(store, id) {
      await store.update<Probe>("tables", PK, id("d"), () => ({ n: 0 }));
      const bump = (body: Probe | null) => ({ n: (body?.n ?? 0) + 1 });
      await Promise.all([store.update<Probe>("tables", PK, id("d"), bump), store.update<Probe>("tables", PK, id("d"), bump)]);
      const read = await store.get<Probe>("tables", PK, id("d"));
      return read?.body.n === 2 && read.version === 3 ? null : `n ${read?.body.n}, version ${read?.version}, expected 2 and 3`;
    },
  },
  {
    name: "list returns one partition newest first",
    async run(store, id) {
      await store.update<Probe>("tables", PK, id("e1"), () => ({ n: 1 }));
      await sleep(5);
      await store.update<Probe>("tables", PK, id("e2"), () => ({ n: 2 }));
      await store.update<Probe>("tables", `${PK}-other`, id("e3"), () => ({ n: 3 }));
      const ids = (await store.list<Probe>("tables", PK, 50)).map((doc: Doc<Probe>) => doc.id);
      const [first, second] = [ids.indexOf(id("e2")), ids.indexOf(id("e1"))];
      const leaked = ids.includes(id("e3"));
      await store.remove("tables", `${PK}-other`, id("e3"));
      return first !== -1 && second !== -1 && first < second && !leaked ? null : `list order ${JSON.stringify(ids)}`;
    },
  },
  {
    name: "remove then get is null",
    async run(store, id) {
      await store.update<Probe>("tables", PK, id("f"), () => ({ n: 1 }));
      await store.remove("tables", PK, id("f"));
      return (await store.get("tables", PK, id("f"))) === null ? null : "removed document still reads";
    },
  },
];

const SUFFIXES = ["a", "b", "c", "d", "e1", "e2", "f"];

export async function checkStore(store: Store): Promise<string | null> {
  const run = Math.random().toString(36).slice(2, 8);
  const id = (suffix: string) => `check-${run}-${suffix}`;
  try {
    for (const { name, run: runCase } of CASES) {
      const problem = await runCase(store, id).catch((error: unknown) => describeError(error));
      if (problem) return `${name}: ${problem}`;
    }
    return null;
  } finally {
    await Promise.all(SUFFIXES.map((suffix) => store.remove("tables", PK, id(suffix)).catch(() => undefined)));
  }
}

export interface StoreCheckState {
  ready: boolean;
  check: string;
}

// Runs the check now and every `everyMs` until it passes. Returns a stop function.
export function watchStore(store: Store, onResult: (state: StoreCheckState) => void, everyMs = 10_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  onResult({ ready: false, check: "running" });
  const attempt = async () => {
    const problem = await checkStore(store);
    if (stopped) return;
    onResult(problem === null ? { ready: true, check: "passed" } : { ready: false, check: problem });
    if (problem !== null) timer = setTimeout(attempt, everyMs);
  };
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

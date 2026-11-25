import type { DealerLlm } from "../ports";

export function createBrokenLlm(): DealerLlm {
  return {
    name: "broken",
    async ask() {
      return { output: { cards: ["ZZ"], action: "hit", say: "" }, model: "broken", ms: 0 };
    },
  };
}

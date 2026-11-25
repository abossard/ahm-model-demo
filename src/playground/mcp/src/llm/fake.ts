import type { DealerLlm, DealerOutput, DealerRequest } from "../ports";

// Answers from a calculation of the request alone, so a test knows every card.
export function createFakeLlm(answer: (request: DealerRequest) => DealerOutput): DealerLlm {
  return {
    name: "fake",
    async ask(request) {
      return { output: answer(request), model: "fake", ms: 0 };
    },
  };
}

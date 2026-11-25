import { CARDS, SUITS } from "@playground/contracts";
import type { DealerOutput, DealerRequest } from "../ports";

const RANK_WALK = ["T", "7", "9", "5", "K", "6", "A", "8", "3", "Q", "4", "2", "J"];
const WALK = SUITS.flatMap((suit) => RANK_WALK.map((rank) => `${rank}${suit}`));

// A dealer whose every answer is known in advance. A shuffle walks WALK from (cards left) mod 52 and skips cards that are gone.
export function fakeDealer(request: DealerRequest): DealerOutput {
  if (request.kind === "decide") {
    return request.total < 17 && request.hits < 5
      ? { cards: [], action: "hit", say: "The house draws." }
      : { cards: [], action: "stand", say: "The house stands." };
  }
  const left = { ...request.remaining };
  const total = CARDS.reduce((sum, card) => sum + (left[card] ?? 0), 0);
  const cards: string[] = [];
  for (let step = 0; cards.length < Math.min(request.count, total); step++) {
    const card = WALK[(total + step) % WALK.length]!;
    if ((left[card] ?? 0) > 0) {
      left[card]!--;
      cards.push(card);
    }
  }
  return { cards, action: "stand", say: "Cards are in the mix." };
}

import { Career, LAB_EXHIBITS_TO_UNLOCK, LAYERS, NEW_CAREER, type Layer, type LayerId } from "@playground/contracts";

export const CAREER_KEY = "playground.career";

export function layerOf(id: LayerId): Layer {
  return LAYERS.find((layer) => layer.id === id)!;
}

export type RungState = "open" | "locked";

export function rungState(career: Career, layer: LayerId): RungState {
  return career.unlocked >= layer ? "open" : "locked";
}

// A calculation: what the visitor sees on a locked layer. The job is the one that opens it, so it belongs to the layer before.
export function jobToOpen(layer: LayerId): string {
  return layer === 1 ? "Open the page." : layerOf((layer - 1) as LayerId).job;
}

// A calculation: the copy on disk may be old, damaged or from another version. Anything unreadable is a new career.
export function parseStoredCareer(raw: string | null): Career {
  if (!raw) return NEW_CAREER;
  try {
    const parsed = Career.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : NEW_CAREER;
  } catch {
    return NEW_CAREER;
  }
}

// The higher of two copies wins on screen. Order: completed, layer, exhibits tried.
export function sameCareer(a: Career, b: Career): boolean {
  return a.unlocked === b.unlocked && a.completed === b.completed && a.lab.length === b.lab.length && a.lab.every((exhibit) => b.lab.includes(exhibit));
}

export function higherCareer(a: Career, b: Career): Career {
  const score = (career: Career) => [career.completed ? 1 : 0, career.unlocked, career.lab.length] as const;
  const [sa, sb] = [score(a), score(b)];
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! > sb[i]! ? a : b;
  return a;
}

export interface Offer {
  headline: string;
  name: string;
  did: string;
  next: string;
  // The layer the primary button goes to. Null when the career is complete.
  go: LayerId | null;
  layer: LayerId;
  completed: boolean;
}

const DID: Record<number, string> = {
  2: "You called a tool from inside a View. The host carried the call to the server.",
  3: `You tried ${LAB_EXHIBITS_TO_UNLOCK} exhibits.`,
  4: "You took a piece.",
  5: "You sold cargo for more than you paid.",
};
const NEXT: Record<number, string> = {
  2: "Next: ten switches, each one a request a View can make of its host.",
  3: "Next: two people, one board, and turns the server pushes.",
  4: "Next: a long game that lives in server state.",
  5: "Next: a table of strangers and a language model dealing.",
};

function layerOffer(layer: LayerId, did: string, next: string): Offer {
  const info = layerOf(layer);
  return { headline: `Layer ${layer} open`, name: info.name, did, next, go: layer, layer, completed: false };
}

// A calculation: what the visitor is offered when the career moves from `prev` to `next`. Null when nothing opened.
export function offerFor(prev: Career, next: Career): Offer | null {
  if (next.completed && !prev.completed) {
    return {
      headline: "Career complete", name: "Every layer", layer: 5, go: null, completed: true,
      did: "You won a hand.", next: "That is every layer. The wire has no more secrets from you.",
    };
  }
  if (next.unlocked <= prev.unlocked) return null;
  if (next.unlocked - prev.unlocked > 1) {
    const first = (prev.unlocked + 1) as LayerId;
    return {
      headline: "All layers open", name: "Code accepted", layer: next.unlocked, go: first, completed: false,
      did: "You typed the code.", next: `Every layer is open. ${layerOf(first).name} is the first you have not seen.`,
    };
  }
  return layerOffer(next.unlocked, DID[next.unlocked] ?? "", NEXT[next.unlocked] ?? "");
}

export function progressLine(career: Career): string {
  return career.completed ? "Career complete" : `${career.unlocked} of ${LAYERS.length} layers open`;
}

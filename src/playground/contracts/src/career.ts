import { z } from "zod";

// The five layers and what unlocks the next one. The host shows `job`; the MCP server applies `advanceCareer`.
export const LAYERS = [
  { id: 1, slug: "briefing", name: "Briefing", teaches: "A tool can come with a View. The host renders it in a sandbox.",
    job: "Press the button inside the View." },
  { id: 2, slug: "lab", name: "The Lab", teaches: "Everything a View can ask of its host, one switch at a time.",
    job: "Try any three exhibits." },
  { id: 3, slug: "checkers", name: "Checkers", teaches: "Two people, one table, turns pushed by the server.",
    job: "Take a piece." },
  { id: 4, slug: "trader", name: "Drift Ledger", teaches: "A View that keeps a long game in server state.",
    job: "Sell cargo for more than you paid." },
  { id: 5, slug: "blackjack", name: "Blackjack", teaches: "Many players, live turns, and a language model as the dealer.",
    job: "Win a hand." },
] as const;
export type Layer = (typeof LAYERS)[number];
export const LayerId = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export type LayerId = z.infer<typeof LayerId>;

export const LAB_EXHIBITS = [
  "call_tool", "read_resource", "progress", "message", "model_context", "open_link", "display_mode", "log",
  "theme", "app_tool",
] as const;
export const LabExhibit = z.enum(LAB_EXHIBITS);
export type LabExhibit = z.infer<typeof LabExhibit>;
export const LAB_EXHIBITS_TO_UNLOCK = 3;

export const CHEAT_CODE = "opencity";

export const Career = z.object({
  unlocked: LayerId,
  lab: z.array(LabExhibit),
  completed: z.boolean(),
});
export type Career = z.infer<typeof Career>;
export const NEW_CAREER: Career = { unlocked: 1, lab: [], completed: false };

export type CareerEvent =
  | { type: "hello_ping" }
  | { type: "lab_exhibit"; exhibit: LabExhibit }
  | { type: "checkers_capture" }
  | { type: "trader_profit" }
  | { type: "blackjack_win" }
  | { type: "cheat" };

function atLeast(career: Career, layer: LayerId): Career {
  return career.unlocked >= layer ? career : { ...career, unlocked: layer };
}

// A calculation. Returns the same object when nothing changed, so the caller can skip the write.
export function advanceCareer(career: Career, event: CareerEvent): Career {
  switch (event.type) {
    case "hello_ping":
      return atLeast(career, 2);
    case "lab_exhibit": {
      if (career.lab.includes(event.exhibit)) return career;
      const lab = [...career.lab, event.exhibit];
      return atLeast({ ...career, lab }, lab.length >= LAB_EXHIBITS_TO_UNLOCK ? 3 : career.unlocked);
    }
    case "checkers_capture":
      return atLeast(career, 4);
    case "trader_profit":
      return atLeast(career, 5);
    case "blackjack_win":
      return career.completed ? career : { ...career, unlocked: 5, completed: true };
    case "cheat":
      return atLeast(career, 5);
  }
}

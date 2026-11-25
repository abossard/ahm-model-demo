import type { LayerId, Player, ToolInput, ToolName } from "@playground/contracts";
import { TOOLS, VIEWS, type ViewName } from "@playground/contracts";

export interface Entry {
  tool: ToolName;
  args: Record<string, unknown>;
}

const ENTRY_TOOL: Record<LayerId, ToolName> = {
  1: "hello_show", 2: "lab_open", 3: "checkers_open", 4: "trader_open", 5: "blackjack_open",
};

// A calculation: the tool that opens a layer's View, and its arguments. A table id in the URL goes to the games that have tables.
export function entryFor(layer: LayerId, player: Player, tableId: string | null): Entry {
  const tool = ENTRY_TOOL[layer];
  const args: ToolInput<"checkers_open"> = tableId && (layer === 3 || layer === 5) ? { player, tableId } : { player };
  return { tool, args };
}

export function viewOf(tool: ToolName): ViewName {
  const view = TOOLS[tool].view;
  if (!view) throw new Error(`${tool} has no View`);
  return view;
}

export function resourceOf(tool: ToolName): string {
  return VIEWS[viewOf(tool)];
}

// What the frame chrome says about its sandbox. The View policy of the host server enforces it.
export const SANDBOX_NOTE = { origin: "origin null", connect: "connect-src 'none'", flags: "sandbox allow-scripts" } as const;

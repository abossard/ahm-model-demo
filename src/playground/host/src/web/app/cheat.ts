import { CHEAT_CODE } from "@playground/contracts";

export interface CheatState {
  typed: string;
  hit: boolean;
}
export const CHEAT_START: CheatState = { typed: "", hit: false };

// A calculation: the keys typed so far, as far as they still lead to the code. A hit resets the buffer.
export function nextCheat(state: CheatState, key: string, code: string = CHEAT_CODE): CheatState {
  if (key.length !== 1) return { typed: state.typed, hit: false };
  const typed = (state.typed + key.toLowerCase()).slice(-code.length);
  return typed === code ? { typed: "", hit: true } : { typed, hit: false };
}

// A calculation: keys typed into a field are text, not a cheat.
export function isTypingTarget(tag: string, editable: boolean): boolean {
  return editable || ["input", "textarea", "select"].includes(tag.toLowerCase());
}

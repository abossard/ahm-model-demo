import type { SignalValue } from "./types";

const DECIMALS = 3;
const SIGNIFICANT = 3;

/**
 * A signal value as a reader wants it: a fraction is rounded, because a metric such as 4.090909090909091
 * is too long for a card row, and text is kept as it is. `null` has no text.
 */
export function formatSignalValue(value: SignalValue): string {
  if (value === null) return "";
  if (typeof value === "string" || !Number.isFinite(value) || Number.isInteger(value)) return String(value);
  return String(Math.abs(value) >= 1 ? Number(value.toFixed(DECIMALS)) : Number(value.toPrecision(SIGNIFICANT)));
}

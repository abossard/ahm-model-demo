import type { ChangeBadge } from "./changes";
import { diffTokens, impactOf, impactStyle, tokensFor } from "./palette";
import { formatSignalValue } from "./signalValue";
import { clipText, textWidth, wrapText } from "./textMetrics";
import type { Entity, EntitySignal } from "./types";

/**
 * The size and content of an entity card in the Swimlanes view. A card is as wide as its name and
 * its widest signal row need, within bounds, and as tall as its lines. Every number is a function
 * of the data and of `textMetrics`, so a layout needs no DOM and the same input gives the same
 * picture. The component draws exactly what this says; its CSS uses the constants below.
 */
export type SignalMode = "all" | "problems" | "none";

export const NAME_STYLE = { size: 12.5, weight: 600 } as const;
export const ROW_STYLE = { size: 11, weight: 400 } as const;
export const VALUE_STYLE = { size: 11, weight: 600 } as const;
const WORD_STYLE = { size: 10.5, weight: 600 } as const;
const CHIP_STYLE = { size: 10, weight: 600 } as const;

export const MIN_WIDTH = 176;
export const MAX_WIDTH = 320;
export const NAME_LINE = 16;
export const HEADER_PAD = 9;
export const HEADER_MIN = 40;
export const CHIP_ROW = 22;
export const SIGNAL_ROW = 20;
export const SUMMARY_ROW = 18;
export const ROWS_PAD_TOP = 5;
export const ROWS_PAD_BOTTOM = 6;
/** Signal rows a card lists before it says "and N more". */
export const MAX_SIGNAL_ROWS = 8;
/** The name starts after the icon. */
export const NAME_LEFT = 36;
const STATE_RIGHT = 10;
const PILL_CHROME = 10 + 12 + 4 + 10;

const RANK: Readonly<Record<string, number>> = { Unhealthy: 3, Degraded: 2, Unknown: 1, Healthy: 0 };

export interface CardChip {
  readonly kind: "impact" | "diff";
  readonly glyph: string;
  readonly word: string;
  readonly width: number;
}

export interface CardRow {
  readonly key: string;
  readonly name: string;
  readonly value: string;
  readonly state: string;
}

export interface CardSpec {
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly nameLines: readonly string[];
  readonly chips: readonly CardChip[];
  readonly rows: readonly CardRow[];
  /** What the rows leave out, as a line of text, or null. */
  readonly summary: string | null;
}

function chipsOf(entity: Entity, badge: ChangeBadge | null): CardChip[] {
  const chips: CardChip[] = [];
  const width = (word: string): number => Math.ceil(18 + textWidth(word, CHIP_STYLE.size, CHIP_STYLE.weight) + 8);
  if (badge) chips.push({ kind: "diff", glyph: diffTokens[badge].glyph, word: diffTokens[badge].word, width: width(diffTokens[badge].word) });
  const impact = impactOf(entity.impact);
  if (impact !== "Standard") chips.push({ kind: "impact", glyph: impactStyle[impact].glyph, word: impactStyle[impact].word, width: width(impactStyle[impact].word) });
  return chips;
}

/** The signals a card lists, worst first, and the line that says what is left out. */
function rowsOf(signals: readonly EntitySignal[], mode: SignalMode): { rows: CardRow[]; summary: string | null } {
  if (mode === "none" || signals.length === 0) return { rows: [], summary: null };
  const ordered = signals
    .map((signal, index) => ({ signal, index }))
    .sort((a, b) => (RANK[b.signal.healthState] ?? 0) - (RANK[a.signal.healthState] ?? 0) || a.index - b.index)
    .map((item) => item.signal);
  const healthy = ordered.filter((signal) => signal.healthState === "Healthy").length;
  const wanted = mode === "problems" ? ordered.filter((signal) => signal.healthState !== "Healthy") : ordered;
  const shown = wanted.slice(0, MAX_SIGNAL_ROWS);
  const parts: string[] = [];
  if (wanted.length > shown.length) parts.push(`+${wanted.length - shown.length} more`);
  if (mode === "problems" && healthy > 0) parts.push(`+${healthy} healthy ${healthy === 1 ? "signal" : "signals"}`);
  return {
    rows: shown.map((signal) => ({ key: signal.name, name: signal.displayName || signal.name, value: formatSignalValue(signal.value), state: signal.healthState })),
    summary: parts.length > 0 ? parts.join(", ") : null,
  };
}

export function measureCard(entity: Entity, mode: SignalMode, badge: ChangeBadge | null = null): CardSpec {
  const name = entity.displayName || entity.name;
  const word = tokensFor(entity.healthState).word;
  const pill = Math.ceil(PILL_CHROME + textWidth(word, WORD_STYLE.size, WORD_STYLE.weight));
  const { rows, summary } = rowsOf(entity.signals, mode);
  const chips = chipsOf(entity, badge);

  const nameNatural = textWidth(name, NAME_STYLE.size, NAME_STYLE.weight);
  const rowNatural = rows.reduce((widest, row) => Math.max(widest, 28 + textWidth(row.name, ROW_STYLE.size, row.state === "Healthy" ? 400 : 600) + 14 + textWidth(row.value, VALUE_STYLE.size, VALUE_STYLE.weight) + 12), 0);
  const chipNatural = chips.reduce((sum, chip) => sum + chip.width + 4, NAME_LEFT) + 8;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(Math.max(NAME_LEFT + nameNatural + 8 + pill + STATE_RIGHT, rowNatural, chipNatural))));

  const wrapped = wrapText(name, width - NAME_LEFT - 8 - pill - STATE_RIGHT, NAME_STYLE, 2);
  const headerHeight = Math.max(HEADER_MIN, HEADER_PAD + Math.max(20, wrapped.lines.length * NAME_LINE) + (chips.length > 0 ? CHIP_ROW : 0) + HEADER_PAD);
  const region = rows.length > 0 || summary !== null;
  const height = headerHeight + (region ? 1 + ROWS_PAD_TOP + rows.length * SIGNAL_ROW + (summary === null ? 0 : SUMMARY_ROW) + ROWS_PAD_BOTTOM : 0);
  return { width, height, headerHeight, nameLines: wrapped.lines, chips, rows, summary };
}

/** The label of a chip that stands for folded entities. */
export const FOLD_HEIGHT = 30;

export function foldWidth(text: string): number {
  return Math.max(112, Math.ceil(textWidth(text, 11, 600) + 44));
}

/** A relationship's label as a pill: the text cut to a length that still leaves a line room to dodge it, and the pill's size around it. */
export const PILL_HEIGHT = 20;
export const PILL_TEXT = { size: 10.5, weight: 400 } as const;
const PILL_MAX_TEXT = 150;

export function pillOf(label: string): { readonly text: string; readonly width: number; readonly height: number } | null {
  const trimmed = label.trim();
  if (trimmed === "") return null;
  const text = clipText(trimmed, PILL_MAX_TEXT, PILL_TEXT);
  return { text, width: Math.ceil(textWidth(text, PILL_TEXT.size, PILL_TEXT.weight) + 14), height: PILL_HEIGHT };
}

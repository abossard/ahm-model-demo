// text.mjs — text measurement for layout, no browser required at runtime.
// Advance widths come from src/font-metrics.mjs, measured once in headless Chrome against the
// renderer's real font stack (regular and 600-weight tables — see scripts/measure-font.mjs).
// A small safety factor absorbs cross-platform font substitution (e.g. real Segoe UI on
// Windows vs the metrics host's fallback), so measured boxes err on the roomy side — layout
// must never clip text.

import { FONT } from "./font-metrics.mjs";

const SAFETY = 1.02;

function charW(ch, table) {
  const key = ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
  const w = table[ch] ?? table[key];
  if (w != null) return w;
  const cp = ch.codePointAt(0);
  // CJK, emoji, and other wide scripts ≈ 1em; everything else unknown ≈ 0.62em
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x1f000 && cp <= 0x1ffff) || (cp >= 0x2600 && cp <= 0x27bf))) return 1000;
  return 620;
}

// width in px of `text` at `fontSize`; `weight` >= 600 uses the measured bold table
export function textWidth(text, fontSize, weight = 400) {
  const table = weight >= 600 ? FONT.bold : FONT.regular;
  let units = 0;
  for (const ch of String(text)) units += charW(ch, table);
  return (units / 1000) * fontSize * SAFETY;
}

// Greedy word wrap into at most maxLines lines of width <= maxW. Words longer than maxW are
// hard-broken so a line can never overflow. If the text doesn't fit, the last line is
// ellipsized and `clipped: true` is reported so callers can attach a tooltip + diagnostic.
export function wrapText(text, maxW, fontSize, { weight = 400, maxLines = 2 } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  const fits = (s) => textWidth(s, fontSize, weight) <= maxW;
  const pushCur = () => { if (cur) { lines.push(cur); cur = ""; } };

  for (let w of words) {
    while (!fits(w) && w.length > 1) {          // hard-break oversized words
      let cut = w.length - 1;
      while (cut > 1 && !fits(w.slice(0, cut))) cut--;
      pushCur();
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const cand = cur ? cur + " " + w : w;
    if (fits(cand)) cur = cand;
    else { pushCur(); cur = w; }
  }
  pushCur();

  if (lines.length <= maxLines) return { lines, clipped: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] + " " + lines.slice(maxLines).join(" ");
  while (last.length > 1 && !fits(last + "…")) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = last + "…";
  return { lines: kept, clipped: true };
}

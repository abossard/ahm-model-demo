/**
 * Text measuring that needs no DOM, so layout is the same in a browser, in vitest and in a build.
 *
 * Advance widths (per mille of the font size) for a sans-serif face, regular and 600 weight, are
 * from ahm-diagrammo (MIT), src/font-metrics.mjs, measured once in headless Chrome. The measure
 * and the greedy word wrap are its src/text.mjs. A safety factor makes measured boxes err on the
 * roomy side, because the face on screen (Segoe UI, SF, Roboto) is never exactly the measured one,
 * and a card clips what it cannot fit rather than overflow.
 */

type Table = Readonly<Record<string, number>>;

const REGULAR: Table = {
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556, " ": 278,
  "!": 278, "\"": 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333, "*": 389, "+": 584,
  ",": 278, "-": 333, ".": 278, "/": 278, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015,
  "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778, "H": 722, "I": 278, "J": 500, "K": 667,
  "L": 556, "M": 833, "N": 722, "O": 778, "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667,
  "W": 944, "X": 667, "Y": 667, "Z": 611, "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556, "`": 333, "a": 556,
  "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556, "h": 556, "i": 222, "j": 222, "k": 500, "l": 222,
  "m": 833, "n": 556, "o": 556, "p": 556, "q": 556, "r": 333, "s": 500, "t": 278, "u": 556, "v": 500, "w": 722,
  "x": 500, "y": 500, "z": 500, "{": 334, "|": 260, "}": 334, "~": 584, "…": 1000, "–": 556, "—": 1000, "‘": 222,
  "’": 222, "“": 333, "”": 333, "„": 333, "•": 350, "·": 333, "×": 584, "µ": 576, "°": 400, "±": 549, "→": 1000,
  "↳": 838,
};

const BOLD: Table = {
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556, " ": 278,
  "!": 333, "\"": 474, "#": 556, "$": 556, "%": 889, "&": 722, "'": 238, "(": 333, ")": 333, "*": 389, "+": 584,
  ",": 278, "-": 333, ".": 278, "/": 278, ":": 333, ";": 333, "<": 584, "=": 584, ">": 584, "?": 611, "@": 975,
  "A": 722, "B": 722, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778, "H": 722, "I": 278, "J": 556, "K": 722,
  "L": 611, "M": 833, "N": 722, "O": 778, "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667,
  "W": 944, "X": 667, "Y": 667, "Z": 611, "[": 333, "\\": 278, "]": 333, "^": 584, "_": 556, "`": 333, "a": 556,
  "b": 611, "c": 556, "d": 611, "e": 556, "f": 333, "g": 611, "h": 611, "i": 278, "j": 278, "k": 556, "l": 278,
  "m": 889, "n": 611, "o": 611, "p": 611, "q": 611, "r": 389, "s": 556, "t": 333, "u": 611, "v": 556, "w": 778,
  "x": 556, "y": 556, "z": 500, "{": 389, "|": 280, "}": 389, "~": 584, "…": 1000, "–": 556, "—": 1000, "‘": 278,
  "’": 278, "“": 500, "”": 500, "„": 500, "•": 350, "·": 333, "×": 584, "µ": 576, "°": 400, "±": 549, "→": 1000,
  "↳": 838,
};

/** Per mille of the font size, for a character the tables lack: about the width of a lower-case letter. */
const UNKNOWN = 620;
/** Per mille, for characters of wide scripts and emoji. */
const WIDE = 1000;
/** Measured in Chromium on macOS (system-ui) at 10 to 12.5 px, real widths ran 3 to 8 % over the table, 12 % at worst: 10 % keeps nearly every text whole. */
const SAFETY = 1.1;

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1ffff) ||
      (codePoint >= 0x2600 && codePoint <= 0x27bf))
  );
}

/** The width in px of `text` at `size` px; a weight of 600 or more uses the bold table. */
export function textWidth(text: string, size: number, weight = 400): number {
  const table = weight >= 600 ? BOLD : REGULAR;
  let units = 0;
  for (const char of text) {
    const known = table[char];
    units += known ?? (isWide(char.codePointAt(0) as number) ? WIDE : UNKNOWN);
  }
  return (units / 1000) * size * SAFETY;
}

export interface TextStyle {
  readonly size: number;
  readonly weight?: number;
}

/** `text` cut with an ellipsis so that it is at most `maxWidth` wide; unchanged when it fits. */
export function clipText(text: string, maxWidth: number, { size, weight = 400 }: TextStyle): string {
  if (textWidth(text, size, weight) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size, weight) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export interface Wrapped {
  readonly lines: readonly string[];
  /** The last line was cut with an ellipsis. */
  readonly clipped: boolean;
}

/**
 * Greedy word wrap into at most `maxLines` lines no wider than `maxWidth`. A word longer than a
 * line is broken, so no line can overflow; when the text does not fit, the last line ends in an ellipsis.
 */
export function wrapText(text: string, maxWidth: number, { size, weight = 400 }: TextStyle, maxLines = 2): Wrapped {
  const fits = (candidate: string): boolean => textWidth(candidate, size, weight) <= maxWidth;
  const lines: string[] = [];
  let current = "";
  const push = (): void => {
    if (current !== "") lines.push(current);
    current = "";
  };
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (!fits(word) && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut -= 1;
      push();
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const joined = current === "" ? word : `${current} ${word}`;
    if (fits(joined)) current = joined;
    else {
      push();
      current = word;
    }
  }
  push();
  if (lines.length <= maxLines) return { lines, clipped: false };
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`;
  while (last.length > 1 && !fits(`${last}…`)) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, clipped: true };
}

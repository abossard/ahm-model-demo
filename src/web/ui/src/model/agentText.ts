/**
 * The assistant writes the summaries, findings and reasons, and writes them for engineers. The interface cannot change
 * the words, but it can show the answer first and keep identifiers quiet: the first sentence is the answer, the rest is
 * the evidence, and code, resource paths and ids sit in a small monospace.
 */

export interface AnswerParts {
  /** The first sentence, which answers the question. */
  readonly answer: string;
  /** Everything after it, or an empty string. */
  readonly evidence: string;
}

// A sentence ends at a full stop, question or exclamation mark that is followed by space; a dot inside an
// identifier ("resourceHealth.enabled") or a number ("0.2") is no end.
const SENTENCE_END = /[.!?](?=\s|$)/g;
const INLINE_CODE = /`[^`]*`/g;

/** The first sentence of a text and the rest; a text of one sentence has no evidence. */
export function splitAnswer(text: string): AnswerParts {
  const trimmed = text.trim();
  // A full stop inside inline code ends nothing.
  const masked = trimmed.replace(INLINE_CODE, (code) => "_".repeat(code.length));
  for (const match of masked.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + 1;
    return { answer: trimmed.slice(0, end), evidence: trimmed.slice(end).trim() };
  }
  return { answer: trimmed, evidence: "" };
}

export interface InlinePart {
  readonly text: string;
  /** True for code, a resource path or an id: shown quietly, in monospace. */
  readonly code: boolean;
}

// Backticked code, an ARM resource path, a GUID, or a dotted camelCase setting such as resourceHealth.enabled.
const IDENTIFIER = new RegExp(
  [
    "`[^`]+`",
    "/subscriptions/[^\\s,;)]+",
    "\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b",
    "\\b[a-z]+[A-Z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)+\\b",
  ].join("|"),
  "g",
);

/** A text cut into plain runs and identifiers; the backticks of inline code are dropped. */
export function inlineParts(text: string): readonly InlinePart[] {
  const parts: InlinePart[] = [];
  let from = 0;
  for (const match of text.matchAll(IDENTIFIER)) {
    const start = match.index ?? 0;
    if (start > from) parts.push({ text: text.slice(from, start), code: false });
    const found = match[0];
    parts.push({ text: found.startsWith("`") ? found.slice(1, -1) : found, code: true });
    from = start + found.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), code: false });
  return parts;
}

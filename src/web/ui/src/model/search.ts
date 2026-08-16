import type { Entity, Relationship } from "./types";

export type SearchGroup = "entities" | "relationships" | "signals";

export interface SearchHit {
  readonly id: string;
  readonly group: SearchGroup;
  /** Text shown to the user; `matchStart`/`matchLength` index into this string. */
  readonly label: string;
  readonly detail: string;
  readonly matchStart: number;
  readonly matchLength: number;
  /** Entity to highlight once the hit is picked. */
  readonly focusEntity: string;
  /** Every entity the viewport must frame — both endpoints for a relationship. */
  readonly focusEntities: readonly string[];
}

export const GROUP_LABELS: Readonly<Record<SearchGroup, string>> = {
  entities: "Entities",
  relationships: "Relationships",
  signals: "Signals",
};

const GROUP_ORDER: readonly SearchGroup[] = ["entities", "relationships", "signals"];

interface Match {
  readonly label: string;
  readonly start: number;
}

/**
 * Locale lowercasing can change UTF-16 length (`İ` folds to two units), so an index found in the
 * folded string may not address the same characters in the original. Only an index that still spans
 * the needle in the original is usable for marking.
 */
function foldedIndexOf(text: string, needle: string): number | null {
  const at = text.toLocaleLowerCase().indexOf(needle);
  if (at < 0) return null;
  if (text.length !== text.toLocaleLowerCase().length) return null;
  return text.slice(at, at + needle.length).toLocaleLowerCase() === needle ? at : null;
}

/** True when the text contains the needle at all, regardless of whether the index survives folding. */
function foldedIncludes(text: string, needle: string): boolean {
  return text.toLocaleLowerCase().includes(needle);
}

/**
 * Prefers the display text so the highlight lands on what the user reads, but falls back to the
 * technical name — every returned hit must be able to mark the substring that matched it.
 */
function matchIn(label: string, alternate: string, needle: string): Match | null {
  const direct = foldedIndexOf(label, needle);
  if (direct !== null) return { label, start: direct };
  const fallback = foldedIndexOf(alternate, needle);
  if (fallback !== null) return { label: alternate, start: fallback };
  // Matched somewhere, but no index survives folding. Show the label; mark nothing rather than
  // marking the wrong characters.
  if (foldedIncludes(label, needle)) return { label, start: -1 };
  return foldedIncludes(alternate, needle) ? { label: alternate, start: -1 } : null;
}

export function searchGraph(
  query: string,
  entities: readonly Entity[],
  relationships: readonly Relationship[],
): readonly SearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return [];

  const hits: SearchHit[] = [];
  const push = (
    group: SearchGroup,
    id: string,
    label: string,
    alternate: string,
    detail: string,
    focusEntity: string,
    focusEntities: readonly string[],
  ): void => {
    const match = matchIn(label, alternate, needle);
    if (match === null) return;
    const marks = match.start >= 0;
    hits.push({
      id,
      group,
      label: match.label,
      detail,
      matchStart: marks ? match.start : 0,
      matchLength: marks ? needle.length : 0,
      focusEntity,
      focusEntities,
    });
  };

  for (const item of entities) {
    const label = item.displayName || item.name;
    push("entities", `entity:${item.name}`, label, item.name, item.healthState, item.name, [item.name]);
  }

  for (const item of relationships) {
    const label = item.displayName || item.name;
    push(
      "relationships",
      `relationship:${item.name}`,
      label,
      item.name,
      `${item.parentEntityName} → ${item.childEntityName}`,
      item.childEntityName,
      [item.parentEntityName, item.childEntityName],
    );
  }

  for (const item of entities) {
    for (const current of item.signals) {
      const label = current.displayName || current.name;
      push(
        "signals",
        `signal:${item.name}:${current.name}`,
        label,
        current.name,
        item.displayName || item.name,
        item.name,
        [item.name],
      );
    }
  }

  return hits.sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group));
}

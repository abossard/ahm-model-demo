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
 * Prefers the display text so the highlight lands on what the user reads, but falls back to showing
 * the technical name — every returned hit must be able to mark the substring that matched it.
 */
function matchIn(label: string, alternate: string, needle: string): Match | null {
  const direct = label.toLocaleLowerCase().indexOf(needle);
  if (direct >= 0) return { label, start: direct };
  const fallback = alternate.toLocaleLowerCase().indexOf(needle);
  return fallback >= 0 ? { label: alternate, start: fallback } : null;
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
    hits.push({
      id,
      group,
      label: match.label,
      detail,
      matchStart: match.start,
      matchLength: needle.length,
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

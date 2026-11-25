// The one calculation every log in the playground shares: what a visitor sees after the kind chips and the text filter,
// with runs of the same line folded into one line and a count.
export interface LogLine {
  kind: string;
  text: string;
}

export interface LogRow<T extends LogLine> {
  line: T;
  count: number;
}

// Consecutive lines with the same kind and text become one row. The first of the run is kept.
export function collapseRuns<T extends LogLine>(lines: readonly T[]): LogRow<T>[] {
  const rows: LogRow<T>[] = [];
  for (const line of lines) {
    const last = rows.at(-1);
    if (last && last.line.kind === line.kind && last.line.text === line.text) last.count += 1;
    else rows.push({ line, count: 1 });
  }
  return rows;
}

// The kinds in a log, in the order they first appear.
export function kindsOf(lines: readonly LogLine[]): string[] {
  return [...new Set(lines.map((line) => line.kind))];
}

// The lines whose kind is not switched off and whose text holds the query (case does not matter).
export function filterLines<T extends LogLine>(lines: readonly T[], off: ReadonlySet<string>, query: string): T[] {
  const needle = query.trim().toLowerCase();
  return lines.filter((line) => !off.has(line.kind) && (needle === "" || line.text.toLowerCase().includes(needle)));
}

export function visibleLog<T extends LogLine>(lines: readonly T[], off: ReadonlySet<string>, query: string): LogRow<T>[] {
  return collapseRuns(filterLines(lines, off, query));
}

// The count as the page writes it: nothing for one, "×7" for seven.
export function countText(count: number): string {
  return count > 1 ? `×${count}` : "";
}

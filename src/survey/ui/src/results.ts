export type HistogramBin = { range: string; from: number; to: number; count: number };

const EDGES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export function histogramBins(distribution: readonly number[]): HistogramBin[] {
  return EDGES.slice(0, -1).map((from, index) => {
    const to = index === 9 ? 100 : (EDGES[index + 1] ?? 100) - 1;
    return { range: `${from}-${to}`, from, to,
      count: distribution.slice(from, to + 1).reduce((sum, count) => sum + count, 0) };
  });
}

export type DotPlacement = { value: number; row: number };

// One placement per answer at its exact score. Dots closer than minGap (in score units) cannot share a row.
export function dotPlacements(distribution: readonly number[], minGap: number): DotPlacement[] {
  const placed: DotPlacement[] = [];
  distribution.forEach((count, value) => {
    for (let n = 0; n < count; n++) {
      let row = 0;
      while (placed.some(dot => dot.row === row && Math.abs(dot.value - value) < minGap)) row++;
      placed.push({ value, row });
    }
  });
  return placed;
}

export function scoreCounts(distribution: readonly number[]): [number, number][] {
  return distribution.flatMap((count, value): [number, number][] => count > 0 ? [[value, count]] : []);
}

export type Band = { label: string; from: number; to: number; count: number; share: number };

const BAND_RANGES = [[0, 19], [20, 39], [40, 60], [61, 80], [81, 100]] as const;

// Share is exact (count / total * 100); rounding belongs to labels only.
export function scoreBands(distribution: readonly number[]): Band[] {
  const total = distribution.reduce((sum, count) => sum + count, 0);
  return BAND_RANGES.map(([from, to]) => {
    const count = distribution.slice(from, to + 1).reduce((sum, n) => sum + n, 0);
    return { label: `${from}-${to}`, from, to, count, share: total === 0 ? 0 : count / total * 100 };
  });
}

export function percentLabel(share: number): string {
  return `${Math.round(share * 10) / 10}%`;
}

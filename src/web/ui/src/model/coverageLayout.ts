import type { Coverage } from "./coverage";

/**
 * Where each cell of the coverage partition goes, for a width, and what it can show. Everything
 * here follows from the number of leaf columns and the width: a few parts get wide cells with
 * names, 80 get a column of 15 to 20 px each with a state glyph and a vertical name, 300 get
 * thin strips of state with no text. Sizes need no measuring.
 */
export type Density = "labels" | "glyphs" | "strips";

export interface LaidCell {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly band: 0 | 1;
  readonly leaf: boolean;
  /** The name shortened to fit, or null where there is no room for text. */
  readonly label: string | null;
  readonly labelAxis: "horizontal" | "vertical" | null;
  /** Room for the state glyph at the top of the cell. */
  readonly glyph: boolean;
  /** Room for the parent-count badge. */
  readonly badge: boolean;
}

export interface LaidBand {
  readonly band: 0 | 1;
  readonly y: number;
  readonly height: number;
}

export interface CoverageLayout {
  readonly cells: readonly LaidCell[];
  readonly bands: readonly LaidBand[];
  readonly width: number;
  readonly height: number;
  readonly density: Density;
  /** Pixels per leaf column. */
  readonly unit: number;
}

export const ROW = 44;
export const GAP = 3;
const LEAF_HEIGHT = 124;
const BAND_GAP = 44;
export const MAX_UNIT = 150;
const LABELS_AT = 52;
const GLYPHS_AT = 14;
const CHAR = 7;
const GLYPH_ROOM = 30;

/** `text`, cut with an ellipsis so it fits `room` pixels, or null when not even a few letters fit. */
export function fitText(text: string, room: number): string | null {
  const capacity = Math.floor(room / CHAR);
  if (text.length <= capacity) return text;
  return capacity < 4 ? null : `${text.slice(0, capacity - 1).trimEnd()}…`;
}

export function layoutCoverage(model: Coverage, labelOf: (name: string) => string, width: number): CoverageLayout {
  const widest = Math.max(1, ...model.bands.map((band) => band.leaves));
  const unit = Math.min(MAX_UNIT, Math.max(1, width / widest));
  const density: Density = unit >= LABELS_AT ? "labels" : unit >= GLYPHS_AT ? "glyphs" : "strips";

  const bands: LaidBand[] = [];
  let top = 0;
  for (const band of model.bands) {
    const height = (band.rows - 1) * ROW + LEAF_HEIGHT;
    bands.push({ band: band.band, y: top, height });
    top += height + BAND_GAP;
  }
  const bandTop = new Map(bands.map((band) => [band.band, band.y] as const));
  const rows = new Map(model.bands.map((band) => [band.band, band.rows] as const));

  const cells = model.cells.map((cell): LaidCell => {
    const w = Math.max(1, cell.span * unit - GAP);
    const levels = rows.get(cell.band) ?? 1;
    const h = cell.leaf ? (levels - cell.depth - 1) * ROW + LEAF_HEIGHT : ROW - GAP;
    const full = labelOf(cell.name);
    let label: string | null = null;
    let labelAxis: LaidCell["labelAxis"] = null;
    if (density !== "strips") {
      const horizontalRoom = w - GLYPH_ROOM - (cell.otherParents.length > 0 ? 18 : 0);
      if (w >= 56 && (density === "labels" || !cell.leaf || w >= 70)) {
        label = fitText(full, horizontalRoom);
        labelAxis = label === null ? null : "horizontal";
      } else if (cell.leaf) {
        label = fitText(full, h - 38);
        labelAxis = label === null ? null : "vertical";
      }
    }
    return {
      name: cell.name,
      x: cell.start * unit,
      y: (bandTop.get(cell.band) ?? 0) + cell.depth * ROW,
      width: w,
      height: h,
      depth: cell.depth,
      band: cell.band,
      leaf: cell.leaf,
      label,
      labelAxis,
      glyph: density !== "strips" && w >= 12,
      badge: density !== "strips" && w >= 40 && cell.otherParents.length > 0,
    };
  });
  return { cells, bands, width: Math.ceil(widest * unit), height: Math.max(0, top - BAND_GAP), density, unit };
}

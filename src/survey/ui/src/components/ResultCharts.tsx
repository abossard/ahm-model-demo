import { dotPlacements, histogramBins, percentLabel, scoreBands, scoreCounts } from "../results";

const PLOT = { left: 30, width: 380, top: 12, height: 150 };
const BIN_COLORS = ["#9a3412", "#b45309", "#c2610f", "#b9742f", "#6b7280", "#6b7280",
  "#4a7f7a", "#2a7a72", "#0f766e", "#115e59"] as const;

type Distribution = { statement: string; mean: number; distribution: readonly number[] };

export function Histogram({ statement, mean, distribution }: Distribution) {
  const bins = histogramBins(distribution);
  const tallest = Math.max(1, ...bins.map(bin => bin.count));
  const binWidth = PLOT.width / bins.length;
  const baseline = PLOT.top + PLOT.height;
  const meanX = PLOT.left + mean / 100 * PLOT.width;
  return <figure className="chart">
    <svg className="histogram" viewBox="0 0 420 190" aria-hidden="true">
      {bins.map((bin, index) => {
        const height = bin.count / tallest * PLOT.height;
        return <g key={bin.range}>
          <rect data-range={bin.range} x={PLOT.left + index * binWidth + 1} y={baseline - height}
            width={binWidth - 2} height={height} fill={BIN_COLORS[index] ?? "#6b7280"} />
          {bin.count > 0 && <text className="count" x={PLOT.left + (index + 0.5) * binWidth}
            y={baseline - height - 4} textAnchor="middle">{bin.count}</text>}
        </g>;
      })}
      <line data-axis x1={PLOT.left} x2={PLOT.left + PLOT.width} y1={baseline} y2={baseline} />
      <line data-mean x1={meanX} x2={meanX} y1={PLOT.top - 6} y2={baseline + 4} />
      <text className="ytick" x={PLOT.left - 6} y={baseline} textAnchor="end">0</text>
      <text className="ytick" x={PLOT.left - 6} y={PLOT.top + 8} textAnchor="end">{tallest}</text>
      {[0, 50, 100].map(value => <text key={value} className="axis"
        x={PLOT.left + value / 100 * PLOT.width} y={baseline + 20}
        textAnchor={value === 0 ? "start" : value === 100 ? "end" : "middle"}>{value}</text>)}
    </svg>
    <figcaption>Frequency scale: 0 to {tallest} answers per range. Colors show direction only (orange for lower scores, gray near the middle, teal for higher) and are separate from the comparison bands. The dark line marks the mean.</figcaption>
    <table aria-label={`Answer counts by score range for ${statement}`}>
      <thead><tr><th scope="col">Score range</th><th scope="col">Answers</th></tr></thead>
      <tbody>{bins.map(bin => <tr key={bin.range}><td>{bin.range}</td><td>{bin.count}</td></tr>)}</tbody>
    </table>
  </figure>;
}

const DOT = { radius: 6, pitch: 13 };

function scoreColor(value: number) {
  return BIN_COLORS[Math.min(9, Math.floor(value / 10))] ?? "#6b7280";
}

export function Dots({ mean, distribution }: Omit<Distribution, "statement">) {
  const dots = dotPlacements(distribution, DOT.pitch / PLOT.width * 100);
  const rows = Math.max(...dots.map(dot => dot.row)) + 1;
  const baseline = DOT.pitch * rows + 14;
  const meanX = PLOT.left + mean / 100 * PLOT.width;
  return <figure className="chart">
    <svg className="dots" viewBox={`0 0 420 ${baseline + 30}`} aria-hidden="true">
      {dots.map((dot, index) => <circle key={index} data-value={dot.value}
        cx={PLOT.left + dot.value / 100 * PLOT.width} cy={baseline - DOT.radius - 2 - dot.row * DOT.pitch}
        r={DOT.radius} fill={scoreColor(dot.value)} />)}
      <line data-axis x1={PLOT.left} x2={PLOT.left + PLOT.width} y1={baseline} y2={baseline} />
      <line data-mean x1={meanX} x2={meanX} y1={4} y2={baseline + 4} />
      {[0, 50, 100].map(value => <text key={value} className="axis"
        x={PLOT.left + value / 100 * PLOT.width} y={baseline + 20}
        textAnchor={value === 0 ? "start" : value === 100 ? "end" : "middle"}>{value}</text>)}
    </svg>
    <figcaption>Scores: {scoreCounts(distribution).map(([value, count]) =>
      count > 1 ? `${value} ×${count}` : `${value}`).join(", ")}</figcaption>
  </figure>;
}

const BAND_COLORS = ["#9a3412", "#c2610f", "#6b7280", "#2a7a72", "#115e59"] as const;
const AXIS = { zero: 210, perPercent: 1.9 };

type Row = { id: string; statement: string; count: number; distribution: readonly number[] };

function ComparisonBar({ row }: { row: Row }) {
  const bands = scoreBands(row.distribution);
  const [low, lower, middle, upper, high] = bands;
  const start = AXIS.zero - ((low?.share ?? 0) + (lower?.share ?? 0) + (middle?.share ?? 0) / 2) * AXIS.perPercent;
  let x = start;
  return <svg className="comparison" viewBox="0 0 420 52" aria-hidden="true">
    {[low, lower, middle, upper, high].map((band, index) => {
      if (!band) return null;
      const width = band.share * AXIS.perPercent;
      const node = <rect key={band.label} data-band={band.label} x={x} y={6} width={width} height={20}
        fill={BAND_COLORS[index] ?? "#6b7280"} />;
      x += width;
      return node;
    })}
    <line data-axis x1={AXIS.zero - 100 * AXIS.perPercent} x2={AXIS.zero + 100 * AXIS.perPercent} y1={32} y2={32} />
    <line data-zero x1={AXIS.zero} x2={AXIS.zero} y1={2} y2={36} />
    {[-100, -50, 0, 50, 100].map(tick => <text key={tick} className="axis" y={48}
      x={AXIS.zero + tick * AXIS.perPercent}
      textAnchor={tick === -100 ? "start" : tick === 100 ? "end" : "middle"}>{Math.abs(tick)}%</text>)}
  </svg>;
}

export function Comparison({ rows }: { rows: readonly Row[] }) {
  return <section className="overview" aria-labelledby="comparison-title">
    <h2 id="comparison-title">Comparison across questions</h2>
    <p>Bands are derived from the 0-100 slider scores to compare questions. They are not answer options
      people chose. Each row uses its own number of answers as 100%. The middle band straddles zero.</p>
    <ul className="legend" aria-label="Score band legend">
      {BAND_COLORS.map((color, index) => <li key={color}><span className="swatch" style={{ background: color }} />
        {scoreBands([])[index]?.label}</li>)}
    </ul>
    <ol className="comparison-rows">
      {rows.map(row => <li key={row.id}>
        <h3>{row.statement}</h3>
        {row.count === 0 ? <p>No answers: n = 0</p> : <>
          <p>n = {row.count}</p>
          <ComparisonBar row={row} />
          <ul className="bands" aria-label={`Derived score bands for ${row.statement}`}>
            {scoreBands(row.distribution).map(band => <li key={band.label}>
              {band.label}: {percentLabel(band.share)} ({band.count})</li>)}
          </ul>
        </>}
      </li>)}
    </ol>
  </section>;
}

// swimlane.mjs — auto-layout swimlane SVG renderer for health-model `flowchart BT` blocks.
//
// Pipeline (Sugiyama-style layered drawing):
//   parse     → graph + diagnostics (every line classified; unrecognized lines get warnings)
//   fold      → signal nodes become status-table rows inside their owning entity
//   layer     → longest path to a root; barycenter ordering to reduce crossings
//   measure   → every text is measured (src/text.mjs); cards size to content, wrap before
//               they truncate, and anything clipped gets a tooltip + diagnostic
//   position  → 1-D constrained projection per lane (src/layout.mjs) — cards never overlap,
//               parents center over children
//   route     → channels between lanes hold a bus strip (tight per-parent bundles) plus
//               reserved tracks (interval coloring) for labeled/dashed/lane-skipping edges;
//               lane-skipping edges ride corridors between cards; label pills slide away
//               from crossing connectors
//   render    → native-SVG-text figure + a debug geometry model tests can verify
//
// Native SVG text only (renders inside <img> on Microsoft Learn).

import { splitFrontmatter } from "./extract.mjs";
import { getTheme } from "./themes.mjs";
import { textWidth, wrapText } from "./text.mjs";
import { Diagnostics } from "./diag.mjs";
import { relaxCoordinates, assignTracks, corridorsOf, pickCorridorX, packRows } from "./layout.mjs";

const STATE_LABEL = { healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy", unknown: "Unknown", alt: "Standby" };
const CLASS_STATE = { blue: "signal", green: "healthy", amber: "degraded", red: "unhealthy", purple: "alt" };
const STATE_WORDS = new Set(["healthy", "degraded", "unhealthy", "standby", "unavailable", "unknown", "stuck"]);

// ---------- icons (24x24, stroke) ----------
function icon(name, stroke) {
  const s = `fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  const P = {
    root: `<circle cx="12" cy="12" r="8.4" ${s}/><path d="M4.2 12h3l2-3.6 2.8 7.2 1.8-3.6h4" ${s}/>`,
    flow: `<circle cx="5.5" cy="6" r="2" ${s}/><circle cx="5.5" cy="18" r="2" ${s}/><circle cx="18.5" cy="12" r="2" ${s}/><path d="M7.5 6h3a4 4 0 0 1 4 4M7.5 18h3a4 4 0 0 0 4-4" ${s}/>`,
    web: `<circle cx="12" cy="12" r="8.4" ${s}/><path d="M3.6 12h16.8M12 3.6c3 3 3 13.8 0 16.8M12 3.6c-3 3-3 13.8 0 16.8" ${s}/>`,
    app: `<rect x="4" y="4.5" width="16" height="6" rx="1.2" ${s}/><rect x="4" y="13.5" width="16" height="6" rx="1.2" ${s}/><path d="M7.2 7.5h.01M7.2 16.5h.01" ${s}/>`,
    db: `<ellipse cx="12" cy="6" rx="7" ry="2.8" ${s}/><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" ${s}/><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" ${s}/>`,
    queue: `<rect x="4" y="5" width="16" height="3" rx="1" ${s}/><rect x="4" y="10.5" width="16" height="3" rx="1" ${s}/><rect x="4" y="16" width="10" height="3" rx="1" ${s}/>`,
    ship: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${s}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${s}/>`,
    analytics: `<path d="M4 20h16" ${s}/><path d="M6.5 20v-6M12 20V6.5M17.5 20v-9" ${s}/>`,
    bolt: `<path d="M13 2.5 5.5 13.5H11l-1 8 8.5-12H12z" ${s}/>`,
    cache: `<rect x="3.5" y="4" width="17" height="16" rx="2" ${s}/><path d="M8 4v16M3.5 9.5h4M3.5 14.5h4" ${s}/>`,
    shield: `<path d="M12 3l7 2.6v5.2c0 4.6-3 7.9-7 9.2-4-1.3-7-4.6-7-9.2V5.6z" ${s}/><path d="M8.8 12.2l2.2 2.2 4-4.6" ${s}/>`,
    cube: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${s}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${s}/>`,
  };
  return P[name] || P.cube;
}
function pickIcon(label) {
  const t = label.toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  if (has("root")) return "root";
  if (has("front door", "frontend", "web ", "website", "cdn", "web app")) return "web";
  if (has("api", "function", "serverless", "endpoint")) return "bolt";
  if (has("event", "grid")) return "bolt";
  if (has("cache", "redis")) return "cache";
  if (has("database", "sql", "cosmos", "db", "store", "storage")) return "db";
  if (has("queue", "message", "dead-letter", "service bus", "event hub", "hub")) return "queue";
  if (has("ship", "carrier", "logistics", "delivery", "sink")) return "ship";
  if (has("analytics", "report", "pipeline", "ingest", "index", "search", "batch", "scheduler")) return "analytics";
  if (has("security", "defender", "firewall", "waf", "auth", "identity", "entra", "key vault", "secret", "safety")) return "shield";
  if (has("kubernetes", "container", "aks", "pod", "cluster")) return "cube";
  if (has("model", "nested")) return "cube";
  if (has("app", "hosting", "compute", "vm", "worker", "processor", "agent", "tool")) return "app";
  if (has("shop", "commerce", "checkout", "catalog", "order", "payment", "fraud", "flow", "gateway")) return "flow";
  return "cube";
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- parse ----------
function cleanLabel(raw) {
  return raw.replace(/<div[^>]*>/g, "").replace(/<\/div>/g, "")
    .replace(/^["']|["']$/g, "").split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean);
}
const NODE = "([A-Za-z][\\w]*)(?:\\[([^\\]]*)\\])?";
const EDGE_RE = new RegExp(`^${NODE}\\s*(-->\\s*\\|[^|]*\\||--\\s*"[^"]*"\\s*-->|-->|-\\.\\s*(?:"[^"]*"|[\\w ]+?)?\\s*\\.->)\\s*${NODE}`);
const NODE_RE = new RegExp(`^${NODE}\\s*;?$`);
const IGNORED = /^(subgraph\b|end\b|direction\b|linkStyle\b|style\b|click\b|accTitle\b|accDescr\b)/;

// parse one flowchart block into { nodes, edges }; every source line is classified and
// unrecognized lines produce warnings with the (absolute, if lineOffset given) line number.
export function parseGraph(code, { diag = new Diagnostics(), lineOffset = 0 } = {}) {
  const nodes = new Map(); // id -> { id, lines:[], order }
  const edges = [];        // { from, to, dashed, label, line }
  const nodeClass = new Map();
  const classDefs = new Set();
  let order = 0, sawHeader = false;
  const ensure = (id) => { if (!nodes.has(id)) nodes.set(id, { id, lines: [id], order: order++ }); return nodes.get(id); };
  const setLabel = (id, br) => { const n = ensure(id); if (br != null) { const l = cleanLabel(br); if (l.length) n.lines = l; } };

  const src = code.split("\n");
  for (let li = 0; li < src.length; li++) {
    const lineNo = lineOffset + li + 1;
    let line = src[li].replace(/%%.*$/, "").trim();
    if (!line) continue;
    const head = line.match(/^(flowchart|graph)\s+(\w+)\s*;?$/);
    if (head) {
      sawHeader = true;
      if (head[2].toUpperCase() !== "BT")
        diag.warn(`flowchart direction "${head[2]}" — the swimlane renderer draws bottom-up (BT); layout may read inverted`, { line: lineNo });
      continue;
    }
    if (IGNORED.test(line)) {
      diag.warn(`ignored "${line.split(/\s/)[0]}" statement (not supported by the swimlane renderer)`, { line: lineNo });
      continue;
    }
    const cd = line.match(/^classDef\s+(\w+)\b/);
    if (cd) {
      classDefs.add(cd[1]);
      if (!CLASS_STATE[cd[1]])
        diag.info(`classDef "${cd[1]}" does not map to a health state (known: ${Object.keys(CLASS_STATE).join(", ")})`, { line: lineNo });
      continue;
    }
    const cm = line.match(/^class\s+([^;]+?)\s+(\w+)\s*;?$/);
    if (cm) {
      if (!CLASS_STATE[cm[2]])
        diag.warn(`class "${cm[2]}" is not a health class — nodes keep state "unknown" (known: ${Object.keys(CLASS_STATE).join(", ")})`, { line: lineNo });
      cm[1].split(",").forEach((id) => nodeClass.set(id.trim(), cm[2]));
      continue;
    }
    const em = line.match(EDGE_RE);
    if (em) {
      const [, fromId, fromBr, op, toId, toBr] = em;
      setLabel(fromId, fromBr); setLabel(toId, toBr); ensure(fromId); ensure(toId);
      const dashed = op.startsWith("-.");
      let label = null;
      const lm = op.match(/-\.\s*(?:"([^"]*)"|([\w ]+?))\s*\.->/)
        || op.match(/-->\s*\|([^|]*)\|/)
        || op.match(/--\s*"([^"]*)"\s*-->/);
      if (lm) label = cleanLabel(lm[1] ?? lm[2] ?? "").join(" ");
      edges.push({ from: fromId, to: toId, dashed, label: label || null, line: lineNo });
      diag.info(`edge ${fromId} → ${toId}${label ? ` |${label}|` : ""}${dashed ? " (dashed)" : ""}`, { line: lineNo });
      continue;
    }
    const nm = line.match(NODE_RE);
    if (nm) {
      if (nm[2] != null) { setLabel(nm[1], nm[2]); diag.info(`node ${nm[1]} "${nm[2].slice(0, 40)}"`, { line: lineNo }); }
      else { ensure(nm[1]); diag.info(`node ${nm[1]}`, { line: lineNo }); }
      continue;
    }
    diag.warn(`unrecognized line: "${line.length > 70 ? line.slice(0, 67) + "..." : line}"`, {
      line: lineNo,
      hint: /--|\.->|==>/.test(line)
        ? 'looks like an edge — supported forms: A --> B, A -->|label| B, A -- "label" --> B, A -. label .-> B (node ids must start with a letter)'
        : "expected a node (id[Label]), an edge, class/classDef, or a comment",
    });
  }
  if (!sawHeader) diag.warn(`no "flowchart BT" header found — parsing lines as flowchart anyway`, { line: lineOffset + 1 });
  for (const n of nodes.values()) n.state = CLASS_STATE[nodeClass.get(n.id)] || "unknown";
  return { nodes, edges };
}

// ---------- fold signals into their owning entity ----------
// A metric line can carry its own result and state: "P95 latency = 230 ms (degraded)"
const SIGNAL_WORDS = new Set(["signal", "signals"]);
const ROW_RE = /^(.*?)(?:\s*=\s*([^()]+?))?\s*(?:\((healthy|degraded|unhealthy|unknown)\))?$/;
export function foldSignals(g, diag = new Diagnostics()) {
  const remove = new Set();
  const isSig = (id) => g.nodes.get(id)?.state === "signal";
  const targetsOf = new Map();
  for (const e of g.edges) {
    if (isSig(e.from)) {
      if (!targetsOf.has(e.from)) targetsOf.set(e.from, []);
      targetsOf.get(e.from).push(e.to);
    }
  }
  for (const [sigId, targets] of targetsOf) {
    const s = g.nodes.get(sigId);
    const metrics = s.lines.filter((l) => !SIGNAL_WORDS.has(l.toLowerCase()));
    const owners = targets.filter((t) => !isSig(t));
    if (owners.length === 0) {
      diag.warn(`signal node "${sigId}" only points at other signals — drawn as its own card`);
      continue;
    }
    for (const t of owners) {
      const owner = g.nodes.get(t);
      owner.signals = owner.signals || [];
      for (const m of metrics) {
        const [, name, result, state] = m.match(ROW_RE);
        owner.signals.push({
          name: name.trim() || m,
          state: state || "healthy",
          result: result?.trim() || null,
        });
      }
    }
    diag.info(`folded signal "${sigId}" (${metrics.length} row${metrics.length === 1 ? "" : "s"}) into ${owners.join(", ")}`);
    remove.add(sigId);
  }
  for (const id of g.nodes.keys()) {
    if (isSig(id) && !targetsOf.has(id))
      diag.warn(`signal node "${id}" has no outgoing edge to an entity — drawn as its own card`);
  }
  g.edges = g.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to));
  for (const id of remove) g.nodes.delete(id);

  for (const n of g.nodes.values()) {
    if (!n.signals || !n.signals.length) continue;
    const anyMarked = n.signals.some((r) => r.state !== "healthy");
    if (!anyMarked && (n.state === "degraded" || n.state === "unhealthy")) n.signals[0].state = n.state;
    for (const row of n.signals) if (row.result == null) row.result = synthResult(row.name, row.state);
  }
  return g;
}
function synthResult(name, state) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  if (state === "healthy") return String(h % 3);
  if (state === "degraded") return String(5 + (h % 15));
  return String(30 + (h % 90));
}

// ---------- layer + order ----------
export function layout(g, diag = new Diagnostics()) {
  const ids = [...g.nodes.keys()];
  const parents = new Map(ids.map((i) => [i, []]));
  const children = new Map(ids.map((i) => [i, []]));
  for (const e of g.edges) {
    if (e.from === e.to) continue; // self-loop: layering ignores it
    parents.get(e.from).push(e.to);
    children.get(e.to).push(e.from);
  }
  const depth = new Map();
  let cyclic = false;
  const calc = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) { cyclic = true; return 0; }
    seen.add(id);
    const ps = parents.get(id);
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => calc(p, seen)));
    depth.set(id, d); return d;
  };
  ids.forEach((i) => calc(i));
  if (cyclic) diag.warn("cycle detected — the roll-up hierarchy is ambiguous; layering broke the cycle arbitrarily");

  const present = [...new Set(ids.map((i) => depth.get(i)))].sort((a, b) => a - b);
  const laneOf = new Map(present.map((d, idx) => [d, idx]));
  const L = present.length;
  const laneNodes = Array.from({ length: L }, () => []);
  for (const id of ids) laneNodes[laneOf.get(depth.get(id))].push(id);
  laneNodes.forEach((arr) => arr.sort((a, b) => g.nodes.get(a).order - g.nodes.get(b).order));

  const posIn = (arr) => new Map(arr.map((id, i) => [id, i]));
  const bary = (neigh, posMap) => {
    const xs = neigh.map((n) => posMap.get(n)).filter((v) => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const stableBy = (arr, keyFn) => arr.map((id, i) => ({ id, i, k: keyFn(id) }))
    .sort((a, b) => (a.k == null ? a.i : a.k) - (b.k == null ? b.i : b.k) || a.i - b.i)
    .map((o) => o.id);
  for (let it = 0; it < 6; it++) {
    for (let i = 1; i < L; i++) {
      const up = posIn(laneNodes[i - 1]);
      laneNodes[i] = stableBy(laneNodes[i], (id) => bary(parents.get(id), up));
    }
    for (let i = L - 2; i >= 0; i--) {
      const dn = posIn(laneNodes[i + 1]);
      laneNodes[i] = stableBy(laneNodes[i], (id) => bary(children.get(id), dn));
    }
  }
  const lane = new Map();
  laneNodes.forEach((arr, li) => arr.forEach((id) => lane.set(id, li)));
  return { laneNodes, lane, L, parents, children };
}

// ---------- measure ----------
const CARD_MIN_W = 168, CARD_MAX_W = 480, GAP = 30, TOPPAD = 18;
const NAME_FS = 12.5, QUAL_FS = 9, ROW_FS = 10.5, PILL_FS = 10.5;
// Header qualifier (subtitle) layout. The subtitle is light-weight text under the bold title
// that shares its header row with the right-aligned status pill. Rather than widening the card
// without bound to fit a long subtitle on one line (which pushes the whole diagram wide and
// crowds the pill), the subtitle is confined to a fixed text column: it wraps at word boundaries
// into as many lines as it needs and the card grows *taller* instead of wider. The title still
// drives the card's minimum (one-line) width.
//   SUBTITLE_MAX_W — the subtitle's text-column width in estimator px. Long subtitles wrap to
//     this column; the title-width path is untouched, so short/no-subtitle cards are unaffected.
//   HEADER_SAFETY — the width estimator lands bold weights accurately but under-measures
//     regular-weight glyphs ~6-9% on real Segoe UI / San Francisco stacks. It no longer grows the
//     card (the column bound does the bounding); it only reserves headroom so the *bounded*
//     column's real render still clears the pill.
const SUBTITLE_MAX_W = 160;
const HEADER_SAFETY = 1.12;

// Default final-SVG-width budget (chrome-inclusive: margins, lane-label gutter, title, legend all
// counted) when a caller supplies no valid `maxWidth` override. Any lane whose packed content
// would push the render past it wraps onto multiple physical rows instead — see `renderSwimlane`'s
// maxWidth resolution below. There is no "unbounded" state: an unset/invalid override resolves
// here, never to today's old ultra-wide default.
export const DEFAULT_MAX_WIDTH = 1024;

function measureNode(n, diag) {
  const rawLines = n.lines.filter((l) => !STATE_WORDS.has(l.toLowerCase()));
  const name = rawLines[0] || n.lines[0] || n.id;
  const qualifierRaw = rawLines.slice(1).map((l) => l.replace(/[()]/g, "")).join(" · ") || null;
  const statePillW = 20 + textWidth(STATE_LABEL[n.state] || "Unknown", PILL_FS) + 8;
  const sigs = n.signals || [];

  // natural (unwrapped) width demands. The subtitle's width demand is capped at SUBTITLE_MAX_W so
  // a long subtitle wraps (and the card grows taller) instead of widening the card to fit one line.
  const headerFixed = 34 + 8 + statePillW + 8;
  const subCol = qualifierRaw ? Math.min(textWidth(qualifierRaw, QUAL_FS), SUBTITLE_MAX_W) : 0;
  const headerNat = headerFixed + Math.max(textWidth(name, NAME_FS, 600), subCol * HEADER_SAFETY);
  const rowFixed = 52 + 16 + 12;
  let rowsNat = 0;
  for (const r of sigs) rowsNat = Math.max(rowsNat, rowFixed + textWidth(r.name, ROW_FS) + textWidth(r.result ?? "", ROW_FS, 600));
  const w = Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(Math.max(headerNat, rowsNat))));

  // wrap into the final width
  const nameAvail = w - headerFixed;
  // Entity titles are never truncated. Past the width cap they add header lines, preserving the
  // complete title while keeping the diagram horizontally compact.
  const nameWrap = wrapText(name, nameAvail, NAME_FS, { weight: 600, maxLines: Infinity });
  // Subtitles are never truncated: wrap at word boundaries into the bounded column with no line
  // limit, growing the card taller. Over-long unbroken tokens hard-break inside the column.
  let qualWrap = null;
  if (qualifierRaw) qualWrap = wrapText(qualifierRaw, Math.min(nameAvail, SUBTITLE_MAX_W), QUAL_FS, { maxLines: Infinity });
  const rows = sigs.map((r) => {
    const resultW = textWidth(r.result ?? "", ROW_FS, 600);
    const avail = w - rowFixed - resultW;
    const wrap = wrapText(r.name, avail, ROW_FS, { maxLines: 2 });
    if (wrap.clipped) diag.warn(`signal row "${r.name.slice(0, 40)}…" on "${n.id}" clipped (full text kept as tooltip)`);
    return { ...r, lines: wrap.lines, clipped: wrap.clipped, rowH: 18 + 13 * (wrap.lines.length - 1), resultW };
  });

  const headerContentH = nameWrap.lines.length * 14 + (qualWrap ? qualWrap.lines.length * 11 : 0);
  const headerH = Math.max(34, headerContentH + 14);
  const h = rows.length
    ? headerH + 3 + 6 + rows.reduce((a, r) => a + r.rowH, 0) + 6
    : Math.max(58, headerContentH + 26);
  return { w, h, headerH, name, qualifier: qualifierRaw, nameWrap, qualWrap, statePillW, rows };
}

// ---------- geometry / routing ----------
// A single-channel tracked edge whose two risers (exitLo, entryU) land this close together carries
// only the anti-collinearity bump makeSlots adds (one pitch = 6px, below) — a redundant jog around
// the label row, not real horizontal travel — so it is drawn as one straight vertical. 8 = one
// pitch + rounding headroom, and stays strictly below two pitches (12px): 12 is the smallest gap
// that can hide an intervening vertical, so a delta ≥ 12 signals a genuine obstacle/offset and is
// left orthogonal. Coupled to makeSlots' pitch — revisit both together if that changes.
const STRAIGHT_SNAP_DX = 8;
const ROUTE_TRACK = 12;
const ROUTE_SLOT_PITCH = ROUTE_TRACK + 0.5;
// Two card centers this close are indistinguishable in any public/debug output (relaxation and
// its re-anchoring pass can leave ~1e-14-level float noise between centers a caller-facing check
// treats as equal); 1e-6 clears that noise by many orders of magnitude while staying far below
// any meaningful pixel distance, so it never masks a genuine positional difference. Exported so a
// caller-facing "visible order" check can apply the identical tolerance (see swimlane.test.mjs).
export const CENTER_TIE_EPS = 1e-6;

// True when a single-channel tracked edge's risers are near-aligned enough to collapse to one
// straight vertical at x = exitLo, AND that x still lands on the upper card ([uLo, uHi] = its slot
// range from nodeRange) so the straightened riser can't fall off the parent. Pure so the exact
// snap boundary can be exercised directly without contorting a diagram layout.
export function straightenTrackedX(exitLo, entryU, uLo, uHi) {
  return Math.abs(exitLo - entryU) <= STRAIGHT_SNAP_DX && exitLo >= uLo && exitLo <= uHi;
}

// One vertical-x registry per channel: every riser/trunk/stub in a channel draws from the same
// pool, so two verticals of different edges can never be collinear. Each caller stays inside its
// own card footprint via [lo, hi]. Exposes `used` (channel -> already-picked xs) so a lane-
// skipping corridor pick — which effectively shares a position with the channels immediately
// above and below the lane it crosses (see `corr()`) — can see and avoid them too.
function makeSlots() {
  const used = new Map(); // channel -> xs[]
  const pick = (chan, want, lo, hi, pitch = 6) => {
    if (!used.has(chan)) used.set(chan, []);
    const xs = used.get(chan);
    let x = Math.min(hi, Math.max(lo, want));
    for (let k = 0; k < 120; k++) {
      const step = Math.ceil(k / 2) * pitch * (k % 2 ? 1 : -1);
      const cand = Math.min(hi, Math.max(lo, x + step));
      if (xs.every((u) => Math.abs(u - cand) >= pitch - 0.5)) { xs.push(cand); return cand; }
    }
    xs.push(x); return x; // saturated: accept (cards are wide enough in practice)
  };
  return { pick, used };
}

function roundedOrtho(pts, r = 8) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const d1 = Math.hypot(p.x - a.x, p.y - a.y), d2 = Math.hypot(b.x - p.x, b.y - p.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const u1x = (p.x - a.x) / (d1 || 1), u1y = (p.y - a.y) / (d1 || 1);
    const u2x = (b.x - p.x) / (d2 || 1), u2y = (b.y - p.y) / (d2 || 1);
    d += ` L${(p.x - u1x * rr).toFixed(1)} ${(p.y - u1y * rr).toFixed(1)} Q${p.x.toFixed(1)} ${p.y.toFixed(1)} ${(p.x + u2x * rr).toFixed(1)} ${(p.y + u2y * rr).toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

function withoutCollinearPoints(pts) {
  return pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const a = pts[i - 1], b = pts[i + 1];
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}
// `trunk` (default null) tags a segment as part of an intentionally-shared bundle span (see
// C24/C29): the geometry verifier's collinearity checks treat two different edges' segments
// sharing the same non-null trunk id as a deliberate coincidence, not a violation.
const segsOf = (pts, edge, trunk = null) => {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    out.push({ x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y), kind: a.x === b.x ? "v" : "h", edge, trunk });
  }
  return out;
};

function laneLabels(L, custom) {
  if (Array.isArray(custom) && custom.length) {
    const out = custom.slice(0, L).map(String);
    while (out.length < L) out.push(`Layer ${out.length}`);
    return out;
  }
  if (L === 1) return ["Workload root"];
  if (L === 2) return ["Workload root", "Application components"];
  if (L === 3) return ["Workload root", "Business & user flows", "Application components"];
  const middle = ["Business & user flows", "Application components", "Dependencies", "Subsystems"];
  const out = ["Workload root"];
  for (let i = 0; i < L - 1; i++) out.push(middle[i] || `Layer ${i + 1}`);
  return out.slice(0, L);
}

// Heuristic used by the CLI's auto renderer selection.
export function looksLikeHealthModel(code) {
  const { body } = splitFrontmatter(code);
  if (!/^\s*(flowchart|graph)\s+BT\b/m.test(body)) return false;
  return /^\s*class\s+[^;]+\s+(blue|green|amber|red|purple)\s*;?\s*$/m.test(body);
}

// ---------- main render ----------
// opts: { theme, title, subtitle, lanes, legend, maxWidth, laneLabels, diag, baseLine, debug }
export function renderSwimlane(code, opts = {}) {
  const diag = opts.diag || new Diagnostics();
  const T = typeof opts.theme === "object" && opts.theme !== null ? opts.theme : getTheme(opts.theme);
  const { body, raw } = splitFrontmatter(code);
  const fmLines = raw ? raw.split("\n").length - 1 : 0;
  const g = parseGraph(body, { diag, lineOffset: (opts.baseLine || 0) + fmLines });
  if (g.nodes.size === 0) {
    const bad = diag.warnings.filter((w) => w.message.startsWith("unrecognized"));
    throw new Error(`no nodes parsed${bad.length ? ` — ${bad.length} unrecognized line(s), first at line ${bad[0].line}` : ""}`);
  }
  foldSignals(g, diag);
  const lay = layout(g, diag);
  const { laneNodes: logicalLaneNodes, L: logicalL, parents } = lay;

  // ----- measure cards -----
  const size = new Map();
  for (const [id, n] of g.nodes) size.set(id, measureNode(n, diag));
  diag.info(`graph: ${g.nodes.size} nodes, ${g.edges.length} edges, ${logicalL} lanes`);

  // ----- chrome (margins, lane-label gutter, title, legend) — hoisted ahead of packing: these
  // depend only on opts/theme/lane *count*, never on node content, positions, or routing, so the
  // final-width budget can be resolved (and any lane wrapped to fit it) before X/routing exist. -----
  const M = { left: 40, top: 78 };
  const laneLabelsOn = opts.laneLabels !== false;
  const labels = laneLabels(logicalL, opts.lanes);
  const labelWraps = labels.map((l) => wrapText(l, 150, 13, { weight: 600, maxLines: 3 }).lines);
  // With labels off, the reserved right-edge gutter shrinks to zero — that reclaimed width goes
  // straight into every row's packing budget below (C20) — while band fills/hairlines (painted
  // in the render loop further down) stay exactly as they are; only the label <text> itself and
  // its reserved width disappear.
  const gutterW = laneLabelsOn
    ? Math.max(120, ...labelWraps.map((ls) => Math.max(...ls.map((s) => textWidth(s, 13, 600))))) + 48
    : 0;
  const title = opts.title ?? "";
  const subtitle = opts.subtitle ?? "Signals live inside each entity; health rolls up to the workload root.";
  const legendOn = opts.legend !== false;
  const legendItems = [["Healthy", T.state.healthy.dot], ["Degraded", T.state.degraded.dot], ["Unhealthy", T.state.unhealthy.dot], ["Unknown", T.state.unknown.dot]];
  let legendW = textWidth("Legend", 11.5, 600) + 12;
  for (const [lbl] of legendItems) legendW += 26 + textWidth(lbl, 11.5);
  legendW += 22 + textWidth("Metric", 11.5);
  const subtitleW = textWidth(subtitle, 12);
  const headW = M.left + textWidth(title, 18, 700) + 24 + 40;

  // ----- resolve maxWidth: default 1024, or a valid positive-finite override; clamp up (with a
  // warning) when even that is below the diagram's own structural floor — chrome plus the widest
  // single node that can never be split further (C4's exception; a whole atomic group may still
  // exceed this floor without being infeasible, since it degrades to per-node placement). -----
  const widestSingleItem = Math.max(0, ...[...size.values()].map((s) => s.w));
  const minFeasibleW = Math.max(
    headW,
    M.left + 24 + gutterW + widestSingleItem,
    subtitleW + M.left + 40,
    legendOn ? M.left + legendW + 40 : 0,
  );
  let maxWidth = Number.isFinite(opts.maxWidth) && opts.maxWidth > 0 ? opts.maxWidth : DEFAULT_MAX_WIDTH;
  if (maxWidth < minFeasibleW) {
    diag.warn(`maxWidth ${maxWidth} is below the diagram's computed minimum feasible width (${Math.ceil(minFeasibleW)}px, from fixed chrome and the widest unavoidable content) — clamped up to ${Math.ceil(minFeasibleW)}px`);
    maxWidth = minFeasibleW;
  }
  // Row-budget floor: shrinking the budget below the single widest unavoidable card could never
  // reduce the final width further (that card would occupy its own row unsplit regardless, per
  // the C4 exception), so retries never probe below it.
  const rowBudgetFloor = Math.max(1, widestSingleItem);

  // ----- pack, position, route, and measure the final width — as a function of rowBudget so an
  // over-budget result (routing/corridor geometry can, rarely, extend a few px past the packed
  // card content — see the retry loop below) can be retried with a tighter budget instead of
  // silently exceeding maxWidth. -----
  function computeLayout(rowBudget) {
    // ----- wrap each logical lane into physical rows that fit the row budget, grouping by each
    // node's primary parent (first-declared edge) so sibling cards stay cohesive instead of
    // splitting arbitrarily. laneOrigin maps a physical row back to its source logical lane, so
    // rendering can still paint one continuous band/label per logical lane (see the render loop).
    const primaryParentOf = (id) => (parents.get(id) || [])[0];
    const laneNodes = [], laneOrigin = [];
    logicalLaneNodes.forEach((ids, logicalIdx) => {
      for (const row of packRows(ids, (id) => size.get(id).w, GAP, rowBudget, primaryParentOf)) {
        laneNodes.push(row);
        laneOrigin.push(logicalIdx);
      }
    });
    const L = laneNodes.length;
    const lane = new Map();
    laneNodes.forEach((arr, li) => arr.forEach((id) => lane.set(id, li)));

    // ----- x coordinates (variable widths, no overlap by construction) -----
    const widths = new Map([...size].map(([id, s]) => [id, s.w]));
    const neighbors = new Map();
    for (const id of g.nodes.keys()) neighbors.set(id, []);
    for (const e of g.edges) {
      if (e.from === e.to) continue;
      neighbors.get(e.from).push(e.to);
      neighbors.get(e.to).push(e.from);
    }
    const X = relaxCoordinates(laneNodes, widths, neighbors, GAP);

    // ----- re-anchor wrapped rows: relaxCoordinates pulls each row toward the average of its OWN
    // members' neighbors, so sibling rows split from the same original lane (grouped by different
    // primary parents) can drift to disjoint x-offsets even though each row's own internal content
    // stays tight (no per-row overflow). Left uncorrected, the canvas would need to span the union
    // of those disjoint offsets — silently busting the maxWidth bound this feature exists to
    // enforce. Force every physical row of one original lane to share a single content-width-
    // weighted centroid instead: each row's own tight internal arrangement (already guaranteed by
    // packRows + projectPositions' no-slack behavior) is untouched, only its rigid block position
    // shifts, so a wrapped lane's total horizontal footprint becomes its widest single row — never
    // the sum of independently-drifted rows. Lanes that did not wrap (their common, pre-existing
    // case) are left completely untouched: zero behavior change when nothing wrapped.
    const rowExtent = (ri) => {
      const row = laneNodes[ri];
      let lo = Infinity, hi = -Infinity;
      for (const id of row) { lo = Math.min(lo, X.get(id) - widths.get(id) / 2); hi = Math.max(hi, X.get(id) + widths.get(id) / 2); }
      return { lo, hi, w: hi - lo, centroid: (lo + hi) / 2 };
    };
    const rowsByOrigin = new Map();
    laneNodes.forEach((_, ri) => {
      const o = laneOrigin[ri];
      if (!rowsByOrigin.has(o)) rowsByOrigin.set(o, []);
      rowsByOrigin.get(o).push(ri);
    });
    for (const rowIdxs of rowsByOrigin.values()) {
      if (rowIdxs.length < 2) continue; // unwrapped lane: nothing to re-anchor
      let sumW = 0, sumWC = 0;
      const extents = rowIdxs.map(rowExtent);
      extents.forEach((ext) => { sumW += ext.w; sumWC += ext.w * ext.centroid; });
      const target = sumW ? sumWC / sumW : 0;
      rowIdxs.forEach((ri, k) => {
        const shift = target - extents[k].centroid;
        for (const id of laneNodes[ri]) X.set(id, X.get(id) + shift);
      });
    }

    // ----- classify edges -----
    const bundlesByParent = new Map(); // parentId -> [edge]
    const tracked = [];                // { e, u, l, sameLane, reverse, pill }
    for (const e of g.edges) {
      if (e.from === e.to) { diag.warn(`self-loop on "${e.from}" is not drawn`, { line: e.line }); continue; }
      const lu = lane.get(e.to), ll = lane.get(e.from);
      if (lu === ll) {
        diag.warn(`edge ${e.from} → ${e.to} connects nodes in the same lane — routed over the top of the lane`, { line: e.line });
        tracked.push({ e, u: lu, l: ll, sameLane: true, pill: !!e.label });
      } else if (lu > ll) {
        diag.warn(`edge ${e.from} → ${e.to} points downward (child sits above its parent) — drawn bottom-up`, { line: e.line });
        tracked.push({ e, u: ll, l: lu, reverse: true, pill: !!e.label });
      } else if (!e.label && !e.dashed) {
        // Bundle-eligible at ANY physical-row distance (generalizes the old ll-lu===1-only
        // gate, C24): every solid, unlabeled, upward edge sharing a target groups here,
        // regardless of how many physical rows separate it from that target.
        if (!bundlesByParent.has(e.to)) bundlesByParent.set(e.to, []);
        bundlesByParent.get(e.to).push(e);
      } else {
        // Dashed and/or labelled edges always stay individually tracked (C25) — this branch
        // now catches exactly that set, since every clean upward edge is bundle-eligible above.
        tracked.push({ e, u: lu, l: ll, pill: !!e.label });
      }
    }
    for (const [pid, es] of bundlesByParent) {
      if (es.length > 1) continue;
      bundlesByParent.delete(pid);
      const [e] = es;
      tracked.push({ e, u: lane.get(e.to), l: lane.get(e.from), pill: false });
    }
    const edgesPerChild = new Map();
    for (const e of g.edges) {
      if (e.from === e.to) continue;
      edgesPerChild.set(e.from, (edgesPerChild.get(e.from) || 0) + 1);
    }
    const pillPitchByChild = new Map();
    for (const t of tracked) {
      if (!t.pill) continue;
      let wrap = wrapText(t.e.label, 170, PILL_FS, { weight: 600, maxLines: 2 });
      if (wrap.clipped) wrap = wrapText(t.e.label, 280, PILL_FS, { weight: 600, maxLines: 2 });
      if (wrap.clipped) diag.warn(`edge label "${t.e.label.slice(0, 40)}…" is too long even wrapped — clipped (full text kept as tooltip)`);
      t.pillLines = wrap.lines;
      t.pillClipped = wrap.clipped;
      t.pillW = Math.max(...wrap.lines.map((l) => textWidth(l, PILL_FS, 600))) + 20;
      t.pillH = wrap.lines.length === 1 ? 20 : 33;
      const siblingClearance = 4;
      pillPitchByChild.set(t.e.from, Math.max(pillPitchByChild.get(t.e.from) || 0, t.pillW / 2 + siblingClearance));
    }

    // ----- corridor + slot planning (x only; ys come after channel heights are known) -----
    const cardsInLane = (j) => laneNodes[j].map((id) => ({ id, x: X.get(id) - size.get(id).w / 2, w: size.get(id).w }));
    const corridorCache = new Map();
    const corridorTaken = new Map(); // lane -> xs
    const { pick: slots, used: slotsUsed } = makeSlots();
    const useWideCorridors = tracked.filter((t) => t.pill).length <= 8;
    const claimSlot = (chan, x) => { if (!slotsUsed.has(chan)) slotsUsed.set(chan, []); slotsUsed.get(chan).push(x); };
    // A lane-j corridor pick doubles as channel (j-1)'s "xBelow" and channel j's "xAbove" (see the
    // channel-building loop below) — it shares those channels' vertical-x registries, not just its
    // own lane's. Seed its avoidance list with whatever those two channels have already claimed, and
    // claim its own pick back into both, so a later entry/exit slot in either channel avoids it too.
    // Bidirectional: without this, a corridor crossing and an unrelated entry/exit riser could each
    // be picked unaware of the other and land collinear.
    const corr = (j, want) => {
      if (!corridorCache.has(j)) corridorCache.set(j, corridorsOf(cardsInLane(j)));
      if (!corridorTaken.has(j)) corridorTaken.set(j, []);
      const taken = [...corridorTaken.get(j), ...(slotsUsed.get(j - 1) || []), ...(slotsUsed.get(j) || [])];
      const corridors = corridorCache.get(j);
      // A busy shared boundary (many lane-skippers converging on one "wanted" x) can exhaust both
      // the wide and default pitches against the full cross-channel ledger. Rather than fall back to
      // an unguarded raw `want` — which can land squarely inside lane j's own card — retry once more
      // at a tighter pitch against the SAME full `taken` set (never dropping the cross-channel
      // collinearity guard, only packing closer) before giving up. This tier still guarantees a real
      // corridor slot with at least `spacing` clearance from every existing pick, so distinctness
      // (still > the verifier's 1.5px collinearity tolerance) is never sacrificed, only tightness
      // (already user-permitted below the nominal 12.5px pitch) (C4-R1). A still-tighter (`1.6px`)
      // fourth tier was tried alongside this one when the corridor-exhaustion defect was first fixed,
      // but is unreachable in the accepted corpus — this `3px` tier alone already resolves every
      // committed corridor-exhaustion case (confirmed live: zero fallthroughs to a fourth tier across
      // the full public test suite, sweep included) — so it was removed rather than shipped untested
      // (C5-R3).
      const x = (useWideCorridors ? pickCorridorX(corridors, want, taken, { spacing: ROUTE_TRACK }) : null) ??
        pickCorridorX(corridors, want, taken) ??
        pickCorridorX(corridors, want, taken, { spacing: 3 });
      if (x == null) return want; // no corridor: fall back (verifier will flag if it matters)
      corridorTaken.get(j).push(x);
      claimSlot(j - 1, x); claimSlot(j, x);
      return x;
    };
    const nodeRange = (id) => { const s = size.get(id); return [X.get(id) - s.w / 2 + 12, X.get(id) + s.w / 2 - 12]; };
    const topSlot = (chan, id, want, pitch = ROUTE_SLOT_PITCH) => { const [lo, hi] = nodeRange(id); return slots(chan, want, lo, hi, pitch); };
    const botSlot = (chan, id, want, pitch = ROUTE_SLOT_PITCH) => { const [lo, hi] = nodeRange(id); return slots(chan, want, lo, hi, pitch); };
    for (const t of tracked) {
      const [uNode, loNode] = t.sameLane
        ? [t.e.to, t.e.from]
        : (t.reverse ? [t.e.from, t.e.to] : [t.e.to, t.e.from]);
      t.uNode = uNode; t.loNode = loNode;
      t.chan = t.sameLane ? t.u - 1 : t.u;
      t.pillChan = t.sameLane ? t.chan : t.l - 1;
    }

    // Claims into a shared per-channel/per-lane ledger (exit slots, corridor picks) must not
    // depend on source-declaration order: whichever edge is processed first wins its exact
    // "wanted" spot, and later edges sharing that ledger get bumped outward from it — inverting
    // visible left-to-right order whenever source order doesn't already match visible order
    // (C-R1). Every claim below (pill-preloop, corridor chain, exit slots) therefore iterates
    // `claimOrder` — farthest-from-parent-center first, the same rule the entry-side sort uses
    // below, so exit/corridor priority agrees with entry priority — tie-broken by physical lane
    // then authored edge index. A raw (unresolved) child/parent interpolation is fine here since
    // this only decides claim *priority*, never a final position.
    const rawEntryWant = (t) => {
      const locx = X.get(t.loNode);
      if (t.sameLane || t.l === t.u + 1) return locx;
      const ucx = X.get(t.uNode);
      const frac = (t.l - (t.u + 1)) / (t.l - t.u);
      return locx + (ucx - locx) * frac;
    };
    const claimOrder = tracked
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const da = Math.abs(rawEntryWant(a.t) - X.get(a.t.uNode));
        const db = Math.abs(rawEntryWant(b.t) - X.get(b.t.uNode));
        if (db !== da) return db - da;
        if (a.t.l !== b.t.l) return a.t.l - b.t.l;
        return a.i - b.i;
      })
      .map(({ t }) => t);

    for (const t of claimOrder) {
      if (!useWideCorridors || !t.pill || t.sameLane) continue;
      const { uNode, loNode } = t;
      const ucx = X.get(uNode), locx = X.get(loNode), loW = size.get(loNode).w;
      const spread = edgesPerChild.get(loNode) > 1
        ? locx + Math.sign(ucx - locx) * Math.min(Math.abs(ucx - locx), loW / 2 - 14)
        : locx;
      const [exLo, exHi] = nodeRange(loNode);
      t.exitLo = slots(t.l - 1, spread, exLo, exHi, Math.max(ROUTE_SLOT_PITCH, t.pillW / 2 + 8));
    }

    // bundles first (they own the space right under their parent) — generalized to ANY
    // physical-row distance (C24). A group targeting `pid` rides one shared per-lane "spine":
    // for every strictly-intermediate lane it skips over, one position validated against THAT
    // lane's own cards (chained from the deepest lane up toward the parent so consecutive
    // positions stay close, jogging only where two lanes genuinely disagree — a single constant
    // x cannot be assumed valid everywhere, since different intermediate lanes hold different
    // cards). When every member is directly adjacent (today's original shape, no intermediate
    // lane at all), the trunk is simply centered under the parent, exactly as before. One shared
    // pick per (group, lane) — not one per member — genuine geometric coincidence, and fewer
    // total corridor picks than today's per-edge scheme (C32). Each member's own short branch
    // stub joins the spine at ITS OWN row (its "peel channel", `ll-1`); everything from the join
    // point up to the parent is the same for every member that reaches that far.
    const bundlePlans = [];
    const fitsFootprint = (cx, cw, x) => x >= cx - cw / 2 + 12 && x <= cx + cw / 2 - 12;
    for (const [pid, es] of bundlesByParent) {
      const lu = lane.get(pid);
      const pcx = X.get(pid), pw = size.get(pid).w;
      const kids = es.map((e) => ({ e, cx: X.get(e.from), cw: size.get(e.from).w, ll: lane.get(e.from) }))
        .sort((a, b) => a.cx - b.cx);
      const maxLl = Math.max(...kids.map((k) => k.ll));
      const spine = new Map(); // lane index (lu+1..maxLl-1) -> validated x, deepest-first
      let want = pcx;
      for (let j = maxLl - 1; j >= lu + 1; j--) { want = corr(j, want); spine.set(j, want); }
      const trunkX = spine.has(lu + 1) ? spine.get(lu + 1) : slots(lu, pcx, pcx - pw / 2 + 12, pcx + pw / 2 - 12, ROUTE_SLOT_PITCH);
      const groupStraight = fitsFootprint(pcx, pw, trunkX);
      const entryX = groupStraight ? trunkX : botSlot(lu, pid, trunkX);
      kids.forEach((k, index) => {
        k.peelChan = k.ll - 1;
        k.joinX = spine.has(k.peelChan) ? spine.get(k.peelChan) : trunkX;
        const delta = k.cx - k.joinX;
        const side = Math.abs(delta) > 0.01 ? Math.sign(delta) : (index % 2 ? 1 : -1);
        const wantedStub = Math.abs(delta) >= ROUTE_TRACK ? k.cx : k.joinX + side * ROUTE_TRACK;
        const stubPitch = Math.max(ROUTE_SLOT_PITCH, pillPitchByChild.get(k.e.from) || 0);
        k.stubX = topSlot(k.peelChan, k.e.from, wantedStub, stubPitch);
        k.ownStraight = false;
      });
      // One shared jog per lane boundary where the spine genuinely bends (deliberately keyed
      // by channel, not by member — every kid whose own row reaches this deep draws the exact
      // same jog, by construction), so it can take part in the SAME channel-level assignment
      // (below) as everything else that channel holds — including an unrelated sibling's own
      // branch, whose fixed "+6" landing offset could otherwise coincidentally collide with it.
      const jogs = new Map(); // channel (j-1) -> { here, up }
      for (let j = maxLl - 1; j >= lu + 2; j--) {
        const here = spine.get(j), up = spine.get(j - 1);
        if (Math.abs(up - here) > 0.01) jogs.set(j - 1, { here, up });
      }
      bundlePlans.push({ pid, lu, kids, spine, jogs, trunkX, groupStraight, entryX });
    }

    // tracked edges: corridor chain bottom-up, then entry/exit slots.
    // A child with several outgoing edges (tracked OR bundled — a bundle stub is just as much a
    // "sibling riser" a wide pill could hug/cross) spreads its exits toward each edge's parent, so
    // sibling risers don't hug each other (a wide pill would otherwise cover its sibling's line).
    const trackedPerChild = edgesPerChild;
    for (const t of claimOrder) {
      const { uNode, loNode } = t;
      // This exit slot's pitch is intentionally the pre-existing bare `6`, not `ROUTE_SLOT_PITCH`
      // (12.5) — a prior attempt widened it to close a suspected unowned-T-junction defect at a
      // parent boundary, but independent inspection found zero exact unowned junctions in either
      // variant: widening bought nothing here and cost 7 new crossings / +557px on `pill-flood`
      // alone (C-R2's no-new-crossings requirement). The actual junction risk is guarded directly
      // by `findUnownedJunctions()` (test/helpers/geo.mjs) and the C-R4 regression test below,
      // not by a numeric spacing proxy on this exit floor.
      const exitPitch = t.pill && edgesPerChild.get(loNode) > 1 ? Math.max(6, t.pillW / 2 + 8) : 6;
      if (t.sameLane) {
        t.exitLo = topSlot(t.chan, loNode, X.get(uNode));
        t.exitU = topSlot(t.chan, uNode, X.get(loNode));
        t.channels = [{ g: t.chan, xBelow: t.exitLo, xAbove: t.exitU }];
      } else {
        const ucx = X.get(uNode), locx = X.get(loNode);
        t.corr = {}; // laneIdx -> x
        for (let j = t.l - 1; j > t.u; j--) {
          const frac = (t.l - j) / (t.l - t.u);
          const want = locx + (ucx - locx) * frac;
          t.corr[j] = corr(j, want);
        }
        // Exit at the child's own center when it has a single outgoing edge (keeps risers spread
        // out across children); when the child has several, pull each exit toward its parent so
        // sibling risers separate. Lane-skippers aim at their first corridor.
        const loW = size.get(loNode).w;
        const spread = trackedPerChild.get(loNode) > 1
          ? locx + Math.sign(ucx - locx) * Math.min(Math.abs(ucx - locx), loW / 2 - 14)
          : locx;
        const [exLo, exHi] = nodeRange(loNode);
        t.exitLo ??= slots(t.l - 1, t.corr[t.l - 1] ?? spread, exLo, exHi, exitPitch);
      }
    }

    // Entry-slot claims into a shared parent must be solved per (channel, parent) GROUP all at
    // once, not one edge at a time in some priority order: a sequential greedy claim — whoever is
    // processed first wins their exact "wanted" spot outright, and every later claimant reacts to
    // whatever already landed — can strand a later-processed claimant on the wrong side of an
    // earlier one's now-fixed position even though each individual claim looks locally valid
    // (confirmed live: a far-boundary-clamped child needed to fit between that boundary and an
    // unrelated sibling's own untouched center — only one channel-pitch apart — and got shoved
    // PAST that sibling instead, since the sibling's position was already "claimed" territory the
    // clamped child's independent search had no choice but to route around, even though the
    // sibling itself sits farther from the boundary and hadn't even taken its own entry turn yet;
    // ordering claims by distance-from-center, tried first, only rearranges WHICH edge hits this
    // failure mode, it can't remove it, because the failure is inherent to resolving claims one at
    // a time against whatever partial state happens to exist so far).
    // Solve each group as a whole instead: sort by natural entry position (clamped into the
    // parent's own range; ties broken by physical lane then authored edge index) to fix the
    // REQUIRED left-to-right order, then run one monotonic-separation pass across every member at
    // once — forward to enforce the minimum pitch, backward from the far edge if that overflows
    // the parent's own range — so a member's final position reflects every OTHER member's
    // presence simultaneously, not just whichever claim happened to be resolved first. Untouched
    // (uncontested) members keep their exact clamped want verbatim, including a passthrough
    // member whose own exit position already sits inside the parent's range: with no sibling
    // close enough to force a move, the forward pass is a no-op for it, and it lands exactly on
    // its own exit x — the unobstructed straight-vertical case stays intact.
    // For a lane-skipping edge, the natural position at the entry lane is not its own (several-
    // rows-away) card center but the same lo→hi interpolation the corridor loop above uses to seed
    // that lane's want (the `frac` at j = t.u+1): comparing a directly-adjacent sibling's own
    // center against a distant sibling's pre-bend card center mixes two different quantities and
    // can invert the very order this fix exists to correct (confirmed live: once `maxWidth`
    // wrapping turns one flat row of children into several lane-skipping rows, ranking a wrapped
    // row's members by raw cx inverts a near-center pair against a farther, differently-skipped
    // sibling). For a lane-skipper this must be the corridor loop's *resolved* corr[t.u+1] (post
    // pickCorridorX/obstacle-avoidance), not a fresh naive interpolation recomputed here — a
    // second, unresolved interpolation can rank two lane-skippers by a value neither of them will
    // actually land on, inverting order even though the resolved corridors themselves are already
    // monotone. Same-lane edges use a different, untouched slotting path (topSlot, above) and are
    // excluded.
    const naturalEntryWant = (t) => t.corr[t.u + 1] ?? X.get(t.loNode);
    const entryGroups = new Map(); // "chan|uNode" -> [t, ...] sharing one parent's entry channel
    for (const t of tracked) {
      if (t.sameLane) continue;
      const key = `${t.u}|${t.uNode}`;
      if (!entryGroups.has(key)) entryGroups.set(key, []);
      entryGroups.get(key).push(t);
    }
    for (const members of entryGroups.values()) {
      const chan = members[0].u;
      const [lo, hi] = nodeRange(members[0].uNode);
      const pitch = ROUTE_SLOT_PITCH;
      // A group's own directly-adjacent members already sit in this exact channel's ledger under
      // their OWN exitLo (exit channel `t.l-1` and entry channel `t.u` numerically collapse for a
      // single-hop edge) — those are not foreign obstacles, they're this member's own claim and
      // must not block its own entry want. A lane-skipper's own resolved corridor pick at
      // `j = t.u+1` is the exact same quantity as its own `naturalEntryWant(t)` below, and `corr()`
      // registers that pick into this same channel's ledger too (it claims both `chan=j-1` and
      // `chan=j` so the corridor and the entry it feeds land on the same x) — so a lane-skipper's
      // own natural want must be excluded here for the identical reason a direct hop's exitLo is:
      // it is this member's own already-committed claim, not a foreign one (confirmed live: a
      // lane-skipper's own want was appearing verbatim in its own group's obstacle list, forcing an
      // unnecessary self-push that a direct hop would never suffer). Anything else already in the
      // ledger for this channel is a genuinely unrelated, already-committed claim (typically a
      // bundle trunk centered under the same parent, or a different lane-skipper's corridor pick
      // through an intermediate lane that happens to coincide with this parent's entry channel) and
      // must be treated as a fixed wall the group routes around, not smoothed over (confirmed live:
      // a lane-skip corridor and a directly-adjacent sibling's own entry landed collinear at the
      // same x once the group ignored it). A member's own claim can coincide, in value, with a
      // genuinely foreign claim (a bundle trunk centered on the very same parent center a direct
      // child also wants) — removing by value with a Set would then discard the real, still-
      // unaccounted-for obstacle too. Remove by count instead: each member's own claim cancels
      // exactly one matching ledger entry, so a coincidentally-identical foreign claim beyond that
      // count still survives as fixed (confirmed live: a bundle trunk landed exactly on an unrelated
      // tracked child's own natural center).
      const ownExitLoCount = new Map();
      for (const t of members) {
        const ownX = t.l === t.u + 1 ? t.exitLo : naturalEntryWant(t);
        ownExitLoCount.set(ownX, (ownExitLoCount.get(ownX) || 0) + 1);
      }
      const remaining = new Map(ownExitLoCount);
      const fixed = [...new Set((slotsUsed.get(chan) || []).filter((x) => {
        if ((remaining.get(x) || 0) > 0) { remaining.set(x, remaining.get(x) - 1); return false; }
        return true;
      }))];
      // The REQUIRED final sequence is each member's own visible card-center order (mirroring the
      // caller-facing definition of "visible order" exactly: card center, then physical lane, then
      // authored index) — not the corridor-resolved `want` used below as each member's preferred
      // target. A degenerate wrap can hand several lane-skippers the exact same raw card center
      // (every one of them relaxed onto its own solo row at an identical reflow x); their corridor
      // `want`s at the shared entry-adjacent lane are then whatever a separate, per-edge corridor
      // search happened to land on, and that search's own resolution order has no obligation to
      // agree with physical-lane order — so ranking this group by `want` can walk the members in
      // the wrong sequence entirely (confirmed live: distances-from-center for six such lane-skip
      // wants were genuinely too close to break ties meaningfully, and ranking by that
      // near-arbitrary order inverted every one of them against physical lane). Ranking by visible
      // order first and treating `want` only as a per-member preference — never the sequence
      // itself — guarantees the assigned positions land monotonically in the one order that
      // actually matters, regardless of how scattered the underlying corridor wants are.
      // Centers must be compared with CENTER_TIE_EPS, not bitwise: two members can carry the exact
      // same PUBLIC card center while relaxation's raw output for them differs by float noise many
      // orders of magnitude below any meaningful pixel distance — an exact `a.cx - b.cx` would let
      // that noise silently decide the order instead of falling through to lane/index (confirmed
      // live: a tie at one shared public center, split across three different skip-depths, walked
      // out of lane order because raw noise between two of them broke the tie before lane could).
      const ordered = members
        .map((t, i) => ({ t, i, cx: X.get(t.loNode), want: Math.min(hi, Math.max(lo, naturalEntryWant(t))) }))
        .sort((a, b) => (Math.abs(a.cx - b.cx) < CENTER_TIE_EPS ? 0 : a.cx - b.cx) || a.t.l - b.t.l || a.i - b.i);
      const final = ordered.map((o) => o.want);
      // Push `final[i]` past every fixed obstacle within one pitch, walking outward (`dir`) until
      // clear of all of them — bounded, since each push strictly increases (dir=+1) or decreases
      // (dir=-1) the candidate and there are finitely many fixed obstacles to clear.
      const pushPastFixed = (i, dir) => {
        for (let guard = 0, moved = true; moved && guard <= fixed.length; guard++) {
          moved = false;
          for (const f of fixed) if (Math.abs(final[i] - f) < pitch - 1e-6) { final[i] = f + dir * pitch; moved = true; }
        }
      };
      for (let i = 0; i < final.length; i++) {
        if (i) final[i] = Math.max(final[i], final[i - 1] + pitch);
        pushPastFixed(i, 1);
      }
      if (final.length && final[final.length - 1] > hi) {
        final[final.length - 1] = hi;
        pushPastFixed(final.length - 1, -1);
        for (let i = final.length - 2; i >= 0; i--) {
          final[i] = Math.min(final[i], final[i + 1] - pitch);
          pushPastFixed(i, -1);
        }
      }
      ordered.forEach((o, idx) => { o.t.entryU = final[idx]; claimSlot(chan, final[idx]); });
    }
    // A lane-skipper's own resolved corridor pick at `j = t.u+1` (`naturalEntryWant(t)` above, i.e.
    // `t.corr[t.u+1]`) is a real, independently-rendered channel-crossing riser one lane below its
    // own entry channel, and it stays exactly where `corr()` placed it regardless of where the
    // entry-ordering pass above ultimately landed that same member's own `entryU` (its own preferred
    // position can be pushed elsewhere entirely by that pass's visible-order spacing or hi-clamp
    // fixup). When `entryU` diverges from that pick, the pick is abandoned but still drawn — nothing
    // above accounts for it as an obstacle for the rest of the group, so a differently-skipped
    // sibling's own entryU can land within the verifier's collinearity tolerance of it (confirmed
    // live: always <1.5px, never exact — C5-R1). Folding the pick into the shared `fixed` obstacle
    // list above (tried first) pushes siblings a full pitch away from it — the same clearance owed
    // to a genuinely foreign trunk — which perturbs fixtures that never had this defect (confirmed
    // live: pills-stress-test's own crossings, and the aggregate crossing count, both changed with
    // no collinear-overlap defect of their own). The actual defect is only ever a near-miss just
    // under the verifier's 1.5px tolerance, so the smallest correct repair nudges only the colliding
    // sibling, only far enough to clear that tolerance with a small margin — not a full pitch. 1.6 is
    // that margin: the verifier's own collinear-overlap band is strictly <1.5px, so 1.6 is the
    // smallest round value that clears it with headroom, independent of any fixture's own content
    // (C6 — a full pitch of 12.5 was tried first and, though it also fixed all seven overlaps, it
    // changed pills-stress-test's own crossings and breached per-fixture Manhattan-length ratchets
    // (the aggregate ≤194 gate itself stayed at 194 either way — C2-R2's gate is a sum, not a per-
    // fixture ceiling) on a fixture with no overlap defect of its own — confirming the fix must be
    // as small as possible, not merely "past the threshold"). The pick's `owner` is recorded and
    // excluded below: an edge's own abandoned pick can never collide with itself in the verifier
    // (same-edge segment pairs are excluded from the collinear-overlap check), so nudging an edge
    // away from its own abandoned pick has no verifier benefit and only risks new displacement —
    // confirmed live: it fired nine times over the committed sweep, and at larger fan-in (n=15/16)
    // that self-displacement alone produced two new collinear overlaps with zero sibling nudges
    // involved (C6-R1).
    const COLLINEAR_CLEAR = 1.6;
    const abandonedLaneSkipPicks = tracked
      .filter((t) => !t.sameLane && t.l !== t.u + 1 && t.corr[t.u + 1] != null && Math.abs(t.entryU - t.corr[t.u + 1]) > 1e-6)
      .map((t) => ({ chan: t.u, x: t.corr[t.u + 1], owner: t }));
    // A single forward pass over `abandonedLaneSkipPicks` can clear an earlier pick and land back
    // within `COLLINEAR_CLEAR` of it while clearing a later one — the two picks can sit closer
    // together than `2 * COLLINEAR_CLEAR`, so no point between them clears both, and re-checking
    // already-cleared picks with a freshly recomputed sign just oscillates (confirmed live: C7 — a
    // 14-sibling fan-in where two abandoned picks 3px apart left an empty clearance window).
    // `pushPastFixed` above avoids exactly this by committing to one direction for an entire
    // clearing operation and only ever moving further that way, so a pick once cleared stays
    // cleared; re-scanning the full list is then bounded by its length, never open-ended. The same
    // approach applies here: pick `dir` once, from the first real conflict in scan order, then walk
    // every applicable pick in that fixed direction until a full pass clears them all.
    for (const t of tracked) {
      if (t.sameLane) continue;
      const applicable = abandonedLaneSkipPicks.filter((p) => p.chan === t.u && p.owner !== t);
      let dir = null;
      for (let guard = 0, moved = true; moved && guard <= applicable.length; guard++) {
        moved = false;
        for (const p of applicable) {
          const d = t.entryU - p.x;
          if (Math.abs(d) < COLLINEAR_CLEAR) {
            dir ??= Math.sign(d || 1);
            t.entryU = p.x + dir * COLLINEAR_CLEAR;
            moved = true;
          }
        }
      }
    }
    for (const t of tracked) {
      if (t.sameLane) continue;
      t.channels = [];
      for (let gph = t.u; gph <= t.l - 1; gph++) {
        const xAbove = gph === t.u ? t.entryU : t.corr[gph];
        const xBelow = gph === t.l - 1 ? t.exitLo : t.corr[gph + 1];
        t.channels.push({ g: gph, xBelow, xAbove });
      }
    }

    // ----- per-channel structure: bus levels (bundles) + track rows (tracked edges) -----
    const chanIdx = new Set();
    for (const t of tracked) t.channels.forEach((c) => chanIdx.add(c.g));
    for (const b of bundlePlans) {
      chanIdx.add(b.lu);
      for (const k of b.kids) chanIdx.add(k.peelChan);
      for (const gph of b.jogs.keys()) chanIdx.add(gph);
    }
    const chans = new Map(); // g -> { busLevels, items, rows, h }
    for (const gph of chanIdx) chans.set(gph, { busLevels: 0, items: [] });

    // side-bus horizontals are interval-colored ACROSS parents so buses of different parents
    // sharing a y can never overlap collinearly. Three flavors now share this mechanism: a
    // member's own peel-off jog (in ITS OWN channel, `k.peelChan` — may be several channels
    // below the parent for a multi-row skip), a group's shared spine jog at an intermediate
    // lane boundary (one item per GROUP per boundary, not per member — every member deep enough
    // to reach it rides the identical jog), and the group's single shared jog into the parent
    // (in channel `b.lu`). Assigning all three through the same per-channel level pool is what
    // keeps an unrelated sibling's own branch from coincidentally landing at the same fixed
    // offset as a passing group's spine jog in that same channel.
    for (const gph of chanIdx) {
      const busItems = [];
      for (const b of bundlePlans) {
        for (const k of b.kids) {
          if (k.peelChan !== gph) continue;
          busItems.push({ target: k, prop: "ownBusLevel", order: 1, xL: Math.min(k.stubX, k.joinX) - 4, xR: Math.max(k.stubX, k.joinX) + 4 });
        }
        if (b.jogs.has(gph)) {
          const j = b.jogs.get(gph);
          busItems.push({ target: j, prop: "level", order: 0, xL: Math.min(j.here, j.up) - 4, xR: Math.max(j.here, j.up) + 4 });
        }
        if (!b.groupStraight && b.lu === gph)
          busItems.push({ target: b, prop: "groupBusLevel", order: -1, xL: Math.min(b.trunkX, b.entryX) - 4, xR: Math.max(b.trunkX, b.entryX) + 4 });
      }
      if (busItems.length) {
        const { levelOf, count } = assignTracks(busItems.map((it, i) => ({ id: i, xL: it.xL, xR: it.xR, order: it.order })));
        busItems.forEach((it, i) => { it.target[it.prop] = levelOf.get(i); });
        chans.get(gph).busLevels = count;
      }
    }

    for (const t of tracked) {
      for (const c of t.channels) {
        const isPill = t.pill && c.g === t.pillChan;
        // pill pad covers the slide overhang (pw/2−6 past either segment end) plus margin
        const pad = isPill ? Math.max(16, t.pillW - 6) : 6;
        chans.get(c.g).items.push({
          t, cRef: c,
          xL: Math.min(c.xBelow, c.xAbove) - pad,
          xR: Math.max(c.xBelow, c.xAbove) + pad,
          pill: isPill,
          span: Math.abs(c.xAbove - c.xBelow),
        });
      }
    }
    for (const [, c] of chans) {
      const uniq = c.items.map((it, i) => ({ id: i, xL: it.xL, xR: it.xR, pill: it.pill, order: -it.span }));
      const { levelOf, count, pillLevels, plainLevels } = assignTracks(uniq);
      c.plainLevels = plainLevels;
      uniq.forEach((u, i) => { c.items[i].level = levelOf.get(u.id); });
      c.rows = [];
      for (let i = 0; i < count; i++) {
        const isPillRow = i >= count - pillLevels;
        // pill rows grow to fit their tallest (possibly two-line) pill
        const tallest = Math.max(20, ...c.items.filter((it) => it.level === i && it.pill).map((it) => it.t.pillH || 20));
        c.rows.push({ h: isPillRow ? tallest + 7 : 12 });
      }
      const busH = c.busLevels ? c.busLevels * ROUTE_TRACK : (count ? 6 : 0);
      c.busH = busH;
      c.h = busH + c.rows.reduce((a, r) => a + r.h, 0) + (count || c.busLevels ? 10 : 0);
    }
    const chanH = (gph) => chans.get(gph)?.h || 0;

    // ----- vertical stacking -----
    const laneMaxH = laneNodes.map((arr) => Math.max(58, ...arr.map((id) => size.get(id).h)));
    const laneTop = [], laneBandH = [];
    let cursorY = M.top + chanH(-1) + (chanH(-1) ? 6 : 0);
    for (let i = 0; i < L; i++) {
      laneTop.push(cursorY);
      const bodyH = TOPPAD + laneMaxH[i] + 14;
      laneBandH.push(bodyH + chanH(i));
      cursorY += bodyH + chanH(i);
    }
    const totalH = cursorY + 18;
    const chanTop = (gph) => (gph === -1 ? M.top : laneTop[gph] + TOPPAD + laneMaxH[gph] + 14);
    const rowY = (gph, level) => {
      const c = chans.get(gph);
      let y = chanTop(gph) + (c.busH || 6);
      for (let i = 0; i < level; i++) y += c.rows[i].h;
      return y + c.rows[level].h / 2;
    };

    // card boxes
    const box = new Map();
    for (const [id, s] of size) {
      const li = lane.get(id);
      const x = X.get(id) - s.w / 2, y = laneTop[li] + TOPPAD;
      box.set(id, { x, y, w: s.w, h: s.h, cx: X.get(id), top: y, bottom: y + s.h });
    }

    // ----- vertical bookkeeping (recomputable: crossings depend on row assignment) -----
    const gEnd = (gph, side) => (side === "below" ? chanTop(gph) + chanH(gph) : chanTop(gph));
    const itemFor = (t, c) => chans.get(c.g).items.find((it) => it.t === t && it.cRef === c);

    // Shared per-(group,member) path geometry. Every member first leaves its source on a distinct
    // state-colored branch, even when the card is aligned with the eventual spine. Above that
    // branch, members ride the group's per-lane spine toward the parent.
    function bundleGeom(b, k) {
      const pb = box.get(b.pid), cb = box.get(k.e.from);
      const finalY = b.groupStraight ? pb.bottom : chanTop(b.lu) + 6 + (b.groupBusLevel || 0) * ROUTE_TRACK;
      let branchPts = [];
      const trunkPts = [];
      const ownBusY = chanTop(k.peelChan) + 6 + (k.ownBusLevel || 0) * ROUTE_TRACK;
      branchPts = [{ x: k.stubX, y: cb.top }, { x: k.stubX, y: ownBusY }, { x: k.joinX, y: ownBusY }];
      trunkPts.push({ x: k.joinX, y: ownBusY });
      for (let j = k.peelChan; j >= b.lu + 2; j--) {
        const chan = j - 1;
        if (!b.jogs.has(chan)) continue;
        const jog = b.jogs.get(chan);
        const y = chanTop(chan) + 6 + (jog.level || 0) * ROUTE_TRACK;
        trunkPts.push({ x: jog.here, y }, { x: jog.up, y });
      }
      trunkPts.push({ x: b.trunkX, y: finalY });
      if (!b.groupStraight) trunkPts.push({ x: b.entryX, y: finalY }, { x: b.entryX, y: pb.bottom });
      const dedupe = (pts) => pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
      return { branchPts: dedupe(branchPts), trunkPts: dedupe(trunkPts) };
    }

    // Canonicalize the shared topology at every member junction. A geometrically coincident span
    // is tagged/drawn as neutral trunk ink only when at least two relationships use the exact same
    // canonical segment; unique approach spans remain part of that source's colored branch.
    const bundlePieces = new Map();
    const pointOn = (p, a, b) =>
      a.x === b.x
        ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
        : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
    const splitAt = (pts, cuts) => {
      if (pts.length < 2) return pts;
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const between = cuts.filter((p) =>
          pointOn(p, a, b) &&
          !(p.x === a.x && p.y === a.y) &&
          !(p.x === b.x && p.y === b.y)
        ).sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
        for (const p of between)
          if (p.x !== out[out.length - 1].x || p.y !== out[out.length - 1].y) out.push(p);
        out.push(b);
      }
      return out;
    };
    const canonicalKey = (a, b) => {
      const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
      const x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
      return `${a.x === b.x ? "v" : "h"}|${x1.toFixed(4)},${y1.toFixed(4)}→${x2.toFixed(4)},${y2.toFixed(4)}`;
    };
    for (const b of bundlePlans) {
      const raw = new Map(b.kids.map((k) => [k, bundleGeom(b, k)]));
      const cuts = [...raw.values()].flatMap(({ trunkPts }) => trunkPts);
      const canonical = new Map([...raw].map(([k, geom]) => [k, { ...geom, trunkPts: splitAt(geom.trunkPts, cuts) }]));
      const users = new Map();
      for (const [k, { trunkPts }] of canonical)
        for (let i = 1; i < trunkPts.length; i++) {
          const key = canonicalKey(trunkPts[i - 1], trunkPts[i]);
          if (!users.has(key)) users.set(key, new Set());
          users.get(key).add(k.e);
        }
      for (const [k, { branchPts, trunkPts }] of canonical) {
        const pieces = [{ shared: false, pts: branchPts.slice() }];
        for (let i = 1; i < trunkPts.length; i++) {
          const a = trunkPts[i - 1], next = trunkPts[i];
          const shared = users.get(canonicalKey(a, next)).size >= 2;
          const last = pieces[pieces.length - 1];
          if (last.shared === shared && last.pts.length && last.pts[last.pts.length - 1].x === a.x && last.pts[last.pts.length - 1].y === a.y)
            last.pts.push(next);
          else
            pieces.push({ shared, pts: [a, next] });
        }
        bundlePieces.set(k, pieces.filter((piece) => piece.pts.length >= 2));
      }
    }

    function collectVerticals() {
      const map = new Map(); // g -> [{x, y1, y2, owner}]
      const add = (gph, x, y1, y2, owner) => {
        if (!map.has(gph)) map.set(gph, []);
        map.get(gph).push({ x, y1: Math.min(y1, y2), y2: Math.max(y1, y2), owner });
      };
      for (const b of bundlePlans) {
        for (const k of b.kids) {
          const { branchPts, trunkPts } = bundleGeom(b, k);
          for (let i = 1; i < branchPts.length; i++)
            if (branchPts[i].x === branchPts[i - 1].x) add(k.peelChan, branchPts[i].x, branchPts[i].y, branchPts[i - 1].y, k.e);
          // every trunk vertical is registered across the member's WHOLE spanned channel range
          // (its own peel channel up to the group's channel `lu`) — a pill in any intermediate
          // channel sees the whole ride, not just whichever single lane a given jog happens to
          // sit at; a broad, deliberately over-inclusive registration for this best-effort
          // pill-avoidance mechanism (never a correctness gate).
          for (let i = 1; i < trunkPts.length; i++)
            if (trunkPts[i].x === trunkPts[i - 1].x)
              for (let gc = b.lu; gc <= k.peelChan; gc++) add(gc, trunkPts[i].x, trunkPts[i].y, trunkPts[i - 1].y, k.e);
        }
      }
      for (const t of tracked) {
        if (t.sameLane) {
          const c = t.channels[0], y = rowY(c.g, itemFor(t, c).level);
          add(c.g, t.exitLo, y, gEnd(c.g, "below"), t.e);
          add(c.g, t.exitU, y, gEnd(c.g, "below"), t.e);
          continue;
        }
        let prevX = t.exitLo;
        for (let i = t.channels.length - 1; i >= 0; i--) {
          const c = t.channels[i], y = rowY(c.g, itemFor(t, c).level);
          add(c.g, prevX, y, gEnd(c.g, "below"), t.e);      // riser below this row
          add(c.g, c.xAbove, gEnd(c.g, "above"), y, t.e);   // continuation above this row
          prevX = c.xAbove;
        }
      }
      return map;
    }

    // slide simulation: best x for a pill along its horizontal (with overhang), given verticals
    function slidePill(pw, anchor, segX, y, verts, ownerEdge, ph = 20) {
      const halfH = ph / 2;
      const near = verts.filter((v) => v.owner !== ownerEdge && v.y1 < y + halfH && v.y2 > y - halfH);
      const lo = Math.min(segX[0], anchor), hi = Math.max(segX[1], anchor);
      const overhang = Math.max(0, pw / 2 - 6);
      const domLo = lo - overhang, domHi = hi + overhang;
      const conflicts = (x) => near.reduce((k, v) => k + (Math.abs(v.x - x) < pw / 2 + 3 ? 1 : 0), 0);
      let bestX = Math.min(domHi, Math.max(domLo, anchor)), bestC = conflicts(bestX), bestD = Infinity;
      if (bestC > 0) {
        const cands = [domLo, domHi];
        for (let x = domLo; x < domHi; x += 4) cands.push(x);
        for (const v of near) cands.push(v.x + pw / 2 + 3.5, v.x - pw / 2 - 3.5); // just past each crosser
        for (const c of cands) {
          if (c < domLo - 1e-9 || c > domHi + 1e-9) continue;
          const k = conflicts(c), d = Math.abs(c - anchor);
          if (k < bestC || (k === bestC && d < bestD)) { bestX = c; bestC = k; bestD = d; }
        }
      }
      return { x: bestX, conflicts: bestC };
    }
    // ----- pill placement, one mechanism: each pill tries its own row first, then every other
    // pill row of its channel (row order changes which risers/trunks cross it — a purely
    // combinatorial move), keeping the row with the fewest slide conflicts. Final xs are computed
    // in a second sweep so every pill sees the settled row assignment.
    const pillTs = tracked.filter((t) => t.pill);
    const pillGeom = (t) => {
      const c = t.channels.find((cc) => cc.g === t.pillChan);
      const item = itemFor(t, c);
      return { item, segX: [Math.min(c.xBelow, c.xAbove), Math.max(c.xBelow, c.xAbove)], anchor: c.xBelow };
    };
    for (const t of pillTs) {
      const pg = pillGeom(t);
      const chan = chans.get(t.pillChan);
      const orig = pg.item.level;
      const tryRows = [orig, ...chan.rows.map((_, i) => i).filter((i) => i >= chan.plainLevels && i !== orig)];
      let best = null;
      for (const row of tryRows) {
        if (row !== orig && chan.items.some((it) => it !== pg.item && it.level === row && !(pg.item.xR < it.xL || pg.item.xL > it.xR))) continue;
        pg.item.level = row;
        const verts = collectVerticals().get(t.pillChan) || [];
        const c = slidePill(t.pillW, pg.anchor, pg.segX, rowY(t.pillChan, row), verts, t.e, t.pillH).conflicts;
        if (!best || c < best.c) best = { row, c };
        if (c === 0) break;
      }
      pg.item.level = best.row;
    }
    const pills = [];
    const settledVerts = collectVerticals();
    for (const t of pillTs) {
      const pg = pillGeom(t);
      const y = rowY(t.pillChan, pg.item.level);
      const sim = slidePill(t.pillW, pg.anchor, pg.segX, y, settledVerts.get(t.pillChan) || [], t.e, t.pillH);
      if (sim.conflicts > 0)
        diag.warn(`label pill "${t.e.label}" could not fully avoid crossing connectors — it may sit on one`);
      pills.push({ t, x: sim.x, y });
    }

    // ----- build paths + geometry from the final assignment -----
    const debug = { cards: [], pills: [], statusPills: [], segs: [], texts: [], lanes: [] };
    const paths = []; // { d, stroke, width, dash }
    const stateRank = { healthy: 0, unknown: 1, degraded: 2, unhealthy: 3, alt: 1, signal: 1 };

    for (const b of bundlePlans) {
      for (const k of [...b.kids].sort((a, b2) => stateRank[g.nodes.get(a.e.from).state] - stateRank[g.nodes.get(b2.e.from).state])) {
        const st = T.state[g.nodes.get(k.e.from).state] || T.state.unknown;
        const edgeKey = `${k.e.from}->${k.e.to}`;
        for (const piece of bundlePieces.get(k)) {
          paths.push({
            d: roundedOrtho(withoutCollinearPoints(piece.pts), 7),
            stroke: piece.shared ? T.muted : st.border,
            width: 1.7,
          });
          debug.segs.push(...segsOf(piece.pts, edgeKey, piece.shared ? b.pid : null));
        }
      }
    }

    for (const t of tracked) {
      const st = T.state[g.nodes.get(t.e.from).state] || T.state.unknown;
      let pts;
      if (t.sameLane) {
        const cLo = box.get(t.loNode), cU = box.get(t.uNode);
        const y = rowY(t.chan, itemFor(t, t.channels[0]).level);
        pts = [{ x: t.exitLo, y: cLo.top }, { x: t.exitLo, y }, { x: t.exitU, y }, { x: t.exitU, y: cU.top }];
      } else {
        const cLo = box.get(t.loNode), cU = box.get(t.uNode);
        pts = [{ x: t.exitLo, y: cLo.top }];
        let prevX = t.exitLo;
        for (let i = t.channels.length - 1; i >= 0; i--) {
          const c = t.channels[i];
          const y = rowY(c.g, itemFor(t, c).level);
          pts.push({ x: prevX, y }, { x: c.xAbove, y });
          prevX = c.xAbove;
        }
        pts.push({ x: t.entryU, y: cU.bottom });
        pts = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
        if (t.channels.length === 1) {
          const [uLo, uHi] = nodeRange(t.uNode);
          if (straightenTrackedX(t.exitLo, t.entryU, uLo, uHi))
            pts = [{ x: t.exitLo, y: cLo.top }, { x: t.exitLo, y: cU.bottom }];
        }
      }
      paths.push({
        d: roundedOrtho(pts, 7),
        stroke: st.border,
        width: t.e.dashed ? 1.6 : 1.7,
        dash: t.e.dashed ? "5 4" : null,
      });
      debug.segs.push(...segsOf(pts, `${t.e.from}->${t.e.to}`));
    }

    // ----- global extents; translate if anything went left of 0 -----
    let minX = 0, maxX = 0;
    const scanX = (x) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); };
    for (const b of box.values()) { scanX(b.x); scanX(b.x + b.w); }
    for (const s of debug.segs) { scanX(s.x1); scanX(s.x2); }
    for (const p of pills) { scanX(p.x - p.t.pillW / 2); scanX(p.x + p.t.pillW / 2); }
    const tx = M.left - minX;
    const contentH = totalH;
    const legendGap = 20, legendRowH = 28;
    const W = Math.max(
      maxX + tx + 24 + gutterW,
      headW,
      subtitleW + M.left + 40,
      legendOn ? M.left + legendW + 40 : 0,
    );
    const H = legendOn ? contentH + legendGap + legendRowH : contentH;
    return { W, H, contentH, legendGap, legendRowH, L, laneOrigin, laneTop, laneBandH, lane, tx, box, paths, pills, debug };
  }

  // Packing/routing determines rowBudget-driven card content, but chrome-adjacent routing (a
  // lane-skipping corridor riding a wide flank, a widened pill-slide domain) can occasionally push
  // the *final* width a little past what the packed content alone implied. Retry with a tighter
  // budget — bounded and deterministic, never a combinatorial search — until it fits maxWidth or
  // shrinking the budget further could no longer help (rowBudgetFloor reached).
  let rowBudget = maxWidth - (M.left + 24 + gutterW);
  let built = computeLayout(rowBudget);
  for (let attempt = 0; attempt < 6 && built.W > maxWidth + 0.5 && rowBudget > rowBudgetFloor + 0.5; attempt++) {
    rowBudget = Math.max(rowBudgetFloor, rowBudget - (built.W - maxWidth) - 8);
    built = computeLayout(rowBudget);
  }
  const {
    W, H, contentH, legendGap, legendRowH, L, laneOrigin, laneTop, laneBandH,
    lane, tx, box, paths, pills, debug,
  } = built;


  const shift = (v) => v + tx;
  for (const b of box.values()) b.x = shift(b.x), b.cx = shift(b.cx);
  for (const s of debug.segs) s.x1 = shift(s.x1), s.x2 = shift(s.x2);
  for (const p of pills) p.x = shift(p.x);
  // paths carry absolute coords in their strings — rebuild them shifted instead
  // (cheap: we regenerate the d strings by shifting recorded points is complex; instead we
  //  wrap drawable content in a translate group and keep debug geometry in final coords)

  // ----- emit -----
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif">`);
  out.push(`<defs><filter id="cs" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.3" flood-color="#000" flood-opacity="${T.shadowOpacity}"/></filter></defs>`);
  out.push(`<rect width="${Math.ceil(W)}" height="${Math.ceil(H)}" fill="${T.bg}"/>`);

  // lane bands + labels: consecutive physical rows that wrapped from the same logical lane
  // (same laneOrigin) paint as one continuous band with a single centered label — "multiple rows
  // within one lane," not new lanes — while each row still keeps its own tight debug.lanes entry
  // so the geometry verifier's per-row card-containment check is unaffected by the grouping.
  for (let i = 0; i < L; i++) {
    if (i === 0 || laneOrigin[i] !== laneOrigin[i - 1]) {
      let j = i;
      while (j + 1 < L && laneOrigin[j + 1] === laneOrigin[i]) j++;
      const bandIdx = laneOrigin[i];
      const top = laneTop[i];
      const bh = laneTop[j] + laneBandH[j] - top;
      out.push(`<rect x="0" y="${top.toFixed(1)}" width="${Math.ceil(W)}" height="${bh.toFixed(1)}" fill="${bandIdx % 2 ? T.band : T.bg}"/>`);
      out.push(`<line x1="0" y1="${top.toFixed(1)}" x2="${Math.ceil(W)}" y2="${top.toFixed(1)}" stroke="${T.hair}"/>`);
      if (laneLabelsOn) {
        const lx = W - gutterW + 24, mid = top + bh / 2, ls = labelWraps[bandIdx];
        ls.forEach((s, k) => {
          const y = mid + (k - (ls.length - 1) / 2) * 17 + 4.5;
          out.push(`<text x="${lx.toFixed(1)}" y="${y.toFixed(1)}" font-size="13" font-weight="700" fill="${T.laneLabel}">${esc(s)}</text>`);
          debug.texts.push({ x: lx, y: y - 11, w: textWidth(s, 13, 600), h: 14, text: s });
        });
      }
    }
    debug.lanes.push({ top: laneTop[i], h: laneBandH[i], label: labels[laneOrigin[i]] });
  }
  out.push(`<line x1="0" y1="${(contentH - 0.5).toFixed(1)}" x2="${Math.ceil(W)}" y2="${(contentH - 0.5).toFixed(1)}" stroke="${T.hair}"/>`);

  // title + subtitle
  if (title) {
    out.push(`<text x="${M.left}" y="34" font-size="18" font-weight="700" fill="${T.ink}">${esc(title)}</text>`);
    debug.texts.push({ x: M.left, y: 20, w: textWidth(title, 18, 700), h: 20, text: title });
  }
  if (subtitle) {
    out.push(`<text x="${M.left}" y="52" font-size="12" fill="${T.muted}">${esc(subtitle)}</text>`);
    debug.texts.push({ x: M.left, y: 41, w: textWidth(subtitle, 12), h: 13, text: subtitle });
  }
  // legend — dedicated bottom footer row, left-aligned at the title margin, below the content
  // boundary hairline. Order: Legend, Healthy, Degraded, Unhealthy, Unknown, Metric.
  if (legendOn) {
    let x = M.left;
    const yy = contentH + legendGap + legendRowH / 2;
    out.push(`<text x="${x.toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="11.5" font-weight="600" fill="${T.muted}">Legend</text>`);
    x += textWidth("Legend", 11.5, 600) + 12;
    for (const [lbl, color] of legendItems) {
      out.push(`<circle cx="${(x + 6).toFixed(1)}" cy="${yy.toFixed(1)}" r="4.5" fill="${color}"/>`);
      out.push(`<text x="${(x + 16).toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="11.5" fill="${T.laneLabel}">${lbl}</text>`);
      x += 26 + textWidth(lbl, 11.5);
    }
    out.push(metricIcon(T, x, yy - 7, 14));
    out.push(`<text x="${(x + 18).toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="11.5" fill="${T.laneLabel}">Metric</text>`);
  }

  // edges + pills + cards inside the translate group
  out.push(`<g transform="translate(${tx.toFixed(1)},0)">`);
  out.push(`<g fill="none" stroke-linecap="butt" stroke-linejoin="round">`);
  for (const p of paths) {
    out.push(`<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.width}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ""}/>`);
  }
  out.push(`</g>`);
  for (const p of pills) {
    const pw = p.t.pillW, ph = p.t.pillH, lines = p.t.pillLines, x = p.x - tx; // group is translated; local coords
    const tip = p.t.pillClipped ? `<title>${esc(p.t.e.label)}</title>` : "";
    const rows = lines.map((line, k) => {
      const ly = p.y - (lines.length - 1) * 6.5 + k * 13 + 3.6;
      return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${PILL_FS}" font-weight="600" fill="${T.ink}" text-anchor="middle">${esc(line)}${k === 0 ? tip : ""}</text>`;
    }).join("");
    out.push(`<g stroke="none"><rect x="${(x - pw / 2).toFixed(1)}" y="${(p.y - ph / 2).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" rx="10" fill="${T.pillFill}" stroke="${T.pillStroke}" stroke-width="1"/>${rows}</g>`);
    debug.pills.push({ x: p.x - pw / 2, y: p.y - ph / 2, w: pw, h: ph, label: p.t.e.label, edge: `${p.t.e.from}->${p.t.e.to}` });
    for (const line of lines) {
      const lw = textWidth(line, PILL_FS, 600);
      debug.texts.push({ x: p.x - lw / 2, y: p.y - ph / 2 + 3, w: lw, h: ph - 6, text: line, container: { x: p.x - pw / 2, y: p.y - ph / 2, w: pw, h: ph } });
    }
  }
  for (const [id, n] of g.nodes) {
    const b = box.get(id), s = size.get(id);
    out.push(entityCard(T, n, { ...b, x: b.x - tx, cx: b.cx - tx }, s, debug, b));
    debug.cards.push({
      id, x: b.x, y: b.y, w: b.w, h: b.h, headerH: s.headerH,
      qualLines: s.qualWrap ? s.qualWrap.lines.length : 0, lane: lane.get(id),
    });
  }
  out.push(`</g></svg>`);
  const svg = out.join("\n");
  if (/NaN|Infinity|undefined/.test(svg)) throw new Error("internal: non-finite coordinate in SVG output");
  if (!svg.includes("</svg>")) throw new Error("internal: incomplete SVG");
  return { svg, W: Math.ceil(W), H: Math.ceil(H), nodes: g.nodes.size, lanes: L, debug, diag };
}

// ---------- card + small glyph emitters ----------
function metricIcon(T, x, y, sizePx = 14) {
  const s = sizePx / 16, [a, b, c] = T.metricBars;
  return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${s})"><rect x="1.5" y="8" width="2.6" height="6" rx="0.6" fill="${a}"/><rect x="5.7" y="4.5" width="2.6" height="9.5" rx="0.6" fill="${b}"/><rect x="9.9" y="6.5" width="2.6" height="7.5" rx="0.6" fill="${c}"/></g>`;
}
function statusDot(T, state, cx, cy) {
  const st = T.state[state] || T.state.unknown;
  if (state === "healthy") {
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${st.dot}"/><path d="M${(cx - 2.7).toFixed(1)} ${cy.toFixed(1)} l1.9 1.9 l3.4 -3.9" fill="none" stroke="${T.bg}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${st.dot}"/>`;
}

// b is in local (translated-group) coords; absB in final coords for debug text boxes
function entityCard(T, n, b, s, debug, absB) {
  const st = T.state[n.state] || T.state.unknown;
  const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : "";
  const p = [];
  const dbgText = (localX, topY, w, h, text) =>
    debug.texts.push({ x: localX + (absB.x - b.x), y: topY, w, h, text, container: { x: absB.x, y: absB.y, w: absB.w, h: absB.h } });

  p.push(`<g filter="url(#cs)"><rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w}" height="${b.h}" rx="10" fill="${st.fill}" stroke="${st.border}" stroke-width="2"${dash}/></g>`);

  const headerH = s.rows.length ? s.headerH : b.h;
  const headerMid = b.y + headerH / 2;
  const iconScale = 0.82;
  p.push(`<g transform="translate(${(b.x + 6).toFixed(1)},${(headerMid - 12 * iconScale).toFixed(2)}) scale(${iconScale})">${icon(pickIcon(s.name), T.muted)}</g>`);

  const px = b.x + b.w - s.statePillW - 8;
  const nameX = b.x + 34;
  const blockH = s.nameWrap.lines.length * 14 + (s.qualWrap ? s.qualWrap.lines.length * 11 : 0);
  let ty = headerMid - blockH / 2 + 10.5;
  const nameTitle = s.nameWrap.clipped ? `<title>${esc(s.name)}</title>` : "";
  s.nameWrap.lines.forEach((line) => {
    p.push(`<text x="${nameX.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${NAME_FS}" font-weight="600" fill="${T.ink}">${esc(line)}${nameTitle && line === s.nameWrap.lines[0] ? nameTitle : ""}</text>`);
    dbgText(nameX, ty - 10.5, textWidth(line, NAME_FS, 600), 14, line);
    ty += 14;
  });
  if (s.qualWrap) {
    s.qualWrap.lines.forEach((line) => {
      p.push(`<text x="${nameX.toFixed(1)}" y="${(ty - 2).toFixed(1)}" font-size="${QUAL_FS}" fill="${T.muted}">${esc(line)}</text>`);
      dbgText(nameX, ty - 2 - 8, textWidth(line, QUAL_FS), 10, line);
      ty += 11;
    });
  }
  p.push(`<rect x="${px.toFixed(1)}" y="${(headerMid - 9).toFixed(2)}" width="${s.statePillW.toFixed(1)}" height="18" rx="9" fill="${T.pillFill}" stroke="${st.border}" stroke-width="1"/>`);
  debug.statusPills.push({ x: px + (absB.x - b.x), y: headerMid - 9, w: s.statePillW, h: 18, id: n.id, container: { x: absB.x, y: absB.y, w: absB.w, h: absB.h } });
  p.push(statusDot(T, n.state, px + 11, headerMid));
  const stLabel = STATE_LABEL[n.state] || "Unknown";
  p.push(`<text x="${(px + 20).toFixed(1)}" y="${(headerMid + PILL_FS * 0.34).toFixed(2)}" font-size="${PILL_FS}" fill="${T.laneLabel}">${stLabel}</text>`);
  dbgText(px + 20, headerMid - 6, textWidth(stLabel, PILL_FS), 12, stLabel);

  if (s.rows.length) {
    const tY = b.y + s.headerH + 3;
    p.push(`<line x1="${(b.x + 1).toFixed(1)}" y1="${tY.toFixed(1)}" x2="${(b.x + b.w - 1).toFixed(1)}" y2="${tY.toFixed(1)}" stroke="${T.hair}"/>`);
    const iconX = b.x + 32, nameX2 = b.x + 52, resX = b.x + b.w - 12;
    let top = tY + 6;
    s.rows.forEach((r, i) => {
      const ry = top + 9; // first-line center
      if (i > 0) p.push(`<line x1="${(b.x + 10).toFixed(1)}" y1="${(top - 0).toFixed(1)}" x2="${(b.x + b.w - 10).toFixed(1)}" y2="${top.toFixed(1)}" stroke="${T.hair}" stroke-opacity="0.7"/>`);
      p.push(statusDot(T, r.state, b.x + 16, ry));
      p.push(metricIcon(T, iconX, ry - 7, 14));
      const rowTitle = r.clipped ? `<title>${esc(r.name)}</title>` : "";
      r.lines.forEach((line, k) => {
        p.push(`<text x="${nameX2.toFixed(1)}" y="${(ry + 3.5 + k * 13).toFixed(1)}" font-size="${ROW_FS}" fill="${T.ink}">${esc(line)}${k === 0 ? rowTitle : ""}</text>`);
        dbgText(nameX2, ry + 3.5 + k * 13 - 9, textWidth(line, ROW_FS), 11, line);
      });
      const rs = T.state[r.state] || T.state.healthy;
      p.push(`<text x="${resX.toFixed(1)}" y="${(ry + 3.5).toFixed(1)}" font-size="${ROW_FS}" font-weight="${r.state === "healthy" ? 400 : 600}" fill="${r.state === "healthy" ? T.muted : rs.dot}" text-anchor="end">${esc(r.result ?? "")}</text>`);
      dbgText(resX - r.resultW, ry - 5.5, r.resultW, 11, r.result ?? "");
      top += r.rowH;
    });
  }
  return p.join("");
}

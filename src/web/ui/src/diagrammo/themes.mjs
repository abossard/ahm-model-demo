// themes.mjs — palettes shared by the swimlane renderer and the themed-mermaid renderer.
// Every theme carries the full set of colors the swimlane renderer draws with, plus the
// state colors the mermaid renderer maps onto the article's classDefs (blue/green/amber/red/purple).

const portal = {
  name: "portal",
  bg: "#ffffff", band: "#faf9f8", ink: "#242424", muted: "#605e5c",
  laneLabel: "#323130", hair: "#e6e4e2", pillFill: "#ffffff", pillStroke: "#d8d6d4",
  shadowOpacity: 0.10,
  state: {
    healthy:   { border: "#a0d8a0", fill: "#f2f8f2", dot: "#4c9a2a" },
    degraded:  { border: "#db7500", fill: "#fbf2e7", dot: "#c26a00" },
    unhealthy: { border: "#ba0d16", fill: "#faeceb", dot: "#c50f18" },
    unknown:   { border: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", dash: "4 3" },
    alt:       { border: "#8661c5", fill: "#f4f0fb", dot: "#8661c5" },
    signal:    { border: "#0078D4", fill: "#eff6fc", dot: "#0078D4" },
  },
  metricBars: ["#8661c5", "#0078D4", "#3fb0ac"],
};

const midnight = {
  name: "midnight",
  bg: "#1b1a19", band: "#232120", ink: "#f3f2f1", muted: "#a19f9d",
  laneLabel: "#d2d0ce", hair: "#3b3a39", pillFill: "#2b2a29", pillStroke: "#4a4846",
  shadowOpacity: 0.35,
  state: {
    healthy:   { border: "#6ccb5f", fill: "#1e2d1c", dot: "#6ccb5f" },
    degraded:  { border: "#f7a350", fill: "#33261a", dot: "#f7a350" },
    unhealthy: { border: "#f1707b", fill: "#331d1f", dot: "#f1707b" },
    unknown:   { border: "#7a7874", fill: "#262524", dot: "#979593", dash: "4 3" },
    alt:       { border: "#a58fd8", fill: "#262033", dot: "#a58fd8" },
    signal:    { border: "#4ba3e3", fill: "#1c2733", dot: "#4ba3e3" },
  },
  metricBars: ["#a58fd8", "#4ba3e3", "#57c3bf"],
};

const candy = {
  name: "candy",
  bg: "#fffdfa", band: "#fdf6fb", ink: "#3d2b3d", muted: "#8a7a8a",
  laneLabel: "#5b3d5b", hair: "#f0e4ee", pillFill: "#ffffff", pillStroke: "#e8d8e6",
  shadowOpacity: 0.10,
  state: {
    healthy:   { border: "#7fd1ae", fill: "#eefaf4", dot: "#2eb884" },
    degraded:  { border: "#ffb454", fill: "#fff4e4", dot: "#f39114" },
    unhealthy: { border: "#ff7d9c", fill: "#ffeef3", dot: "#ef476f" },
    unknown:   { border: "#cfc7cf", fill: "#f7f4f7", dot: "#9a8f9a", dash: "4 3" },
    alt:       { border: "#a78bfa", fill: "#f3eefe", dot: "#8b5cf6" },
    signal:    { border: "#5eb0ef", fill: "#e9f4fd", dot: "#3d95e0" },
  },
  metricBars: ["#a78bfa", "#5eb0ef", "#7fd1ae"],
};

const slate = {
  name: "slate",
  bg: "#f8fafc", band: "#eef2f7", ink: "#0f172a", muted: "#64748b",
  laneLabel: "#334155", hair: "#e2e8f0", pillFill: "#ffffff", pillStroke: "#cbd5e1",
  shadowOpacity: 0.10,
  state: {
    healthy:   { border: "#34d399", fill: "#ecfdf5", dot: "#10b981" },
    degraded:  { border: "#fbbf24", fill: "#fffbeb", dot: "#d97706" },
    unhealthy: { border: "#f87171", fill: "#fef2f2", dot: "#dc2626" },
    unknown:   { border: "#cbd5e1", fill: "#f1f5f9", dot: "#94a3b8", dash: "4 3" },
    alt:       { border: "#a78bfa", fill: "#f5f3ff", dot: "#7c3aed" },
    signal:    { border: "#60a5fa", fill: "#eff6ff", dot: "#2563eb" },
  },
  metricBars: ["#a78bfa", "#60a5fa", "#2dd4bf"],
};

export const THEMES = { portal, midnight, candy, slate };
export const THEME_NAMES = Object.keys(THEMES);

export function getTheme(name) {
  const t = THEMES[String(name || "portal").toLowerCase()];
  if (!t) throw new Error(`unknown theme "${name}" (themes: ${THEME_NAMES.join(", ")})`);
  return t;
}

// Mermaid-side theming: classDef bodies for the article's five class names, in this theme.
export function mermaidClassDefs(theme) {
  const s = theme.state, tx = theme.ink;
  return {
    blue:   `classDef blue fill:${s.signal.fill},stroke:${s.signal.border},stroke-width:2px,color:${tx};`,
    green:  `classDef green fill:${s.healthy.fill},stroke:${s.healthy.border},stroke-width:2.5px,color:${tx};`,
    amber:  `classDef amber fill:${s.degraded.fill},stroke:${s.degraded.border},stroke-width:2.5px,color:${tx};`,
    red:    `classDef red fill:${s.unhealthy.fill},stroke:${s.unhealthy.border},stroke-width:2.5px,color:${tx};`,
    purple: `classDef purple fill:${s.alt.fill},stroke:${s.alt.border},stroke-width:2px,color:${tx};`,
  };
}

// Mermaid config (themeVariables) for plain mermaid blocks rendered via mmdc, in this theme.
export function mermaidConfig(theme) {
  return {
    securityLevel: "loose",
    theme: "base",
    themeVariables: {
      fontFamily: "Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif",
      fontSize: "13px",
      darkMode: theme.name === "midnight",
      background: theme.bg,
      lineColor: theme.muted,
      primaryColor: theme.band,
      primaryBorderColor: theme.state.unknown.border,
      primaryTextColor: theme.ink,
      secondaryColor: theme.state.signal.fill,
      secondaryBorderColor: theme.state.signal.border,
      tertiaryColor: theme.bg,
      clusterBkg: theme.band,
      clusterBorder: theme.state.unknown.border,
      edgeLabelBackground: theme.pillFill,
      titleColor: theme.ink,
      nodeTextColor: theme.ink,
      // sequence / state / pie share these
      actorBkg: theme.band, actorBorder: theme.state.signal.border, actorTextColor: theme.ink,
      signalColor: theme.muted, signalTextColor: theme.ink,
      labelBoxBkgColor: theme.band, labelBoxBorderColor: theme.state.unknown.border, labelTextColor: theme.ink,
      noteBkgColor: theme.state.degraded.fill, noteBorderColor: theme.state.degraded.border, noteTextColor: theme.ink,
    },
    flowchart: { htmlLabels: false, curve: "basis", nodeSpacing: 45, rankSpacing: 55, padding: 10 },
    htmlLabels: false,
  };
}

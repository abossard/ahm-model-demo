// extract.mjs — pull mermaid blocks out of a Markdown file, along with per-block options.
//
// A block can carry options three ways (later sources win):
//   1. fence info string:      ```mermaid swimlane theme=midnight
//   2. YAML frontmatter:       ---\n title: Checkout \n diagrammo:\n   theme: candy\n ---
//   3. directive comments:     %%| theme: midnight
//
// All three are invisible to GitHub/VS Code mermaid preview: the fence language stays `mermaid`,
// mermaid itself understands frontmatter, and `%%` lines are mermaid comments.

// ---------- tiny YAML subset (maps by indentation, "- " lists, inline [a, b], scalars) ----------
export function parseYamlite(text) {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  let i = 0;
  function parseBlock(indent) {
    const isList = lines[i] != null && lineIndent(lines[i]) === indent && lines[i].trim().startsWith("- ");
    const out = isList ? [] : {};
    while (i < lines.length) {
      const line = lines[i], ind = lineIndent(line), t = line.trim();
      if (ind < indent) break;
      if (ind > indent) { i++; continue; } // over-indented stray; skip
      if (t.startsWith("- ")) {
        if (!Array.isArray(out)) break;
        out.push(scalar(t.slice(2).trim())); i++; continue;
      }
      const m = t.match(/^([\w][\w .\/-]*)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim();
      i++;
      if (m[2] !== "") { out[key] = scalar(m[2]); continue; }
      // empty value: nested block if the next line is deeper, else null
      if (i < lines.length && lineIndent(lines[i]) > ind) out[key] = parseBlock(lineIndent(lines[i]));
      else out[key] = null;
    }
    return out;
  }
  return parseBlock(lines.length ? lineIndent(lines[0]) : 0);
}
function lineIndent(l) { return l.length - l.trimStart().length; }
function scalar(v) {
  v = v.trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => scalar(x)) : [];
  }
  if (v === "true" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "off" || v === "no") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// ---------- option sources ----------
const RENDERERS = new Set(["auto", "swimlane", "mermaid"]);

// fence info string after "mermaid": bare words match a renderer or theme name; key=value otherwise
export function parseFenceInfo(info, themeNames, issues = null, line = null) {
  const opts = {};
  const { tokens, unclosedQuote } = tokenizeFenceInfo(info);
  if (unclosedQuote && issues) {
    issues.push({ level: "warn", message: `unterminated ${unclosedQuote} quote in fence options`, line });
  }
  for (const tok of tokens) {
    const kv = tok.match(/^([\w-]+)=(.*)$/);
    if (kv) {
      opts[kv[1]] = scalar(kv[2].replace(/^["']|["']$/g, ""));
      continue;
    }
    const w = tok.toLowerCase();
    if (RENDERERS.has(w)) opts.renderer = w;
    else if (themeNames.includes(w)) opts.theme = w;
    else if (issues) issues.push({ level: "warn", message: `fence token "${tok}" is neither a renderer (${[...RENDERERS].join("/")}) nor a theme (${themeNames.join("/")}) — ignored`, line });
  }
  return opts;
}

function tokenizeFenceInfo(info) {
  const tokens = [];
  let token = "", quote = null;
  for (const char of (info || "").replace(/[{}]/g, " ")) {
    if (quote) {
      token += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      token += char;
    } else if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ""; }
    } else {
      token += char;
    }
  }
  if (token) tokens.push(token);
  return { tokens, unclosedQuote: quote };
}

// %%| directives inside the block, one `key: value` per line
export function parseDirectives(code, issues = null, codeLine = 0) {
  const opts = {};
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*%%\|\s*(.+)$/);
    if (!m) continue;
    const kv = m[1].match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) opts[kv[1]] = scalar(kv[2]);
    else if (issues) issues.push({ level: "warn", message: `malformed directive "%%| ${m[1].trim()}" — expected "%%| key: value"`, line: codeLine + i });
  }
  return opts;
}

// frontmatter at the top of the block: returns { fm, body } (body = code without frontmatter)
export function splitFrontmatter(code) {
  const m = code.match(/^\s*---[ \t]*\n([\s\S]*?)\n[ \t]*---[ \t]*\n?/);
  if (!m) return { fm: null, body: code, raw: null };
  return { fm: parseYamlite(m[1]), body: code.slice(m[0].length), raw: m[0] };
}

// Remove only the `diagrammo:` key (and its indented children) from a frontmatter block,
// keeping mermaid-native keys like title/config untouched.
export function stripDiagrammoKey(rawFrontmatter) {
  const lines = rawFrontmatter.split("\n");
  const out = [];
  let skipIndent = -1;
  for (const l of lines) {
    if (skipIndent >= 0) {
      if (l.trim() && lineIndent(l) > skipIndent) continue;
      skipIndent = -1;
    }
    if (/^(\s*)diagrammo\s*:\s*$/.test(l) || /^(\s*)diagrammo\s*:\s+\S/.test(l)) {
      skipIndent = lineIndent(l); continue;
    }
    out.push(l);
  }
  // frontmatter reduced to just the fences? drop it entirely
  const inner = out.filter((l) => l.trim() && !/^\s*---\s*$/.test(l));
  return inner.length ? out.join("\n") : "";
}

// ---------- markdown walk ----------
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "diagram";
}

export const KNOWN_OPTIONS = ["renderer", "theme", "title", "subtitle", "name", "lanes", "legend", "background", "alt", "maxWidth", "laneLabels"];

// Reserves a slug in the shared `used` map before any new block's slug is derived, so a
// managed block's stable identity (its first-generated marker slug) can never be re-derived or
// collided into by a later plain/unmanaged block sharing the same base heading/title. Handles
// both a bare base slug ("checkout") and an already-suffixed one ("checkout-2") by also bumping
// the bare base's count, so the *next* collision on that base skips past the reservation.
export function reserveSlug(used, slug) {
  used.set(slug, Math.max(used.get(slug) || 0, 1));
  const m = slug.match(/^(.+)-(\d+)$/);
  if (m) {
    const base = m[1], n = Number(m[2]);
    if (n >= 2) used.set(base, Math.max(used.get(base) || 0, n));
  }
}

// The optional `used` map can be shared across calls to keep slugs unique across multiple files.
// The optional `preferred` map (fence open line → slug) lets a caller pin a block's slug to a
// stable, previously-generated identity (e.g. an existing managed marker) regardless of its
// current heading/title — used by `--sync-markdown` to keep the first-generated filename stable.
// Returns [{ slug, heading, info, code, options, line, codeLine, issues }]
//   code     — block body with frontmatter kept (renderers decide what to strip)
//   options  — merged per-block options (fence info < frontmatter < directives)
//   line     — 1-based line number of the opening fence
//   codeLine — 1-based line number of the first code line (fence line + 1)
//   closeLine — 1-based line number of the closing fence line, or null when the fence never closes
//   issues   — [{ level, message, line }] option-level problems (unknown keys, bad values)
export function extractBlocks(md, themeNames = [], used = new Map(), preferred = null) {
  const lines = md.split("\n");
  const blocks = [];
  let heading = "diagram";
  let inBlock = false, buf = [], info = "", openLine = 0, openFence = "";
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h && !inBlock) heading = h[1].trim();
    const open = line.match(/^\s*(`{3,}|~{3,})\s*mermaid\b(.*)$/);
    if (!inBlock && open) { inBlock = true; buf = []; info = open[2].trim(); openLine = li + 1; openFence = open[1]; continue; }
    const close = inBlock && line.match(/^\s*(`+|~+)\s*$/);
    if (close && close[1][0] === openFence[0] && close[1].length >= openFence.length) {
      inBlock = false;
      blocks.push(buildBlock({ heading, info, code: buf.join("\n"), line: openLine, closeLine: li + 1, themeNames, used, preferredSlug: preferred ? preferred.get(openLine) : null }));
      continue;
    }
    if (inBlock) buf.push(line);
  }
  if (inBlock) {
    const blk = buildBlock({ heading, info, code: buf.join("\n"), line: openLine, closeLine: null, themeNames, used, preferredSlug: preferred ? preferred.get(openLine) : null });
    blk.issues.push({ level: "warn", message: "mermaid fence is never closed (``` missing) — using everything up to end of file", line: openLine });
    blocks.push(blk);
  }
  return blocks;
}

function buildBlock({ heading, info, code, line, closeLine, themeNames, used, preferredSlug }) {
  const issues = [];
  const { fm } = splitFrontmatter(code);
  const fence = parseFenceInfo(info, themeNames, issues, line);
  const fmOpts = fm && typeof fm === "object" && !Array.isArray(fm) ? extractFmOptions(fm) : {};
  const directives = parseDirectives(code, issues, line + 1);
  const options = { ...fence, ...fmOpts, ...directives };
  for (const src of [fmOpts, directives]) {
    for (const k of Object.keys(src)) {
      if (!KNOWN_OPTIONS.includes(k) && k !== "title")
        issues.push({ level: "warn", message: `unknown option "${k}" (known: ${KNOWN_OPTIONS.join(", ")})`, line });
    }
  }
  if (options.renderer != null && !["auto", "swimlane", "mermaid"].includes(String(options.renderer).toLowerCase()))
    issues.push({ level: "error", message: `unknown renderer "${options.renderer}" (use auto, swimlane, or mermaid)`, line });
  if (options.theme != null && themeNames.length && !themeNames.includes(String(options.theme).toLowerCase()))
    issues.push({ level: "error", message: `unknown theme "${options.theme}" (themes: ${themeNames.join(", ")})`, line });
  if (options.lanes != null && !Array.isArray(options.lanes))
    issues.push({ level: "warn", message: `"lanes" should be a list, e.g. lanes: [Root, Flows, Services] — got ${JSON.stringify(options.lanes)}`, line });
  // An `alt` override that is present but empty/whitespace-only must not silently become empty
  // accessibility text (an empty `![]`/`alt-text=""` is worse than none) — warn and let the shared
  // alt pipeline fall back to title/heading. A `%%| alt` line with no colon is already reported by
  // parseDirectives' "malformed directive" path, so only the empty-value case is handled here.
  if (options.alt != null && !String(options.alt).trim())
    issues.push({ level: "warn", message: `empty "alt" override — falling back to title/heading for the accessibility text`, line });
  if (options.maxWidth != null && !(Number.isFinite(options.maxWidth) && options.maxWidth > 0)) {
    issues.push({ level: "warn", message: `"maxWidth" should be a positive number of CSS px — got ${JSON.stringify(options.maxWidth)} — falling back to the renderer's default`, line });
    delete options.maxWidth; // never an "unbounded" state: dropping it lets the 1024 default (or another still-valid source) apply
  }
  // `laneLabels` follows the same explicit warn-and-drop precedent as `maxWidth` above — a
  // deliberate improvement over `legend`'s own silent gap, not merely mirroring it (see the
  // blueprint's Decisions table): a non-boolean value warns and is dropped, falling back to the
  // default-on behavior, so a direct JS/library caller passing e.g. "false" (a string) never
  // reaches renderSwimlane un-normalized.
  if (options.laneLabels != null && typeof options.laneLabels !== "boolean") {
    issues.push({ level: "warn", message: `"laneLabels" should be a boolean — got ${JSON.stringify(options.laneLabels)} — falling back to shown (the default)`, line });
    delete options.laneLabels;
  }
  // A preferred slug (e.g. an existing managed marker's stable identity) wins outright — the
  // heading/title-derived base below is never even computed as a candidate for this block.
  let slug;
  if (preferredSlug) {
    slug = preferredSlug;
  } else {
    const base = slugify(options.name || options.title || heading);
    const n = (used.get(base) || 0) + 1; used.set(base, n);
    slug = n === 1 ? base : `${base}-${n}`;
  }
  return { slug, heading, info, code, options, line, codeLine: line + 1, closeLine, issues };
}

function extractFmOptions(fm) {
  const opts = {};
  if (typeof fm.title === "string") opts.title = fm.title;
  const d = fm.diagrammo;
  if (d && typeof d === "object" && !Array.isArray(d)) Object.assign(opts, d);
  else if (typeof d === "string") opts.renderer = d;
  return opts;
}

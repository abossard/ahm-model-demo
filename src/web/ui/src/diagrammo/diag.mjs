// diag.mjs — structured diagnostics for parsing and layout. Every entry can carry a source
// line so CLI output reads like a compiler: `doc.md:42  warn  unrecognized line …`.

export class Diagnostics {
  constructor({ file = null } = {}) {
    this.file = file;
    this.items = [];
  }
  add(level, message, { line = null, hint = null } = {}) {
    this.items.push({ level, message, line, hint });
    return this;
  }
  info(message, loc) { return this.add("info", message, loc); }
  warn(message, loc) { return this.add("warn", message, loc); }
  error(message, loc) { return this.add("error", message, loc); }

  get warnings() { return this.items.filter((i) => i.level === "warn"); }
  get errors() { return this.items.filter((i) => i.level === "error"); }
  get infos() { return this.items.filter((i) => i.level === "info"); }
  hasErrors() { return this.errors.length > 0; }

  // formatted lines; verbose=false hides `info`
  format({ verbose = false, indent = "  " } = {}) {
    const out = [];
    for (const it of this.items) {
      if (it.level === "info" && !verbose) continue;
      const where = it.line != null ? `${this.file ? this.file + ":" : "line "}${it.line}  ` : (this.file ? this.file + "  " : "");
      out.push(`${indent}${it.level.padEnd(5)} ${where}${it.message}${it.hint ? `\n${indent}      ↳ ${it.hint}` : ""}`);
    }
    return out;
  }
}

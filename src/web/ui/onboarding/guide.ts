import { readFileSync } from "node:fs";

/** Replace each quotation with the text Playwright read from the same view as the screenshot. */
export function renderGuide(excerpts: Readonly<Record<string, string>>): string {
  const template = readFileSync(new URL("./guide.md", import.meta.url), "utf8");
  return insertExcerpts(template, excerpts);
}

export function insertExcerpts(template: string, excerpts: Readonly<Record<string, string>>): string {
  return template.replace(/^\{\{excerpt:([\w-]+)\}\}$/gm, (_, step: string) => {
    const text = excerpts[step]?.trim();
    if (!text) throw new Error(`Missing browser excerpt for ${step}`);
    return text.split(/\r?\n/).map(line => "> " + line
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/[\\`*_~\[\]]/g, "\\$&")).join("\n");
  });
}

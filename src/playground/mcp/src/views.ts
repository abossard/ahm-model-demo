import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VIEW_NAMES } from "@playground/contracts";
import type { ViewName } from "@playground/contracts";

export interface Views {
  docs: Partial<Record<ViewName, string>>;
  missing: ViewName[];
}

export function loadViews(dir: string): Views {
  const docs: Views["docs"] = {};
  const missing: ViewName[] = [];
  for (const name of VIEW_NAMES) {
    const file = join(dir, `${name}.html`);
    if (existsSync(file)) docs[name] = readFileSync(file, "utf8");
    else missing.push(name);
  }
  return { docs, missing };
}

export const LAB_NOTES = `# Lab notes

Everything in the lab is a message between the View, the host and this server.
Open the wire drawer to read each one.

- The View asks the host to call a tool. The host forwards it here.
- Progress notifications travel back the same way.
- This text is a resource: the View read it with resources/read.
`;

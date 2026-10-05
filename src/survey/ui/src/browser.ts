import { record } from "./model";

export type Author = { code: string; key: string };
const AUTHOR_STORE = "survey.authors.v1";
const authorsInMemory = new Map<string, string>();
const responseInMemory = new Map<string, string>();
export const validKey = (key: unknown): key is string =>
  typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key);

export function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function authors(): { entries: Author[]; warning: string } {
  try {
    const raw = localStorage.getItem(AUTHOR_STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed) || parsed.some((a: unknown) =>
      !record(a) || typeof a.code !== "string" || !/^[A-Z]{6}$/.test(a.code) || !validKey(a.key)))
      throw new Error("Invalid author records");
    const entries: Author[] = [];
    for (const item of parsed) {
      if (record(item) && typeof item.code === "string" && validKey(item.key))
        entries.push({ code: item.code, key: item.key });
    }
    for (const [code, key] of authorsInMemory) {
      if (!entries.some(a => a.code === code)) entries.push({ code, key });
    }
    return { entries, warning: "" };
  } catch {
    return { entries: [...authorsInMemory].map(([code, key]) => ({ code, key })),
      warning: "Author storage is unavailable or damaged. Keep your private editing URL; this browser may not remember your surveys." };
  }
}

export function rememberAuthor(author: Author): string {
  authorsInMemory.set(author.code, author.key);
  const saved = authors();
  try {
    if (saved.warning) return saved.warning;
    localStorage.setItem(AUTHOR_STORE, JSON.stringify(
      [...saved.entries.filter(a => a.code !== author.code), author]));
    return "";
  } catch {
    return "Author storage is unavailable. Keep your private editing URL; it is your recovery key.";
  }
}

export function captureAuthor(code: string): { key: string; warning: string } {
  const fragment = new URLSearchParams(location.hash.slice(1)).get("key");
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (fragment !== null) {
    if (!validKey(fragment)) throw new Error("Invalid private editing URL.");
    return { key: fragment, warning: authors().warning };
  }
  const saved = authors();
  const key = saved.entries.find(a => a.code === code)?.key;
  if (!key) throw new Error("Open your private editing URL to edit this survey.");
  return { key, warning: saved.warning };
}

export function responseKey(code: string): string {
  const name = `survey.response.v1.${code}`;
  let existing: string | null;
  try {
    existing = localStorage.getItem(name);
  } catch {
    throw new Error("Response storage is unavailable. Enable browser storage before saving; no new voting identity has been created.");
  }
  if (existing !== null && !validKey(existing))
    throw new Error("The saved response key is damaged. No replacement voting identity was created.");
  const key = existing ?? responseInMemory.get(code) ?? newKey();
  responseInMemory.set(code, key);
  try {
    localStorage.setItem(name, key);
    if (localStorage.getItem(name) !== key) throw new Error("Response storage did not persist");
  } catch {
    throw new Error("Your response key could not be stored. Enable browser storage, then Retry. Answers have not been sent.");
  }
  return key;
}

export const privateUrl = (code: string, key: string) => `${location.origin}/edit/${code}#key=${key}`;
export const joinUrl = (code: string) => `${location.origin}/join/${code}`;

import { createHash } from "node:crypto";
import { VIEW_MIME } from "@playground/contracts";

// A calculation: the HTML documents a `resources/read` result carries, found by their MIME type.
export function viewDocuments(message: unknown): string[] {
  const contents = (message as { result?: { contents?: unknown } } | null)?.result?.contents;
  if (!Array.isArray(contents)) return [];
  return contents.flatMap((item: { mimeType?: unknown; text?: unknown }) =>
    item?.mimeType === VIEW_MIME && typeof item.text === "string" ? [item.text] : []);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The View documents the proxy has relayed, by the SHA-256 of their text: the digest the browser computes.
export function createViews(limit = 50) {
  const documents = new Map<string, string>();
  return {
    put(text: string): string {
      const digest = sha256(text);
      documents.delete(digest);
      documents.set(digest, text);
      if (documents.size > limit) documents.delete(documents.keys().next().value!);
      return digest;
    },
    get: (digest: string) => documents.get(digest),
  };
}
export type Views = ReturnType<typeof createViews>;

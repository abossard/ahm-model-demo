// Numbers name entries in the action map of this result.
export const SHOW_ME_MARKER = /\[\[show:(\d+)\]\]/g;

/** Prose for a surface such as a live announcement that cannot display buttons. */
export function withoutShowMeMarkers(text: string): string {
  return text.replace(SHOW_ME_MARKER, "").replace(/ {2,}/g, " ").replace(/ +([.!?,])/g, "$1").trim();
}

import { LAB_EXHIBITS, LAB_EXHIBITS_TO_UNLOCK, type LabExhibit } from "@playground/contracts";

export type Group = "server" | "host" | "both";

export interface ExhibitDef {
  id: LabExhibit;
  group: Group;
  title: string;
  teaches: string;
}

export const GROUPS: readonly { id: Group; title: string; line: string }[] = [
  { id: "server", title: "Ask the server", line: "The View calls a tool. The host carries the call both ways." },
  { id: "host", title: "Ask the host", line: "Requests the host may grant, refuse or ignore." },
  { id: "both", title: "Listen and offer", line: "The host speaks first, or asks the View for something." },
];

export const EXHIBITS: readonly ExhibitDef[] = [
  { id: "call_tool", group: "server", title: "Call a tool", teaches: "tools/call from the View. The reply is the tool's structured output." },
  { id: "read_resource", group: "server", title: "Read a resource", teaches: "resources/read through the host, for text the server keeps." },
  { id: "progress", group: "server", title: "Stream progress", teaches: "A progress token on the call. Each tick comes back as a notification." },
  { id: "message", group: "host", title: "Message the host", teaches: "ui/message adds a user message to the conversation." },
  { id: "model_context", group: "host", title: "Update model context", teaches: "ui/update-model-context tells the model what you see, without a message." },
  { id: "open_link", group: "host", title: "Open a link", teaches: "A sandboxed View cannot navigate. The host opens the page, after asking." },
  { id: "display_mode", group: "host", title: "Change display mode", teaches: "Ask for fullscreen. The host answers with the mode it chose." },
  { id: "log", group: "host", title: "Log to the host", teaches: "notifications/message. For debugging, never shown to the model." },
  { id: "theme", group: "both", title: "Follow the theme", teaches: "host-context-changed. The host flips light or dark and the View follows." },
  { id: "app_tool", group: "both", title: "Offer a tool", teaches: "The View registers a tool of its own. The host lists it and may call it." },
];

// A calculation: what is left to do to open the next layer.
export function unlockLine(done: readonly LabExhibit[]): string {
  const left = Math.max(0, LAB_EXHIBITS_TO_UNLOCK - done.length);
  if (left === 0) return `${done.length} of ${LAB_EXHIBITS.length} tried. Checkers is open.`;
  return `${done.length} of ${LAB_EXHIBITS.length} tried. ${left} more opens Checkers.`;
}

export function clip(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A calculation: add an exhibit to the tried list once.
export function withDone(done: readonly LabExhibit[], id: LabExhibit): LabExhibit[] {
  return done.includes(id) ? [...done] : [...done, id];
}

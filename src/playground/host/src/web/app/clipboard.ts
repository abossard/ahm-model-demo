import { logHost } from "./hostEvents";

// Copies text and says so on the console. Falls back to a hidden textarea where the async clipboard is not allowed.
export async function copyText(text: string, what: string): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
  }
  logHost("copy", { what, bytes: text.length, ok });
  return ok;
}

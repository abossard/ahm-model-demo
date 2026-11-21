import "./highlight.css";

export interface ShowMeDescriptor {
  readonly name: string;
  readonly description: string;
  /** Leave empty for a handle that takes no id. */
  readonly idDescription: string;
}

export interface ShowMeHandle extends ShowMeDescriptor {
  /** Resolve after navigation with the mounted destination, or null for an unavailable id. */
  open(id: string | undefined, signal: AbortSignal): Element | null | Promise<Element | null>;
}

export interface ShowMeHighlight {
  readonly color?: "blue" | "amber" | "violet";
  readonly label?: string;
}

export interface ShowMeAction {
  readonly handle: string;
  readonly id?: string;
  readonly highlight?: ShowMeHighlight;
}

export type ShowMeOutcome = "shown" | "unavailable" | "superseded";

export interface ShowMeRegistry {
  describe(): ShowMeDescriptor[];
  execute(action: ShowMeAction): Promise<ShowMeOutcome>;
  clear(): void;
}

function textWithin(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max
    && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value);
}

function validHighlight(value: unknown): value is ShowMeHighlight {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { color, label } = value as ShowMeHighlight;
  return Object.keys(value).every(key => key === "color" || key === "label")
    && (color === undefined || color === "blue" || color === "amber" || color === "violet")
    && (label === undefined || textWithin(label, 120));
}

let annotationSequence = 0;

function mark(target: Element, highlight: ShowMeHighlight, signal: AbortSignal): void {
  const color = highlight.color ?? "blue";
  target.setAttribute("data-show-me-highlight", color);
  signal.addEventListener("abort", () => target.removeAttribute("data-show-me-highlight"), { once: true });
  target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
  if (!highlight.label) return;

  const doc = target.ownerDocument;
  const note = doc.createElement("span");
  note.id = `show-me-annotation-${++annotationSequence}`;
  note.dataset.showMeAnnotation = color;
  note.setAttribute("role", "note");
  note.textContent = highlight.label;
  const anchor = `--${note.id}`;
  const style = (target as HTMLElement | SVGElement).style;
  style.setProperty("--show-me-anchor", anchor);
  note.style.setProperty("position-anchor", anchor);
  const descriptions = target.getAttribute("aria-describedby");
  target.setAttribute("aria-describedby", [descriptions, note.id].filter(Boolean).join(" "));
  signal.addEventListener("abort", () => {
    note.remove();
    style.removeProperty("--show-me-anchor");
    const remaining = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== note.id);
    if (remaining.length) target.setAttribute("aria-describedby", remaining.join(" "));
    else target.removeAttribute("aria-describedby");
  }, { once: true });
  // A top-layer caption follows a scrolling target and can appear inside a native modal.
  if (typeof note.showPopover === "function") note.popover = "manual";
  (target.closest('dialog, [role="dialog"]') ?? doc.body).append(note);
  note.showPopover?.();
}

/** Keep one registry for the lifetime of a surface and clear it when the surface closes. */
export function createShowMe(handles: readonly ShowMeHandle[]): ShowMeRegistry {
  if (handles.length > 16) throw new Error("A turn can offer up to 16 Show me handles");
  const byName = new Map<string, ShowMeHandle>();
  for (const handle of handles) {
    if (byName.has(handle.name)) throw new Error(`Duplicate Show me handle "${handle.name}"`);
    if (!textWithin(handle.name, 64) || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(handle.name)
      || !textWithin(handle.description, 256)
      || !(handle.idDescription === "" || textWithin(handle.idDescription, 256))) {
      throw new Error(`Invalid Show me descriptor "${handle.name}"`);
    }
    byName.set(handle.name, handle);
  }
  let active: AbortController | undefined;
  function clear(): void {
    active?.abort();
    active = undefined;
  }
  return {
    describe: () => [...byName.values()].map(({ name, description, idDescription }) => ({ name, description, idDescription })),
    clear,
    async execute(action) {
      clear();
      const handle = byName.get(action?.handle);
      if (!handle || Object.keys(action).some(key => key !== "handle" && key !== "id" && key !== "highlight")
        || (handle.idDescription ? !textWithin(action.id, 256) : action.id !== undefined)
        || (action.highlight !== undefined && !validHighlight(action.highlight))) return "unavailable";

      const turn = new AbortController();
      active = turn;
      try {
        const target = await handle.open(action.id, turn.signal);
        if (turn.signal.aborted) return "superseded";
        if (!target?.isConnected || target.closest("[hidden], [inert]")
          || target.checkVisibility?.({ visibilityProperty: true }) === false) {
          clear();
          return "unavailable";
        }
        mark(target, action.highlight ?? {}, turn.signal);
        // Virtual rows and graph nodes can disappear while their answer is still open.
        const observer = new MutationObserver(() => { if (!target.isConnected) clear(); });
        observer.observe(target.ownerDocument, { childList: true, subtree: true });
        turn.signal.addEventListener("abort", () => observer.disconnect(), { once: true });
        return "shown";
      } catch {
        if (turn.signal.aborted) return "superseded";
        clear();
        return "unavailable";
      }
    },
  };
}

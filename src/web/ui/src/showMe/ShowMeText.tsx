import { Fragment, useState, type ReactNode } from "react";
import type { ShowMeAction, ShowMeOutcome, ShowMeRegistry } from "./index";
import { SHOW_ME_MARKER } from "./markers";
import "./showMeText.css";

export interface ShowMeTextProps {
  readonly text: string;
  readonly actions: Readonly<Record<string, ShowMeAction>>;
  readonly registry: ShowMeRegistry;
  readonly renderText?: (text: string) => ReactNode;
}

/** Also used for destinations the host knows directly from structured evidence in a saved answer. */
export function ShowMeButton({ action, registry, children, testId }: {
  action: ShowMeAction; registry: ShowMeRegistry; children?: ReactNode; testId?: string;
}) {
  const destination = action.highlight?.label ?? (typeof children === "string" ? children : action.id) ?? action.handle;
  const [status, setStatus] = useState<ShowMeOutcome | null>(null);
  const open = async () => {
    setStatus(null);
    const result = await registry.execute(action);
    if (result !== "superseded") setStatus(result);
  };

  return (
    <>
      <button type="button" className="show-me-button" onClick={() => void open()}
        aria-label={`Show me – ${destination}`} title={destination} data-show-me-handle={action.handle}
        data-show-me-id={action.id} data-testid={testId}>
        {children ?? "Show me"}
      </button>
      <span className={status === "shown" ? "show-me-spoken" : "show-me-feedback"} role="status">
        {status === "shown" ? `Showing ${destination}.` : status === "unavailable" ? "This destination is no longer available." : ""}
      </span>
    </>
  );
}

/** Replace a tool-issued marker in prose with a button. Other text goes through the host's renderer. */
export function ShowMeText({ text, actions, registry, renderText = (part) => part }: ShowMeTextProps) {
  const parts: ReactNode[] = [];
  let start = 0;
  for (const marker of text.matchAll(SHOW_ME_MARKER)) {
    const at = marker.index;
    if (at > start) parts.push(<Fragment key={`text-${start}`}>{renderText(text.slice(start, at))}</Fragment>);
    const action = actions[marker[1]!];
    parts.push(action
      ? <ShowMeButton key={at} action={action} registry={registry} />
      : <span key={at} className="show-me-feedback">Destination unavailable</span>);
    start = at + marker[0].length;
  }
  if (start < text.length) parts.push(<Fragment key={`text-${start}`}>{renderText(text.slice(start))}</Fragment>);
  return <>{parts}</>;
}

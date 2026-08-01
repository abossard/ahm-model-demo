import type { JSX } from "react";

export function ChatPanel(): JSX.Element {
  return (
    <aside className="chat-panel" aria-label="Health copilot" data-testid="chat-panel">
      <iframe
        className="chat-frame"
        src="/agent?embed=1"
        title="Health copilot chat"
        data-testid="chat-frame"
      />
    </aside>
  );
}

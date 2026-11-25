import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LobbyRow, Notice } from "@playground/contracts";
import { ago } from "./clock";

// The host's chrome already names the layer, so `title` is optional: leave it out unless the View is not alone on the page.
export function Frame(props: { title?: string; aside?: ReactNode; offline?: boolean; children: ReactNode }) {
  return (
    <main className="frame">
      {props.title || props.aside ? (
        <header className="frame-head">
          {props.title ? <h1 className="frame-title">{props.title}</h1> : null}
          {props.aside ? <div className="frame-aside">{props.aside}</div> : null}
        </header>
      ) : null}
      {props.offline ? <p className="frame-offline" role="status">The server is not answering. Trying again.</p> : null}
      {props.children}
    </main>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "danger" | "plain";
  busy?: boolean | undefined;
};

export function Button({ variant = "plain", busy = false, disabled, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`btn btn-${variant}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    />
  );
}

// A rule that did not apply, or a server that could not serve. Announced politely, never a modal.
export function NoticeBar({ notice, error }: { notice?: Notice | null; error?: string | null }) {
  if (error) {
    return <p className="notice" data-kind="error" role="alert" data-testid="notice">{error}</p>;
  }
  if (!notice) return null;
  return (
    <p className="notice" role="status" data-testid="notice" data-code={notice.code}>
      <code>{notice.code}</code>
      <span>{notice.message}</span>
    </p>
  );
}

export interface LobbyAction {
  testid: string;
  label: string;
  onClick(): void;
  primary?: boolean;
  quiet?: boolean;
}

const ROW_LABEL: Record<LobbyRow["status"], string> = { open: "Join", playing: "Watch", over: "Review" };

export function Lobby(props: {
  rows: readonly LobbyRow[];
  actions: readonly LobbyAction[];
  onOpen(row: LobbyRow): void;
  empty: string;
  busy?: boolean | undefined;
  now?: number;
}) {
  const now = props.now ?? Date.now();
  return (
    <section className="lobby" aria-label="Open tables">
      <div className="lobby-actions">
        {props.actions.map((action) => (
          <Button
            key={action.testid}
            data-testid={action.testid}
            variant={action.primary ? "primary" : action.quiet ? "quiet" : "plain"}
            busy={props.busy}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {props.rows.length === 0 ? <p className="lobby-empty">{props.empty}</p> : (
        <ul className="lobby-rows">
          {props.rows.map((row) => (
            <li key={row.tableId} className="lobby-row" data-testid="lobby-row" data-table={row.tableId} data-status={row.status}>
              <span className="lobby-title">{row.title}</span>
              <span className="lobby-meta">
                <span className="lobby-status" data-status={row.status}>{row.seatsTaken} of {row.seatsTotal} seats</span>
                <span>{ago(row.updatedAt, now)}</span>
              </span>
              <Button variant="quiet" disabled={props.busy} onClick={() => props.onOpen(row)}>{ROW_LABEL[row.status]}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

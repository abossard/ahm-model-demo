import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectTheme } from "../store/selectors";
import { closeChat } from "../store/uiSlice";

const READY_TIMEOUT_MS = 12000;
type ChatState = "loading" | "ready" | "error";

function postTheme(frame: HTMLIFrameElement | null, theme: "light" | "dark"): void {
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    { type: "health-agent-theme", version: 1, theme },
    window.location.origin,
  );
}

function hasOperationLine(message: string, operationId: string): boolean {
  const escapedId = operationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\boperation\\s+${escapedId}\\b`, "i").test(message);
}

export function ChatPanel(): JSX.Element {
  const dispatch = useAppDispatch();
  const theme = useAppSelector(selectTheme);
  const openerRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const themeRef = useRef<"light" | "dark">(theme);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ChatState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("The assistant is loading.");
  const [errorOperationId, setErrorOperationId] = useState<string | null>(null);
  const [errorRetryable, setErrorRetryable] = useState(true);
  const [readyOnce, setReadyOnce] = useState(false);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setState("loading");
    setErrorMessage("The assistant is loading.");
    setErrorOperationId(null);
    setErrorRetryable(true);
    const timeout = window.setTimeout(() => {
      setState("error");
      setErrorMessage(
        "The assistant is taking longer than expected. Try retrying.",
      );
      setErrorOperationId(null);
      setErrorRetryable(true);
    }, READY_TIMEOUT_MS);

    function onMessage(event: MessageEvent): void {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      const message = event.data as {
        readonly type?: string;
        readonly retryable?: boolean;
        readonly operationId?: string;
        readonly message?: string;
      };
      if (message.type === "health-agent-ready") {
        window.clearTimeout(timeout);
        setState("ready");
        setReadyOnce(true);
        postTheme(frameRef.current, themeRef.current);
      } else if (message.type === "health-agent-close") {
        window.clearTimeout(timeout);
        dispatch(closeChat());
      } else if (message.type === "health-agent-error") {
        window.clearTimeout(timeout);
        const retryable = message.retryable !== false;
        setState("error");
        setErrorMessage(
          typeof message.message === "string" && message.message.trim().length > 0
            ? message.message
            : retryable
            ? "The assistant is temporarily unavailable. Retry to reconnect."
            : "The assistant requires configuration before it can run.",
        );
        setErrorOperationId(
          typeof message.operationId === "string" ? message.operationId : null,
        );
        setErrorRetryable(retryable);
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      openerRef.current?.focus();
    };
  }, [dispatch, attempt]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const inModelPicker = path.some((target) => {
        if (!(target instanceof HTMLElement)) return false;
        return target.classList.contains("model-picker");
      });
      if (inModelPicker) return;
      dispatch(closeChat());
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [dispatch]);

  useEffect(() => {
    postTheme(frameRef.current, theme);
  }, [theme, state]);

  return (
    <aside className="chat-panel" aria-label="Health copilot" data-testid="chat-panel">
      <header className="chat-panel__header">
        <h3>Health copilot</h3>
        <button
          type="button"
          className="panel-close"
          aria-label="Close Health copilot"
          onClick={() => dispatch(closeChat())}
          data-testid="chat-close"
        >
          ×
        </button>
      </header>
      {state === "error" ? (
        <div className="report-error" role="alert" data-testid="chat-error">
          {errorMessage}
          {errorOperationId && !hasOperationLine(errorMessage, errorOperationId) ? (
            <div data-testid="chat-error-operation">Operation {errorOperationId}.</div>
          ) : null}
          {errorRetryable ? (
            <div className="chat-panel__actions">
              <button
                type="button"
                className="refresh-now"
                onClick={() => {
                  setState("loading");
                  setErrorOperationId(null);
                  setErrorRetryable(true);
                  setErrorMessage("The assistant is loading.");
                  setAttempt((current) => current + 1);
                  frameRef.current?.contentWindow?.location.reload();
                }}
              >
                Retry assistant
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <iframe
        ref={frameRef}
        className="chat-frame"
        src="/agent?embed=1"
        title="Health copilot chat"
        data-testid="chat-frame"
        hidden={state === "error" && !readyOnce}
      />
    </aside>
  );
}

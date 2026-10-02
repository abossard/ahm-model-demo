"use client";

import {
  CopilotChat,
  CopilotKitProvider,
  useConfigureSuggestions,
  useInterrupt,
} from "@copilotkit/react-core/v2";
import { useEffect, useRef, useState } from "react";

type HealthReportArgs = {
  entity_name: string;
  signal_name: string;
  health_state: string;
  value: number | null;
  reason_preset: string;
  reason: string;
  expires_in_minutes: number;
};

type ChatError = {
  operationId: string;
  retryable: boolean;
  message: string;
};

const STARTERS = [
  {
    title: "Summarize application health",
    message:
      "Read the Health Model now. Give the exact model name, observedAt, entity count, relationship count, health-state counts, and any unavailable information.",
  },
  {
    title: "Explain the request journey",
    message:
      "Read the exact entity request-journey now. Explain its health and dependencies, recent transitions, and canonical signal history. Label unavailable data and do not send a report.",
  },
  {
    title: "Inspect PostgreSQL health",
    message:
      "Read the exact entity postgres now. State current health, observedAt, recent transitions, and canonical signal history. Do not infer database connectivity from an absent signal.",
  },
  {
    title: "Stage report with approval",
    message:
      "Stage a health report and show every field for approval before sending it. This changes model signals only after explicit approval.",
  },
] as const;

function parentMessage(
  message:
    | { type: "health-agent-ready"; version: 1 }
    | { type: "health-agent-close"; version: 1 }
    | {
        type: "health-agent-error";
        version: 1;
        component: "agent-app";
        operationId: string;
        retryable: boolean;
        message: string;
      },
) {
  if (window.parent !== window) {
    window.parent.postMessage(message, window.location.origin);
  }
}

function HealthCopilot({
  embed,
  chatError,
}: {
  embed: boolean;
  chatError: ChatError | null;
}) {
  useEffect(() => {
    if (!embed) {
      return;
    }
    document.documentElement.dataset.agentReady = "true";
    parentMessage({ type: "health-agent-ready", version: 1 });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        parentMessage({ type: "health-agent-close", version: 1 });
      }
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      delete document.documentElement.dataset.agentReady;
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [embed]);

  useEffect(() => {
    if (!embed) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || typeof event.data !== "object") return;
      const message = event.data as {
        readonly type?: string;
        readonly theme?: "light" | "dark";
      };
      if (
        message.type === "health-agent-theme" &&
        (message.theme === "light" || message.theme === "dark")
      ) {
        document.documentElement.dataset.theme = message.theme;
        document.documentElement.classList.toggle("dark", message.theme === "dark");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embed]);

  useInterrupt({
    enabled: (event) => getReportArgs(event.value) !== null,
    render: ({ interrupt, resolve }) => {
      const args = getReportArgs(interrupt);
      return args ? (
        <HealthReportApproval
          args={args}
          approve={() => resolve({ accepted: true })}
          cancel={() => resolve({ accepted: false })}
        />
      ) : (
        <p role="status">Preparing report approval…</p>
      );
    },
  });

  useConfigureSuggestions({
    suggestions: [...STARTERS],
  });

  const chat = (
    <CopilotChat
      agentId="default"
      className="agent-chat"
      input={{
        textArea: { "aria-label": "Health copilot message input" },
        sendButton: { "aria-label": "Send message" },
        addMenuButton: { "aria-label": "Open assistant menu" },
      }}
      labels={{
        welcomeMessageText:
          "I can read the live Health Model and stage a bounded health report for your approval.",
        chatInputPlaceholder: "Ask about health, signals, or a report…",
      }}
    />
  );

  if (embed) {
    return (
      <main className="embed-shell" aria-label="Embedded health assistant">
        <p className="context-label">Application model scope only</p>
        {chat}
      </main>
    );
  }

  return (
    <main className="copilot-shell">
      <header className="copilot-header">
        <div>
          <p className="context-label">Azure Health Model / local assistant</p>
          <p className="context-label">Application model scope only</p>
          <h1>Health copilot</h1>
          <p className="lede">
            Ask about the live model, inspect an entity, or stage a bounded
            health report for explicit approval.
          </p>
        </div>
      </header>
      <section className="operational-note" aria-labelledby="truth-title">
        <span aria-hidden="true">◇</span>
        <div>
          <h2 id="truth-title">Grounded in fresh observations</h2>
          <p>
            Answers use the Health Pulse APIs. Report acceptance is pending and
            never means Azure has finished evaluation.
          </p>
        </div>
      </section>
      {chatError ? (
        <section className="chat-error" role="alert">
          <h2>Health copilot unavailable</h2>
          <p>
            {chatError.retryable
              ? "This operation can be retried."
              : "This operation requires a configuration change."}
          </p>
          <p>
            Operation <code>{chatError.operationId}</code>
          </p>
        </section>
      ) : null}
      {chat}
    </main>
  );
}

function HealthReportApproval({
  args,
  approve,
  cancel,
}: {
  args: HealthReportArgs;
  approve: () => unknown | Promise<unknown>;
  cancel: () => unknown | Promise<unknown>;
}) {
  const decided = useRef(false);
  const [decision, setDecision] = useState<"approved" | "cancelled" | null>(
    null,
  );
  const fields = [
    ["Entity", args.entity_name],
    ["Signal", args.signal_name],
    ["Requested state", args.health_state],
    ["Value", args.value === null ? "null" : args.value],
    ["Reason", args.reason],
    ["Expiry", `${args.expires_in_minutes ?? "—"} minute(s)`],
  ];

  async function decide(
    next: "approved" | "cancelled",
    action: () => unknown | Promise<unknown>,
  ) {
    if (decided.current) {
      return;
    }
    decided.current = true;
    setDecision(next);
    await action();
  }

  return (
    <section className="approval-surface" aria-labelledby="approval-title">
      <div>
        <h3 id="approval-title">Confirm health report</h3>
        <p>Nothing is sent until you approve these exact values.</p>
      </div>
      <dl className="approval-fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {!decision ? (
        <div className="approval-actions">
          <button
            className="approval-primary"
            type="button"
            onClick={() => void decide("approved", approve)}
          >
            Approve report
          </button>
          <button
            className="approval-secondary"
            type="button"
            onClick={() => void decide("cancelled", cancel)}
          >
            Cancel report
          </button>
        </div>
      ) : (
        <p role="status">
          {decision === "approved"
            ? "Approved. Sending one report…"
            : "Cancelled. No report will be sent."}
        </p>
      )}
    </section>
  );
}

function getReportArgs(value: unknown): HealthReportArgs | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const framework = (
    metadata as {
      agent_framework?: {
        function_call?: { name?: unknown; arguments?: unknown };
      };
    }
  ).agent_framework;
  if (framework?.function_call?.name !== "send_health_report") {
    return null;
  }
  const args = framework.function_call.arguments;
  return args && typeof args === "object"
    ? (args as HealthReportArgs)
    : null;
}

export default function HealthCopilotRoot({ embed }: { embed: boolean }) {
  const [chatError, setChatError] = useState<ChatError | null>(null);

  const readNested = (
    context: Record<string, unknown>,
    path: readonly string[],
  ): unknown => {
    let current: unknown = context;
    for (const key of path) {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };

  const readStatus = (context: Record<string, unknown>): number | null => {
    const raw = [
      context.status,
      context.statusCode,
      context.status_code,
      readNested(context, ["error", "status"]),
      readNested(context, ["error", "statusCode"]),
      readNested(context, ["response", "status"]),
      readNested(context, ["response", "statusCode"]),
    ];
    for (const candidate of raw) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value >= 100) return value;
    }
    return null;
  };

  const readErrorEnvelope = (
    context: Record<string, unknown>,
  ): { readonly retryable: boolean | null; readonly operationId: string | null; readonly message: string | null } => {
    const parseObject = (value: unknown): Record<string, unknown> | null => {
      if (value && typeof value === "object") {
        return value as Record<string, unknown>;
      }
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value) as unknown;
          return parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
      return null;
    };

    const candidates = [
      context,
      context.error,
      context.payload,
      context.body,
      context.data,
      context.responseText,
      context.message,
      readNested(context, ["error", "payload"]),
      readNested(context, ["event"]),
      readNested(context, ["response", "body"]),
      readNested(context, ["response", "data"]),
      readNested(context, ["response", "text"]),
    ];
    for (const value of candidates) {
      const parsed = parseObject(value);
      if (!parsed) continue;
      const error = parseObject(parsed.error);
      const envelope = (error ?? parsed) as Record<string, unknown>;
      const hasEnvelopeFields =
        typeof envelope.retryable === "boolean" ||
        typeof envelope.operationId === "string" ||
        typeof envelope.message === "string";
      if (!hasEnvelopeFields) continue;
      return {
        retryable:
          typeof envelope.retryable === "boolean" ? envelope.retryable : null,
        operationId:
          typeof envelope.operationId === "string" ? envelope.operationId : null,
        message: typeof envelope.message === "string" ? envelope.message : null,
      };
    }
    return { retryable: null, operationId: null, message: null };
  };

  const reportError = (event: {
    code: unknown;
    context: Record<string, unknown>;
  }) => {
    const status = readStatus(event.context);
    const fromEnvelope = readErrorEnvelope(event.context);
    const runtimeErrorCode = readNested(event.context, [
      "runtimeErrorCode",
    ]);
    const runEventCode = readNested(event.context, ["event", "code"]);
    const rawCode =
      typeof runtimeErrorCode === "string"
        ? runtimeErrorCode.toLowerCase()
        : typeof runEventCode === "string"
          ? runEventCode.toLowerCase()
          : typeof event.code === "string"
            ? event.code.toLowerCase()
            : "";
    const nonRetryableCodes = new Set([
      "agent_runtime_unconfigured",
      "configuration_required",
      "not_configured",
    ]);
    const readOperationIdFromMessage = (value: string | null): string | null => {
      if (!value) return null;
      const match = value.match(/\bop[-_][a-z0-9][-_a-z0-9]{2,}\b/);
      return match ? match[0] : null;
    };
    const retryable =
      fromEnvelope.retryable ??
      (nonRetryableCodes.has(rawCode)
        ? false
        :
      (status === null ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500 ||
        /TIMEOUT|RATE|UNAVAILABLE|INCOMPLETE_STREAM/i.test(String(event.code))));
    const operationId =
      fromEnvelope.operationId ??
      readOperationIdFromMessage(fromEnvelope.message) ??
      crypto.randomUUID().replaceAll("-", "");
    const message =
      fromEnvelope.message ??
      (retryable
        ? "The assistant is temporarily unavailable. Retry to reconnect."
        : "The assistant requires configuration before it can run.");
    const error = {
      operationId,
      retryable,
      message,
    };
    setChatError(error);
    if (embed) {
      parentMessage({
        type: "health-agent-error",
        version: 1,
        component: "agent-app",
        ...error,
      });
    }
  };

  return (
    <CopilotKitProvider
      runtimeUrl="/agent/api/copilotkit"
      onError={reportError}
    >
      <HealthCopilot embed={embed} chatError={chatError} />
    </CopilotKitProvider>
  );
}

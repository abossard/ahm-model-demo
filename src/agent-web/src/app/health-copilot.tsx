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
};

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
        window.parent.document
          .getElementById("copilot-close")
          ?.click();
      }
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      delete document.documentElement.dataset.agentReady;
      document.removeEventListener("keydown", closeOnEscape, true);
    };
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
    suggestions: [
      {
        title: "Summarize the live model",
        message:
          "Read the Health Model now and summarize its entities, relationships, states, signals, and observation time.",
      },
      {
        title: "Explain an entity",
        message:
          "Ask me which entity to inspect, then read its current state, recent transitions, and canonical signal history.",
      },
      {
        title: "Stage a health report",
        message:
          "Help me stage a health report and show every field for approval before sending it.",
      },
    ],
  });

  const chat = (
    <CopilotChat
      agentId="default"
      className="agent-chat"
      labels={{
        welcomeMessageText:
          "I can read the live Health Model and stage a bounded health report for your approval.",
        chatInputPlaceholder: "Ask about health, signals, or a report…",
      }}
    />
  );

  if (embed) {
    return (
      <main
        className="embed-shell"
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            parentMessage({ type: "health-agent-close", version: 1 });
          }
        }}
      >
        {chat}
      </main>
    );
  }

  return (
    <main className="copilot-shell">
      <header className="copilot-header">
        <div>
          <p className="context-label">Azure Health Model / local assistant</p>
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
  const reportError = (event: {
    code: unknown;
    context: Record<string, unknown>;
  }) => {
    const status = Number(event.context.status ?? event.context.statusCode);
    const retryable =
      !Number.isFinite(status) ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500 ||
      /TIMEOUT|RATE|UNAVAILABLE|INCOMPLETE_STREAM/i.test(String(event.code));
    const error = {
      operationId: crypto.randomUUID().replaceAll("-", ""),
      retryable,
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

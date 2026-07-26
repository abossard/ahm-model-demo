"use client";

import {
  CopilotKitProvider,
  CopilotPopup,
  useConfigureSuggestions,
  useInterrupt,
} from "@copilotkit/react-core/v2";
import { useState } from "react";

type HealthReportArgs = {
  entity_name: string;
  signal_name: string;
  health_state: string;
  value: number | null;
  reason_preset: string;
  reason: string;
  expires_in_minutes: number;
};

function HealthCopilot() {
  const [chatError, setChatError] = useState<{
    operationId: string;
    retryable: boolean;
  } | null>(null);

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

  return (
    <main className="copilot-shell">
      <header className="copilot-header">
        <div>
          <p className="context-label">Azure Health Model / live assistant</p>
          <h1>Health copilot</h1>
          <p className="lede">
            Ask about the live model, inspect an entity, or stage a bounded
            health report for explicit approval.
          </p>
        </div>
        <a className="return-link" href={process.env.NEXT_PUBLIC_HEALTH_APP_URL || "/"}>
          Return to Health Pulse
        </a>
      </header>

      <section className="operational-note" aria-labelledby="truth-title">
        <span aria-hidden="true">◇</span>
        <div>
          <h2 id="truth-title">Grounded in fresh observations</h2>
          <p>
            Answers use the Health Pulse APIs. Report acceptance is shown as
            pending; it never implies that Azure has finished evaluation.
          </p>
        </div>
      </section>

      <section className="chat-guide" aria-labelledby="guide-title">
        <h2 id="guide-title">Open the chat to begin</h2>
        <p>
          Every report preview includes entity, signal, state, value, reason,
          and expiry. Nothing is sent until you approve the CopilotKit action.
        </p>
        <ul>
          <li>Whole-model answers include the observation timestamp.</li>
          <li>Entity answers separate state, transitions, and signal history.</li>
          <li>Unavailable data is labeled instead of inferred.</li>
        </ul>
      </section>

      {chatError ? (
        <section
          className="chat-error"
          role="alert"
          data-retryable={chatError.retryable}
        >
          <h2>Health copilot unavailable</h2>
          <p>
            {chatError.retryable
              ? "This operation can be retried."
              : "This operation cannot be retried without a configuration change."}
          </p>
          <p>
            Operation <code>{chatError.operationId}</code>
          </p>
        </section>
      ) : null}

      <CopilotPopup
        agentId="default"
        defaultOpen
        onError={(event) => {
          if (!("code" in event) || !("context" in event)) {
            return;
          }
          const { code, context } = event;
          const status = Number(context.status ?? context.statusCode);
          const retryable =
            !Number.isFinite(status) ||
            status === 408 ||
            status === 409 ||
            status === 429 ||
            status >= 500 ||
            /TIMEOUT|RATE|UNAVAILABLE|INCOMPLETE_STREAM/i.test(code);
          setChatError({
            operationId: crypto.randomUUID().replaceAll("-", ""),
            retryable,
          });
        }}
        labels={{
          welcomeMessageText:
            "I can read the live Health Model and stage a bounded health report for your approval.",
          chatInputPlaceholder: "Ask about health, signals, or a report…",
        }}
      />
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
            : decision === "cancelled"
              ? "Cancelled. No report will be sent."
              : "Preparing approval…"}
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

export default function Home() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit">
      <HealthCopilot />
    </CopilotKitProvider>
  );
}

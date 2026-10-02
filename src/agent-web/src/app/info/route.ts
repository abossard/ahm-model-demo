import { randomUUID } from "node:crypto";

const agentOrigin = new URL(
  process.env.AGENT_URL || "http://127.0.0.1:8000/",
);
const AUTH_MODES = new Set(["managed-identity", "default-azure-credential"]);

export async function GET() {
  const operationId = randomUUID().replaceAll("-", "");
  try {
    const response = await fetch(new URL("ready", agentOrigin), {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error("agent unavailable");
    }
    const payload = await response.json();
    if (payload?.status !== "ready" || typeof payload?.deployment !== "string") {
      throw new Error("agent response invalid");
    }
    const authentication =
      typeof payload?.authentication === "string" &&
      AUTH_MODES.has(payload.authentication)
        ? payload.authentication
        : null;
    if (!authentication) {
      throw new Error("agent response invalid");
    }
    return Response.json({
      status: "ready",
      component: "health-copilot-agent",
      authentication,
      deployment: payload.deployment,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "agent_app_unavailable",
          message: "The agent runtime is temporarily unavailable.",
          retryable: true,
          operationId,
        },
      },
      { status: 503 },
    );
  }
}

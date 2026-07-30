import { HttpAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";

const agentUrl = process.env.AGENT_URL || "http://127.0.0.1:8000/";

const runtime = new CopilotRuntime({
  agents: {
    default: new HttpAgent({ url: agentUrl }),
  },
  runner: new InMemoryAgentRunner(),
});

const endpoint = createCopilotEndpoint({
  runtime,
  basePath: "/api/copilotkit",
});

export const GET = handle(endpoint);
export const POST = handle(endpoint);
export const PATCH = handle(endpoint);
export const DELETE = handle(endpoint);

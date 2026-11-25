import { EXTENSION_ID, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LAB_NOTES_URI, VIEWS, VIEW_MIME, VIEW_NAMES } from "@playground/contracts";
import { registerTools } from "./tools";
import type { ToolContext } from "./tools";
import { LAB_NOTES } from "./views";
import type { Views } from "./views";

const VIEW_META = { ui: { csp: {}, prefersBorder: false } };

export function createMcpServer(context: ToolContext, views: Views): McpServer {
  const server = new McpServer(
    { name: "playground-mcp", version: "1.0.0" },
    { capabilities: { logging: {}, extensions: { [EXTENSION_ID]: { mimeTypes: [VIEW_MIME] } } } },
  );

  registerTools(server, context);

  for (const name of VIEW_NAMES) {
    registerAppResource(server, name, VIEWS[name], { mimeType: VIEW_MIME, _meta: VIEW_META }, async (uri) => {
      const text = views.docs[name];
      if (text === undefined) throw new Error(`The ${name} View is not built.`);
      return { contents: [{ uri: uri.href, mimeType: VIEW_MIME, text, _meta: VIEW_META }] };
    });
  }

  server.registerResource("lab-notes", LAB_NOTES_URI, { mimeType: "text/markdown", title: "Lab notes" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: LAB_NOTES }],
  }));

  return server;
}

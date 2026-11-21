import { workspaceLink } from "../auth/workspaceLink";
import { useEffect, useRef, useState } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppBridge, PostMessageTransport, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authorized } from "../store/api";
import { searchFromSelection } from "../model/selection";
import { useStore } from "../store/store";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { UserMenu } from "./UserMenu";
import "./builderHost.css";

function messageOf(result: CallToolResult): string {
  return result.content.find(item => item.type === "text")?.text ?? "The builder is unavailable.";
}

export default function BuilderHost() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const theme = useStore(s => s.theme);
  useEffect(() => {
    const iframe = frame.current;
    const child = iframe?.contentWindow;
    if (!iframe || !child) return;
    let closed = false;
    const client = new Client({ name: "Health Pulse", version: "1" }, {
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } },
    });
    const bridge = new AppBridge(null, { name: "Health Pulse", version: "1" }, { serverTools: {}, downloadFile: {} }, { hostContext: {theme} });
    const timer = window.setTimeout(() => fail("The builder took too long to open. Try again."), 30000);
    function fail(message: string) {
      if (!closed) setError(message);
    }
    async function connect() {
      await client.connect(new StreamableHTTPClientTransport(new URL("/api/builder/mcp", location.origin), {
        fetch: (url, init) => authorized(String(url), init),
      }));
      const list = await client.listTools();
      const entry = list.tools.find(t => t.name === "builder_open");
      const uri = (entry?._meta?.ui as {resourceUri?: string} | undefined)?.resourceUri;
      if (!uri || !client.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/ui"])
        throw new Error("The server does not offer the health model builder.");
      const sessionId = new URLSearchParams(location.search).get("session");
      const [resource, initial] = await Promise.all([
        client.readResource({ uri }),
        client.callTool({ name: "builder_open", arguments: sessionId ? {sessionId} : {} }) as Promise<CallToolResult>,
      ]);
      if (initial.isError) throw new Error(messageOf(initial));
      const content = resource.contents.find(r => r.uri === uri && r.mimeType === RESOURCE_MIME_TYPE);
      if (!content || !("text" in content)) throw new Error("The builder View could not be read.");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content.text)));
      const digest = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
      bridge.oninitialized = () => {
        void bridge.sendToolResult(initial).then(() => {
          if (!closed) { clearTimeout(timer); setReady(true); }
        }).catch(e => fail(String(e)));
      };
      bridge.ondownloadfile = async ({contents}) => {
        const file = contents[0];
        if (contents.length !== 1 || file?.type !== "resource" || !("text" in file.resource) ||
            !/^file:\/\/\/(plan|modelspec)\.md$/.test(file.resource.uri)) return {isError: true};
        const href = URL.createObjectURL(new Blob([file.resource.text], {type: "text/markdown;charset=utf-8"}));
        const a = document.createElement("a");
        a.href = href; a.download = file.resource.uri.split("/").pop()!; a.click();
        window.setTimeout(() => URL.revokeObjectURL(href), 1000);
        return {};
      };
      bridge.oncalltool = async params => {
        if (!list.tools.some(t => t.name === params.name)) throw new Error("Unknown builder action.");
        const result = await client.callTool(params, undefined, {timeout: 600000}) as CallToolResult;
        const state = result.structuredContent;
        if (!closed && !result.isError && state) {
          if (typeof state.sessionId === "string") {
            const url = new URL(location.href);
            url.searchParams.set("session", state.sessionId);
            history.replaceState(null, "", url);
          }
          if (params.name === "builder_open_model") {
            const target = state.target as {name:string; resourceGroup:string; subscriptionId:string};
            window.location.assign(workspaceLink("/" + searchFromSelection(target)));
          }
        }
        return result;
      };
      if (closed) return;
      await bridge.connect(new PostMessageTransport(child!, child!));
      if (!closed) iframe!.src = "/builder/view/" + digest;
    }
    connect().catch(e => fail(e instanceof Error ? e.message : "The builder could not be opened."));
    return () => {
      closed = true; clearTimeout(timer);
      void bridge.close().catch(() => {});
      void client.close().catch(() => {});
    };
  }, [retry, theme]);
  return <main className="hp-builder-host">
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme}>
      <nav className="hp-builder-nav" aria-label="Workspace"><a href={workspaceLink("/")}>‹ Health models</a><UserMenu /></nav>
    </FluentProvider>
    {error ? <div role="alert">{error} <button onClick={() => {setError(""); setReady(false); setRetry(n=>n+1);}}>Try again</button></div> :
      !ready && <p role="status">Opening health model builder…</p>}
    <iframe ref={frame} title="Health model builder" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" hidden={!ready || Boolean(error)} />
  </main>;
}

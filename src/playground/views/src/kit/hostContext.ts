import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";

// The host's context, re-read whenever the host changes it (theme, display mode, size).
export function useHostContext(app: Pick<App, "getHostContext" | "addEventListener" | "removeEventListener">): McpUiHostContext {
  const [context, setContext] = useState<McpUiHostContext>(() => ({ ...app.getHostContext() }));
  useEffect(() => {
    const listener = () => setContext({ ...app.getHostContext() });
    app.addEventListener("hostcontextchanged", listener);
    return () => app.removeEventListener("hostcontextchanged", listener);
  }, [app]);
  return context;
}

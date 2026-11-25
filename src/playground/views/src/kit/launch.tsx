import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Player } from "@playground/contracts";
import { useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Frame } from "./components";
import { connect, playerOf, type Connected, type ConnectOptions, type Theme } from "./connect";
import { errorText, log, setLogView } from "./log";
import "./fonts.css";
import "./tokens.css";
import "./kit.css";

export interface ViewContext {
  app: App;
  args: Record<string, unknown>;
  first: CallToolResult;
  theme: Theme;
  player: Player;
}

type Boot = { state: "connecting" } | { state: "failed"; message: string } | { state: "ready"; context: ViewContext };

function Root({ name, title, options, Content }: {
  name: string; title: string; options: ConnectOptions; Content: ComponentType<ViewContext>;
}) {
  const [boot, setBoot] = useState<Boot>({ state: "connecting" });
  useEffect(() => {
    connect(name, options).then(
      (connected: Connected) => setBoot({ state: "ready", context: { ...connected, player: playerOf(connected.args) } }),
      (error: unknown) => setBoot({ state: "failed", message: errorText(error) }),
    );
  }, [name, options]);
  if (boot.state === "ready") return <Content {...boot.context} />;
  return (
    <Frame title={title}>
      <p role={boot.state === "failed" ? "alert" : "status"}>
        {boot.state === "failed" ? boot.message : "Waiting for the host."}
      </p>
    </Frame>
  );
}

// The one line of a View's main.tsx: connect, then render `Content` with what the host handed over.
export function launch(name: string, title: string, Content: ComponentType<ViewContext>, options: ConnectOptions = {}): void {
  setLogView(name);
  document.documentElement.dataset["view"] = name;
  window.addEventListener("error", (event) => log.error("uncaught", { error: event.message }));
  window.addEventListener("unhandledrejection", (event) => log.error("unhandled rejection", { error: errorText(event.reason) }));
  createRoot(document.getElementById("root")!).render(<Root name={name} title={title} options={options} Content={Content} />);
}

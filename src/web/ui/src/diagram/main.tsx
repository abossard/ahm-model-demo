import { App } from "@modelcontextprotocol/ext-apps";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { createRoot } from "react-dom/client";
import { healthVariables } from "../model/palette";
import { DiagramView } from "./DiagramView";
import type { DiagramData } from "./data";

const root = createRoot(document.getElementById("diagram-root")!);
const app = new App({ name: "Health model diagram", version: "1" });
let scheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let diagram: DiagramData | null = null;

function render() {
  root.render(<FluentProvider theme={scheme === "dark" ? webDarkTheme : webLightTheme}><DiagramView diagram={diagram} /></FluentProvider>);
}
function theme(value: unknown) {
  if (value !== "light" && value !== "dark") return;
  scheme = value;
  const style = document.documentElement.style;
  style.colorScheme = value;
  for (const [key, color] of Object.entries(healthVariables(value))) style.setProperty("--" + key, color);
  render();
}
theme(scheme);
app.onhostcontextchanged = context => theme(context.theme);
app.ontoolresult = result => {
  diagram = (result.structuredContent?.diagram as DiagramData | null) ?? null;
  render();
};
void app.connect().then(() => theme(app.getHostContext()?.theme)).catch(() => {
  root.render(<p role="alert">The dependency map could not connect to the assistant.</p>);
});

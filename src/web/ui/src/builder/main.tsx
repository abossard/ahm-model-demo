import { App } from "@modelcontextprotocol/ext-apps";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { createRoot } from "react-dom/client";
import { Builder } from "./Builder";
import { builderTools, toolValue } from "./bridge";
import { healthVariables } from "../model/palette";
import { errorMessage, type BuilderState } from "./types";
import "./builder.css";

const root = createRoot(document.getElementById("builder-root")!);
const app = new App({ name: "Health model builder", version: "1.0.0" });
const tools = builderTools(app);
let scheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let initial: BuilderState | undefined;
function renderBuilder() {
  if (initial) root.render(
    <FluentProvider theme={scheme === "dark" ? webDarkTheme : webLightTheme}>
      <Builder initial={initial} tools={tools} />
    </FluentProvider>,
  );
}
function failed(error: unknown) {
  initial = undefined;
  root.render(
    <main className="builder" role="alert">
      <h2>Could not open the builder</h2>
      <p>{errorMessage(error)}</p>
    </main>,
  );
}
function theme(value: unknown) {
  if (value !== "light" && value !== "dark") return;
  const style = document.documentElement.style;
  style.colorScheme = value;
  for (const [key, color] of Object.entries(healthVariables(value))) style.setProperty("--" + key, color);
  if (scheme !== value) {
    scheme = value;
    renderBuilder();
  }
}
theme(scheme);
app.onhostcontextchanged = (context) => theme(context.theme);
app.ontoolresult = (result) => {
  try {
    initial = toolValue<BuilderState>(result);
    renderBuilder();
  } catch (error) {
    failed(error);
  }
};
root.render(
  <main className="builder" role="status">
    Opening health model builder…
  </main>,
);
void app
  .connect()
  .then(() => theme(app.getHostContext()?.theme))
  .catch(failed);

import { createRoot } from "react-dom/client";
// The faces ship in the bundle. Nothing here leaves the origin.
import "@fontsource-variable/big-shoulders-display";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./design/tokens.css";
import "./design/base.css";
import "./ladder/ladder.css";
import "./stage/stage.css";
import "./drawer/drawer.css";
import "./lab/lab.css";
import { App } from "./app/App";

createRoot(document.getElementById("root")!).render(<App />);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { actions } from "./store/store";
import { App } from "./components/App";
import { AuthGate } from "./components/AuthGate";
import { applyTheme, detectInitialTheme } from "./model/theme";
import "@xyflow/react/dist/style.css";
import "./ui.css";

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");

const theme = detectInitialTheme(window);
applyTheme(theme, document);
actions.initializeTheme(theme);

createRoot(container).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);

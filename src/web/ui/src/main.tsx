import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { actions } from "./store/store";
import { App } from "./components/App";
import { AuthGate } from "./components/AuthGate";
import { applyTheme, detectInitialTheme } from "./model/theme";
import "@xyflow/react/dist/style.css";
import "./ui.css";

const container = document.getElementById("root");
const BuilderHost = lazy(() => import("./components/BuilderHost"));
if (!container) throw new Error("root container missing");

const theme = detectInitialTheme(window);
applyTheme(theme, document);
actions.initializeTheme(theme);

// MSAL restores the original address during AuthGate startup, before it mounts this page.
function SignedInPage() {
  if (window.location.pathname !== "/builder") return <App />;
  return (
    <Suspense fallback={<p role="status">Opening health model builder…</p>}>
      <BuilderHost />
    </Suspense>
  );
}

createRoot(container).render(
  <StrictMode>
    <AuthGate><SignedInPage /></AuthGate>
  </StrictMode>,
);

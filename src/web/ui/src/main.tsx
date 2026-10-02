import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { store } from "./store/store";
import { App } from "./components/App";
import { applyTheme, detectInitialTheme } from "./model/theme";
import "@xyflow/react/dist/style.css";
import "./ui.css";

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");

applyTheme(detectInitialTheme(window), document);

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);

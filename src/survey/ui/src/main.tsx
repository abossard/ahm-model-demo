import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { App } from "./components/App";
import { store } from "./store";
import "./ui.css";

const root = document.getElementById("root");
if (!root) throw new Error("Survey root is missing");
createRoot(root).render(<Provider store={store}><App /></Provider>);

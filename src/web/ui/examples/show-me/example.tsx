import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createShowMe, type ShowMeAction } from "../../src/showMe";
import { ShowMeText } from "../../src/showMe/ShowMeText";
import { ShowMeNextSteps } from "../../src/showMe/NextSteps";

const checks = document.getElementById("checks")!;
const historyPanel = document.getElementById("history")!;
const dialog = document.querySelector<HTMLDialogElement>("#migration-detail")!;

function openView(view: "checks" | "history") {
  if (view === "history" && dialog.open) dialog.close();
  checks.hidden = view !== "checks";
  historyPanel.hidden = view !== "history";
  for (const link of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
    if (link.hash === "#" + view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (location.hash !== "#" + view) history.pushState(null, "", "#" + view);
  return view === "checks" ? checks : historyPanel;
}

function openMigration() {
  openView("checks");
  if (!dialog.open) dialog.show();
  return dialog;
}

const registry = createShowMe([
  {
    name: "release", description: "Inspect this release's checks and history.",
    idDescription: "history, or check/<id> from the checks with a detail dialog. This release has check/migration.",
    open: id => id === "history" ? openView("history") : id === "check/migration" ? openMigration() : null,
  },
]);
window.addEventListener("hashchange", () => {
  registry.clear();
  openView(location.hash === "#history" ? "history" : "checks");
});
document.getElementById("migration")!.onclick = openMigration;
dialog.addEventListener("close", () => {
  if (!dialog.open && dialog.hasAttribute("data-show-me-highlight")) registry.clear();
});
openView(location.hash === "#history" ? "history" : "checks");

// A saved example reply. The health-model app gets the same map from its agent.
const actions = {
  "1": { handle: "release", id: "check/migration", highlight: { color: "amber", label: "Required for release" } },
  "2": { handle: "release", id: "history", highlight: { color: "violet", label: "Latest run" } },
} satisfies Record<string, ShowMeAction>;

function Assistant() {
  const [step, setStep] = useState(0);
  const handles = registry.describe();
  async function advance() {
    if (step === 2) {
      registry.clear();
      setStep(0);
    } else if (await registry.execute(step === 0 ? actions["1"] : actions["2"]) === "shown") {
      setStep(step + 1);
    }
  }
  return <>
    <h2>Assistant</h2>
    <p className="question">Can we ship release 2.8?</p>
    <p><ShowMeText registry={registry} actions={actions}
      text="The database migration is waiting for review. [[show:1]] Approval is the last release check." /></p>
    <p><ShowMeText registry={registry} actions={actions}
      text="The rollback rehearsal passed on the latest run. [[show:2]]" /></p>
    <ShowMeNextSteps registry={registry} actions={actions} choices={[
      { id: "1", label: "Inspect the migration" }, { id: "2", label: "See release history" },
    ]} />
    <button type="button" onClick={() => void advance()}>
      {["Walk through the checks", "Next · Release history", "Finish walkthrough"][step]}
    </button>
    <details>
      <summary>Handles for this turn</summary>
      <dl>{handles.map(handle => <div key={handle.name}>
        <dt>{handle.name}</dt><dd>{handle.description} {handle.idDescription || "Takes no ID."}</dd>
      </div>)}</dl>
    </details>
  </>;
}

createRoot(document.getElementById("assistant")!).render(<Assistant />);

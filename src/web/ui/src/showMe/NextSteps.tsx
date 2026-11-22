import { useId, useState } from "react";
import type { NextStep, ShowMeAction, ShowMeRegistry } from "./index";
import "./showMeText.css";
import "./nextSteps.css";

/** A tour supplies its own branch ids. Saved answers use ids from their action map. */
export function NextSteps({ choices, onChoose, label = "Where next?", disabled = false }: {
  choices: readonly NextStep[];
  onChoose: (id: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const title = useId();
  if (!choices.length) return null;
  return <div className="next-steps" role="group" aria-labelledby={title}>
    <span id={title} className="next-steps-label">{label}</span>
    <div className="next-steps-choices">
      {choices.map(choice => <button type="button" key={choice.id} data-next-step={choice.id}
        disabled={disabled} onClick={() => onChoose(choice.id)}>
        {choice.label}<span aria-hidden="true">→</span>
      </button>)}
    </div>
  </div>;
}

export function ShowMeNextSteps({ choices, actions, registry }: {
  choices: readonly NextStep[];
  actions: Readonly<Record<string, ShowMeAction>>;
  registry: ShowMeRegistry;
}) {
  const [feedback, setFeedback] = useState<{ shown: boolean; message: string } | null>(null);
  const choose = async (id: string) => {
    setFeedback(null);
    const action = actions[id];
    const outcome = action ? await registry.execute(action) : "unavailable";
    if (outcome === "unavailable") setFeedback({ shown: false, message: "This destination is no longer available." });
    if (outcome === "shown") setFeedback({ shown: true, message: "Destination opened." });
  };
  return <>
    <NextSteps choices={choices} onChoose={id => void choose(id)} />
    <span role="status" className={feedback?.shown ? "show-me-spoken" : "show-me-feedback"}>{feedback?.message}</span>
  </>;
}

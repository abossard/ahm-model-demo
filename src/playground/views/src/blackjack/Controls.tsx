import type { BlackjackView } from "@playground/contracts";
import { useEffect } from "react";
import { Disc } from "./Cards";
import { betChoices, canBet, canSit, mySeat, myActions, stateText, stepBet, type Action } from "./logic";

interface Props {
  view: BlackjackView;
  busy: boolean;
  onSit(): void;
  onLeave(): void;
  onBet(amount: number): void;
  onAct(action: Action): void;
}

const KEYS: Record<string, Action> = { h: "hit", s: "stand", d: "double" };
const LABEL: Record<Action, string> = { hit: "Hit", stand: "Stand", double: "Double" };

export function Controls({ view, busy, onSit, onLeave, onBet, onAct }: Props) {
  const actions = myActions(view);
  const seat = mySeat(view);

  // H, S and D play the hand. Typing in a field never reaches this.
  useEffect(() => {
    if (actions.length === 0 || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = KEYS[event.key.toLowerCase()];
      if (action && actions.includes(action)) onAct(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, busy, onAct]);

  if (canSit(view)) {
    return (
      <div className="controls">
        <p className="muted">{stateText(view)}</p>
        <button type="button" className="btn btn-primary" data-testid="sit" disabled={busy} onClick={onSit}>Take a seat</button>
      </div>
    );
  }
  if (actions.length > 0) {
    return (
      <div className="controls" role="group" aria-label="Your hand">
        <div className="act-row">
          {actions.map((action) => (
            <button key={action} type="button" className={`btn btn-big ${action === "stand" ? "" : "btn-primary"}`} data-testid={`act-${action}`}
              disabled={busy} onClick={() => onAct(action)}>
              {LABEL[action]}<kbd aria-hidden="true">{action[0]!.toUpperCase()}</kbd>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (canBet(view) && seat) {
    const choices = betChoices(view);
    const down = stepBet(view, -1);
    const up = stepBet(view, 1);
    return (
      <div className="controls" role="group" aria-label="Your bet">
        <div className="bet-row">
          <div className="bet-chips">
            {choices.map((value) => (
              <button key={value} type="button" className="btn chip-btn" data-testid={`bet-${value}`} aria-pressed={seat.bet === value}
                disabled={busy} onClick={() => onBet(value)}>
                <Disc value={value} /><span className="num">{value}</span>
              </button>
            ))}
          </div>
          <div className="stepper">
            <button type="button" className="btn btn-quiet" aria-label="Lower bet" data-testid="bet-down" disabled={busy || down === null}
              onClick={() => down !== null && onBet(down)}>&minus;</button>
            <span className="num bet-now" data-testid="bet-now">{seat.bet}</span>
            <button type="button" className="btn btn-quiet" aria-label="Raise bet" data-testid="bet-up" disabled={busy || up === null}
              onClick={() => up !== null && onBet(up)}>+</button>
          </div>
        </div>
        <button type="button" className="btn btn-quiet btn-small" data-testid="leave" disabled={busy} onClick={onLeave}>Leave table</button>
      </div>
    );
  }
  return (
    <div className="controls">
      <p className="muted">{stateText(view)}</p>
      {seat && <button type="button" className="btn btn-quiet btn-small" data-testid="leave" disabled={busy} onClick={onLeave}>Leave table</button>}
    </div>
  );
}

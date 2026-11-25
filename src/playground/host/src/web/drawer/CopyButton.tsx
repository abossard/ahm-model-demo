import { useEffect, useState, type ReactNode } from "react";
import { copyText } from "../app/clipboard";

type Phase = "idle" | "copied" | "failed";

export function CopyButton(props: { text: () => string; what: string; testId?: string; children: ReactNode; title?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  useEffect(() => {
    if (phase === "idle") return;
    const timer = setTimeout(() => setPhase("idle"), 1400);
    return () => clearTimeout(timer);
  }, [phase]);
  return (
    <button
      type="button" className="btn btn-quiet" data-testid={props.testId} title={props.title}
      onClick={async () => setPhase((await copyText(props.text(), props.what)) ? "copied" : "failed")}
    >
      {phase === "copied" ? "Copied" : phase === "failed" ? "Copy failed" : props.children}
      <span className="sr-only" role="status">{phase === "copied" ? `${props.what} copied` : ""}</span>
    </button>
  );
}

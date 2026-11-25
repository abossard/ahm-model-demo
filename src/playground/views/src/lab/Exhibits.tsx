import { useEffect, useRef, useState, type ReactNode } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { LAB_NOTES_URI, type Player } from "@playground/contracts";
import { Button, call, errorText, log, useHostContext } from "../kit";
import { clip } from "./catalog";

export interface ExhibitProps {
  app: App;
  player: Player;
  // Records the exhibit as tried. Safe to call again.
  finish(): Promise<void>;
}

type Run = { kind: "idle" | "running" | "ok" | "error"; text: string };

// The same three lines in every exhibit: run, show what came back, record it.
// `work` returns the readout, or null when the host declined.
function useRun(finish: () => Promise<void>) {
  const [run, setRun] = useState<Run>({ kind: "idle", text: "" });
  async function start(work: () => Promise<string | null>) {
    setRun({ kind: "running", text: "" });
    try {
      const text = await work();
      if (text === null) return setRun({ kind: "error", text: "The host declined." });
      setRun({ kind: "ok", text });
      await finish();
    } catch (error) {
      log.warn("exhibit failed", { error: errorText(error) });
      setRun({ kind: "error", text: errorText(error) });
    }
  }
  return { run, start };
}

function Readout({ run, children }: { run?: Run; children?: ReactNode }) {
  const state = run?.kind ?? "idle";
  return (
    <output className="lab-readout" data-state={state}>
      {children ?? (run && run.kind !== "idle" ? (run.kind === "running" ? "Waiting for the host." : run.text) : "")}
    </output>
  );
}

function Action(props: { id: string; label: string; run: Run; onClick(): void }) {
  return (
    <Button variant="primary" busy={props.run.kind === "running"} onClick={props.onClick} data-testid={`exhibit-${props.id}`}>
      {props.label}
    </Button>
  );
}

const json = (value: unknown) => JSON.stringify(value);

export function CallTool({ app, player, finish }: ExhibitProps) {
  const [text, setText] = useState("Is anyone out there?");
  const { run, start } = useRun(finish);
  return (
    <>
      <label className="lab-field">
        <span>Text</span>
        <input value={text} maxLength={280} onChange={(event) => setText(event.target.value)} />
      </label>
      <Action id="call_tool" label="Call lab_echo" run={run} onClick={() => start(async () => json(await call(app, "lab_echo", { player, text })))} />
      <Readout run={run} />
    </>
  );
}

export function ReadResource({ app, finish }: ExhibitProps) {
  const { run, start } = useRun(finish);
  return (
    <>
      <Action id="read_resource" label="Read the notes" run={run} onClick={() => start(async () => {
        const result = await app.readServerResource({ uri: LAB_NOTES_URI });
        const content = result.contents[0];
        return content && "text" in content ? clip(content.text, 400) : "The resource has no text.";
      })} />
      <Readout run={run} />
    </>
  );
}

export function Progress({ app, player, finish }: ExhibitProps) {
  const { run, start } = useRun(finish);
  const [ticks, setTicks] = useState<number[]>([]);
  return (
    <>
      <Action id="progress" label="Count down from 5" run={run} onClick={() => start(async () => {
        setTicks([]);
        const out = await call(app, "lab_countdown", { player, from: 5 }, {
          onprogress: (progress) => setTicks((all) => [...all, progress.progress]),
        });
        return `Done after ${out.ticks} ticks.`;
      })} />
      <ol className="lab-ticks" aria-label="Progress notifications" data-testid="exhibit-progress-ticks">
        {ticks.map((tick, index) => <li key={index}>{tick}</li>)}
      </ol>
      <Readout run={run} />
    </>
  );
}

export function Message({ app, finish }: ExhibitProps) {
  const [text, setText] = useState("Hello from the lab.");
  const { run, start } = useRun(finish);
  return (
    <>
      <label className="lab-field">
        <span>Message</span>
        <input value={text} maxLength={200} onChange={(event) => setText(event.target.value)} />
      </label>
      <Action id="message" label="Send as the user" run={run} onClick={() => start(async () => {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        return result.isError ? null : "The host took the message.";
      })} />
      <Readout run={run} />
    </>
  );
}

export function ModelContext({ app, finish }: ExhibitProps) {
  const [text, setText] = useState("The visitor is reading the lab.");
  const { run, start } = useRun(finish);
  return (
    <>
      <label className="lab-field">
        <span>What the model should know</span>
        <input value={text} maxLength={200} onChange={(event) => setText(event.target.value)} />
      </label>
      <Action id="model_context" label="Update the context" run={run} onClick={() => start(async () => {
        await app.updateModelContext({ content: [{ type: "text", text }], structuredContent: { labNote: text } });
        return "The host stored it for the model's next turn.";
      })} />
      <Readout run={run} />
    </>
  );
}

const DOCS = "https://apps.extensions.modelcontextprotocol.io/api/documents/Quickstart.html";

export function OpenLink({ app, finish }: ExhibitProps) {
  const { run, start } = useRun(finish);
  return (
    <>
      <p className="lab-note">{DOCS}</p>
      <Action id="open_link" label="Ask the host to open it" run={run} onClick={() => start(async () => {
        const result = await app.openLink({ url: DOCS });
        return result.isError ? null : "The host opened the page.";
      })} />
      <Readout run={run} />
    </>
  );
}

export function DisplayMode({ app, finish }: ExhibitProps) {
  const context = useHostContext(app);
  const { run, start } = useRun(finish);
  const mode = context.displayMode ?? "inline";
  const next = mode === "fullscreen" ? "inline" : "fullscreen";
  return (
    <>
      <p className="lab-note">Now <code data-testid="exhibit-display_mode-now">{mode}</code></p>
      <Action id="display_mode" label={next === "fullscreen" ? "Go fullscreen" : "Back to inline"} run={run} onClick={() => start(async () => {
        const result = await app.requestDisplayMode({ mode: next });
        return result.mode === next ? `The host chose ${result.mode}.` : `Asked for ${next}. The host kept ${result.mode}.`;
      })} />
      <Readout run={run} />
    </>
  );
}

const LEVELS = ["info", "warning", "error"] as const;

export function Log({ app, finish }: ExhibitProps) {
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("info");
  const { run, start } = useRun(finish);
  return (
    <>
      <label className="lab-field">
        <span>Level</span>
        <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
          {LEVELS.map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      <Action id="log" label="Send a log line" run={run} onClick={() => start(async () => {
        await app.sendLog({ level, logger: "lab", data: { msg: "log exhibit", at: new Date().toISOString() } });
        return `Sent at ${level}. Nothing comes back: it is a notification.`;
      })} />
      <Readout run={run} />
    </>
  );
}

export function Theme({ app, finish }: ExhibitProps) {
  const context = useHostContext(app);
  const theme = context.theme ?? "dark";
  const first = useRef(theme);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (theme === first.current) return;
    first.current = theme;
    setChanges((n) => n + 1);
    void finish();
  }, [theme]);
  return (
    <>
      <p className="lab-note">The host says <code data-testid="exhibit-theme-now">{theme}</code>. Changes seen: {changes}.</p>
      <Button variant="primary" onClick={() => log.info("theme read", { theme })} data-testid="exhibit-theme">Read the host theme</Button>
      <Readout>{changes > 0 ? "The host changed it and this page followed." : "Flip the theme in the frame controls. This page follows."}</Readout>
    </>
  );
}

export function AppTool({ app, finish }: ExhibitProps) {
  const offered = useRef<ReturnType<App["registerTool"]> | null>(null);
  const [on, setOn] = useState(false);
  const [calls, setCalls] = useState(0);
  const { run, start } = useRun(finish);
  useEffect(() => () => { offered.current?.remove(); }, []);
  return (
    <>
      <Action id="app_tool" label={on ? "Withdraw lab_clock" : "Offer lab_clock"} run={run} onClick={() => start(async () => {
        if (offered.current) {
          offered.current.remove();
          offered.current = null;
          setOn(false);
          await app.sendToolListChanged();
          return "Withdrawn. The host re-lists the tools.";
        }
        offered.current = app.registerTool("lab_clock", {
          title: "Lab clock",
          description: "Return this View's clock. Offered by the lab View, not by the server.",
        }, async () => {
          setCalls((n) => n + 1);
          const now = new Date().toISOString();
          return { content: [{ type: "text", text: now }], structuredContent: { now } };
        });
        setOn(true);
        await app.sendToolListChanged();
        return "Offered. Find lab_clock in the tool runner and call it.";
      })} />
      <p className="lab-note">Calls from the host: <strong data-testid="exhibit-app_tool-calls">{calls}</strong></p>
      <Readout run={run} />
    </>
  );
}

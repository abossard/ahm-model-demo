import { useCallback, useEffect, useMemo, useState } from "react";
import { callViewTool, listTools, playerArg, runTool, viewTools } from "../app/actions";
import { useStore } from "../app/store";
import { JsonTree } from "../drawer/JsonTree";
import { formatDuration } from "../drawer/wireModel";
import type { ToolInfo, ToolResult } from "../app/wireApi";
import { isModelVisible, seedFromSchema } from "./schemaSeed";

interface Outcome {
  tool: string;
  ms: number;
  result: ToolResult | null;
  error: string | null;
}

type Source = { kind: "server"; name: string } | { kind: "view"; name: string };

function useTools() {
  const connection = useStore((state) => state.connection);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (connection !== "ready") return;
    listTools().then(setTools, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [connection]);
  return { tools, error };
}

function ToolList(props: { title: string; note: string; tools: ToolInfo[]; selected: string | null; onPick(name: string): void }) {
  return (
    <div className="runner-group">
      <h3 className="runner-group-title">{props.title}</h3>
      <p className="runner-note">{props.note}</p>
      <ul>
        {props.tools.map((tool) => (
          <li key={tool.name}>
            <button type="button" data-selected={tool.name === props.selected} aria-pressed={tool.name === props.selected} onClick={() => props.onPick(tool.name)} title={tool.description}>
              <span className="mono">{tool.name}</span>
            </button>
          </li>
        ))}
        {props.tools.length === 0 && <li className="runner-none">None.</li>}
      </ul>
    </div>
  );
}

export function ToolRunner() {
  const { tools, error: listError } = useTools();
  const [offered, setOffered] = useState<ToolInfo[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [text, setText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const refreshOffered = useCallback(() => {
    viewTools().then(setOffered, () => setOffered([]));
  }, []);

  const model = useMemo(() => tools.filter((tool) => isModelVisible(tool._meta)), [tools]);
  const appOnly = useMemo(() => tools.filter((tool) => !isModelVisible(tool._meta)), [tools]);

  const pick = (next: Source, info: ToolInfo | undefined) => {
    setSource(next);
    setOutcome(null);
    setText(JSON.stringify(seedFromSchema(info?.inputSchema, playerArg()), null, 2));
  };

  const parsed = useMemo(() => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? { ok: true as const, value: value as Record<string, unknown> } : { ok: false as const, message: "The arguments must be a JSON object." };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : "Not valid JSON." };
    }
  }, [text]);

  const run = async () => {
    if (!source || !parsed.ok) return;
    setBusy(true);
    const started = performance.now();
    try {
      const result = source.kind === "server" ? await runTool(source.name, parsed.value) : await callViewTool(source.name, parsed.value);
      setOutcome({ tool: source.name, ms: performance.now() - started, result, error: null });
    } catch (error) {
      setOutcome({ tool: source.name, ms: performance.now() - started, result: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="runner" data-testid="tool-runner" aria-label="Tool runner">
      <h2 className="section-title">Tool runner</h2>
      <p className="runner-lead">Call any tool by hand. The call goes through the same host and the same wire as a View's.</p>
      {listError && <p className="runner-error" role="alert">Could not list the tools: {listError}</p>}
      <div className="runner-grid">
        <div className="runner-lists">
          <ToolList title="Visible to the model" note="A model would see these and could call them." tools={model} selected={source?.kind === "server" ? source.name : null}
            onPick={(name) => pick({ kind: "server", name }, tools.find((tool) => tool.name === name))} />
          <ToolList title="App only" note="Hidden from the model. Only a View, through the host, is meant to call them." tools={appOnly} selected={source?.kind === "server" ? source.name : null}
            onPick={(name) => pick({ kind: "server", name }, tools.find((tool) => tool.name === name))} />
          <div className="runner-group">
            <h3 className="runner-group-title">Offered by the View</h3>
            <p className="runner-note">Tools the Lab View registered with the host for the model to call.</p>
            <button type="button" className="btn btn-quiet" onClick={refreshOffered}>Ask the View</button>
            <ul>
              {offered.map((tool) => (
                <li key={tool.name}>
                  <button type="button" data-selected={source?.kind === "view" && source.name === tool.name} onClick={() => pick({ kind: "view", name: tool.name }, tool)}>
                    <span className="mono">{tool.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="runner-work">
          {source ? (
            <>
              <label className="runner-label" htmlFor="runner-args">Arguments for <span className="mono">{source.name}</span></label>
              <textarea id="runner-args" data-testid="runner-args" value={text} spellCheck={false} rows={8} onChange={(event) => setText(event.target.value)} aria-invalid={!parsed.ok} aria-describedby="runner-args-note" />
              <p id="runner-args-note" className={parsed.ok ? "runner-note" : "runner-error"}>{parsed.ok ? "Seeded from the tool's input schema." : parsed.message}</p>
              <button type="button" className="btn btn-primary" data-testid="runner-run" disabled={busy || !parsed.ok} onClick={run}>{busy ? "Calling…" : "Call tool"}</button>
            </>
          ) : (
            <p className="runner-note">Pick a tool on the left. Its arguments are written for you.</p>
          )}
          {outcome && (
            <div className="runner-result" data-testid="runner-result" data-error={outcome.error !== null || outcome.result?.isError === true}>
              <p className="runner-note">
                <span className="mono">{outcome.tool}</span> answered in <span className="mono">{formatDuration(outcome.ms)}</span>
                {outcome.result?.isError ? ", as an error" : ""}.
              </p>
              {outcome.error ? <p className="runner-error">{outcome.error}</p> : <JsonTree value={outcome.result} />}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

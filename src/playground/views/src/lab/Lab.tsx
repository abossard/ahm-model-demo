import { useCallback, useRef, useState, type ComponentType } from "react";
import type { LabExhibit } from "@playground/contracts";
import { Frame, call, errorText, log, outputOf, type ViewContext } from "../kit";
import * as X from "./Exhibits";
import { EXHIBITS, GROUPS, unlockLine, withDone } from "./catalog";
import "./lab.css";

const BODY: Record<LabExhibit, ComponentType<X.ExhibitProps>> = {
  call_tool: X.CallTool,
  read_resource: X.ReadResource,
  progress: X.Progress,
  message: X.Message,
  model_context: X.ModelContext,
  open_link: X.OpenLink,
  display_mode: X.DisplayMode,
  log: X.Log,
  theme: X.Theme,
  app_tool: X.AppTool,
};

// Layer 2. Ten switches, each one request. Trying one is recorded on the server.
export function Lab({ app, player, first }: ViewContext) {
  const [done, setDone] = useState<LabExhibit[]>(() => outputOf<"lab_open">(first).done);
  const doneRef = useRef(done);
  doneRef.current = done;

  const record = useCallback(async (id: LabExhibit) => {
    if (doneRef.current.includes(id)) return;
    setDone((all) => withDone(all, id));
    try {
      const out = await call(app, "lab_checkpoint", { player, exhibit: id });
      setDone((all) => out.done.reduce<LabExhibit[]>((merged, item) => withDone(merged, item), all));
    } catch (error) {
      log.warn("checkpoint failed", { exhibit: id, error: errorText(error) });
    }
  }, [app, player]);

  return (
    <Frame>
      <p className="lab-intro">Ten switches. Flip three. <span data-testid="lab-progress">{unlockLine(done)}</span></p>
      {GROUPS.map((group) => (
        <section key={group.id} className="lab-group">
          <header>
            <h2>{group.title}</h2>
            <p>{group.line}</p>
          </header>
          <ul>
            {EXHIBITS.filter((exhibit) => exhibit.group === group.id).map((exhibit) => {
              const Body = BODY[exhibit.id];
              const tried = done.includes(exhibit.id);
              return (
                <li key={exhibit.id} className="lab-exhibit" data-exhibit={exhibit.id} data-done={tried}>
                  <div className="lab-what">
                    <h3>{exhibit.title}</h3>
                    <p>{exhibit.teaches}</p>
                    {tried ? <span className="lab-done" data-testid={`exhibit-${exhibit.id}-done`}>Tried</span> : null}
                  </div>
                  <div className="lab-controls">
                    <Body app={app} player={player} finish={() => record(exhibit.id)} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Frame>
  );
}

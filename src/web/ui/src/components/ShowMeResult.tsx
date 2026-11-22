import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { Task, VerificationRow } from "../model/types";
import type { ShowMeAction, ShowMeRegistry } from "../showMe";
import { SHOW_ME_MARKER, withoutShowMeMarkers } from "../showMe/markers";
import { ShowMeButton, ShowMeText } from "../showMe/ShowMeText";
import { ShowMeNextSteps } from "../showMe/NextSteps";
import type { ShowChange } from "../store/diffShowMe";
import { actions, useStore } from "../store/store";
import { workspaceShowMe } from "../store/workspaceShowMe";

const Context = createContext<{
  registry: ShowMeRegistry;
  actions: Readonly<Record<string, ShowMeAction>> | undefined;
  changeList: RefObject<ShowChange | null>;
} | null>(null);

/** One result owns its action map and highlight for as long as the reader can see the answer. */
export function ShowMeResult({ task, children }: { readonly task: Task; readonly children: ReactNode }) {
  const changeList = useRef<ShowChange | null>(null);
  const context = useMemo(() => {
    const offered = new Set(task.showMeHandles?.map(item => item.name));
    const saved = task.result?.showMe;
    return {
      // Tool-issued buttons must belong to the original turn. The host can also link known
      // references in older answers. Both use one registry so only one destination is active.
      actions: saved && Object.fromEntries(Object.entries(saved).filter(([, action]) => offered.has(action.handle))),
      registry: workspaceShowMe(useStore, task, new Set([...offered, "graph", "timeline", "panel"]),
        id => changeList.current?.(id) ?? null),
      changeList,
    };
  }, [task]);
  useEffect(() => () => {
    context.registry.clear();
    actions.setWorkspaceTarget(null);
  }, [context]);

  return <Context.Provider value={context}>{children}</Context.Provider>;
}

export function ResultNextSteps({ task }: { task: Task }) {
  const context = useContext(Context);
  if (!task.result?.nextSteps || !context?.actions) return null;
  return <ShowMeNextSteps key={task.id} choices={task.result.nextSteps} actions={context.actions} registry={context.registry} />;
}

export function ResultText({ text, renderText }: { text: string; renderText: (text: string) => ReactNode }) {
  const context = useContext(Context);
  return context?.actions ? <ShowMeText text={text} registry={context.registry} actions={context.actions} renderText={renderText} /> : <>{renderText(text)}</>;
}

export function useChangeListTarget() {
  return useContext(Context)?.changeList ?? null;
}

export function useResultTooltip(text: string) {
  return useContext(Context)?.actions ? withoutShowMeMarkers(text) : text;
}

/** An authored pointer beside this text takes precedence over the host's suggested destination. */
export function ResultLink({ action, text, children, testId }: {
  action: ShowMeAction | undefined; text: string; children?: ReactNode; testId?: string;
}) {
  const context = useContext(Context);
  if (!context || !action || (action.id && Array.from(action.id).length > 256) ||
      [...text.matchAll(SHOW_ME_MARKER)].some(m => context.actions?.[m[1]!])) return <>{children}</>;
  return <ShowMeButton registry={context.registry} action={action} {...(testId ? { testId } : {})}>{children}</ShowMeButton>;
}

/** A saved signal test can lead to its measured history if that signal existed in the base model. */
export function VerificationLink({ row }: { row: VerificationRow }) {
  const available = useStore(state => state.diff.kind === "success" &&
    state.diff.value.base.entities.some(entity => entity.name === row.entity && entity.signals.some(signal => signal.name === row.signal)));
  const label = `${row.entity} / ${row.signal}`;
  return <ResultLink text="" action={available ? { handle: "timeline", id: `signal/${row.entity}/${row.signal}` } : undefined}>
    {label}
  </ResultLink>;
}

import type { JSX } from "react";
import { flushSync } from "react-dom";
import { Select, Tab, TabList, makeStyles } from "@fluentui/react-components";
import { VIEWS, type ViewId } from "../model/views";
import { viewDefinition } from "../views/registry";
import { actions, useStore } from "../store/store";

// A row of tabs while the graph area fits them, a dropdown below this width: both are always in the DOM, CSS picks one.
const NARROW = "graph (max-width: 960px)";

const useStyles = makeStyles({
  tabs: { [`@container ${NARROW}`]: { display: "none" } },
  select: { display: "none", [`@container ${NARROW}`]: { display: "inline-flex" } },
});

type Scope = Element & { startViewTransition: (update: () => void) => { ready: Promise<void> } };

// The graph area cross-fades to the next view where the browser can scope a view transition to it, and swaps at once elsewhere.
function switchView(from: EventTarget, next: ViewId): void {
  const scope = from instanceof Element ? from.closest("[data-graph-area]") : null;
  const update = (): void => flushSync(() => actions.setView(next));
  if (scope === null || !("startViewTransition" in Element.prototype)) return update();
  (scope as Scope).startViewTransition(update).ready.catch(() => {});
}

export function ViewSwitch(): JSX.Element {
  const styles = useStyles();
  const view = useStore((state) => state.view);
  const selected = viewDefinition(view);

  const choose = (from: EventTarget, next: ViewId): void => {
    switchView(from, next);
    actions.announce(`Showing the ${VIEWS.find((item) => item.id === next)?.label ?? next} view.`);
  };

  return (
    <>
      <TabList
        className={styles.tabs}
        size="small"
        appearance="subtle"
        selectedValue={selected.id}
        onTabSelect={(event, data) => choose(event.target, data.value as ViewId)}
        data-testid="view-switch"
        aria-label="View"
      >
        {VIEWS.map((item) => (
          <Tab key={item.id} value={item.id} title={item.description} data-testid={`view-tab-${item.id}`}>
            {item.label}
          </Tab>
        ))}
      </TabList>
      <Select
        className={styles.select}
        size="small"
        value={selected.id}
        aria-label="View"
        data-testid="view-select"
        onChange={(event, data) => choose(event.target, data.value as ViewId)}
      >
        {VIEWS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </Select>
    </>
  );
}


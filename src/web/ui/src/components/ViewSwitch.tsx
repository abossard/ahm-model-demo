import type { JSX } from "react";
import { Select, Tab, TabList, makeStyles } from "@fluentui/react-components";
import { VIEWS, type ViewId } from "../model/views";
import { viewDefinition } from "../views/registry";
import { actions, useStore } from "../store/store";

// A row of tabs while it fits, a dropdown below this width: both are always in the DOM, CSS picks one.
const NARROW = "(max-width: 960px)";

const useStyles = makeStyles({
  tabs: { [`@media ${NARROW}`]: { display: "none" } },
  select: { display: "none", [`@media ${NARROW}`]: { display: "inline-flex" } },
});

export function ViewSwitch(): JSX.Element {
  const styles = useStyles();
  const view = useStore((state) => state.view);
  const selected = viewDefinition(view);

  const choose = (next: ViewId): void => {
    actions.setView(next);
    actions.announce(`Showing the ${VIEWS.find((item) => item.id === next)?.label ?? next} view.`);
  };

  return (
    <>
      <TabList
        className={styles.tabs}
        size="small"
        appearance="subtle"
        selectedValue={selected.id}
        onTabSelect={(_, data) => choose(data.value as ViewId)}
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
        onChange={(_, data) => choose(data.value as ViewId)}
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


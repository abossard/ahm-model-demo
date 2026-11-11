import { useEffect } from "react";
import type { JSX } from "react";
import {
  Button,
  Link,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from "@fluentui/react-components";
import {
  Add20Regular,
  DocumentSearch20Regular,
  Lightbulb20Regular,
  Sparkle20Regular,
} from "@fluentui/react-icons";
import { launchFailure } from "../model/errors";
import { whyQuestion } from "../model/wording";
import { actions, useStore } from "../store/store";

const TOAST_MS = 12_000;

const useStyles = makeStyles({
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  // On a phone the top bar has no room for the word: the plus and the name for assistive technology are enough.
  menuLabel: { "@media (max-width: 720px)": { display: "none" } },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
});

function useLaunchState(): { readonly starting: boolean; readonly model: boolean; readonly question: string | null } {
  const starting = useStore((state) => state.launch.kind === "starting");
  const model = useStore((state) => state.selected !== null);
  // The question about the selected entity, in the state it has now.
  const question = useStore((state) => {
    if (state.selectedName === null) return null;
    const entity = state.model.kind === "success" ? state.model.value.entities.find((item) => item.name === state.selectedName) : undefined;
    return whyQuestion(entity?.healthState ?? null, entity?.displayName ?? state.selectedName);
  });
  return { starting, model, question };
}

/** "Ask" in the top bar: the question about an entity and the model check start at once; Design opens its form, because it asks about the workload. */
export function TaskMenu(): JSX.Element {
  const styles = useStyles();
  const { starting, model, question } = useLaunchState();
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button
          size="small"
          icon={starting ? <Spinner size="tiny" /> : <Add20Regular />}
          disabledFocusable={starting}
          aria-busy={starting}
          aria-label="Ask the assistant"
          data-task-launcher=""
          data-testid="task-menu"
        >
          <span className={styles.menuLabel}>Ask</span>
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem
            icon={<DocumentSearch20Regular />}
            disabled={!model}
            onClick={() => void actions.startTask({ type: "review" })}
            data-testid="menu-review"
          >
            Check this model
          </MenuItem>
          <MenuItem
            icon={<Lightbulb20Regular />}
            disabled={question === null}
            {...(question === null ? { secondaryContent: "Select an entity first" } : {})}
            onClick={() => void actions.startTask({ type: "explain" })}
            data-testid="menu-explain"
          >
            {question ?? "Why is an entity in its state?"}
          </MenuItem>
          <MenuItem icon={<Sparkle20Regular />} onClick={() => actions.prefillTask("design")} data-testid="menu-design">
            Design a model for my workload…
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/** The two starts that need no entity, for the places that have nothing else to show yet. */
export function StartButtons(): JSX.Element {
  const styles = useStyles();
  const { starting, model } = useLaunchState();
  return (
    <div className={styles.row}>
      <Button
        appearance="primary"
        icon={starting ? <Spinner size="tiny" /> : <DocumentSearch20Regular />}
        disabled={!model}
        disabledFocusable={starting}
        onClick={() => void actions.startTask({ type: "review" })}
        data-task-launcher=""
        data-testid="start-review"
      >
        Check this model
      </Button>
      <Button icon={<Sparkle20Regular />} onClick={() => actions.prefillTask("design")} data-testid="start-design">
        Design a model…
      </Button>
    </div>
  );
}

/**
 * A Task that ended while the user looked elsewhere: a toast that offers its result and does not take focus, and a
 * mark on the Sessions button that stays until the result is opened.
 */
export function TaskNotifier(): JSX.Element {
  const styles = useStyles();
  const toasterId = useId("task-toaster");
  // What a screen reader hears of a start, from a region that is always there: the workspace may not be.
  const spoken = useStore((state) => {
    const { launch } = state;
    if (launch.kind === "starting") return `Asking the assistant: ${launch.label}`;
    if (launch.kind === "failed") return `${launch.label} could not be asked. ${launchFailure(launch.error, launch.step, null).title}.`;
    return "";
  });
  const { dispatchToast, dismissToast } = useToastController(toasterId);
  const notice = useStore((state) => state.notice);

  useEffect(() => {
    if (notice === null) return;
    const toastId = `task-${notice.sessionId}-${notice.seq}`;
    dispatchToast(
      <Toast data-testid="task-toast">
        <ToastTitle
          action={
            <Link
              as="button"
              onClick={() => {
                dismissToast(toastId);
                void actions.showFinished();
              }}
              data-testid="task-toast-show"
            >
              {notice.link}
            </Link>
          }
        >
          {notice.title}
        </ToastTitle>
        <ToastBody>{notice.text.length > 140 ? `${notice.text.slice(0, 137)}...` : notice.text}</ToastBody>
      </Toast>,
      { toastId, intent: notice.status === "done" ? "success" : "error", timeout: TOAST_MS, pauseOnHover: true, pauseOnWindowBlur: true },
    );
  }, [notice, dispatchToast, dismissToast]);

  return (
    <>
      <div role="status" aria-live="polite" className={styles.visuallyHidden} data-testid="launch-log">
        {spoken}
      </div>
      <Toaster toasterId={toasterId} position="bottom-start" />
    </>
  );
}

import type { ApiError, TaskError } from "./types";

/** What the user can do about an error: ask again, or start a new Session. */
export type ErrorAction = "retry" | "new-session";

export interface ErrorPresentation {
  readonly title: string;
  readonly message: string;
  readonly action: ErrorAction | null;
}

type Known = Readonly<Record<string, ErrorPresentation>>;

/** What the signed-in user tried that Azure refused: reading a model, sending a health report, starting a Task on it, or Apply. */
export type AzureAction = "browse" | "report" | "start" | "apply";

/**
 * A 403 `forbidden` means the signed-in user lacks the Azure role for the action, not that the app is broken, so the
 * words name the action and what to ask for.
 */
export function forbiddenFor(action: AzureAction, model = "this health model"): ErrorPresentation {
  switch (action) {
    case "browse":
      return {
        title: "No access to this health model",
        message: `Your account has no Azure role that lets you read ${model}. Ask its owner for a reader role on it, or choose another health model.`,
        action: null,
      };
    case "report":
      return {
        title: "You cannot send health reports here",
        message: `Your account has no Azure role that lets you send a health report to ${model}. Ask its owner for a role that allows it.`,
        action: null,
      };
    case "start":
      return {
        title: "No access to the target model",
        message: `Your account has no Azure role that lets you read ${model}, so the Task did not start. Ask its owner for a reader role on it, or choose another health model.`,
        action: null,
      };
    case "apply":
      return {
        title: "You cannot Apply here",
        message: `Your account has no Azure role that lets you write to ${model}, so nothing was applied. Ask its owner for a role that allows it.`,
        action: null,
      };
  }
}

/** What a 401 that survived its one retry means: the app does not accept this sign-in any more. */
export const SIGN_IN_ENDED = "Your sign-in is no longer accepted. Sign in again to go on.";

/**
 * The words for a failed call: what a 401 or a 403 means for the user, or the app's own message for any other failure.
 * A 403 is about the Azure role for the action, not about the app being broken.
 */
export function accessMessage(error: ApiError, action: AzureAction, model?: string): string {
  if (error.code === "unauthenticated") return SIGN_IN_ENDED;
  return error.code === "forbidden" ? forbiddenFor(action, model).message : error.message;
}

function describe(error: ApiError, known: Known, fallbackTitle: string): ErrorPresentation {
  return known[error.code] ?? { title: fallbackTitle, message: error.message, action: error.retryable ? "retry" : null };
}

const START: Known = {
  task_running: {
    title: "A Task is already running",
    message: "A Session runs one Task at a time. Start the next one when the running Task finishes.",
    action: null,
  },
  agents_busy: {
    title: "All agents are busy",
    message: "Every agent slot of the app is taken by other Tasks. Try again in a few minutes.",
    action: "retry",
  },
  task_limit: {
    title: "This Session is full",
    message: "A Session holds a limited number of Tasks and this one has reached it. Start a new Session to continue.",
    action: "new-session",
  },
  payload_too_large: {
    title: "The request is too large",
    message: "The request was larger than the app accepts. Shorten the Task instruction and try again.",
    action: null,
  },
};

const SESSION: Known = {
  session_limit: {
    title: "The app has no room for another Session",
    message: "The app has reached its limit of Sessions and keeps all of them. Open an existing Session instead.",
    action: null,
  },
  payload_too_large: {
    title: "The request is too large",
    message: "The Session title was larger than the app accepts. Shorten it and try again.",
    action: null,
  },
};

const STREAM: Known = {
  too_many_subscribers: {
    title: "Too many viewers",
    message: "Too many people are following this Task right now. Reconnect in a moment.",
    action: "retry",
  },
  invalid_last_event_id: {
    title: "The timeline could not resume",
    message: "The app could not continue the timeline where it stopped. Reconnect to replay it from the start.",
    action: "retry",
  },
  task_not_found: { title: "The Task is gone", message: "The app no longer has this Task.", action: null },
};

/** Why a Task could not start, with what the user can do next. */
export function startFailure(error: ApiError): ErrorPresentation {
  return error.code === "forbidden" ? forbiddenFor("start") : describe(error, START, "The Task did not start");
}

export function sessionFailure(error: ApiError): ErrorPresentation {
  return describe(error, SESSION, "The Session was not created");
}

/** Why the live Activity timeline closed, as the events endpoint answered when asked again. */
export function streamFailure(error: ApiError | null): ErrorPresentation {
  if (error === null) {
    return { title: "The live connection closed", message: "The timeline stopped before the Task finished. Reconnect to follow it.", action: "retry" };
  }
  return describe(error, STREAM, "The live connection closed");
}

const TASK: Readonly<Record<string, Omit<ErrorPresentation, "action">>> = {
  interrupted: {
    title: "The Task was interrupted",
    message: "The app restarted while the Task ran, so it stopped. Its steps so far stay in the Activity timeline. Start it again to continue.",
  },
  timeout: {
    title: "The Task timed out",
    message: "The Task ran for too long and was stopped. Start it again, or narrow it with a Task instruction.",
  },
};

/** Why a Task ended as failed. Every failed Task can be started again. */
export function taskFailure(error: TaskError | null | undefined): ErrorPresentation {
  const known = error ? TASK[error.code] : undefined;
  if (known) return { ...known, action: "retry" };
  const message = error?.message || "The agent did not finish the Task.";
  return { title: "The Task failed", message: error?.code ? `${message} (${error.code})` : message, action: "retry" };
}

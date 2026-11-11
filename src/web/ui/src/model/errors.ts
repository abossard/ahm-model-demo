import type { ApiError, TaskError } from "./types";

/** What the user can do about an error: ask again, ask in a new topic, open the question that runs, or sign in again. */
export type ErrorAction = "retry" | "new-session" | "open-running" | "sign-in";

export interface ErrorPresentation {
  readonly title: string;
  /** What happened and what to do, in plain words and without codes. */
  readonly message: string;
  readonly action: ErrorAction | null;
  /** The code and reference for someone who reports the problem; shown small, never in the main text. */
  readonly technical: string | null;
}

type Entry = Omit<ErrorPresentation, "technical">;
type Known = Readonly<Record<string, Entry>>;

/** What the signed-in user tried that Azure refused: reading a model, sending a health report, asking the assistant about it, or Apply. */
export type AzureAction = "browse" | "report" | "start" | "apply";

/** The line for someone who reports a problem: the code of the error and the operation it belongs to. */
export function technicalLine(error: { readonly code: string; readonly operationId?: string | null }): string {
  return error.operationId ? `${error.code}, reference ${error.operationId}` : error.code;
}

function shown(entry: Entry, error: { readonly code: string; readonly operationId?: string | null } | null): ErrorPresentation {
  return { ...entry, technical: error === null ? null : technicalLine(error) };
}

/**
 * A 403 `forbidden` means the signed-in user lacks the Azure role for the action, not that the app is broken, so the
 * words name the action and what to ask for.
 */
export function forbiddenFor(action: AzureAction, model = "this health model"): ErrorPresentation {
  switch (action) {
    case "browse":
      return shown(
        {
          title: "You do not have access to this health model",
          message: `Your Azure account cannot read ${model}. Ask its owner for a reader role, or choose another health model.`,
          action: null,
        },
        null,
      );
    case "report":
      return shown(
        {
          title: "You cannot send health reports here",
          message: `Your Azure account is not allowed to send health reports to ${model}. Ask its owner for a role that allows it.`,
          action: null,
        },
        null,
      );
    case "start":
      return shown(
        {
          title: "You do not have access to this model",
          message: `Your Azure account cannot read ${model}, so the assistant could not look at it. Ask its owner for a reader role, or choose another health model.`,
          action: null,
        },
        null,
      );
    case "apply":
      return shown(
        {
          title: "You cannot change this model",
          message: `Your Azure account is not allowed to write to ${model}, so nothing was changed. Ask its owner for a role that allows it.`,
          action: null,
        },
        null,
      );
  }
}

/** What a 401 that survived its one retry means: the app does not accept this sign-in any more. */
export const SIGN_IN_ENDED = "Your sign-in has expired. Sign in again to continue.";

/**
 * The words for a failed call: what a 401 or a 403 means for the user, or the app's own message for any other failure.
 * A 403 is about the Azure role for the action, not about the app being broken.
 */
export function accessMessage(error: ApiError, action: AzureAction, model?: string): string {
  if (error.code === "unauthenticated") return SIGN_IN_ENDED;
  return error.code === "forbidden" ? forbiddenFor(action, model).message : error.message;
}

function describe(error: ApiError, known: Known, fallbackTitle: string): ErrorPresentation {
  const entry = known[error.code] ?? { title: fallbackTitle, message: error.message, action: error.retryable ? "retry" : null };
  return shown(entry, error);
}

/** A 401 the app's one silent retry did not cure: the user has to sign in again before anything else works. */
const SIGNED_OUT: Entry = { title: "You are signed out", message: SIGN_IN_ENDED, action: "sign-in" };

const START: Known = {
  unauthenticated: SIGNED_OUT,
  task_running: {
    title: "The assistant is already working on something",
    message: "It works on one question at a time. Open it to follow along, or ask again when it is done.",
    action: "open-running",
  },
  agents_busy: {
    title: "The assistant is busy",
    message: "Other people are using all of its capacity right now. Try again in a few minutes.",
    action: "retry",
  },
  task_limit: {
    title: "This topic is full",
    message: "A topic holds a limited number of questions and this one has reached it. Ask in a new topic to continue.",
    action: "new-session",
  },
  payload_too_large: {
    title: "Your note is too long",
    message: "The assistant could not take it. Shorten the note and try again.",
    action: null,
  },
};

const SESSION: Known = {
  unauthenticated: SIGNED_OUT,
  session_limit: {
    title: "No room for another topic",
    message: "The app keeps every topic and has reached its limit. Open an earlier one from History instead.",
    action: null,
  },
  payload_too_large: {
    title: "The name is too long",
    message: "Shorten the name of the topic and try again.",
    action: null,
  },
};

const STREAM: Known = {
  too_many_subscribers: {
    title: "Too many people are watching",
    message: "Too many people are following this right now. Reconnect in a moment.",
    action: "retry",
  },
  invalid_last_event_id: {
    title: "The live view could not continue",
    message: "The app could not pick up where it stopped. Reconnect to replay it from the start.",
    action: "retry",
  },
  task_not_found: { title: "This question is gone", message: "The app no longer has it.", action: null },
};

/** Why the assistant could not be asked, with what the user can do next. */
export function startFailure(error: ApiError): ErrorPresentation {
  return error.code === "forbidden"
    ? { ...forbiddenFor("start"), technical: technicalLine(error) }
    : describe(error, START, "The assistant could not be asked");
}

export function sessionFailure(error: ApiError): ErrorPresentation {
  return describe(error, SESSION, "The topic could not be created");
}

/** What the app could not do for a question asked with one click: make its topic, or ask in it. */
export type LaunchStep = "session" | "task";

export interface LaunchPresentation extends ErrorPresentation {
  /** What the user is left with, when that is not obvious: a topic that was created and is empty. */
  readonly note: string | null;
}

/**
 * Why a one-click start stopped, and what the user can do: the refusal of the step that failed, plus what is left behind.
 * A topic made for this start stays open and usable, so the words say that and what Try again does with it.
 */
export function launchFailure(error: ApiError, step: LaunchStep, createdSession: string | null): LaunchPresentation {
  const presented = step === "session" ? sessionFailure(error) : startFailure(error);
  const note =
    createdSession === null
      ? null
      : presented.action === "retry"
        ? `Your question is saved in History as "${createdSession}". Try again asks it there.`
        : `A topic "${createdSession}" is saved in History, with nothing asked in it yet.`;
  return { ...presented, note };
}

/** Why the live view of the assistant's work closed, as the events endpoint answered when asked again. */
export function streamFailure(error: ApiError | null): ErrorPresentation {
  if (error === null) {
    return shown({ title: "The live view stopped", message: "Updates stopped before the assistant finished. Reconnect to keep following it.", action: "retry" }, null);
  }
  return describe(error, STREAM, "The live view stopped");
}

const TASK: Readonly<Record<string, Omit<Entry, "action">>> = {
  interrupted: {
    title: "The question was interrupted",
    message: "The app restarted while the assistant was working, so it stopped. What it did so far is kept. Ask again to continue.",
  },
  timeout: {
    title: "The assistant took too long",
    message: "It was stopped after working for too long. Ask again, or narrow the question with a note.",
  },
};

/** Why a question ended without an answer. Every one of them can be asked again. */
export function taskFailure(error: TaskError | null | undefined): ErrorPresentation {
  const known = error ? TASK[error.code] : undefined;
  if (known) return shown({ ...known, action: "retry" }, error ?? null);
  return shown(
    { title: "The assistant could not finish", message: error?.message || "It stopped without an answer. Try again.", action: "retry" },
    error ?? null,
  );
}

// What Microsoft Entra says when a sign-in fails (the AADSTS codes), in what the user can do about it.
const SIGN_IN_HINTS: readonly (readonly [RegExp, string])[] = [
  [/AADSTS50105/, "Your account is not assigned to this app. Ask the owner of the app to give you access, then sign in again."],
  [
    /AADSTS65001|AADSTS90094|AADSTS90095|AADSTS500011/,
    "The app has not been approved in your directory yet. An administrator of the directory has to approve it once for the whole organization. If you are the administrator, sign in again and approve it for your organization.",
  ],
  [
    /AADSTS700016/,
    "The app was not found in the directory you signed in to. An administrator of that directory has to approve it, or you signed in to the wrong directory. If you run the app, check its client ID.",
  ],
  [
    /AADSTS50020|AADSTS50034/,
    "Your account is not a member or a guest of the directory you signed in to. Use a work or school account of that directory. For a personal account, name the directory it belongs to below.",
  ],
  [/AADSTS90002/, "That directory was not found. Check its domain or ID and try again."],
  [/AADSTS50076|AADSTS50079/, "Your organization asks for a second step to sign in. Sign in again and complete it."],
  [/AADSTS700054|AADSTS900144/, "Signing in is set up incorrectly for this app. Tell the person who runs it."],
];

/** Whether a failed sign-in is cured by naming the directory to sign in to. */
export function needsDirectory(message: string | null): boolean {
  return message !== null && /AADSTS50020|AADSTS50034|AADSTS90002/.test(message);
}

/** What to do about a failed sign-in, when its message names a cause the user can act on; null for any other message. */
export function signInHint(message: string | null): string | null {
  if (message === null) return null;
  return SIGN_IN_HINTS.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

/** Why History could not be loaded. */
export function historyFailure(error: ApiError): ErrorPresentation {
  return describe(error, {}, "History could not be loaded");
}

/** Why a topic, a question or its proposed changes could not be opened. */
export function openFailure(error: ApiError, what: "topic" | "question" | "changes"): ErrorPresentation {
  if (error.code === "session_not_found" || error.code === "task_not_found") {
    return shown(
      {
        title: what === "topic" ? "This topic was not found" : "This question was not found",
        message: "The link may be old, or it belongs to someone else. Open History to find what you asked.",
        action: null,
      },
      error,
    );
  }
  return describe(error, {}, `The ${what} could not be opened`);
}

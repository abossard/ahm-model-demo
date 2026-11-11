import { describe, expect, it } from "vitest";
import {
  SIGN_IN_ENDED,
  accessMessage,
  applyMayHaveWritten,
  applyUnsure,
  forbiddenFor,
  historyFailure,
  launchFailure,
  openFailure,
  needsDirectory,
  sessionFailure,
  signInHint,
  startFailure,
  streamFailure,
  taskFailure,
  technicalLine,
} from "./errors";
import type { ApiError } from "./types";

const error = (code: string, retryable: boolean, message = `message of ${code}`): ApiError => ({
  code,
  message,
  retryable,
  operationId: "op",
});

// The main text of every presentation is plain: no code of the app's own appears in it.
const CODES = /\b(task_running|agents_busy|task_limit|session_limit|payload_too_large|too_many_subscribers|invalid_last_event_id|task_not_found|session_not_found|unauthenticated|forbidden|interrupted|timeout|agent_failed|sessions_unavailable)\b/;

describe("startFailure", () => {
  it.each([
    { code: "task_running", retryable: true, title: "The assistant is already working on something", action: "open-running" },
    { code: "unauthenticated", retryable: false, title: "You are signed out", action: "sign-in" },
    { code: "forbidden", retryable: false, title: "You do not have access to this model", action: null },
    { code: "network_error", retryable: true, title: "The assistant could not be asked", action: "retry" },
    { code: "agents_busy", retryable: true, title: "The assistant is busy", action: "retry" },
    { code: "task_limit", retryable: false, title: "This topic is full", action: "new-session" },
    { code: "payload_too_large", retryable: false, title: "Your note is too long", action: null },
    { code: "sessions_unavailable", retryable: true, title: "The assistant could not be asked", action: "retry" },
    { code: "invalid_instruction", retryable: false, title: "The assistant could not be asked", action: null },
  ])("explains $code", ({ code, retryable, title, action }) => {
    const shown = startFailure(error(code, retryable));
    expect(shown.title).toBe(title);
    expect(shown.action).toBe(action);
  });

  it.each(["task_running", "agents_busy", "task_limit", "payload_too_large", "unauthenticated", "forbidden"])("keeps the code of %s out of the words and in the technical line", (code) => {
    const shown = startFailure(error(code, false));
    expect(`${shown.title} ${shown.message}`).not.toMatch(CODES);
    expect(shown.technical).toBe(`${code}, reference op`);
  });

  it("keeps the app's own words for a code it does not know", () => {
    expect(startFailure(error("unknown_entity", false, "The entity is not in the target model.")).message).toBe(
      "The entity is not in the target model.",
    );
  });

  it.each(["agents_busy", "task_limit", "payload_too_large"])("says nothing of a bare %s message", (code) => {
    expect(startFailure(error(code, false)).message).not.toContain("message of");
  });
});

describe("technicalLine", () => {
  it.each([
    { name: "with a reference", input: { code: "agents_busy", operationId: "op-1" }, expected: "agents_busy, reference op-1" },
    { name: "without one", input: { code: "agents_busy", operationId: null }, expected: "agents_busy" },
    { name: "with none given", input: { code: "agents_busy" }, expected: "agents_busy" },
  ])("writes the code $name", ({ input, expected }) => {
    expect(technicalLine(input)).toBe(expected);
  });
});

describe("sessionFailure", () => {
  it.each([
    { code: "session_limit", retryable: false, title: "No room for another topic", action: null },
    { code: "unauthenticated", retryable: false, title: "You are signed out", action: "sign-in" },
    { code: "payload_too_large", retryable: false, title: "The name is too long", action: null },
    { code: "sessions_unavailable", retryable: true, title: "The topic could not be created", action: "retry" },
  ])("explains $code", ({ code, retryable, title, action }) => {
    expect(sessionFailure(error(code, retryable))).toMatchObject({ title, action });
  });
});

describe("launchFailure", () => {
  it.each([
    { name: "a question refused in a topic that was made", code: "agents_busy", step: "task" as const, made: "Why is Service C Unhealthy? (11 Nov 14:05)", action: "retry", note: 'Your question is saved in History as "Why is Service C Unhealthy? (11 Nov 14:05)". Try again asks it there.' },
    { name: "a question refused for good in a topic that was made", code: "forbidden", step: "task" as const, made: "Check hm-a (11 Nov 14:05)", action: null, note: 'A topic "Check hm-a (11 Nov 14:05)" is saved in History, with nothing asked in it yet.' },
    { name: "a question refused in a topic that was already there", code: "agents_busy", step: "task" as const, made: null, action: "retry", note: null },
    { name: "a running question, which leaves nothing behind", code: "task_running", step: "task" as const, made: null, action: "open-running", note: null },
    { name: "a topic the app could not make", code: "sessions_unavailable", step: "session" as const, made: null, action: "retry", note: null },
    { name: "a sign-in that ended", code: "unauthenticated", step: "session" as const, made: null, action: "sign-in", note: null },
  ])("explains $name", ({ code, step, made, action, note }) => {
    const shown = launchFailure(error(code, code !== "forbidden" && code !== "unauthenticated" && code !== "task_running"), step, made);
    expect(shown.action).toBe(action);
    expect(shown.note).toBe(note);
  });

  it("takes the words of the step that failed", () => {
    expect(launchFailure(error("sessions_unavailable", true), "session", null).title).toBe("The topic could not be created");
    expect(launchFailure(error("sessions_unavailable", true), "task", null).title).toBe("The assistant could not be asked");
  });
});

describe("streamFailure", () => {
  it.each([
    { code: "too_many_subscribers", retryable: true, title: "Too many people are watching", action: "retry" },
    { code: "invalid_last_event_id", retryable: false, title: "The live view could not continue", action: "retry" },
    { code: "task_not_found", retryable: false, title: "This question is gone", action: null },
    { code: "network_error", retryable: true, title: "The live view stopped", action: "retry" },
  ])("explains $code", ({ code, retryable, title, action }) => {
    const shown = streamFailure(error(code, retryable));
    expect(shown).toMatchObject({ title, action });
    expect(`${shown.title} ${shown.message}`).not.toMatch(CODES);
  });

  it("still offers a reconnect when the endpoint could not be asked", () => {
    expect(streamFailure(null)).toMatchObject({ title: "The live view stopped", action: "retry", technical: null });
  });
});

describe("taskFailure", () => {
  it.each([
    { code: "interrupted", title: "The question was interrupted", text: "app restarted" },
    { code: "timeout", title: "The assistant took too long", text: "stopped after working for too long" },
    { code: "agent_failed", title: "The assistant could not finish", text: "The agent stopped." },
  ])("explains a question that failed with $code", ({ code, title, text }) => {
    const shown = taskFailure({ code, message: "The agent stopped." });
    expect(shown.title).toBe(title);
    expect(shown.message).toContain(text);
    expect(shown.action).toBe("retry");
    expect(shown.message).not.toContain(code);
    expect(shown.technical).toBe(code);
  });

  it("explains a failure that carries no reason", () => {
    expect(taskFailure(undefined)).toMatchObject({ title: "The assistant could not finish", message: "It stopped without an answer. Try again.", technical: null });
    expect(taskFailure(null).title).toBe("The assistant could not finish");
  });
});

describe("openFailure and historyFailure", () => {
  it.each([
    { code: "session_not_found", what: "topic" as const, title: "This topic was not found" },
    { code: "task_not_found", what: "question" as const, title: "This question was not found" },
    { code: "diff_unavailable", what: "changes" as const, title: "The changes could not be opened" },
    { code: "sessions_unavailable", what: "topic" as const, title: "The topic could not be opened" },
  ])("explains $code for the $what", ({ code, what, title }) => {
    expect(openFailure(error(code, false), what).title).toBe(title);
  });

  it("keeps the codes of the app out of the words that say a topic or question is missing", () => {
    const shown = openFailure(error("session_not_found", false), "topic");
    expect(shown.message).not.toMatch(CODES);
    expect(shown.technical).toBe("session_not_found, reference op");
  });

  it("says History could not be loaded, with the app's own reason", () => {
    expect(historyFailure(error("sessions_unavailable", true, "The store is unavailable."))).toMatchObject({
      title: "History could not be loaded",
      message: "The store is unavailable.",
      action: "retry",
    });
  });
});

describe("forbiddenFor", () => {
  it.each([
    { action: "browse", title: "You do not have access to this health model", words: ["cannot read hm-x", "reader role"] },
    { action: "report", title: "You cannot send health reports here", words: ["send health reports to hm-x"] },
    { action: "start", title: "You do not have access to this model", words: ["cannot read hm-x", "the assistant could not look at it"] },
    { action: "apply", title: "You cannot change this model", words: ["write to hm-x", "nothing was changed"] },
  ] as const)("names the $action action and the model", ({ action, title, words }) => {
    const shown = forbiddenFor(action, "hm-x");
    expect(shown.title).toBe(title);
    for (const word of words) expect(shown.message).toContain(word);
    expect(shown.action).toBeNull();
  });

  it("says this health model when it is not told which", () => {
    expect(forbiddenFor("browse").message).toContain("read this health model");
  });
});

describe("applyMayHaveWritten", () => {
  it.each([
    { name: "no answer", status: undefined, expected: true },
    { name: "a 500", status: 500, expected: true },
    { name: "a 502", status: 502, expected: true },
    { name: "a 503", status: 503, expected: true },
    { name: "a 504 from the ingress", status: 504, expected: true },
    { name: "a 400", status: 400, expected: false },
    { name: "a 401", status: 401, expected: false },
    { name: "a 403", status: 403, expected: false },
    { name: "a 404", status: 404, expected: false },
    { name: "a 409", status: 409, expected: false },
  ])("is $expected after $name", ({ status, expected }) => {
    expect(applyMayHaveWritten({ ...error("any", false), ...(status === undefined ? {} : { status }) })).toBe(expected);
  });
});

describe("applyUnsure", () => {
  it.each([
    { checking: true, words: ["changes to hm-x", "may have been applied", "It is checking which ones."], not: ["marked Applied"] },
    { checking: false, words: ["changes to hm-x", "may have been applied", "marked Applied were written", "may still be writing it"], not: ["is checking"] },
  ])("says what may have happened, and what the app is doing about it, when checking is $checking", ({ checking, words, not }) => {
    const shown = applyUnsure("hm-x", checking);
    expect(shown.title).toBe("Some changes may have been written");
    for (const word of words) expect(shown.message).toContain(word);
    for (const word of not) expect(shown.message).not.toContain(word);
    expect(shown.message).not.toMatch(/nothing was changed/i);
    expect(shown.action).toBeNull();
  });
});

describe("accessMessage", () => {
  it.each([
    { name: "a 403", code: "forbidden", action: "report", expected: forbiddenFor("report").message },
    { name: "another refusal", code: "health_model_busy", action: "report", expected: "message of health_model_busy" },
    { name: "a sign-in the app no longer accepts", code: "unauthenticated", action: "browse", expected: SIGN_IN_ENDED },
    { name: "a sign-in the app no longer accepts, on a report", code: "unauthenticated", action: "report", expected: SIGN_IN_ENDED },
  ] as const)("says $name in the words that fit", ({ code, action, expected }) => {
    expect(accessMessage(error(code, false), action)).toBe(expected);
  });
});

describe("startFailure and a 403", () => {
  it("says the user cannot read the model", () => {
    expect(startFailure(error("forbidden", false))).toMatchObject({ title: "You do not have access to this model", action: null });
  });
});

describe("needsDirectory", () => {
  it.each([
    { message: "AADSTS50020: User account does not exist in tenant.", expected: true },
    { message: "AADSTS50034: The user account does not exist.", expected: true },
    { message: "AADSTS90002: Tenant not found.", expected: true },
    { message: "AADSTS65001: The user has not consented.", expected: false },
    { message: "The app is starting.", expected: false },
    { message: null, expected: false },
  ])("is $expected for '$message'", ({ message, expected }) => {
    expect(needsDirectory(message)).toBe(expected);
  });
});

describe("signInHint", () => {
  it.each([
    { message: "AADSTS50105: The signed in user is not assigned to a role for the application.", expected: "Your account is not assigned to this app. Ask the owner of the app to give you access, then sign in again." },
    ...["AADSTS65001: The user or administrator has not consented.", "AADSTS90094: Administrator consent is required.", "AADSTS90095: Admin consent request.", "AADSTS500011: The resource principal was not found in the tenant."].map((message) => ({
      message,
      expected: "The app has not been approved in your directory yet. An administrator of the directory has to approve it once for the whole organization. If you are the administrator, sign in again and approve it for your organization.",
    })),
    ...["AADSTS50020: User account 'x' from identity provider 'live.com' does not exist in tenant 'y' and cannot access the application.", "AADSTS50034: The user account does not exist in the directory."].map((message) => ({
      message,
      expected: "Your account is not a member or a guest of the directory you signed in to. Use a work or school account of that directory. For a personal account, name the directory it belongs to below.",
    })),
    { message: "AADSTS90002: Tenant not found.", expected: "That directory was not found. Check its domain or ID and try again." },
    { message: "AADSTS50076: MFA required.", expected: "Your organization asks for a second step to sign in. Sign in again and complete it." },
    { message: "AADSTS700016: Application not found.", expected: "The app was not found in the directory you signed in to. An administrator of that directory has to approve it, or you signed in to the wrong directory. If you run the app, check its client ID." },
    ...["AADSTS700054: response_type id_token is not enabled.", "AADSTS900144: The request body must contain client_id."].map((message) => ({
      message,
      expected: "Signing in is set up incorrectly for this app. Tell the person who runs it.",
    })),
    { message: "The app is starting.", expected: null },
    { message: null, expected: null },
  ])("reads '$message'", ({ message, expected }) => {
    expect(signInHint(message)).toBe(expected);
  });
});

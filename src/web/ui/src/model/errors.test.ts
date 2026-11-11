import { describe, expect, it } from "vitest";
import { SIGN_IN_ENDED, accessMessage, forbiddenFor, sessionFailure, startFailure, streamFailure, taskFailure } from "./errors";
import type { ApiError } from "./types";

const error = (code: string, retryable: boolean, message = `message of ${code}`): ApiError => ({
  code,
  message,
  retryable,
  operationId: "op",
});

describe("startFailure", () => {
  it.each([
    { code: "task_running", retryable: true, title: "A Task is already running", action: null },
    { code: "agents_busy", retryable: true, title: "All agents are busy", action: "retry" },
    { code: "task_limit", retryable: false, title: "This Session is full", action: "new-session" },
    { code: "payload_too_large", retryable: false, title: "The request is too large", action: null },
    { code: "sessions_unavailable", retryable: true, title: "The Task did not start", action: "retry" },
    { code: "invalid_instruction", retryable: false, title: "The Task did not start", action: null },
  ])("explains $code", ({ code, retryable, title, action }) => {
    const shown = startFailure(error(code, retryable));
    expect(shown.title).toBe(title);
    expect(shown.action).toBe(action);
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

describe("sessionFailure", () => {
  it.each([
    { code: "session_limit", retryable: false, title: "The app has no room for another Session", action: null },
    { code: "sessions_unavailable", retryable: true, title: "The Session was not created", action: "retry" },
  ])("explains $code", ({ code, retryable, title, action }) => {
    expect(sessionFailure(error(code, retryable))).toMatchObject({ title, action });
  });
});

describe("streamFailure", () => {
  it.each([
    { code: "too_many_subscribers", retryable: true, title: "Too many viewers", action: "retry" },
    { code: "invalid_last_event_id", retryable: false, title: "The timeline could not resume", action: "retry" },
    { code: "task_not_found", retryable: false, title: "The Task is gone", action: null },
    { code: "network_error", retryable: true, title: "The live connection closed", action: "retry" },
  ])("explains $code", ({ code, retryable, title, action }) => {
    expect(streamFailure(error(code, retryable))).toMatchObject({ title, action });
  });

  it("still offers a reconnect when the endpoint could not be asked", () => {
    expect(streamFailure(null)).toMatchObject({ title: "The live connection closed", action: "retry" });
  });
});

describe("taskFailure", () => {
  it.each([
    { code: "interrupted", title: "The Task was interrupted", text: "app restarted" },
    { code: "timeout", title: "The Task timed out", text: "ran for too long" },
    { code: "agent_failed", title: "The Task failed", text: "The agent stopped. (agent_failed)" },
  ])("explains a Task that failed with $code", ({ code, title, text }) => {
    const shown = taskFailure({ code, message: "The agent stopped." });
    expect(shown.title).toBe(title);
    expect(shown.message).toContain(text);
    expect(shown.action).toBe("retry");
  });

  it("explains a failure that carries no reason", () => {
    expect(taskFailure(undefined).message).toBe("The agent did not finish the Task.");
    expect(taskFailure(null).title).toBe("The Task failed");
  });
});

describe("forbiddenFor", () => {
  it.each([
    { action: "browse", title: "No access to this health model", words: ["read hm-x", "reader role"] },
    { action: "report", title: "You cannot send health reports here", words: ["send a health report to hm-x"] },
    { action: "start", title: "No access to the target model", words: ["read hm-x", "the Task did not start"] },
    { action: "apply", title: "You cannot Apply here", words: ["write to hm-x", "nothing was applied"] },
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
  it("says the user cannot read the target model", () => {
    expect(startFailure(error("forbidden", false))).toMatchObject({ title: "No access to the target model", action: null });
  });
});

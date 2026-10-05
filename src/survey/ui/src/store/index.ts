import { configureStore, createSlice } from "@reduxjs/toolkit";
import type { PayloadAction, ThunkAction, UnknownAction } from "@reduxjs/toolkit";
import { acknowledge, applyDraft, parseBallot, parseSurvey, reorder } from "../model";
import type { Ballot, Dirty, Question, Survey } from "../model";
import { newKey, rememberAuthor, responseKey } from "../browser";
import { ApiError, request } from "./api";

type State = {
  editor: { survey: Survey | null; questions: Question[]; key: string; warning: string; error: string; saving: boolean };
  response: { survey: Survey | null; ballot: Ballot; dirty: Dirty; revision: number;
    status: "loading" | "unanswered" | "saving" | "saved" | "error"; error: string; code: string };
};
const initialState: State = {
  editor: { survey: null, questions: [], key: "", warning: "", error: "", saving: false },
  response: { survey: null, ballot: { version: 0, answers: {} }, dirty: {}, revision: 0,
    status: "loading", error: "", code: "" },
};
const slice = createSlice({
  name: "survey", initialState,
  reducers: {
    editorOpened(state, action: PayloadAction<{ survey: Survey | null; key: string; warning: string }>) {
      state.editor = { ...action.payload, questions: action.payload.survey?.questions ?? [],
        error: "", saving: false };
    },
    questionAdded(state, action: PayloadAction<Question>) { state.editor.questions.push(action.payload); },
    statementChanged(state, action: PayloadAction<{ id: string; statement: string }>) {
      const question = state.editor.questions.find(q => q.id === action.payload.id);
      if (question) question.statement = action.payload.statement;
    },
    moved(state, action: PayloadAction<{ from: number; to: number }>) {
      state.editor.questions = reorder(state.editor.questions, action.payload.from, action.payload.to);
    },
    editorSaving(state) { state.editor.saving = true; state.editor.error = ""; },
    editorFailed(state, action: PayloadAction<string>) { state.editor.error = action.payload; state.editor.saving = false; },
    editorRecovered(state, action: PayloadAction<Survey>) {
      const draft = state.editor.questions;
      state.editor.survey = action.payload;
      state.editor.questions = [...draft, ...action.payload.questions.filter(q => !draft.some(old => old.id === q.id))];
    },
    editorSaved(state, action: PayloadAction<{ survey: Survey; warning: string }>) {
      state.editor.survey = action.payload.survey;
      state.editor.questions = action.payload.survey.questions;
      state.editor.warning = action.payload.warning;
      state.editor.saving = false;
    },
    responseOpened(state, action: PayloadAction<{ code: string; survey: Survey; ballot: Ballot }>) {
      state.response = { ...action.payload, dirty: {}, revision: 0, error: "",
        status: action.payload.ballot.version ? "saved" : "unanswered" };
    },
    answerChanged(state, action: PayloadAction<{ id: string; value: number | null }>) {
      state.response.revision += 1;
      state.response.dirty[action.payload.id] = { value: action.payload.value, revision: state.response.revision };
      state.response.status = "saving";
      state.response.error = "";
    },
    responseSaving(state) { state.response.status = "saving"; state.response.error = ""; },
    responseSaved(state, action: PayloadAction<{ ballot: Ballot; sent: Dirty }>) {
      state.response.ballot = action.payload.ballot;
      state.response.dirty = acknowledge(state.response.dirty, action.payload.sent);
      state.response.status = Object.keys(state.response.dirty).length ? "saving" : "saved";
    },
    responseRecovered(state, action: PayloadAction<{ survey: Survey; ballot: Ballot }>) {
      state.response.survey = action.payload.survey;
      state.response.ballot = action.payload.ballot;
    },
    responseFailed(state, action: PayloadAction<string>) {
      state.response.status = "error"; state.response.error = action.payload;
    },
  },
});
export const actions = slice.actions;
export const store = configureStore({ reducer: slice.reducer });
export type AppState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
type Effect<T> = ThunkAction<T, AppState, unknown, UnknownAction>;
const message = (error: unknown) => error instanceof Error ? error.message : "Request failed. Retain your edits and retry.";

export const saveEditor = (): Effect<Promise<void>> => async (dispatch, getState) => {
  const editor = getState().editor;
  if (editor.saving) return;
  dispatch(actions.editorSaving());
  try {
    const survey = await request(editor.survey ? `/${editor.survey.code}` : "", parseSurvey, {
      method: editor.survey ? "PUT" : "POST", key: editor.key,
      body: { questions: editor.questions, ...(editor.survey ? { version: editor.survey.version } : {}) },
    });
    dispatch(actions.editorSaved({ survey, warning: rememberAuthor({ code: survey.code, key: editor.key }) }));
    history.replaceState(null, "", `/edit/${survey.code}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && editor.survey) {
      try {
        const latest = await request(`/${editor.survey.code}/editor`, parseSurvey, { key: editor.key });
        dispatch(actions.editorRecovered(latest));
      } catch (recovery) { dispatch(actions.editorFailed(message(recovery))); return; }
    }
    dispatch(actions.editorFailed(message(error)));
  }
};

export const createEditor = (): Effect<void> => dispatch => {
  dispatch(actions.editorOpened({ survey: null, key: newKey(), warning: "" }));
};

export const openResponse = (code: string): Effect<Promise<void>> => async dispatch => {
  try {
    const survey = await request(`/${encodeURIComponent(code)}`, parseSurvey);
    const key = responseKey(survey.code);
    const ballot = await request(`/${survey.code}/ballot`, parseBallot, { key });
    dispatch(actions.responseOpened({ code: survey.code, survey, ballot }));
  } catch (error) { dispatch(actions.responseFailed(message(error))); }
};

let inFlight: Promise<boolean> | null = null;
export const flushAnswers = (): Effect<Promise<boolean>> => (dispatch, getState) => {
  if (inFlight) return inFlight;
  const run = async (): Promise<boolean> => {
    while (Object.keys(getState().response.dirty).length) {
      const state = getState().response;
      if (!state.survey) return false;
      const sent = state.dirty;
      dispatch(actions.responseSaving());
      try {
        const key = responseKey(state.code);
        const ballot = await request(`/${state.code}/ballot`, parseBallot, {
          method: "PUT", key, body: { version: state.ballot.version,
            survey_version: state.survey.version,
            answers: Object.fromEntries(Object.entries(sent).map(([id, edit]) => [id, edit.value])) },
        });
        dispatch(actions.responseSaved({ ballot, sent }));
      } catch (error) {
        if (error instanceof ApiError && (error.status === 409 || error.status === 0)) {
          try {
            const key = responseKey(state.code);
            const survey = await request(`/${state.code}`, parseSurvey);
            const ballot = await request(`/${state.code}/ballot`, parseBallot, { key });
            dispatch(actions.responseRecovered({ survey, ballot }));
          } catch (recovery) { dispatch(actions.responseFailed(message(recovery))); return false; }
        }
        dispatch(actions.responseFailed(message(error)));
        return false;
      }
    }
    return true;
  };
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
};

export function responseValues(state: State) {
  const draft = Object.fromEntries(Object.entries(state.response.dirty).map(([id, edit]) => [id, edit.value]));
  return applyDraft(state.response.ballot.answers, draft);
}

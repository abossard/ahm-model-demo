import { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import QRCode from "qrcode";
import { authors, captureAuthor, joinUrl, privateUrl, rememberAuthor } from "../browser";
import type { Results, Survey } from "../model";
import { parseResults, parseSurvey } from "../model";
import { request } from "../store/api";
import { actions, createEditor, flushAnswers, openResponse, responseValues, saveEditor } from "../store";
import type { AppDispatch, AppState } from "../store";

const useAppDispatch = useDispatch.withTypes<AppDispatch>();
const useAppSelector = useSelector.withTypes<AppState>();

function JoinForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return <form onSubmit={event => {
    event.preventDefault();
    if (!/^[A-Za-z]{6}$/.test(code.trim())) { setError("Enter a six-letter survey code."); return; }
    location.assign(`/join/${code.trim().toUpperCase()}`);
  }}>
    <label htmlFor="join-code">Survey code</label>
    <div className="inline"><input id="join-code" value={code} maxLength={6} autoCapitalize="characters"
      autoComplete="off" onChange={event => setCode(event.target.value)} placeholder="ABCDEF" />
      <button type="submit">Join</button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function Home() {
  const saved = authors();
  return <>
    <p className="eyebrow">A little clarity, together</p>
    <h1>Ask. Slide. Understand.</h1>
    <p>Create a few statements. Share a code. See where everyone stands.</p>
    <a className="button primary" href="/create">Create a survey</a>
    <section className="card"><h2>Join a survey</h2><JoinForm /></section>
    {saved.warning && <p role="alert">{saved.warning}</p>}
    {saved.entries.length > 0 && <section><h2>Your surveys</h2>{saved.entries.map(author =>
      <p key={author.code}><a href={privateUrl(author.code, author.key)}>Edit {author.code}</a></p>)}</section>}
  </>;
}

function Slider({ id, statement, value, scale, preview = false, change }: {
  id: string; statement: string; value: number | null; preview?: boolean;
  scale: Survey["scale"];
  change?: (value: number) => void;
}) {
  const touch = useRef<{ x: number; y: number; vertical: boolean } | null>(null);
  const [touchValue, setTouchValue] = useState<number | null>(null);
  return <div className={`slider ${value === null ? "unanswered" : "answered"}`}>
    <label htmlFor={`slider-${id}`}>{statement}</label>
    <output htmlFor={`slider-${id}`}>{preview ? "Preview" : value === null ? "Unanswered (50)" : `Answer: ${value}`}</output>
    <input id={`slider-${id}`} type="range" min={scale.min} max={scale.max} step={scale.step} value={touchValue ?? value ?? 50}
      disabled={preview} aria-orientation="horizontal"
      aria-valuetext={value === null ? "50, unanswered" : `${value}, answered`}
      onPointerDown={event => {
        if (event.pointerType === "touch")
          touch.current = { x: event.clientX, y: event.clientY, vertical: false };
      }}
      onPointerMove={event => {
        const start = touch.current;
        if (start && Math.abs(event.clientY - start.y) > 8 &&
            Math.abs(event.clientY - start.y) > Math.abs(event.clientX - start.x))
          start.vertical = true;
      }}
      onPointerCancel={() => { touch.current = null; setTouchValue(null); }}
      onChange={event => {
        const next = Number(event.target.value);
        if (touch.current) setTouchValue(next);
        else change?.(next);
      }}
      onPointerUp={event => {
        const start = touch.current;
        if (!start?.vertical) change?.(Number(event.currentTarget.value));
        touch.current = null;
        setTouchValue(null);
      }}
      onKeyUp={event => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
          change?.(Number(event.currentTarget.value));
      }} />
    <div className="endpoints"><span>Strongly disagree</span><span>Strongly agree</span></div>
    {!preview && value === null && <button className="quiet" onClick={() => change?.(50)}>Use 50 as my answer</button>}
  </div>;
}

function Share({ survey, authorKey }: { survey: Survey; authorKey: string }) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const url = joinUrl(survey.code);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, { width: 256, margin: 4, errorCorrectionLevel: "M" })
      .then(data => { if (active) setImage(data); })
      .catch(() => { if (active) setError("QR generation failed. Share the public join link instead."); });
    return () => { active = false; };
  }, [url]);
  return <section className="card share">
    <h2>Ready to share</h2>
    <p className="code">{survey.code}</p>
    <label htmlFor="private-link">Private editing URL. Keep this safe, do not share it with respondents.</label>
    <input id="private-link" readOnly value={privateUrl(survey.code, authorKey)} />
    <button onClick={() => {
      navigator.clipboard.writeText(privateUrl(survey.code, authorKey))
        .catch(() => setError("Copy failed. Select and copy the private URL above."));
    }}>Copy private URL</button>
    <h3>Public join link</h3>
    <a href={url}>{url}</a>
    {image && <img src={image} width="256" height="256" alt={`QR code to join survey ${survey.code}`} />}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function Editor({ code }: { code: string | null }) {
  const dispatch = useAppDispatch();
  const editor = useAppSelector(state => state.editor);
  const [loading, setLoading] = useState(Boolean(code));
  const drag = useRef<{ index: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!code) { dispatch(createEditor()); return; }
    let active = true;
    const load = () => {
      setLoading(true);
      try {
        const author = captureAuthor(code);
        request(`/${encodeURIComponent(code)}/editor`, parseSurvey, { key: author.key })
          .then(survey => {
            if (active) dispatch(actions.editorOpened({ survey, key: author.key,
              warning: rememberAuthor({ code: survey.code, key: author.key }) }));
          })
          .catch((error: unknown) => { if (active) dispatch(actions.editorFailed(error instanceof Error ? error.message : "Editor could not load.")); })
          .finally(() => { if (active) setLoading(false); });
      } catch (error) {
        dispatch(actions.editorFailed(error instanceof Error ? error.message : "Editor could not load."));
        setLoading(false);
      }
    };
    load();
    window.addEventListener("hashchange", load);
    return () => { active = false; window.removeEventListener("hashchange", load); };
  }, [code, dispatch]);
  if (loading) return <p role="status">Loading editor...</p>;
  return <>
    <h1>{editor.survey ? `Edit ${editor.survey.code}` : "Create a survey"}</h1>
    <p>Statements, not questions. Respondents choose how much they agree.</p>
    {editor.survey?.voting_started && <p>Voting has started. Existing wording is locked permanently. You can still add and reorder statements.</p>}
    {editor.questions.map((question, index) => {
      const locked = editor.survey?.voting_started &&
        editor.survey.questions.some(q => q.id === question.id);
      return <section className="card question" key={question.id} data-question-id={question.id}>
        <div className="reorder"><span role="button" tabIndex={editor.saving ? -1 : 0}
          className="drag-handle" aria-disabled={editor.saving}
          aria-label={`Drag statement ${index + 1}`}
          onPointerDown={event => {
            if (editor.saving || event.button !== 0) return;
            drag.current = { index, x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerUp={event => {
            const start = drag.current;
            drag.current = null;
            if (!start || editor.saving || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-question-id]");
            const to = editor.questions.findIndex(q => q.id === target?.getAttribute("data-question-id"));
            if (to >= 0) dispatch(actions.moved({ from: start.index, to }));
          }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={event => {
            if (editor.saving || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            dispatch(actions.moved({ from: index, to: index + (event.key === "ArrowUp" ? -1 : 1) }));
          }}>Drag</span>
          <button aria-label={`Move statement ${index + 1} up`} disabled={index === 0 || editor.saving}
            onClick={() => dispatch(actions.moved({ from: index, to: index - 1 }))}>Up</button>
          <button aria-label={`Move statement ${index + 1} down`} disabled={index === editor.questions.length - 1 || editor.saving}
            onClick={() => dispatch(actions.moved({ from: index, to: index + 1 }))}>Down</button></div>
        <label htmlFor={`statement-${question.id}`}>Statement {index + 1}</label>
        <textarea id={`statement-${question.id}`} value={question.statement} maxLength={2000}
          readOnly={Boolean(locked)} disabled={editor.saving}
          onChange={event => dispatch(actions.statementChanged({ id: question.id, statement: event.target.value }))} />
        <Slider id={question.id} statement={question.statement || "Your statement preview"} value={null}
          scale={editor.survey?.scale ?? { min: 0, max: 100, step: 1 }} preview />
      </section>;
    })}
    {editor.key && <div className="inline">
      <button disabled={editor.saving} onClick={() => dispatch(actions.questionAdded({ id: crypto.randomUUID(), statement: "" }))}>Add statement</button>
      <button className="primary" disabled={editor.saving || !editor.questions.length}
        onClick={() => void dispatch(saveEditor())}>{editor.saving ? "Saving..." : "Save"}</button>
    </div>}
    {editor.error && <p role="alert">{editor.error}</p>}
    {editor.error && editor.survey && <button onClick={() => location.reload()}>
      Reload saved definition
    </button>}
    {editor.warning && <p role="alert">{editor.warning}</p>}
    {editor.survey && !editor.saving && <p role="status">{editor.error ? "Not saved" :
      JSON.stringify(editor.questions) === JSON.stringify(editor.survey.questions) ?
        `Saved version ${editor.survey.version}` : "Unsaved changes"}</p>}
    {editor.survey && <Share survey={editor.survey} authorKey={editor.key} />}
  </>;
}

function Join({ code }: { code: string }) {
  const dispatch = useAppDispatch();
  const state = useAppSelector(state => state);
  const response = state.response;
  const values = responseValues(state);
  const survey = response.survey;
  useEffect(() => { void dispatch(openResponse(code)); }, [code, dispatch]);
  useEffect(() => {
    if (!Object.keys(response.dirty).length || response.status === "error") return;
    const timer = setTimeout(() => { void dispatch(flushAnswers()); }, 300);
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { clearTimeout(timer); window.removeEventListener("beforeunload", warn); };
  }, [response.dirty, response.status, dispatch]);
  return <>
    <h1>{response.survey ? `Survey ${response.survey.code}` : "Join a survey"}</h1>
    {survey ? <>
      <p>Slide to answer. Changes save automatically. An untouched slider is not a vote.</p>
      {survey.questions.map(question =>
        <section className="card question" key={question.id}>
          <Slider id={question.id} statement={question.statement} value={values[question.id] ?? null} scale={survey.scale}
            change={value => dispatch(actions.answerChanged({ id: question.id, value }))} />
          <button className="quiet" onClick={() => dispatch(actions.answerChanged({ id: question.id, value: null }))}>
            Reset/Delete answer
          </button>
        </section>)}
      <p role="status">{response.status === "saved" ? "Saved" :
        response.status === "saving" ? "Saving..." : response.status === "unanswered" ? "No answers yet" : "Not saved"}</p>
      <a href={`/results/${survey.code}`} onClick={event => {
        event.preventDefault();
        void dispatch(flushAnswers()).then(saved => {
          if (saved) location.assign(`/results/${survey.code}`);
        });
      }}>Results</a>
    </> : response.status !== "error" && <p role="status">Loading survey...</p>}
    {response.error && <><p role="alert">{response.error}</p><button onClick={() => {
      if (response.survey) void dispatch(flushAnswers());
      else void dispatch(openResponse(code));
    }}>Retry</button><JoinForm /></>}
  </>;
}

function ResultPage({ code }: { code: string }) {
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request(`/${encodeURIComponent(code)}/results`, parseResults)
      .then(value => { if (active) setResults(value); })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Results failed."); });
    return () => { active = false; };
  }, [code]);
  return <><h1>Results {results?.code}</h1>
    {error && <><p role="alert">{error}</p><JoinForm /></>}
    {!results && !error && <p role="status">Loading results...</p>}
    {results?.questions.map(question => <section className="card" key={question.id}>
      <h2>{question.statement}</h2>
      <p>{question.count} answered</p>
      {question.mean === null ? <p>No answers yet</p> : <>
        <p>Mean agreement: {question.mean.toFixed(1)} / {results.scale.max}</p>
        <svg className="distribution" viewBox="0 0 101 60" role="img"
          aria-label={`Answer distribution for ${question.statement}`}>
          {question.distribution.map((count, value) =>
            <rect key={value} x={value} y={60 - count / question.count * 60}
              width="0.9" height={count / question.count * 60}><title>{value}: {count} answers</title></rect>)}
        </svg>
        <div className="endpoints"><span>Strongly disagree</span><span>Strongly agree</span></div>
      </>}
    </section>)}
    {results && <a href={`/join/${results.code}`}>Back to survey</a>}
  </>;
}

export function App() {
  const [pathname, setPathname] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPathname(location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  const path = pathname.split("/");
  const route = path[1] ?? "";
  const code = path[2] ?? "";
  return <><header><a href="/" aria-label="Survey home">survey<span>.</span></a><span>Small questions. Shared perspective.</span></header>
    <main>{route === "" ? <Home /> : route === "create" ? <Editor code={null} /> :
      route === "edit" ? <Editor code={code.toUpperCase()} /> :
      route === "join" ? <Join code={code} /> :
      route === "results" ? <ResultPage code={code} /> : <><h1>Page not found</h1><a href="/">Home</a></>}</main>
    <footer>No accounts or fingerprinting. This browser's key remembers your response. Clearing storage or using another browser may create another ballot. Results are public and small groups can reveal individual answers.</footer>
  </>;
}

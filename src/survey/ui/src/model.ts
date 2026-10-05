export type Question = { id: string; statement: string };
export type Survey = {
  code: string;
  version: number;
  voting_started: boolean;
  scale: { min: number; max: number; step: number };
  questions: Question[];
};
export type Answers = Record<string, number | null>;
export type Ballot = { version: number; answers: Answers };
export type Dirty = Record<string, { value: number | null; revision: number }>;
export type Results = Omit<Survey, "questions"> & { questions: (Question & {
  count: number; mean: number | null; distribution: number[];
})[] };

export function reorder(questions: readonly Question[], from: number, to: number): Question[] {
  const copy = [...questions];
  const item = copy[from];
  if (!item || to < 0 || to >= copy.length) return copy;
  copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

export function applyDraft(answers: Answers, draft: Answers): Answers {
  return { ...answers, ...draft };
}

export function acknowledge(dirty: Dirty, sent: Dirty): Dirty {
  return Object.fromEntries(Object.entries(dirty).filter(([id, change]) =>
    change.revision !== sent[id]?.revision));
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSurvey(value: unknown): Survey {
  if (!record(value) || typeof value.code !== "string" || !/^[A-Z]{6}$/.test(value.code) ||
      !Number.isInteger(value.version) || typeof value.version !== "number" ||
      typeof value.voting_started !== "boolean" || !record(value.scale) ||
      value.scale.min !== 0 || value.scale.max !== 100 || value.scale.step !== 1 ||
      !Array.isArray(value.questions)) throw new Error("Invalid survey response.");
  const questions = value.questions.map((q: unknown) => {
    if (!record(q) || typeof q.id !== "string" || typeof q.statement !== "string")
      throw new Error("Invalid question response.");
    return { id: q.id, statement: q.statement };
  });
  return { code: value.code, version: value.version, voting_started: value.voting_started,
    scale: { min: 0, max: 100, step: 1 }, questions };
}

export function parseBallot(value: unknown): Ballot {
  if (!record(value) || typeof value.version !== "number" || !Number.isInteger(value.version) ||
      !record(value.answers)) throw new Error("Invalid ballot response.");
  const answers: Answers = {};
  for (const [id, answer] of Object.entries(value.answers)) {
    if (answer !== null && (typeof answer !== "number" || !Number.isInteger(answer) ||
        answer < 0 || answer > 100)) throw new Error("Invalid answer response.");
    answers[id] = answer;
  }
  return { version: value.version, answers };
}

export function parseResults(value: unknown): Results {
  const survey = parseSurvey(value);
  if (!record(value) || !Array.isArray(value.questions)) throw new Error("Invalid results.");
  const questions = value.questions.map((q: unknown, index) => {
    const question = survey.questions[index];
    if (!question || !record(q) || typeof q.count !== "number" ||
        (q.mean !== null && typeof q.mean !== "number") || !Array.isArray(q.distribution) ||
        q.distribution.length !== 101) throw new Error("Invalid aggregate response.");
    const distribution = q.distribution.map((n: unknown) => {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error("Invalid distribution.");
      return n;
    });
    return { ...question, count: q.count, mean: q.mean, distribution };
  });
  return { ...survey, questions };
}

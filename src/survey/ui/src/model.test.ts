import { describe, expect, it } from "vitest";
import { applyDraft, acknowledge, reorder } from "./model";

describe("stable survey state", () => {
  it.each([[0, 2, ["b", "c", "a"]], [2, 0, ["c", "a", "b"]], [1, 1, ["a", "b", "c"]]])(
    "reorders %i to %i without changing input", (from, to, ids) => {
      const questions = ["a", "b", "c"].map(id => ({ id, statement: id }));
      expect(reorder(questions, from, to).map(q => q.id)).toEqual(ids);
      expect(questions.map(q => q.id)).toEqual(["a", "b", "c"]);
    },
  );
  it.each([null, 0, 50, 100])("preserves explicit answer %s", value => {
    const before = { a: 75, b: 25 };
    expect(applyDraft(before, { a: value })).toEqual({ a: value, b: 25 });
    expect(before).toEqual({ a: 75, b: 25 });
  });
  it("does not let a delayed save erase a newer reset", () => {
    const dirty = { a: { value: null, revision: 2 }, b: { value: 50, revision: 1 } };
    expect(acknowledge(dirty, { a: { value: 75, revision: 1 }, b: { value: 50, revision: 1 } }))
      .toEqual({ a: { value: null, revision: 2 } });
    expect(dirty.a.value).toBeNull();
  });
});

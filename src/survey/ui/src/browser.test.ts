import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authors, newKey, rememberAuthor, responseKey } from "./browser";

describe("browser capability ownership", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); },
      clear: () => { values.clear(); },
      key: index => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    };
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("generates independent 256-bit URL-safe capabilities", () => {
    const first = newKey();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(atob(first.replaceAll("-", "+").replaceAll("_", "/") + "=")).toHaveLength(32);
    expect(newKey()).not.toEqual(first);
  });
  it.each(["getItem", "setItem"] as const)("refuses a response write if %s fails", operation => {
    localStorage.clear();
    const spy = vi.spyOn(localStorage, operation).mockImplementation(() => {
      throw new DOMException("Unavailable", "SecurityError");
    });
    expect(() => responseKey("ABCDEF")).toThrow(/storage|stored/);
    spy.mockRestore();
  });
  it("retains the generated response key through a quota failure", () => {
    localStorage.clear();
    const attempted: string[] = [];
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation((_name, value) => {
      attempted.push(value);
      throw new DOMException("Quota", "QuotaExceededError");
    });
    expect(() => responseKey("QUOTAA")).toThrow("could not be stored");
    expect(() => responseKey("QUOTAA")).toThrow("could not be stored");
    expect(attempted[1]).toBe(attempted[0]);
    spy.mockRestore();
    expect(responseKey("QUOTAA")).toBe(attempted[0]);
  });
  it("does not replace a damaged response record", () => {
    localStorage.clear();
    localStorage.setItem("survey.response.v1.DAMAGE", "bad");
    expect(() => responseKey("DAMAGE")).toThrow("No replacement");
    expect(localStorage.getItem("survey.response.v1.DAMAGE")).toBe("bad");
  });
  it("keeps author sessions in memory but warns about a failed write", () => {
    localStorage.clear();
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    const key = newKey();
    expect(rememberAuthor({ code: "AUTHOR", key })).toContain("Keep your private editing URL");
    expect(authors().entries).toContainEqual({ code: "AUTHOR", key });
    spy.mockRestore();
  });
});

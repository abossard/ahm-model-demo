import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  resolveInitialTheme,
  sanitizeTheme,
  type ThemeName,
} from "./theme";

describe("sanitizeTheme", () => {
  it.each([
    { input: "light", expected: "light" },
    { input: "dark", expected: "dark" },
    { input: "invalid", expected: null },
    { input: null, expected: null },
  ])("normalizes supported values ($input)", ({ input, expected }) => {
    expect(sanitizeTheme(input)).toBe(expected);
  });
});

describe("resolveInitialTheme", () => {
  function makeStorage(value: string | null): Storage {
    const data = new Map<string, string>();
    if (value !== null) data.set(THEME_STORAGE_KEY, value);
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, next: string) => void data.set(key, next),
      removeItem: (key: string) => void data.delete(key),
      clear: () => void data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    };
  }

  it.each([
    { saved: "light", systemDark: true, expected: "light" as ThemeName },
    { saved: "dark", systemDark: false, expected: "dark" as ThemeName },
    { saved: "invalid", systemDark: true, expected: "dark" as ThemeName },
    { saved: null, systemDark: false, expected: "light" as ThemeName },
  ])("prefers saved valid theme over system ($saved)", ({ saved, systemDark, expected }) => {
    const actual = resolveInitialTheme(
      () => makeStorage(saved),
      () => systemDark,
    );
    expect(actual).toBe(expected);
  });

  it("falls back to system preference when storage access throws", () => {
    const actual = resolveInitialTheme(
      () => {
        throw new Error("blocked");
      },
      () => true,
    );
    expect(actual).toBe("dark");
  });
});

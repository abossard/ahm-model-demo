import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  persistTheme,
  resolveInitialTheme,
  sanitizeTheme,
  watchSystemTheme,
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

describe("persistTheme", () => {
  it.each([
    { explicit: true, before: null, after: "dark" },
    { explicit: false, before: "dark", after: null },
    { explicit: false, before: null, after: null },
  ])("keeps $after when explicit=$explicit and $before was kept", ({ explicit, before, after }) => {
    window.localStorage.clear();
    if (before) window.localStorage.setItem(THEME_STORAGE_KEY, before);
    persistTheme("dark", explicit, window);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(after);
  });
});

describe("applyTheme", () => {
  it.each([
    { explicit: true, content: "dark" },
    { explicit: false, content: "light dark" },
  ])("sets the data-theme and a color-scheme of $content when explicit=$explicit", ({ explicit, content }) => {
    document.head.innerHTML = '<meta name="color-scheme" content="light dark">';
    applyTheme("dark", document, explicit);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(content);
  });
});

describe("watchSystemTheme", () => {
  function makeWindow() {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    const windowObject = {
      matchMedia: () => ({
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
      }),
    } as unknown as Window;
    return { windowObject, listeners };
  }

  it.each([
    { matches: true, expected: "dark" },
    { matches: false, expected: "light" },
  ])("reports $expected when the system change matches dark=$matches", ({ matches, expected }) => {
    const { windowObject, listeners } = makeWindow();
    const seen: ThemeName[] = [];
    watchSystemTheme(windowObject, (theme) => seen.push(theme));
    listeners.forEach((listener) => listener({ matches }));
    expect(seen).toEqual([expected]);
  });

  it("stops listening when the returned function is called", () => {
    const { windowObject, listeners } = makeWindow();
    watchSystemTheme(windowObject, () => undefined)();
    expect(listeners.size).toBe(0);
  });
});

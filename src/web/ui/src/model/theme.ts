export type ThemeName = "light" | "dark";

export const THEME_STORAGE_KEY = "health-pulse-theme";

export function sanitizeTheme(value: string | null | undefined): ThemeName | null {
  if (value === "light" || value === "dark") return value;
  return null;
}

function systemPrefersDark(windowObject: Window): boolean {
  return windowObject.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveInitialTheme(
  getStorage: () => Storage,
  readSystemDark: () => boolean,
): ThemeName {
  try {
    const saved = sanitizeTheme(getStorage().getItem(THEME_STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // Keep going with system fallback when storage is unavailable.
  }
  return readSystemDark() ? "dark" : "light";
}

export function detectInitialTheme(windowObject: Window): ThemeName {
  return resolveInitialTheme(
    () => windowObject.localStorage,
    () => systemPrefersDark(windowObject),
  );
}

export function applyTheme(theme: ThemeName, documentObject: Document): void {
  documentObject.documentElement.dataset.theme = theme;
}

export function persistTheme(theme: ThemeName, windowObject: Window): void {
  try {
    windowObject.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Keep in-memory preference only when storage is unavailable.
  }
}

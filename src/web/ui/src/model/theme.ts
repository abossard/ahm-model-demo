export type ThemeName = "light" | "dark";

export const THEME_STORAGE_KEY = "health-pulse-theme";

export function sanitizeTheme(value: string | null | undefined): ThemeName | null {
  if (value === "light" || value === "dark") return value;
  return null;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(windowObject: Window): boolean {
  return typeof windowObject.matchMedia === "function" && windowObject.matchMedia(DARK_QUERY).matches;
}

/** The theme the viewer chose and this browser kept; null while the page follows the system. */
export function readStoredTheme(getStorage: () => Storage): ThemeName | null {
  try {
    return sanitizeTheme(getStorage().getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function resolveInitialTheme(
  getStorage: () => Storage,
  readSystemDark: () => boolean,
): ThemeName {
  return readStoredTheme(getStorage) ?? (readSystemDark() ? "dark" : "light");
}

export function detectSystemTheme(windowObject: Window): ThemeName {
  return systemPrefersDark(windowObject) ? "dark" : "light";
}

/** Calls back with the system theme each time the operating system changes it; returns the way to stop. */
export function watchSystemTheme(windowObject: Window, onChange: (theme: ThemeName) => void): () => void {
  if (typeof windowObject.matchMedia !== "function") return () => undefined;
  const media = windowObject.matchMedia(DARK_QUERY);
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches ? "dark" : "light");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function detectInitialTheme(windowObject: Window): ThemeName {
  return resolveInitialTheme(
    () => windowObject.localStorage,
    () => systemPrefersDark(windowObject),
  );
}

/** The boot script in public/assets/theme-boot.js does the same before the first paint. */
export function applyTheme(theme: ThemeName, documentObject: Document, explicit = false): void {
  documentObject.documentElement.dataset.theme = theme;
  documentObject.querySelector('meta[name="color-scheme"]')?.setAttribute("content", explicit ? theme : "light dark");
}

/** A choice is kept; no choice (the page follows the system) removes what was kept. */
export function persistTheme(theme: ThemeName, explicit: boolean, windowObject: Window): void {
  try {
    if (explicit) windowObject.localStorage.setItem(THEME_STORAGE_KEY, theme);
    else windowObject.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Keep in-memory preference only when storage is unavailable.
  }
}

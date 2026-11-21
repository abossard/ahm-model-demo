const KEY = "health-pulse-return-query";

/** The original app stored a query alone. The builder also needs its exact, app-owned pathname. */
function allowedReturn(address: string): boolean {
  return /^(?:\?[^#\r\n]*|\/builder(?:\?[^#\r\n]*)?)$/.test(address);
}

export function rememberReturn(storage: Storage, address: string): void {
  try {
    if (allowedReturn(address)) storage.setItem(KEY, address);
    else storage.removeItem(KEY);
  } catch {
    // The user lands on the default view when storage is unavailable.
  }
}

/** Read the pending sign-in destination once, including query-only links from earlier releases. */
export function takeReturn(storage: Storage): string | null {
  try {
    const address = storage.getItem(KEY);
    storage.removeItem(KEY);
    return address !== null && allowedReturn(address) ? address : null;
  } catch {
    return null;
  }
}

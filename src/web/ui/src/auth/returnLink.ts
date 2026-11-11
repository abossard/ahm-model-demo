const KEY = "health-pulse-return-query";

/** Keeps the address's query, `?model=&session=&task=`, through a redirect to the sign-in page, in session storage. */
export function rememberReturn(storage: Storage, search: string): void {
  try {
    if (search === "") storage.removeItem(KEY);
    else storage.setItem(KEY, search);
  } catch {
    // The user lands on the default view when storage is unavailable.
  }
}

/** The query kept before a redirect, once: it is forgotten as it is read. */
export function takeReturn(storage: Storage): string | null {
  try {
    const search = storage.getItem(KEY);
    storage.removeItem(KEY);
    return search !== null && /^\?[^#]*$/.test(search) ? search : null;
  } catch {
    return null;
  }
}

import { getAuth } from "./index";

/** Keep the directory in links that can be copied or opened in another tab. */
export function workspaceLink(path: string): string {
  const tenant = getAuth().account?.tenantId;
  if (!tenant) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("tenant", tenant);
  return url.pathname + url.search + url.hash;
}

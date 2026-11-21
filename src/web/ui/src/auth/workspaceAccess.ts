import type { AzureDirectory, DirectoryDiscovery } from "./auth";

/** A definitive denial is excluded from the chooser. A transport or service failure leaves discovery incomplete. */
export class WorkspaceDenied extends Error {}
export class WorkspaceSignInRequired extends Error {
  constructor(message: string, readonly claims?: string) { super(message); }
}

export async function verifyWorkspaceAccess(tenantId: string, token: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/workspace/access", {
    headers: { Authorization: `Bearer ${token}`, "X-Workspace-Tenant": tenantId },
    mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error", ...(signal ? { signal } : {}),
  });
  if (response.status === 401 || response.status === 403) {
    const body = await response.json().catch(() => null);
    const error = body?.error;
    const message = typeof error?.message === "string" ? error.message : "Your account cannot open a workspace in this directory.";
    if (response.status === 401 && error?.code === "interaction_required") {
      throw new WorkspaceSignInRequired(message, typeof error.claims === "string" ? error.claims : undefined);
    }
    throw new WorkspaceDenied(message);
  }
  if (response.status !== 200) throw new Error(`Workspace access could not be checked (HTTP ${response.status}).`);
  const body = await response.json();
  if (typeof body?.tenantId !== "string" || body.tenantId.toLowerCase() !== tenantId) throw new WorkspaceDenied("The app could not confirm access to this directory.");
}

/** A list may span many tenants. Limit concurrent MSAL and API calls and preserve Azure's display order. */
export async function accessibleDirectories(
  candidates: AzureDirectory[], verify: (candidate: AzureDirectory) => Promise<void>, signal: AbortSignal,
): Promise<DirectoryDiscovery> {
  const remaining = candidates.values();
  const allowed = new Set<string>();
  const pending = new Set<string>();
  let incomplete = false;
  async function worker(): Promise<void> {
    for (const directory of remaining) {
      signal.throwIfAborted();
      try {
        await verify(directory);
        allowed.add(directory.tenantId);
      } catch (error) {
        if (!(error instanceof WorkspaceDenied)) {
          pending.add(directory.tenantId);
          if (!(error instanceof WorkspaceSignInRequired)) incomplete = true;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
  signal.throwIfAborted();
  return {
    directories: candidates.filter(directory => allowed.has(directory.tenantId)),
    ...(pending.size ? { needsCheck: candidates.filter(directory => pending.has(directory.tenantId)) } : {}),
    ...(incomplete ? { incomplete } : {}),
  };
}

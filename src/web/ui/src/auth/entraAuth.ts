import {
  CacheLookupPolicy,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from "@azure/msal-browser";
import { DirectoryConsentRequiredError, NAVIGATING, type Auth, type AuthAccount, type AzureDirectory, type DirectoryDiscovery } from "./auth";
import { CONSUMERS_TENANT_ID, tenantFromLink, authorityOf, canonicalDirectoryId, parseDirectoryInput, readAzureDirectories } from "./directory";
import { rememberReturn, takeReturn } from "./returnLink";
import { accessibleDirectories, verifyWorkspaceAccess, WorkspaceDenied, WorkspaceSignInRequired } from "./workspaceAccess";

export interface EntraSettings {
  readonly clientId: string;
  readonly apiScope: string;
  readonly homeDirectory?: string | null;
}

/** A SPA asking for its own API must use the bare client ID for bundled OBO consent (AADSTS90009). */
export function defaultScope(clientId: string): string {
  if (clientId.trim() === "" || clientId.includes("/")) throw new Error("The app's sign-in settings are incomplete: the client id is missing.");
  return `${clientId}/.default`;
}

export function msalConfiguration(settings: EntraSettings, origin: string): Configuration {
  return {
    auth: {
      clientId: settings.clientId,
      authority: authorityOf("common"),
      redirectUri: `${origin}/`,
      postLogoutRedirectUri: `${origin}/`,
    },
    cache: { cacheLocation: "sessionStorage" },
  };
}

// The ARM resource identifier ends in a slash; the second slash separates its delegated scope.
const ARM_SCOPE = "https://management.azure.com//user_impersonation";
type Workspace = { stage: "selecting" | "selected"; homeAccountId: string; directory: AzureDirectory };
type Session =
  | { stage: "signed-out" }
  | { stage: "choosing"; homeAccountId: string; discoveryAttempted?: boolean }
  | { stage: "discovery"; homeAccountId: string; tenantId?: string; quiet?: boolean }
  | Workspace;

function readSession(key: string): Session | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    if (saved?.stage === "signed-out") return { stage: "signed-out" };
    if (typeof saved?.homeAccountId !== "string" || !saved.homeAccountId) return null;
    if (saved.stage === "choosing" || saved.stage === "discovery") return saved;
    if ((saved.stage === "selected" || saved.stage === "selecting") && typeof saved.directory?.tenantId === "string" &&
        parseDirectoryInput(saved.directory.tenantId)?.kind === "guid" && typeof saved.directory.displayName === "string") return saved;
    return null;
  } catch {
    return null;
  }
}

function checkToken(result: AuthenticationResult, homeAccountId: string, tenantId: string): AccountInfo {
  if (!result.accessToken || !result.account || result.account.homeAccountId !== homeAccountId ||
      result.tenantId?.toLowerCase() !== tenantId.toLowerCase() || result.account.tenantId?.toLowerCase() !== tenantId.toLowerCase() ||
      result.authority?.replace(/\/$/, "").toLowerCase() !== authorityOf(tenantId).toLowerCase()) {
    throw new WorkspaceDenied("Microsoft returned a different account or directory. Sign in with the account that chose this directory.");
  }
  return result.account;
}

function needsFreshGrant(error: unknown): boolean {
  return error instanceof Error && "errorCode" in error && (error.errorCode === "invalid_grant" || error.errorCode === "invalid_resource");
}

export function createEntraAuth(settings: EntraSettings, client?: PublicClientApplication): Auth {
  const msal = client ?? new PublicClientApplication(msalConfiguration(settings, window.location.origin));
  const workspaceScope = defaultScope(settings.clientId);
  const key = `health-pulse-directory:${settings.clientId}`;
  let session = readSession(key);
  let identity: AccountInfo | null = null;
  let directoryError: string | null = null;
  let discovery: AbortController | null = null;
  let inventoryGrant: AuthenticationResult | null = null;
  let consentTenant: string | null = null;

  function save(next: Session): void {
    discovery?.abort();
    window.sessionStorage.setItem(key, JSON.stringify(next));
    session = next;
  }

  function account(): AuthAccount | null {
    if (!identity) return null;
    const selected = session?.stage === "selected" ? session.directory : null;
    return {
      name: identity.name ?? identity.username, username: identity.username, tenantId: selected?.tenantId ?? identity.tenantId,
      ...(selected ? { tenantName: selected.displayName } : {}),
    };
  }

  function requireIdentity(): AccountInfo {
    if (!identity) throw new Error("Nobody is signed in.");
    return identity;
  }

  function requireChooser(): AccountInfo {
    const user = requireIdentity();
    if (session?.stage !== "choosing") throw new Error("Sign out to choose a different directory.");
    return user;
  }

  function keepAddress(): void {
    const { pathname, search } = window.location;
    rememberReturn(window.sessionStorage, pathname === "/" ? search : pathname + search);
  }

  function silent(scope: string, user: AccountInfo, tenantId: string, refresh = false) {
    return msal.acquireTokenSilent({
      account: user, scopes: [scope], authority: authorityOf(tenantId),
      cacheLookupPolicy: refresh ? CacheLookupPolicy.RefreshToken : CacheLookupPolicy.AccessTokenAndRefreshToken,
    });
  }

  async function redirect(scope: string, user: AccountInfo, tenantId: string, state: string, claims?: string, quiet = false): Promise<never> {
    keepAddress();
    await msal.acquireTokenRedirect({ account: user, scopes: [scope], authority: authorityOf(tenantId), state, ...(claims ? { claims } : {}), ...(quiet ? { prompt: "none" } : {}) });
    return NAVIGATING;
  }

  function tenantToken(scope: string, user: AccountInfo, tenantId: string) {
    const profile = msal.getAccount({ homeAccountId: user.homeAccountId, tenantId }) ?? user;
    // MSAL indexes cached access tokens by the profile's tenant. Use its refresh token at the guest authority when
    // only the home profile is cached, so a home-tenant access token cannot satisfy this request.
    return silent(scope, profile, tenantId, profile.tenantId.toLowerCase() !== tenantId.toLowerCase());
  }

  async function workspaceToken(user: AccountInfo, tenantId: string) {
    try {
      return await tenantToken(settings.apiScope, user, tenantId);
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) throw new WorkspaceSignInRequired(error.message, error.claims);
      if (error instanceof Error && "errorCode" in error) {
        // A refresh grant can expire, or this app's API may still need to be provisioned by interactive consent.
        if (needsFreshGrant(error)) throw new WorkspaceSignInRequired(error.message);
        if (error.errorCode === "access_denied") throw new WorkspaceDenied(error.message);
      }
      throw error;
    }
  }

  async function choose(result: AuthenticationResult, pending: Workspace): Promise<AuthAccount> {
    const user = checkToken(result, pending.homeAccountId, pending.directory.tenantId);
    if (session !== pending) throw new Error("The sign-in session changed. Sign in again.");
    await verifyWorkspaceAccess(pending.directory.tenantId, result.accessToken);
    if (session !== pending) throw new Error("The sign-in session changed. Sign in again.");
    save({ ...pending, stage: "selected" });
    identity = user;
    msal.setActiveAccount(user);
    return account()!;
  }

  async function selectDirectory(directory: AzureDirectory): Promise<AuthAccount> {
    const user = requireChooser();
    const previous = session;
    const tenantId = await canonicalDirectoryId(directory.tenantId);
    if (session !== previous) throw new Error("The sign-in session changed. Sign in again.");
    const pending: Workspace = { stage: "selecting", homeAccountId: user.homeAccountId, directory: { ...directory, tenantId } };
    save(pending);
    try {
      try {
        return await choose(await workspaceToken(user, tenantId), pending);
      } catch (error) {
        if (session !== pending || !(error instanceof WorkspaceSignInRequired)) throw error;
        return await redirect(workspaceScope, user, tenantId, "select-directory", error.claims);
      }
    } catch (error) {
      if (session === pending && previous) save(previous);
      throw error;
    }
  }

  /** ARM discovery can require consent in the home tenant. Try known guest profiles and the app's directory silently. */
  function knownDirectories(user: AccountInfo): AzureDirectory[] {
    const ids = new Set([user.tenantId, settings.homeDirectory]);
    for (const profile of msal.getAllAccounts({ homeAccountId: user.homeAccountId })) {
      if (profile.homeAccountId !== user.homeAccountId) continue;
      ids.add(profile.tenantId);
      for (const id of profile.tenantProfiles?.keys() ?? []) ids.add(id);
    }
    const directories = new Map<string, AzureDirectory>();
    for (const id of ids) {
      const input = parseDirectoryInput(id ?? "");
      if (input?.kind !== "guid" || input.id === CONSUMERS_TENANT_ID) continue;
      const displayName = input.id === settings.homeDirectory?.toLowerCase() ? "App directory" : input.id;
      directories.set(input.id, { tenantId: input.id, displayName });
    }
    return [...directories.values()];
  }

  function discoveryTenant(user: AccountInfo): string {
    const configured = parseDirectoryInput(settings.homeDirectory ?? "");
    return tenantFromLink(window.location.search) ??
      (configured?.kind === "guid" && configured.id !== CONSUMERS_TENANT_ID ? configured.id : user.tenantId);
  }

  function discoverySources(user: AccountInfo): AzureDirectory[] {
    const linked = tenantFromLink(window.location.search);
    const preferred = discoveryTenant(user);
    const ids = new Set([consentTenant ?? preferred, preferred, user.tenantId.toLowerCase(), settings.homeDirectory?.toLowerCase()]);
    return [...ids].flatMap(id => {
      if (!id || parseDirectoryInput(id)?.kind !== "guid" || id === CONSUMERS_TENANT_ID) return [];
      const displayName = id === linked ? "Directory from this link" : id === user.tenantId.toLowerCase() ? "Sign-in directory" :
        id === settings.homeDirectory?.toLowerCase() ? "App directory" : id;
      return [{ tenantId: id, displayName }];
    });
  }

  async function requestInventory(user: AccountInfo, tenantId: string, quiet = false): Promise<never> {
    const pending = { stage: "discovery", homeAccountId: user.homeAccountId, tenantId, quiet } as const;
    save(pending);
    try {
      return await redirect(ARM_SCOPE, user, tenantId, "list-directories", undefined, quiet);
    } catch (error) {
      if (session === pending) save({ stage: "choosing", homeAccountId: user.homeAccountId, discoveryAttempted: true });
      throw error;
    }
  }

  /** ARM lists the account's memberships. A guest directory may grant that read when the sign-in directory cannot. */
  async function directoryInventory(user: AccountInfo, known: AzureDirectory[], signal: AbortSignal) {
    consentTenant = null;
    if (inventoryGrant) {
      const grant = inventoryGrant;
      inventoryGrant = null;
      return readAzureDirectories(grant.accessToken, fetch, signal);
    }
    let firstError: unknown;
    const preferred = discoveryTenant(user);
    const sources = new Set([user.tenantId, preferred, ...known.map(directory => directory.tenantId)]);
    for (const tenantId of sources) {
      signal.throwIfAborted();
      try {
        const result = await tenantToken(ARM_SCOPE, user, tenantId);
        signal.throwIfAborted();
        checkToken(result, user.homeAccountId, tenantId);
        return await readAzureDirectories(result.accessToken, fetch, signal);
      } catch (error) {
        signal.throwIfAborted();
        firstError ??= error;
        // A refresh grant may require guest MFA, or MSAL may only have the original issuer's profile.
        // Neither is evidence that the user has been denied membership by this directory.
        if ((error instanceof InteractionRequiredAuthError || needsFreshGrant(error) || error instanceof WorkspaceDenied) &&
            (!consentTenant || tenantId === preferred)) {
          consentTenant = tenantId;
        }
      }
    }
    throw firstError;
  }

  async function listDirectories(): Promise<DirectoryDiscovery> {
    const user = requireChooser();
    discovery?.abort();
    discovery = new AbortController();
    const { signal } = discovery;
    const known = knownDirectories(user);
    let candidates: AzureDirectory[];
    let inventoryError: unknown;
    try {
      candidates = await directoryInventory(user, known, signal);
    } catch (error) {
      signal.throwIfAborted();
      // The refresh grant from common can require interaction in a guest directory even with an existing
      // Entra session there. A single top-level prompt=none can use its first-party sign-in cookie.
      if (session?.stage === "choosing" && !session.discoveryAttempted &&
          consentTenant && consentTenant !== user.tenantId.toLowerCase()) return requestInventory(user, consentTenant, true);
      inventoryError = error;
      candidates = known;
    }
    const verified = await accessibleDirectories(candidates, async ({ tenantId }) => {
      const result = await workspaceToken(user, tenantId);
      signal.throwIfAborted();
      checkToken(result, user.homeAccountId, tenantId);
      await verifyWorkspaceAccess(tenantId, result.accessToken, signal);
    }, signal);
    if (inventoryError && consentTenant) {
      const sources = discoverySources(user);
      const choices = sources.length > 1 ? sources : undefined;
      if (!verified.directories.length) throw new DirectoryConsentRequiredError(choices);
      return { directories: verified.directories, consentRequired: true, ...(choices ? { discoverySources: choices } : {}), ...(verified.incomplete ? { incomplete: true } : {}) };
    }
    if (inventoryError) {
      if (!verified.directories.length) throw inventoryError;
      return { directories: verified.directories, incomplete: true };
    }
    return { ...verified, discoveredCount: candidates.length };
  }

  return {
    get account() { return account(); },
    get needsDirectory() { return identity !== null && session?.stage !== "selected"; },
    get directoryError() { return directoryError; },
    ready: async () => {
      await msal.initialize();
      const saved = session;
      let returned: AuthenticationResult | null = null;
      let redirectError: unknown;
      try {
        returned = await msal.handleRedirectPromise({ navigateToLoginRequestUrl: false });
      } catch (error) {
        redirectError = error;
      } finally {
        const address = takeReturn(window.sessionStorage);
        if (address !== null && window.location.pathname === "/" && window.location.search === "") {
          window.history.replaceState(null, "", address);
        }
      }

      if (saved && saved.stage !== "signed-out") {
        const profile = msal.getAccount({
          homeAccountId: saved.homeAccountId, ...(saved.stage === "selected" ? { tenantId: saved.directory.tenantId } : {}),
        });
        identity = profile?.homeAccountId === saved.homeAccountId ? profile : null;
        if (saved.stage === "selecting" || saved.stage === "discovery") {
          try {
            if (redirectError) throw redirectError;
            if (!returned) throw new Error("The directory request was interrupted. Please try again.");
            if (returned.account?.homeAccountId !== saved.homeAccountId) throw new Error("Microsoft returned a different signed-in account.");
            if (saved.stage === "selecting" && returned.state === "select-directory") return await choose(returned, saved);
            if (saved.stage !== "discovery" || returned.state !== "list-directories") throw new Error("Microsoft did not confirm the directory selection.");
            // Earlier saved discovery requests always targeted the sign-in profile.
            const tenantId = saved.tenantId ?? profile?.tenantId;
            if (!tenantId) throw new Error("Microsoft could not confirm the discovery directory.");
            identity = checkToken(returned, saved.homeAccountId, tenantId);
            inventoryGrant = returned;
          } catch (error) {
            if (session !== saved) return account();
            if (!(saved.stage === "discovery" && saved.quiet && redirectError)) {
              directoryError = error instanceof Error ? error.message : "Microsoft could not complete the directory request.";
            }
          }
          save({ stage: "choosing", homeAccountId: saved.homeAccountId, discoveryAttempted: true });
        } else {
          if (redirectError) throw redirectError;
          if (saved.stage === "selected") {
            if (returned) identity = checkToken(returned, saved.homeAccountId, saved.directory.tenantId);
            if (!identity || identity.tenantId.toLowerCase() !== saved.directory.tenantId) {
              throw new Error("Your saved sign-in expired. Sign in again to open this directory, or sign out to choose another.");
            }
          }
        }
      } else {
        if (redirectError) throw redirectError;
        identity = returned?.account ?? (saved?.stage === "signed-out" ? null : msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null);
        if (identity) save({ stage: "choosing", homeAccountId: identity.homeAccountId });
      }
      if (identity) msal.setActiveAccount(identity);
      return account();
    },

    listDirectories,

    requestDirectoryDiscovery: (source?: string) => {
      const user = requireChooser();
      if (source && !discoverySources(user).some(item => item.tenantId === source)) throw new Error("Choose a listed directory for lookup.");
      return requestInventory(user, source ?? consentTenant ?? discoveryTenant(user));
    },
    selectDirectory,

    getToken: async (request = {}) => {
      const user = requireIdentity();
      const locked = session;
      if (locked?.stage !== "selected") throw new Error("Choose an Azure directory before opening the workspace.");
      const { tenantId } = locked.directory;
      if (!request.claims) {
        try {
          const result = await silent(settings.apiScope, user, tenantId, request.refresh);
          checkToken(result, locked.homeAccountId, tenantId);
          if (session !== locked) throw new Error("The sign-in session changed. Sign in again.");
          return result.accessToken;
        } catch (error) {
          if (!(error instanceof InteractionRequiredAuthError) || session !== locked) throw error;
        }
      }
      return redirect(workspaceScope, user, tenantId, "workspace", request.claims);
    },

    signIn: async () => {
      keepAddress();
      if (session?.stage === "selected") {
        await msal.loginRedirect({ scopes: [workspaceScope], authority: authorityOf(session.directory.tenantId), ...(identity ? { account: identity } : {}), state: "workspace" });
        return;
      }
      save({ stage: "signed-out" });
      identity = null;
      await msal.loginRedirect({ scopes: ["openid", "profile"], authority: authorityOf(tenantFromLink(window.location.search) ?? "common"), prompt: "select_account" });
    },

    signOut: async () => {
      const user = identity;
      const tenant = tenantFromLink(window.location.search);
      if (session?.stage === "selected" && tenant && tenant !== session.directory.tenantId) keepAddress();
      else rememberReturn(window.sessionStorage, "");
      save({ stage: "signed-out" });
      identity = null;
      directoryError = null;
      await msal.logoutRedirect(user === null ? {} : { account: user });
    },
  };
}

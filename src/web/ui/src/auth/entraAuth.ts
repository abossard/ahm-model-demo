import {
  CacheLookupPolicy,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from "@azure/msal-browser";
import { NAVIGATING, PersonalAccountError, type Auth, type AuthAccount, type SignInRequest, type TokenRequest } from "./auth";
import { CONSUMERS_TENANT_ID, authorityOf } from "./directory";
import { rememberReturn, takeReturn } from "./returnLink";

export interface EntraSettings {
  readonly clientId: string;
  /** The scope of the web app's own API, such as `api://<client id>/access_as_user`. */
  readonly apiScope: string;
}

/**
 * What a sign-in or an interactive step asks for: the whole API the user consents to, `<client id>/.default`. The
 * first sign-in in a directory then asks for the app's permissions at once, including the Azure ones it uses on the
 * user's behalf, and the consent covers the Azure MCP server as well. A silent renewal asks for the API's own scope
 * instead, because a token is cached under the scopes it was issued for and a `.default` request would never find it.
 *
 * The resource is the bare client id, not `api://<client id>`: the page and the API are one registration, and Entra
 * refuses an app that asks for a token for itself by its URI (AADSTS90009).
 */
export function defaultScope(clientId: string): string {
  if (clientId.trim() === "" || clientId.includes("/")) throw new Error("The app's sign-in settings are incomplete: the client id is missing.");
  return `${clientId}/.default`;
}

/**
 * The browser's MSAL configuration: authorization code with PKCE through a full-page redirect. The configured authority
 * is any work or school directory; a sign-in to one directory names it, and a token request names the directory the
 * account belongs to. The redirect target is the origin's root, the cache lives in session storage, and a silent renewal
 * never opens a hidden frame (see `silentRequest`), so the page needs one origin besides its own: the authority.
 */
export function msalConfiguration(settings: EntraSettings, origin: string): Configuration {
  return {
    auth: {
      clientId: settings.clientId,
      authority: authorityOf(),
      redirectUri: `${origin}/`,
      postLogoutRedirectUri: `${origin}/`,
    },
    cache: { cacheLocation: "sessionStorage" },
  };
}

/**
 * A silent renewal reads the cache, then asks the token endpoint with the refresh token. The default policy would
 * also try a hidden frame, which needs `frame-src` and fails where third-party cookies are blocked. Without a
 * frame, a session that cannot renew quietly ends in the redirect below.
 */
function silentRequest(apiScope: string, account: AccountInfo, refresh: boolean): Parameters<PublicClientApplication["acquireTokenSilent"]>[0] {
  return {
    scopes: [apiScope],
    authority: authorityOf(account.tenantId),
    account,
    cacheLookupPolicy: refresh ? CacheLookupPolicy.RefreshToken : CacheLookupPolicy.AccessTokenAndRefreshToken,
  };
}

function accountOf(info: AccountInfo): AuthAccount {
  return { name: info.name ?? info.username, username: info.username, tenantId: info.tenantId };
}

const inAnyDirectory = (info: AccountInfo): boolean => info.tenantId.toLowerCase() !== CONSUMERS_TENANT_ID;

export function createEntraAuth(settings: EntraSettings, client?: PublicClientApplication): Auth {
  const msal = client ?? new PublicClientApplication(msalConfiguration(settings, window.location.origin));
  const scope = defaultScope(settings.clientId);
  let signedIn: AccountInfo | null = null;

  const keepAddress = (): void => rememberReturn(window.sessionStorage, window.location.search);

  const requireAccount = (): AccountInfo => {
    if (signedIn === null) throw new Error("Nobody is signed in.");
    return signedIn;
  };

  const redirectForToken = async (request: TokenRequest): Promise<never> => {
    const account = requireAccount();
    keepAddress();
    await msal.acquireTokenRedirect({ scopes: [scope], authority: authorityOf(account.tenantId), account, ...(request.claims ? { claims: request.claims } : {}) });
    return NAVIGATING;
  };

  const signIn = async (request: SignInRequest = {}): Promise<void> => {
    keepAddress();
    // MSAL sends either a hint or the account picker: with a hint the account is already chosen.
    await msal.loginRedirect({
      scopes: [scope],
      authority: authorityOf(request.directory),
      ...(request.loginHint ? { loginHint: request.loginHint } : { prompt: "select_account" }),
    });
  };

  return {
    get account() {
      return signedIn === null ? null : accountOf(signedIn);
    },

    ready: async () => {
      await msal.initialize();
      // Without a redirect to keep the address, a returning visit keeps the one it opened on.
      const returned = await msal.handleRedirectPromise({ navigateToLoginRequestUrl: false });
      const known = [returned?.account, msal.getActiveAccount(), ...msal.getAllAccounts()].filter((info): info is AccountInfo => info != null);
      const found = known.find(inAnyDirectory) ?? null;
      if (found === null) {
        if (known.length > 0) throw new PersonalAccountError(known[0]!.username);
        return null;
      }
      msal.setActiveAccount(found);
      signedIn = found;
      const search = takeReturn(window.sessionStorage);
      if (search !== null && window.location.search === "") window.history.replaceState(null, "", `${window.location.pathname}${search}`);
      return accountOf(found);
    },

    getToken: async (request = {}) => {
      if (request.claims) return redirectForToken(request);
      try {
        const result = await msal.acquireTokenSilent(silentRequest(settings.apiScope, requireAccount(), request.refresh === true));
        return result.accessToken;
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError) return redirectForToken(request);
        throw error;
      }
    },

    signIn,

    signOut: async () => {
      const account = signedIn;
      signedIn = null;
      rememberReturn(window.sessionStorage, "");
      await msal.logoutRedirect(account === null ? {} : { account });
    },
  };
}

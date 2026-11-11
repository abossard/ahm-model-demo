import {
  CacheLookupPolicy,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from "@azure/msal-browser";
import { NAVIGATING, type Auth, type AuthAccount, type TokenRequest } from "./auth";
import { rememberReturn, takeReturn } from "./returnLink";

export interface EntraSettings {
  readonly tenantId: string;
  readonly clientId: string;
  /** The scope of the web app's own API, such as `api://<client id>/access_as_user`. */
  readonly apiScope: string;
}

export const AUTHORITY_HOST = "https://login.microsoftonline.com";

/**
 * The browser's MSAL configuration: authorization code with PKCE through a full-page redirect to one tenant.
 * The redirect target is the origin's root, the cache lives in session storage, and a silent renewal never opens
 * a hidden frame (see `silentRequest`), so the page needs one origin besides its own: the authority.
 */
export function msalConfiguration(settings: EntraSettings, origin: string): Configuration {
  return {
    auth: {
      clientId: settings.clientId,
      authority: `${AUTHORITY_HOST}/${settings.tenantId}`,
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
function silentRequest(scope: string, account: AccountInfo, refresh: boolean): Parameters<PublicClientApplication["acquireTokenSilent"]>[0] {
  return {
    scopes: [scope],
    account,
    cacheLookupPolicy: refresh ? CacheLookupPolicy.RefreshToken : CacheLookupPolicy.AccessTokenAndRefreshToken,
  };
}

function accountOf(info: AccountInfo): AuthAccount {
  return { name: info.name ?? info.username, username: info.username, tenantId: info.tenantId };
}

export function createEntraAuth(settings: EntraSettings, client?: PublicClientApplication): Auth {
  const msal = client ?? new PublicClientApplication(msalConfiguration(settings, window.location.origin));
  let signedIn: AccountInfo | null = null;

  const keepAddress = (): void => rememberReturn(window.sessionStorage, window.location.search);

  const requireAccount = (): AccountInfo => {
    if (signedIn === null) throw new Error("Nobody is signed in.");
    return signedIn;
  };

  const redirectForToken = async (request: TokenRequest): Promise<never> => {
    keepAddress();
    await msal.acquireTokenRedirect({ scopes: [settings.apiScope], account: requireAccount(), ...(request.claims ? { claims: request.claims } : {}) });
    return NAVIGATING;
  };

  const signIn = async (): Promise<void> => {
    keepAddress();
    await msal.loginRedirect({ scopes: [settings.apiScope] });
  };

  return {
    get account() {
      return signedIn === null ? null : accountOf(signedIn);
    },

    ready: async () => {
      await msal.initialize();
      // Without a redirect to keep the address, a returning visit keeps the one it opened on.
      const returned = await msal.handleRedirectPromise({ navigateToLoginRequestUrl: false });
      const found = returned?.account ?? msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
      if (found === null) {
        await signIn();
        return NAVIGATING;
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

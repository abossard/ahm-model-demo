import type { AuthConfig } from "../model/types";
import type { Auth } from "./auth";
import { createEntraAuth } from "./entraAuth";
import { localAuth } from "./localAuth";

export type { Auth, AuthAccount, TokenRequest } from "./auth";
export { localAuth };

let current: Auth = localAuth;

/** The auth the app runs with. Until the app has read its config there is nobody to sign in. */
export function getAuth(): Auth {
  return current;
}

export function setAuth(auth: Auth): void {
  current = auth;
}

/** The auth a config asks for: Entra with the tenant, client and scope it names, or none when the server acts as the developer. */
export function createAuth(config: AuthConfig): Auth {
  if (config.authMode !== "entra") return localAuth;
  if (!config.tenantId || !config.clientId || !config.apiScope) {
    throw new Error("The app's sign-in settings are incomplete: tenant, client or API scope is missing.");
  }
  return createEntraAuth({ tenantId: config.tenantId, clientId: config.clientId, apiScope: config.apiScope });
}

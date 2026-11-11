import type { AuthConfig } from "../model/types";
import type { Auth } from "./auth";
import { createEntraAuth } from "./entraAuth";
import { localAuth } from "./localAuth";

export type { Auth, AuthAccount, SignInRequest, TokenRequest } from "./auth";
export { PersonalAccountError } from "./auth";
export { localAuth };

let current: Auth = localAuth;

/** The auth the app runs with. Until the app has read its config there is nobody to sign in. */
export function getAuth(): Auth {
  return current;
}

export function setAuth(auth: Auth): void {
  current = auth;
}

/** The auth a config asks for: Entra with the client and scope it names, or none when the server acts as the developer. */
export function createAuth(config: AuthConfig): Auth {
  if (config.authMode !== "entra") return localAuth;
  if (!config.clientId || !config.apiScope) {
    throw new Error("The app's sign-in settings are incomplete: client or API scope is missing.");
  }
  return createEntraAuth({ clientId: config.clientId, apiScope: config.apiScope });
}

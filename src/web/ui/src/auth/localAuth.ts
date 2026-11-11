import type { Auth } from "./auth";

/** The server acts as the developer's own identity, so there is nobody to sign in and no token to send. */
export const localAuth: Auth = {
  ready: () => Promise.resolve(null),
  account: null,
  getToken: () => Promise.resolve(null),
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
};

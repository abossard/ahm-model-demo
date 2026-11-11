/** Who is signed in. Nothing here is a secret. */
export interface AuthAccount {
  readonly name: string;
  /** The user name, usually the email address. */
  readonly username: string;
  readonly tenantId: string;
}

export interface TokenRequest {
  /** Claims a Conditional Access policy asks for: the token comes from an interactive step. */
  readonly claims?: string;
  /** The API did not accept the token it was given: get a fresh one rather than the cached one. */
  readonly refresh?: boolean;
}

/** The one seam between the app and whoever signs the user in. */
export interface Auth {
  /**
   * Completes a sign-in that is returning, restores one that is cached, or starts one. It resolves with the signed-in
   * account, or with null when nobody signs in. When it starts a sign-in the page navigates away and it never resolves.
   */
  readonly ready: () => Promise<AuthAccount | null>;
  readonly account: AuthAccount | null;
  /** An access token for the API, or null when nobody signs in. A step that needs the user navigates away and never resolves. */
  readonly getToken: (request?: TokenRequest) => Promise<string | null>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

/** What a promise that only a page navigation ends looks like to its caller. */
export const NAVIGATING: Promise<never> = new Promise<never>(() => undefined);

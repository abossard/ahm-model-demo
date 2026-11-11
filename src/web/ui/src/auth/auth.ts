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

/** Where a sign-in goes. Without a directory it is any work or school directory. */
export interface SignInRequest {
  /** The directory to sign in to: its ID or a domain it has verified. A personal account signs in this way. */
  readonly directory?: string;
  /** The account to offer first. */
  readonly loginHint?: string;
}

/** The user signed in with a personal Microsoft account and landed in the tenant of personal accounts, which has no Azure. */
export class PersonalAccountError extends Error {
  constructor(readonly username: string) {
    super("A personal Microsoft account reaches Azure through a directory.");
  }
}

/** The one seam between the app and whoever signs the user in. */
export interface Auth {
  /**
   * Completes a sign-in that is returning or restores one that is cached. It resolves with the signed-in account, or with
   * null when nobody is signed in: in local mode nobody ever signs in, and otherwise the app offers the user to. It
   * rejects with a `PersonalAccountError` when the only account is a personal one that landed in no directory.
   */
  readonly ready: () => Promise<AuthAccount | null>;
  readonly account: AuthAccount | null;
  /** An access token for the API, or null when nobody signs in. A step that needs the user navigates away and never resolves. */
  readonly getToken: (request?: TokenRequest) => Promise<string | null>;
  /** Starts a sign-in: the page navigates away and this never resolves. */
  readonly signIn: (request?: SignInRequest) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

/** What a promise that only a page navigation ends looks like to its caller. */
export const NAVIGATING: Promise<never> = new Promise<never>(() => undefined);

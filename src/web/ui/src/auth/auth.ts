/** Who is signed in. Nothing here is a secret. */
export interface AuthAccount {
  readonly name: string;
  /** The user name, usually the email address. */
  readonly username: string;
  readonly tenantId: string;
  readonly tenantName?: string;
}

export interface AzureDirectory {
  readonly tenantId: string;
  readonly displayName: string;
  readonly defaultDomain?: string;
}

export interface DirectoryDiscovery {
  readonly directories: AzureDirectory[];
  /** Memberships returned by Azure that still need an explicit access check. */
  readonly needsCheck?: AzureDirectory[];
  readonly discoveredCount?: number;
  readonly consentRequired?: boolean;
  /** Authorities that can be used to ask Microsoft for the membership list. */
  readonly discoverySources?: AzureDirectory[];
  readonly incomplete?: boolean;
}

export class DirectoryConsentRequiredError extends Error {
  constructor(readonly discoverySources?: AzureDirectory[]) {
    super("Microsoft needs your permission to list the Azure directories you can access.");
  }
}

export interface TokenRequest {
  /** Claims a Conditional Access policy asks for: the token comes from an interactive step. */
  readonly claims?: string;
  /** The API did not accept the token it was given: get a fresh one rather than the cached one. */
  readonly refresh?: boolean;
}

/** The one seam between the app and whoever signs the user in. */
export interface Auth {
  /** Restores the signed-in identity. In Entra mode, the user then chooses a workspace directory. */
  readonly ready: () => Promise<AuthAccount | null>;
  readonly account: AuthAccount | null;
  readonly needsDirectory?: boolean;
  readonly directoryError?: string | null;
  /** Entra-only actions available between sign-in and workspace entry. */
  readonly listDirectories?: () => Promise<DirectoryDiscovery>;
  readonly requestDirectoryDiscovery?: (tenantId?: string) => Promise<void>;
  readonly selectDirectory?: (directory: AzureDirectory) => Promise<AuthAccount>;
  /** An access token for the API, or null when nobody signs in. A step that needs the user navigates away and never resolves. */
  readonly getToken: (request?: TokenRequest) => Promise<string | null>;
  /** Starts a sign-in: the page navigates away and this never resolves. */
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

/** What a promise that only a page navigation ends looks like to its caller. */
export const NAVIGATING: Promise<never> = new Promise<never>(() => undefined);

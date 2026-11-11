export const AUTHORITY_HOST = "https://login.microsoftonline.com";
/** The tenant of personal Microsoft accounts: a token it issues never reaches Azure Resource Manager. */
export const CONSUMERS_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** Azure Resource Manager answers a request without a token with the directory that holds the subscription. */
export const SUBSCRIPTION_URL = "https://management.azure.com/subscriptions";
const SUBSCRIPTION_API_VERSION = "2022-12-01";

const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** `authorization_uri="https://login.windows.net/<directory id>"` in the `WWW-Authenticate` header of a 401. */
const CHALLENGE = /authorization_uri="https:\/\/login\.(?:windows\.net|microsoftonline\.com)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?[^"]*"/i;

export class DirectoryError extends Error {}

export type DirectoryInput =
  /** A subscription ID or a directory ID: both are GUIDs, and only Azure can tell which. */
  | { readonly kind: "guid"; readonly id: string }
  /** A domain the directory has verified, such as the one of an organization's email addresses. */
  | { readonly kind: "domain"; readonly name: string };

/** What the user typed to name their directory, or null when it is neither an ID nor a domain. */
export function parseDirectoryInput(text: string): DirectoryInput | null {
  const value = text.trim();
  if (GUID.test(value)) return { kind: "guid", id: value.toLowerCase() };
  if (DOMAIN.test(value)) return { kind: "domain", name: value.toLowerCase() };
  return null;
}

/** The directory a 401 from Azure Resource Manager names, or null when its challenge names none. */
export function directoryFromChallenge(header: string | null): string | null {
  const found = header === null ? null : CHALLENGE.exec(header);
  return found === null ? null : found[1]!.toLowerCase();
}

export const NAME_A_DIRECTORY = "Enter a subscription ID, a directory domain such as contoso.com, or a directory ID.";
export const LOOKUP_FAILED = "The directory of that subscription could not be looked up. Enter the directory's domain or its ID instead.";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The directory to sign in to for what the user typed: a domain or an ID names it itself, and a subscription ID is
 * asked of Azure, which answers an anonymous request with the directory that holds the subscription. A GUID that is no
 * subscription is taken as a directory ID. Nothing here carries a credential.
 */
export async function resolveDirectory(text: string, fetcher: Fetch = (input, init) => fetch(input, init)): Promise<string> {
  const input = parseDirectoryInput(text);
  if (input === null) throw new DirectoryError(NAME_A_DIRECTORY);
  if (input.kind === "domain") return input.name;
  let response: Response;
  try {
    response = await fetcher(`${SUBSCRIPTION_URL}/${input.id}?api-version=${SUBSCRIPTION_API_VERSION}`, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new DirectoryError(LOOKUP_FAILED);
  }
  if (response.status === 401) {
    const directory = directoryFromChallenge(response.headers.get("www-authenticate"));
    if (directory !== null) return directory;
    throw new DirectoryError(LOOKUP_FAILED);
  }
  return input.id;
}

/** The sign-in authority of a directory, or of any work or school directory when none is named. */
export function authorityOf(directory?: string): string {
  return `${AUTHORITY_HOST}/${directory ?? "organizations"}`;
}

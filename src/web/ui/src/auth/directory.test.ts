import { describe, expect, it, vi } from "vitest";
import { AUTHORITY_HOST, CONSUMERS_TENANT_ID, DirectoryError, LOOKUP_FAILED, NAME_A_DIRECTORY, authorityOf, canonicalDirectoryId, directoryFromChallenge, parseDirectoryInput, readAzureDirectories, resolveDirectory } from "./directory";

const SUBSCRIPTION = "11111111-1111-4111-8111-111111111111";
const DIRECTORY = "7f1c0b1e-0000-4000-8000-00000000aaaa";

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

describe("parseDirectoryInput", () => {
  it.each([
    { text: SUBSCRIPTION, expected: { kind: "guid", id: SUBSCRIPTION } },
    { text: `  ${SUBSCRIPTION.toUpperCase()}\n`, expected: { kind: "guid", id: SUBSCRIPTION } },
    { text: "contoso.com", expected: { kind: "domain", name: "contoso.com" } },
    { text: " Contoso.onmicrosoft.com ", expected: { kind: "domain", name: "contoso.onmicrosoft.com" } },
    { text: "eu.dept.contoso.co.uk", expected: { kind: "domain", name: "eu.dept.contoso.co.uk" } },
    { text: "", expected: null },
    { text: "contoso", expected: null },
    { text: "ada@contoso.com", expected: null },
    { text: "organizations", expected: null },
    { text: "https://contoso.com", expected: null },
    { text: "contoso.com/common", expected: null },
    { text: "-bad.contoso.com", expected: null },
    { text: "1111111-1111-4111-8111-111111111111", expected: null },
    { text: `${SUBSCRIPTION}/extra`, expected: null },
  ])("reads $text as $expected", ({ text, expected }) => {
    expect(parseDirectoryInput(text)).toEqual(expected);
  });
});

describe("directoryFromChallenge", () => {
  it.each([
    { header: `Bearer authorization_uri="https://login.windows.net/${DIRECTORY}", error="invalid_token", error_description="missing"`, expected: DIRECTORY },
    { header: `Bearer authorization_uri="https://login.microsoftonline.com/${DIRECTORY.toUpperCase()}/", error="invalid_token"`, expected: DIRECTORY },
    { header: `Bearer authorization_uri="https://login.windows.net/${DIRECTORY}/oauth2/authorize"`, expected: DIRECTORY },
    { header: 'Bearer authorization_uri="https://login.windows.net/common/oauth2/authorize"', expected: null },
    { header: `Bearer authorization_uri="https://evil.example/${DIRECTORY}"`, expected: null },
    { header: `Bearer authorization_uri="http://login.windows.net/${DIRECTORY}"`, expected: null },
    { header: 'Bearer realm=""', expected: null },
    { header: "", expected: null },
    { header: null, expected: null },
  ])("finds the directory in $header", ({ header, expected }) => {
    expect(directoryFromChallenge(header)).toBe(expected);
  });
});

describe("authorityOf", () => {
  it.each([
    { directory: undefined, expected: "https://login.microsoftonline.com/organizations" },
    { directory: DIRECTORY, expected: `https://login.microsoftonline.com/${DIRECTORY}` },
    { directory: "contoso.com", expected: "https://login.microsoftonline.com/contoso.com" },
  ])("is $expected for $directory", ({ directory, expected }) => {
    expect(authorityOf(directory)).toBe(expected);
  });
});

describe("canonicalDirectoryId", () => {
  it("resolves a verified domain through Microsoft's OpenID issuer", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ issuer: `${AUTHORITY_HOST}/${DIRECTORY}/v2.0` }));
    await expect(canonicalDirectoryId("Contoso.com", fetcher)).resolves.toBe(DIRECTORY);
    expect(fetcher).toHaveBeenCalledWith(`${AUTHORITY_HOST}/contoso.com/v2.0/.well-known/openid-configuration`, { credentials: "omit", redirect: "error" });
  });

  it.each([
    "https://example.test/" + DIRECTORY + "/v2.0", AUTHORITY_HOST + "/common/v2.0",
    AUTHORITY_HOST + "/" + DIRECTORY + "/v2.0?extra", AUTHORITY_HOST + "/" + CONSUMERS_TENANT_ID + "/v2.0",
  ])("refuses an issuer that does not identify an Azure directory: %s", async (issuer) => {
    await expect(canonicalDirectoryId("contoso.com", vi.fn().mockResolvedValue(Response.json({ issuer })))).rejects.toBeInstanceOf(DirectoryError);
  });
});

describe("readAzureDirectories", () => {
  const first = "https://management.azure.com/tenants?api-version=2022-12-01";
  it("collects all pages, keeping each Azure directory once and the actual display names", async () => {
    const nextLink = "https://management.azure.com/tenants?next=2";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ value: [{ tenantId: DIRECTORY }, { tenantId: CONSUMERS_TENANT_ID }], nextLink }))
      .mockResolvedValueOnce(Response.json({ value: [
        { tenantId: DIRECTORY.toUpperCase(), displayName: "Contoso" }, { tenantId: SUBSCRIPTION, defaultDomain: "woodgrove.com" },
      ] }));
    await expect(readAzureDirectories("arm", fetcher)).resolves.toEqual([
      { tenantId: DIRECTORY, displayName: "Contoso" }, { tenantId: SUBSCRIPTION, defaultDomain: "woodgrove.com", displayName: "woodgrove.com" },
    ]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([first, nextLink]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ headers: { Authorization: "Bearer arm" }, redirect: "error", credentials: "omit" });
  });

  it.each([first, "http://management.azure.com/tenants", "https://example.test/tenants", "https://management.azure.com/subscriptions"])("rejects an invalid continuation before sending the bearer to %s", async (nextLink) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ value: [], nextLink }));
    await expect(readAzureDirectories("arm", fetcher)).rejects.toThrow("invalid next page");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDirectory", () => {
  const challenge = `Bearer authorization_uri="https://login.windows.net/${DIRECTORY}", error="invalid_token"`;

  it("takes a domain as the directory without asking anyone", async () => {
    const fetcher = vi.fn();

    await expect(resolveDirectory("Contoso.com", fetcher)).resolves.toBe("contoso.com");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks Azure which directory holds a subscription, without a credential", async () => {
    const fetcher = vi.fn().mockResolvedValue(answer(401, { "www-authenticate": challenge }));

    await expect(resolveDirectory(SUBSCRIPTION, fetcher)).resolves.toBe(DIRECTORY);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`https://management.azure.com/subscriptions/${SUBSCRIPTION}?api-version=2022-12-01`, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  });

  it.each([404, 400, 200])("takes an ID that Azure answers with %i as a directory ID", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(answer(status));

    await expect(resolveDirectory(DIRECTORY, fetcher)).resolves.toBe(DIRECTORY);
  });

  it.each([
    { name: "a challenge that names no directory", fetcher: () => Promise.resolve(answer(401, { "www-authenticate": "Bearer" })) },
    { name: "no challenge", fetcher: () => Promise.resolve(answer(401)) },
    { name: "a lookup that cannot be made", fetcher: () => Promise.reject(new TypeError("Failed to fetch")) },
  ])("says the lookup failed for $name", async ({ fetcher }) => {
    await expect(resolveDirectory(SUBSCRIPTION, fetcher)).rejects.toThrow(LOOKUP_FAILED);
  });

  it.each(["", "contoso", "ada@contoso.com"])("asks for an ID or a domain instead of %j", async (text) => {
    const failure = await resolveDirectory(text, vi.fn()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DirectoryError);
    expect((failure as Error).message).toBe(NAME_A_DIRECTORY);
  });
});

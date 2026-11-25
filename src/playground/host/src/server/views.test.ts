import { describe, expect, it } from "vitest";
import { createViews, sha256, viewDocuments } from "./views";

const html = (text: string) => ({ uri: "ui://playground/hello.html", mimeType: "text/html;profile=mcp-app", text });

describe("viewDocuments", () => {
  it.each([
    ["a View document", { result: { contents: [html("<p>a</p>")] } }, ["<p>a</p>"]],
    ["another MIME type", { result: { contents: [{ uri: "x", mimeType: "text/plain", text: "no" }] } }, []],
    ["a blob", { result: { contents: [{ uri: "x", mimeType: "text/html;profile=mcp-app", blob: "AA==" }] } }, []],
    ["a reply with no contents", { result: { tools: [] } }, []],
    ["no object", "text", []],
    ["null", null, []],
  ])("%s", (_name, message, expected) => {
    expect(viewDocuments(message)).toEqual(expected);
  });
});

describe("createViews", () => {
  it("files a document under the SHA-256 of its text", () => {
    const views = createViews();
    const digest = views.put("héllo");
    expect(digest).toBe(sha256("héllo"));
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(views.get(digest)).toBe("héllo");
  });

  it.each([[1, 2], [3, 5]])("keeps the newest %i of %i documents", (limit, total) => {
    const views = createViews(limit);
    const digests = Array.from({ length: total }, (_, i) => views.put(`doc ${i}`));
    expect(digests.map((digest) => views.get(digest) !== undefined)).toEqual(digests.map((_, i) => i >= total - limit));
  });
});

import { describe, expect, it } from "vitest";
import { SSE_START, readSse } from "./sse";

const STREAM = 'event: message\ndata: {"a":1}\n\n: comment\n\ndata: line one\ndata: line two\n\nid: 3\n\ndata: {"b":"é"}\n\n';
const PAYLOADS = ['{"a":1}', "line one\nline two", '{"b":"é"}'];

function readAll(chunks: string[]): string[] {
  let state = SSE_START;
  return chunks.flatMap((chunk) => {
    const read = readSse(state, chunk);
    state = read.state;
    return read.payloads;
  });
}

describe("readSse", () => {
  const cases: [string, string[]][] = [
    ["one chunk", [STREAM]],
    ["CRLF", [STREAM.replace(/\n/g, "\r\n")]],
    ["byte by byte", STREAM.split("")],
    ...Array.from({ length: STREAM.length - 1 }, (_, at): [string, string[]] => [`split at ${at + 1}`, [STREAM.slice(0, at + 1), STREAM.slice(at + 1)]]),
  ];
  it.each(cases)("%s gives the same payloads", (_name, chunks) => {
    expect(readAll(chunks)).toEqual(PAYLOADS);
  });

  it("holds an event that is not complete", () => {
    expect(readAll(["data: x\n"])).toEqual([]);
  });

  it("splits CRLF delivered across chunks at the carriage return", () => {
    expect(readAll(["data: x\r", "\n\r", "\n"])).toEqual(["x"]);
  });
});

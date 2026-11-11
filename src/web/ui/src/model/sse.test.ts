import { describe, expect, it } from "vitest";
import { createSseParser, type SseFrame } from "./sse";

function parse(chunks: readonly string[]): readonly SseFrame[] {
  const parser = createSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

const ACTIVITY = 'id: 1\nevent: activity\ndata: {"seq":1}\n\n';

describe("createSseParser", () => {
  it.each([
    { name: "one frame", chunks: [ACTIVITY], expected: [{ event: "activity", data: '{"seq":1}', id: "1" }] },
    {
      name: "a frame split anywhere",
      chunks: ["id: 1\nev", "ent: activity\nda", 'ta: {"seq":1}\n', "\n"],
      expected: [{ event: "activity", data: '{"seq":1}', id: "1" }],
    },
    { name: "CRLF line ends", chunks: [ACTIVITY.replaceAll("\n", "\r\n")], expected: [{ event: "activity", data: '{"seq":1}', id: "1" }] },
    { name: "a CRLF split between its CR and its LF", chunks: ["id: 1\r\nevent: activity\r\ndata: x\r", "\n\r", "\n"], expected: [{ event: "activity", data: "x", id: "1" }] },
    { name: "lone CR line ends", chunks: ["event: done\rdata: {}\r\r", "\n"], expected: [{ event: "done", data: "{}", id: null }] },
    { name: "a comment keep-alive", chunks: [": keep-alive\n\n", ACTIVITY], expected: [{ event: "activity", data: '{"seq":1}', id: "1" }] },
    { name: "several data lines", chunks: ["event: activity\ndata: a\ndata: b\n\n"], expected: [{ event: "activity", data: "a\nb", id: null }] },
    { name: "a frame without an event name", chunks: ["data: x\n\n"], expected: [{ event: "message", data: "x", id: null }] },
    { name: "a value with no space after the colon", chunks: ["event:activity\ndata:x\n\n"], expected: [{ event: "activity", data: "x", id: null }] },
    { name: "a frame with no data", chunks: ["event: activity\n\n"], expected: [] },
    { name: "an unfinished frame", chunks: ["event: activity\ndata: x\n"], expected: [] },
    {
      name: "an id that carries over to the frames after it",
      chunks: ["id: 7\ndata: a\n\ndata: b\n\n"],
      expected: [
        { event: "message", data: "a", id: "7" },
        { event: "message", data: "b", id: "7" },
      ],
    },
    { name: "an id with a NUL, which is ignored", chunks: ["id: a\0b\ndata: x\n\n"], expected: [{ event: "message", data: "x", id: null }] },
  ])("reads $name", ({ chunks, expected }) => {
    expect(parse(chunks)).toEqual(expected);
  });

  it.each([
    { name: "a retry that arrives alone", chunks: ["retry: 40\n\n"], expected: 40 },
    { name: "the last of two retries", chunks: ["retry: 40\n\nretry: 90\n\n"], expected: 90 },
    { name: "a retry inside a frame", chunks: ["retry: 70\nid: 1\ndata: x\n\n"], expected: 70 },
    { name: "no retry", chunks: [ACTIVITY], expected: null },
    { name: "a retry that is not a number", chunks: ["retry: soon\n\n"], expected: null },
  ])("remembers $name", ({ chunks, expected }) => {
    const parser = createSseParser();
    for (const chunk of chunks) parser.push(chunk);
    expect(parser.retry()).toBe(expected);
  });

  it("reads two frames that arrive in one piece, in order", () => {
    const frames = parse([`${ACTIVITY}${ACTIVITY.replace(/1/g, "2")}event: done\ndata: {"status":"done"}\n\n`]);
    expect(frames.map((frame) => [frame.event, frame.id])).toEqual([
      ["activity", "1"],
      ["activity", "2"],
      ["done", "2"],
    ]);
  });
});

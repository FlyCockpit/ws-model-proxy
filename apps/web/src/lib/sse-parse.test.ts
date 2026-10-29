import { describe, expect, it } from "vitest";

import { createSseParser, type SseEvent } from "./sse-parse";

function parse(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe("createSseParser", () => {
  it("reads named events and skips comments, retry and id", () => {
    expect(
      parse([
        'retry: 3000\n\nevent: hello\ndata: {"v":1}\n\n: ping\n\nid: 7\nevent: node\ndata: {"a":1}\n\n',
      ]),
    ).toEqual([
      { event: "hello", data: '{"v":1}' },
      { event: "node", data: '{"a":1}' },
    ]);
  });

  it("joins events split anywhere across chunks", () => {
    const text = 'event: node\ndata: {"type":"node.trust"}\n\nevent: node\ndata: {"x":2}\n\n';
    for (let cut = 1; cut < text.length; cut += 1) {
      expect(parse([text.slice(0, cut), text.slice(cut)])).toEqual([
        { event: "node", data: '{"type":"node.trust"}' },
        { event: "node", data: '{"x":2}' },
      ]);
    }
  });

  it("accepts CRLF and CR line ends, also split between chunks", () => {
    expect(parse(["event: a\r\ndata: 1\r\n\r\n", "event: b\rdata: 2\r", "\r"])).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
    expect(parse(["event: c\r", "\ndata: 3\r\n\r", "\n"])).toEqual([{ event: "c", data: "3" }]);
  });

  it("joins several data lines, defaults the name and keeps an unfinished event", () => {
    expect(parse(["data: one\ndata:two\ndata\n\n", "data: half"])).toEqual([
      { event: "message", data: "one\ntwo\n" },
    ]);
  });

  it("dispatches nothing for an event without data", () => {
    expect(parse(["event: empty\n\n"])).toEqual([]);
  });
});

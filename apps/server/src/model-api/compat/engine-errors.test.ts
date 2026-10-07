import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseEngineRejection, resolveLocation } from "./engine-errors.js";

type Case = {
  name: string;
  status: number;
  body: string;
  request: unknown;
  headers?: Record<string, string>;
  expect: unknown;
};

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/engine-errors.json", import.meta.url), "utf8"),
) as { cases: Case[] };

describe("engine 400 parsing", () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(
      parseEngineRejection({
        status: entry.status,
        bodyText: entry.body,
        requestBody: entry.request,
        requestHeaders: new Headers(entry.headers ?? {}),
      }),
    ).toEqual(entry.expect);
  });

  it("names a nested key by its unique path when the error gives only its name", () => {
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: '{"error":"unknown field `strict`, expected one of `name`"}',
        requestBody: { tools: [{ type: "function", function: { name: "f", strict: true } }] },
        requestHeaders: new Headers(),
      }),
    ).toEqual({ kind: "field", path: "tools[].function.strict" });
  });

  it("reads OpenAI-style indexed paths", () => {
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: '{"error":{"message":"Unknown parameter: \'messages[0].content[0].foo\'."}}',
        requestBody: {
          messages: [{ role: "user", content: [{ type: "text", text: "x", foo: 1 }] }],
        },
        requestHeaders: new Headers(),
      }),
    ).toEqual({ kind: "field", path: "messages[].content[].foo" });
  });

  it("does not pin a word of the message on a nested caller field", () => {
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: '{"error":{"message":"Unsupported parameter value for \'temperature\'"}}',
        requestBody: { temperature: 3, metadata: { value: 1 } },
        requestHeaders: new Headers(),
      }),
    ).toBeNull();
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: '{"error":"unknown field `type`"}',
        requestBody: {
          tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        },
        requestHeaders: new Headers(),
      }),
    ).toEqual({ kind: "field", path: "tools[].type" });
  });

  it("never pins an error about a missing path on another field", () => {
    for (const bodyText of [
      '{"error":{"message":"Unknown parameter: \'missing.extra\'."}}',
      '{"error":{"message":"Unknown parameter: \'messages[0].missing.extra\'."}}',
    ])
      expect(
        parseEngineRejection({
          status: 400,
          bodyText,
          requestBody: { extra: 1, messages: [{ role: "user", content: "x", extra: 1 }] },
          requestHeaders: new Headers(),
        }),
      ).toBeNull();
    expect(resolveLocation(["body", "nope", "extra"], { extra: 1 })).toBeNull();
  });

  it("parses adversarial 16 KiB messages in linear time", () => {
    const hostile = [
      "'a' not supported ".repeat(1000),
      `field ${"a".repeat(16_000)}`,
      `'loc': (${"'a', ".repeat(3000)}`,
      `unknown field \`${"x".repeat(16_000)}`,
      `${"messages.0.".repeat(1500)}\n  Extra inputs are not permitted`,
    ];
    for (const message of hostile) {
      const started = performance.now();
      parseEngineRejection({
        status: 400,
        bodyText: JSON.stringify({ error: { message } }),
        requestBody: { messages: [] },
        requestHeaders: new Headers(),
      });
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it("learns nothing when union variants disagree", () => {
    const detail = {
      detail: [
        {
          type: "extra_forbidden",
          loc: ["body", "messages", 0, "UserMessage", "reasoning_content"],
          msg: "Extra inputs are not permitted",
        },
        {
          type: "extra_forbidden",
          loc: ["body", "messages", 0, "AssistantMessage", "name"],
          msg: "Extra inputs are not permitted",
        },
      ],
    };
    expect(
      parseEngineRejection({
        status: 422,
        bodyText: JSON.stringify(detail),
        requestBody: {
          messages: [{ role: "assistant", content: "x", reasoning_content: "r", name: "n" }],
        },
        requestHeaders: new Headers(),
      }),
    ).toBeNull();
  });

  it("does not guess between two keys of the same name", () => {
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: '{"error":"unknown field `extra`"}',
        requestBody: { messages: [{ role: "user", extra: 1 }], tools: [{ extra: 2 }] },
        requestHeaders: new Headers(),
      }),
    ).toBeNull();
  });

  it("tells an unsupported header from a rejected value", () => {
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: "header `openai-beta` is not supported by this server",
        requestBody: {},
        requestHeaders: new Headers({ "openai-beta": "x" }),
      }),
    ).toEqual({ kind: "header", name: "openai-beta", reason: "unsupported" });
  });

  it("ignores a header the request did not send", () => {
    expect(
      parseEngineRejection({
        status: 400,
        bodyText: "Unexpected value(s) `x` for the `anthropic-beta` header.",
        requestBody: {},
        requestHeaders: new Headers(),
      }),
    ).toBeNull();
  });
});

describe("resolveLocation", () => {
  it("skips union tags and needs the last key to exist", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "x", y: 1 }] }] };
    expect(
      resolveLocation(["body", "messages", 0, "user", "content", 0, "TextPart", "y"], body),
    ).toBe("messages[].content[].y");
    expect(resolveLocation(["body", "messages", 0, "missing"], body)).toBeNull();
    expect(resolveLocation(["body", "messages", 7, "role"], body)).toBeNull();
  });
});

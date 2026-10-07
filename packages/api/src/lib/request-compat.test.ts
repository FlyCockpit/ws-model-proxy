import { describe, expect, it } from "vitest";
import {
  isSemanticPath,
  parseFieldPath,
  readLearnedProfile,
  readRequestCompat,
  requestCompatSchema,
  rulePathProblem,
} from "./request-compat";

describe("semantic fields", () => {
  it.each([
    "model",
    "messages",
    "max_tokens",
    "max_completion_tokens",
    "response_format",
    "response_format.json_schema.strict",
    "text.format",
    "reasoning.effort",
    "thinking",
    "stream",
    "tools",
    "tools[].function.parameters",
    "tools[].function.strict",
    "messages[].content",
    "messages[].role",
    "messages[].content[].text",
    "input",
    "prediction",
    "text",
    "previous_response_id",
    "tools[].strict",
    "guided_json",
    "chat_template_kwargs",
  ])("%s is semantic", (path) => expect(isSemanticPath(path)).toBe(true));

  it.each([
    "stream_options",
    "stream_options.include_usage",
    "messages[].cache_control",
    "messages[].content[].cache_control",
    "tools[].cache_control",
    "metadata",
    "parallel_tool_calls",
    "user",
    "store",
    "top_k",
    "text.verbosity",
  ])("%s is not semantic", (path) => expect(isSemanticPath(path)).toBe(false));
});

describe("field paths and rule safety", () => {
  it("parses dotted paths with [] markers", () => {
    expect(parseFieldPath("messages[].content[].cache_control")).toEqual([
      { key: "messages", each: true },
      { key: "content", each: true },
      { key: "cache_control", each: false },
    ]);
    for (const bad of [
      "",
      "a..b",
      "a.0",
      "a[0]",
      "$x",
      "a b",
      "a.b.c.d.e.f.g.h.i",
      "__proto__.x",
      "a.constructor",
      "prototype",
    ])
      expect(parseFieldPath(bad)).toBeNull();
  });

  it("refuses targets, streaming and credential-like or address-like names", () => {
    for (const path of [
      "model",
      "stream",
      "api_key",
      "extra.apiKey",
      "headers.authorization",
      "auth",
      "x.access_token",
      "client_secret",
      "base_url",
      "image_url.url",
      "password",
    ])
      expect(rulePathProblem(path), path).not.toBeNull();
    for (const path of [
      "max_tokens",
      "max_completion_tokens",
      "stream_options.include_usage",
      "top_k",
    ])
      expect(rulePathProblem(path), path).toBeNull();
  });

  it("validates rules: semantic drops need the operator's allowance", () => {
    expect(
      requestCompatSchema.safeParse({ rewriteRules: [{ op: "drop", path: "logprobs" }] }).success,
    ).toBe(false);
    expect(
      requestCompatSchema.safeParse({
        allowDropSemanticFields: ["logprobs"],
        rewriteRules: [{ op: "drop", path: "logprobs" }],
      }).success,
    ).toBe(true);
  });

  it("keeps defaults free of URLs, paths and data URIs", () => {
    const parse = (value: unknown) =>
      requestCompatSchema.safeParse({ rewriteRules: [{ op: "default", path: "a.b", value }] })
        .success;
    expect(parse(false)).toBe(true);
    expect(parse("low")).toBe(true);
    expect(parse("https://evil.example/x")).toBe(false);
    expect(parse("data:image/png;base64,AAAA")).toBe(false);
    expect(parse("/media/x")).toBe(false);
    expect(
      requestCompatSchema.safeParse({ rewriteRules: [{ op: "default", path: "a[].b", value: 1 }] })
        .success,
    ).toBe(false);
  });

  it("keeps defaults off content, adapters, files and media", () => {
    for (const path of [
      "instructions",
      "system",
      "messages",
      "lora_path",
      "lora_request.name",
      "file_id",
      "input_audio.data",
      "image_detail",
      "text.format",
    ])
      expect(
        requestCompatSchema.safeParse({ rewriteRules: [{ op: "default", path, value: "x" }] })
          .success,
        path,
      ).toBe(false);
    expect(
      requestCompatSchema.safeParse({
        rewriteRules: [{ op: "default", path: "temperature", value: 0.6 }],
      }).success,
    ).toBe(true);
  });

  it("guards renames of semantic fields like drops, except same-meaning spellings", () => {
    expect(
      requestCompatSchema.safeParse({
        rewriteRules: [{ op: "rename", path: "messages", to: "msgs" }],
      }).success,
    ).toBe(false);
    expect(
      requestCompatSchema.safeParse({
        rewriteRules: [{ op: "rename", path: "max_completion_tokens", to: "max_tokens" }],
      }).success,
    ).toBe(true);
  });

  it("refuses a rename onto a forbidden key and unknown rule shapes", () => {
    expect(
      requestCompatSchema.safeParse({ rewriteRules: [{ op: "rename", path: "x", to: "model" }] })
        .success,
    ).toBe(false);
    expect(
      requestCompatSchema.safeParse({ rewriteRules: [{ op: "rename", path: "x", to: "api_key" }] })
        .success,
    ).toBe(false);
    expect(
      requestCompatSchema.safeParse({ rewriteRules: [{ op: "eval", path: "x" }] }).success,
    ).toBe(false);
    expect(requestCompatSchema.safeParse({ headers: { authorization: "forward" } }).success).toBe(
      false,
    );
    expect(
      requestCompatSchema.safeParse({
        rewriteRules: [{ op: "clamp", path: "temperature", min: 2, max: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("stored settings", () => {
  it("reads invalid stored parts as absent", () => {
    expect(readRequestCompat({ compat: { unknownFieldPolicy: "strict" } })).toEqual({
      unknownFieldPolicy: "strict",
    });
    expect(readRequestCompat({ compat: { unknownFieldPolicy: "nope" } })).toEqual({});
    expect(readRequestCompat(null)).toEqual({});
    expect(readLearnedProfile({ v: 2 })).toEqual({ v: 1, fixes: {}, stripHeaders: [] });
  });
});

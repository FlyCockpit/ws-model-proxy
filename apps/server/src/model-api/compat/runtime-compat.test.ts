import { emptyLearnedProfile } from "@ws-model-proxy/api/lib/request-compat";
import { describe, expect, it } from "vitest";
import {
  compatRequestHeaders,
  NO_RUNTIME_COMPAT,
  normalizeOptions,
  proxyExtras,
  type RuntimeCompat,
  withLearnedFix,
  withLearnedHeader,
} from "./runtime-compat.js";

function runtime(patch: Partial<RuntimeCompat>): RuntimeCompat {
  return { ...NO_RUNTIME_COMPAT, ...patch };
}

describe("proxy extras", () => {
  it("is conservative for unknown engines and on for known ones", () => {
    expect(proxyExtras(runtime({ engine: "OTHER" }))).toEqual({ streamUsage: false, topK: false });
    expect(proxyExtras(runtime({ engine: null }))).toEqual({ streamUsage: false, topK: false });
    expect(proxyExtras(runtime({ engine: "VLLM" }))).toEqual({ streamUsage: true, topK: true });
    expect(proxyExtras(runtime({ engine: "OLLAMA" }))).toEqual({ streamUsage: true, topK: false });
  });

  it("follows the description, then what was learned, and the operator above both", () => {
    const described = runtime({
      engine: "OTHER",
      accepted: {
        v: 1,
        endpoints: { "chat.completions": { p: { stream_options: {}, top_k: { s: 1 } } } },
      },
    });
    expect(proxyExtras(described)).toEqual({ streamUsage: true, topK: true });
    const learned = runtime({
      engine: "VLLM",
      learned: {
        ...emptyLearnedProfile(),
        fixes: { "chat.completions": [{ kind: "drop", path: "stream_options" }] },
      },
    });
    expect(proxyExtras(learned).streamUsage).toBe(false);
    expect(
      proxyExtras({ ...learned, compat: { extras: { streamUsage: true, topK: false } } }),
    ).toEqual({
      streamUsage: true,
      topK: false,
    });
  });
});

describe("header policy", () => {
  it("forwards, strips and applies learned strips, never touching credentials", () => {
    const client = new Headers({
      authorization: "Bearer secret",
      "x-api-key": "secret",
      "anthropic-beta": "b",
      "openai-beta": "assistants=v2",
      "anthropic-version": "2023-06-01",
    });
    const base = new Headers({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "b",
    });
    const result = compatRequestHeaders({
      base,
      client,
      runtime: runtime({
        compat: { headers: { "openai-beta": "forward", "anthropic-version": "strip" } },
        learned: { ...emptyLearnedProfile(), stripHeaders: ["anthropic-beta"] },
      }),
    });
    expect(Object.fromEntries(result.headers)).toEqual({
      "content-type": "application/json",
      "openai-beta": "assistants=v2",
    });
    expect(result.stripped.sort()).toEqual(["anthropic-beta", "anthropic-version"]);
  });

  it("forward wins over a learned strip", () => {
    const result = compatRequestHeaders({
      base: new Headers({ "anthropic-beta": "b" }),
      client: new Headers({ "anthropic-beta": "b" }),
      runtime: runtime({
        compat: { headers: { "anthropic-beta": "forward" } },
        learned: { ...emptyLearnedProfile(), stripHeaders: ["anthropic-beta"] },
      }),
    });
    expect(result.headers.get("anthropic-beta")).toBe("b");
  });
});

describe("learning", () => {
  it("deduplicates and bounds learned fixes", () => {
    const once = withLearnedFix(emptyLearnedProfile(), "chat.completions", {
      kind: "drop",
      path: "a",
    });
    expect(once?.fixes["chat.completions"]).toEqual([{ kind: "drop", path: "a" }]);
    expect(withLearnedFix(once!, "chat.completions", { kind: "drop", path: "a" })).toBeNull();
    let full = emptyLearnedProfile();
    for (let index = 0; index < 64; index += 1)
      full = withLearnedFix(full, "messages", { kind: "drop", path: `f${index}` }) ?? full;
    expect(withLearnedFix(full, "messages", { kind: "drop", path: "more" })).toBeNull();
    const header = withLearnedHeader(emptyLearnedProfile(), "anthropic-beta");
    expect(header?.stripHeaders).toEqual(["anthropic-beta"]);
    expect(withLearnedHeader(header!, "anthropic-beta")).toBeNull();
  });
});

describe("response options", () => {
  it("defaults to keeping the engine's reasoning field and its extra fields", () => {
    expect(normalizeOptions(NO_RUNTIME_COMPAT)).toEqual({
      reasoningField: "auto",
      stripNonStandard: false,
    });
    expect(
      normalizeOptions(
        runtime({ compat: { response: { reasoningField: "strip", stripNonStandard: true } } }),
      ),
    ).toEqual({ reasoningField: "strip", stripNonStandard: true });
  });
});

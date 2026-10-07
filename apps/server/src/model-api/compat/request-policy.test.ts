import { readFile } from "node:fs/promises";
import type { AcceptedProfile, RequestCompat } from "@ws-model-proxy/api/lib/request-compat";
import { describe, expect, it } from "vitest";
import { acceptedProfileFromOpenApi, openApiEngineVersion } from "./openapi-profile.js";
import { applyRequestCompat, planCompatRetry, unknownPaths } from "./request-policy.js";

const openapi = JSON.parse(
  await readFile(new URL("./fixtures/openapi-strict-chat.json", import.meta.url), "utf8"),
) as unknown;
const profile = acceptedProfileFromOpenApi(openapi) as AcceptedProfile;
const chat = profile.endpoints["chat.completions"]!;

function request() {
  return {
    model: "m",
    messages: [
      { role: "developer", content: "be brief" },
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
      },
    ],
    stream: true,
    stream_options: { include_usage: true, continuous_usage_stats: true },
    parallel_tool_calls: false,
    metadata: { a: 1 },
    logprobs: true,
    tools: [{ type: "function", function: { name: "f", parameters: {}, strict: true } }],
  };
}

describe("OpenAPI accepted profile", () => {
  it("reads request schemas through $ref, anyOf, oneOf, allOf and null variants", () => {
    expect(Object.keys(profile.endpoints).sort()).toEqual(["chat.completions", "embeddings"]);
    expect(Object.keys(chat.p ?? {})).toContain("stream_options");
    expect(chat.p?.stream_options?.p?.include_usage).toEqual({ s: 1 });
    expect(chat.p?.messages?.i?.p?.role?.e).toEqual(["assistant", "system", "user"]);
    expect(chat.p?.messages?.i?.p?.tool_calls).toBeDefined();
    expect(chat.p?.messages?.i?.p?.content?.i?.p?.type?.e).toEqual(["image_url", "text"]);
    // An open map with no named keys accepts anything below it.
    expect(chat.p?.chat_template_kwargs).toEqual({});
    expect(chat.p?.messages?.i?.p?.content?.s).toBe(1);
    // Two embedding request shapes: either one's keys are accepted.
    expect(Object.keys(profile.endpoints.embeddings?.p ?? {}).sort()).toEqual([
      "dimensions",
      "input",
      "messages",
      "model",
    ]);
  });

  it("refuses what is not an OpenAPI document and survives reference loops", () => {
    expect(acceptedProfileFromOpenApi({ swagger: "2.0" })).toBeNull();
    expect(acceptedProfileFromOpenApi(null)).toBeNull();
    const loop = {
      openapi: "3.0.0",
      paths: {
        "/v1/chat/completions": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Loop: { type: "object", properties: { self: { $ref: "#/components/schemas/Loop" } } },
        },
      },
    };
    expect(acceptedProfileFromOpenApi(loop)?.endpoints["chat.completions"]?.p?.self).toBeDefined();
  });

  it("treats an object without additionalProperties as open", () => {
    expect(unknownPaths({ metadata_ignore: { a: "x", b: 1 } }, chat)).toEqual([]);
  });

  it("adds sibling properties next to $ref and anyOf", () => {
    const document = {
      openapi: "3.1.0",
      paths: {
        "/v1/chat/completions": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Base",
                    properties: { extra_key: { type: "string" } },
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Base: {
            type: "object",
            properties: { model: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
    };
    const node = acceptedProfileFromOpenApi(document)?.endpoints["chat.completions"];
    expect(Object.keys(node?.p ?? {}).sort()).toEqual(["extra_key", "model"]);
    expect(unknownPaths({ model: "m", extra_key: "x", other: 1 }, node!)).toEqual(["other"]);
  });

  it("fingerprints the engine from info", () => {
    expect(openApiEngineVersion(openapi)).toBe("Strict Engine 1.2.3");
    expect(openApiEngineVersion({ info: { title: "x\u0000y" } })).toBe("xy");
  });

  it("lists unknown keys only where the description is closed", () => {
    expect(
      unknownPaths(
        { chat_template_kwargs: { anything: true }, foo: 1, tools: [{ type: "function", x: 1 }] },
        chat,
      ),
    ).toEqual(["foo", "tools[].x"]);
  });
});

describe("applyRequestCompat", () => {
  it("auto drops unknown non-semantic fields, keeps semantic ones and maps developer", () => {
    const input = request();
    const result = applyRequestCompat({
      endpoint: "chat.completions",
      body: input,
      compat: {},
      accepted: chat,
      learned: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.dropped.sort()).toEqual([
      "messages[].cache_control",
      "messages[].content[].cache_control",
      "metadata",
      "stream_options.continuous_usage_stats",
    ]);
    expect(result.report.rewrites).toEqual(["mapRole:developer>system"]);
    expect(result.body.logprobs).toBe(true);
    expect(result.body.parallel_tool_calls).toBe(false);
    expect(result.body.tools).toEqual(input.tools);
    expect(result.body.stream_options).toEqual({ include_usage: true });
    expect((result.body.messages as Array<{ role: string }>)[0]!.role).toBe("system");
    // The caller's object is untouched.
    expect(input.metadata).toEqual({ a: 1 });
    expect(input.messages[0]!.role).toBe("developer");
  });

  it("strict refuses the first unknown field and forward sends everything", () => {
    const strict = applyRequestCompat({
      endpoint: "chat.completions",
      body: request(),
      compat: { unknownFieldPolicy: "strict" },
      accepted: chat,
      learned: [],
    });
    expect(strict).toMatchObject({ ok: false, refusal: { code: "unknown_field" } });
    const forward = applyRequestCompat({
      endpoint: "chat.completions",
      body: request(),
      compat: { unknownFieldPolicy: "forward" },
      accepted: chat,
      learned: [{ kind: "drop", path: "metadata" }],
    });
    expect(forward).toEqual({ ok: true, body: request(), report: { dropped: [], rewrites: [] } });
  });

  it("drops a semantic field only when the operator allowed it", () => {
    const learned = [{ kind: "drop" as const, path: "logprobs" }];
    const kept = applyRequestCompat({
      endpoint: "chat.completions",
      body: { model: "m", logprobs: true },
      compat: {},
      accepted: null,
      learned,
    });
    expect(kept).toMatchObject({ ok: true, body: { logprobs: true } });
    const dropped = applyRequestCompat({
      endpoint: "chat.completions",
      body: { model: "m", logprobs: true },
      compat: { allowDropSemanticFields: ["logprobs"] },
      accepted: null,
      learned,
    });
    expect(dropped).toMatchObject({
      ok: true,
      body: { model: "m" },
      report: { dropped: ["logprobs"] },
    });
  });

  it("applies rewrite rules in order, scoped to their endpoint", () => {
    const compat: RequestCompat = {
      rewriteRules: [
        { op: "rename", path: "max_completion_tokens", to: "max_tokens" },
        { op: "default", path: "chat_template_kwargs.enable_thinking", value: false },
        { op: "clamp", path: "temperature", max: 1 },
        { op: "mapRole", from: "developer", to: "system" },
        { op: "drop", path: "user", endpoint: "chat.completions" },
        { op: "drop", path: "seed_hint", endpoint: "responses" },
      ],
    };
    const result = applyRequestCompat({
      endpoint: "chat.completions",
      body: {
        model: "m",
        max_completion_tokens: 9,
        temperature: 1.7,
        user: "u",
        seed_hint: 1,
        messages: [{ role: "developer", content: "x" }],
      },
      compat,
      accepted: null,
      learned: [],
    });
    expect(result).toEqual({
      ok: true,
      body: {
        model: "m",
        max_tokens: 9,
        temperature: 1,
        seed_hint: 1,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "system", content: "x" }],
      },
      report: {
        dropped: ["user"],
        rewrites: [
          "rename:max_completion_tokens>max_tokens",
          "default:chat_template_kwargs.enable_thinking",
          "clamp:temperature",
          "mapRole:developer>system",
        ],
      },
    });
  });

  it("never overwrites a value the caller sent with a default", () => {
    const result = applyRequestCompat({
      endpoint: "chat.completions",
      body: { chat_template_kwargs: { enable_thinking: true } },
      compat: {
        rewriteRules: [
          { op: "default", path: "chat_template_kwargs.enable_thinking", value: false },
        ],
      },
      accepted: null,
      learned: [],
    });
    expect(result).toMatchObject({
      ok: true,
      body: { chat_template_kwargs: { enable_thinking: true } },
    });
  });
});

describe("object internals", () => {
  it("never walks into or writes a prototype", () => {
    const body = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>;
    const result = applyRequestCompat({
      endpoint: "chat.completions",
      body,
      compat: {},
      accepted: null,
      learned: [{ kind: "drop", path: "__proto__.x" }],
    });
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("planCompatRetry", () => {
  const excerpt = "engine said no";
  it("learns a drop for a non-semantic field under auto", () => {
    expect(
      planCompatRetry({
        endpoint: "chat.completions",
        compat: {},
        rejection: { kind: "field", path: "metadata" },
        excerpt,
      }),
    ).toEqual({ action: "learn", fix: { kind: "drop", path: "metadata" } });
  });

  it("renames a semantic field to its same-meaning spelling", () => {
    expect(
      planCompatRetry({
        endpoint: "chat.completions",
        compat: {},
        rejection: { kind: "field", path: "max_completion_tokens" },
        excerpt,
      }),
    ).toEqual({
      action: "learn",
      fix: { kind: "rename", path: "max_completion_tokens", to: "max_tokens" },
    });
    expect(
      planCompatRetry({
        endpoint: "chat.completions",
        compat: {},
        rejection: { kind: "replace", path: "max_tokens", with: "max_completion_tokens" },
        excerpt,
      }),
    ).toEqual({
      action: "learn",
      fix: { kind: "rename", path: "max_tokens", to: "max_completion_tokens" },
    });
  });

  it("refuses a semantic field with the engine's words", () => {
    const plan = planCompatRetry({
      endpoint: "chat.completions",
      compat: {},
      rejection: { kind: "field", path: "logprobs" },
      excerpt,
    });
    expect(plan).toMatchObject({
      action: "refuse",
      refusal: { code: "semantic_field", path: "logprobs" },
    });
    expect(plan?.action === "refuse" && plan.refusal.message).toContain(excerpt);
    expect(
      planCompatRetry({
        endpoint: "chat.completions",
        compat: { allowDropSemanticFields: ["logprobs"] },
        rejection: { kind: "field", path: "logprobs" },
        excerpt,
      }),
    ).toEqual({ action: "learn", fix: { kind: "drop", path: "logprobs" } });
  });

  it("maps developer to system and refuses other roles", () => {
    expect(
      planCompatRetry({
        endpoint: "chat.completions",
        compat: {},
        rejection: { kind: "role", value: "developer" },
        excerpt,
      }),
    ).toEqual({ action: "learn", fix: { kind: "mapRole", from: "developer", to: "system" } });
    expect(
      planCompatRetry({
        endpoint: "chat.completions",
        compat: {},
        rejection: { kind: "role", value: "tool" },
        excerpt,
      }),
    ).toMatchObject({ action: "refuse" });
  });

  it("learns nothing under forward or strict, and strips headers only when not forwarded", () => {
    for (const unknownFieldPolicy of ["forward", "strict"] as const)
      expect(
        planCompatRetry({
          endpoint: "chat.completions",
          compat: { unknownFieldPolicy },
          rejection: { kind: "field", path: "metadata" },
          excerpt,
        }),
      ).toBeNull();
    expect(
      planCompatRetry({
        endpoint: "messages",
        compat: {},
        rejection: { kind: "header", name: "anthropic-beta", reason: "unsupported" },
        excerpt,
      }),
    ).toEqual({ action: "stripHeader", name: "anthropic-beta", remember: true });
    expect(
      planCompatRetry({
        endpoint: "messages",
        compat: {},
        rejection: { kind: "header", name: "anthropic-beta", reason: "value" },
        excerpt,
      }),
    ).toEqual({ action: "stripHeader", name: "anthropic-beta", remember: false });
    expect(
      planCompatRetry({
        endpoint: "messages",
        compat: { headers: { "anthropic-beta": "forward" } },
        rejection: { kind: "header", name: "anthropic-beta", reason: "unsupported" },
        excerpt,
      }),
    ).toBeNull();
  });
});

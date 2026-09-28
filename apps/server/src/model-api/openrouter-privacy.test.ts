import { describe, expect, it } from "vitest";
import {
  applyOpenRouterDataCollection,
  isOpenRouterDataPolicyRefusal,
  mapOpenRouterDataPolicyRefusal,
  OPENROUTER_ERROR_INSPECT_MAX_BYTES,
  OpenRouterPrivacyRenderError,
  openRouterDataCollectionPolicy,
} from "./openrouter-privacy.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;

describe("openRouterDataCollectionPolicy", () => {
  it("denies for OpenRouter accounts unless the owner allowed data collection", () => {
    expect(
      openRouterDataCollectionPolicy({ providerType: "openrouter", allowDataCollection: false }),
    ).toBe("deny");
    expect(
      openRouterDataCollectionPolicy({ providerType: " OpenRouter ", allowDataCollection: false }),
    ).toBe("deny");
    expect(
      openRouterDataCollectionPolicy({ providerType: "openrouter", allowDataCollection: true }),
    ).toBeNull();
  });

  it("never applies to other provider types", () => {
    for (const providerType of ["openai", "anthropic", "openai-compatible", "anthropic-compatible"])
      expect(openRouterDataCollectionPolicy({ providerType, allowDataCollection: false })).toBe(
        null,
      );
  });
});

describe("applyOpenRouterDataCollection", () => {
  it("adds provider.data_collection deny", () => {
    const body = decode(applyOpenRouterDataCollection(encode('{"model":"m"}'), "deny"));
    expect(body).toEqual({ model: "m", provider: { data_collection: "deny" } });
  });

  it("merges into an existing provider object and overrides a relaxed value", () => {
    const body = decode(
      applyOpenRouterDataCollection(
        encode('{"provider":{"only":["x"],"data_collection":"allow"}}'),
        "deny",
      ),
    );
    expect(body.provider).toEqual({ only: ["x"], data_collection: "deny" });
  });

  it("replaces a provider value that is not an object", () => {
    for (const provider of ['"allow"', "null", "[1]", "3"]) {
      const body = decode(
        applyOpenRouterDataCollection(encode(`{"provider":${provider}}`), "deny"),
      );
      expect(body.provider).toEqual({ data_collection: "deny" });
    }
  });

  it("returns the body unchanged without a policy or without a body", () => {
    const original = encode('{"provider":{"data_collection":"allow"}}');
    expect(applyOpenRouterDataCollection(original, null)).toBe(original);
    const empty = new Uint8Array();
    expect(applyOpenRouterDataCollection(empty, "deny")).toBe(empty);
  });

  it("fails closed on a body that cannot carry the preference", () => {
    for (const body of ["not json", "[]", '"text"', "null"])
      expect(() => applyOpenRouterDataCollection(encode(body), "deny")).toThrow(
        OpenRouterPrivacyRenderError,
      );
  });
});

describe("OpenRouter data-policy refusal mapping", () => {
  const refusal =
    '{"error":{"message":"No endpoints found matching your data policy (Free model training).","code":404}}';

  it("recognizes only a 404 that names the data policy", () => {
    expect(isOpenRouterDataPolicyRefusal(404, refusal)).toBe(true);
    expect(isOpenRouterDataPolicyRefusal(400, refusal)).toBe(false);
    expect(isOpenRouterDataPolicyRefusal(404, '{"error":{"message":"Model not found"}}')).toBe(
      false,
    );
  });

  it("maps the refusal to a 503 with a stable code", async () => {
    const { response: mapped, refused } = await mapOpenRouterDataPolicyRefusal(
      new Response(refusal, { status: 404 }),
    );
    expect(refused).toBe(true);
    expect(mapped.status).toBe(503);
    expect(mapped.headers.get("content-type")).toBe("application/json");
    const payload = (await mapped.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("provider_data_policy_unavailable");
  });

  it("passes other statuses through untouched", async () => {
    const response = new Response("ok", { status: 200 });
    expect(await mapOpenRouterDataPolicyRefusal(response)).toEqual({ response, refused: false });
  });

  it("replays a large 404 body byte-for-byte without mapping it", async () => {
    const chunk = "x".repeat(16 * 1024);
    const chunks = Array.from({ length: 8 }, () => chunk);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of chunks) controller.enqueue(encode(part));
        controller.enqueue(encode(" data policy"));
        controller.close();
      },
    });
    const { response: mapped, refused } = await mapOpenRouterDataPolicyRefusal(
      new Response(stream, { status: 404 }),
    );
    expect(refused).toBe(false);
    expect(mapped.status).toBe(404);
    const text = await mapped.text();
    expect(text.length).toBeGreaterThan(OPENROUTER_ERROR_INSPECT_MAX_BYTES);
    expect(text).toBe(`${chunks.join("")} data policy`);
  });

  it("replays a body read failure after the inspected prefix", async () => {
    const failure = new Error("stream failed");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encode("partial"));
        controller.error(failure);
      },
    });
    const { response: mapped, refused } = await mapOpenRouterDataPolicyRefusal(
      new Response(stream, { status: 404 }),
    );
    expect(refused).toBe(false);
    expect(mapped.status).toBe(404);
    await expect(mapped.text()).rejects.toThrow("stream failed");
  });
});

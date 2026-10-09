import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({ env: { BETTER_AUTH_SECRET: "x".repeat(32) } }));

const { MCP_REDACTED_VALUE, redactSecrets } = await import("./redaction");
const { toJsonSafe } = await import("./serialization");

const AGENT_TOKEN = `wsmp_agent_${"A".repeat(43)}`;
const API_KEY = `wsmp_key_${"b".repeat(43)}`;
const JWT = `eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjF9.c2lnbmF0dXJlLWJ5dGVz`;

describe("MCP output redaction", () => {
  it("keeps node secret names and other names that only mention a secret", () => {
    const output = {
      secretNames: ["WSMP_SECRET_HF_TOKEN", "WSMP_SECRET_DB"],
      secrets: [{ name: "WSMP_SECRET_HF_TOKEN", updatedAt: "2026-10-06T00:00:00.000Z" }],
      secretFile: true,
      launch: { secrets: ["WSMP_SECRET_HF_TOKEN"] },
      lookupPrefix: "wsmp_agent_AB",
      credentialType: "api_key",
    };
    expect(redactSecrets(output)).toEqual(output);
  });

  it("redacts credential values under any key, and inside text", () => {
    expect(
      redactSecrets({
        note: `use ${API_KEY} for it`,
        raw: AGENT_TOKEN,
        header: `Bearer ${"t".repeat(40)}`,
        jwt: JWT,
      }),
    ).toEqual({
      note: `use ${MCP_REDACTED_VALUE} for it`,
      raw: MCP_REDACTED_VALUE,
      header: MCP_REDACTED_VALUE,
      jwt: MCP_REDACTED_VALUE,
    });
  });

  it("redacts exact credential-value keys whatever they hold", () => {
    expect(
      redactSecrets({
        secretDigest: "ab",
        client_secret: "s",
        accessToken: 1,
        nested: [{ password: "p" }],
      }),
    ).toEqual({
      secretDigest: MCP_REDACTED_VALUE,
      client_secret: MCP_REDACTED_VALUE,
      accessToken: MCP_REDACTED_VALUE,
      nested: [{ password: MCP_REDACTED_VALUE }],
    });
  });

  it("passes dates and decimals through for the serializer and never mutates input", () => {
    const at = new Date("2026-10-06T00:00:00.000Z");
    const input = { at, list: [AGENT_TOKEN] };
    const output = toJsonSafe(redactSecrets(input));
    expect(output).toEqual({ at: at.toISOString(), list: [MCP_REDACTED_VALUE] });
    expect(input.list[0]).toBe(AGENT_TOKEN);
  });

  it("bounds depth", () => {
    let deep: unknown = "x";
    for (let index = 0; index < 40; index += 1) deep = { deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain(MCP_REDACTED_VALUE);
  });
});

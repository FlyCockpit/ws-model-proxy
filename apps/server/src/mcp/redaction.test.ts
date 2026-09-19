import { describe, expect, it, vi } from "vitest";

import { MCP_REDACTED_VALUE, redactSecrets } from "./redaction";
import { toJsonSafe } from "./serialization";

// redaction.ts imports PRODUCT_CREDENTIAL_PREFIXES from
// @ws-model-proxy/db/forwarder-security, which reads env at module scope.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://redaction-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://redaction-test",
    NODE_ENV: "test",
  },
}));

describe("redactSecrets — key-fragment matrix", () => {
  it("redacts values under secret-bearing keys across spellings", () => {
    expect(
      redactSecrets({
        secret: "x",
        client_secret: "x",
        "auth-tag": "x",
        secretDigest: "x",
        refreshToken: "x",
        passwordHint: "x",
        api_key: "x",
        authorizationHeader: "x",
        bearerValue: "x",
        privateKeyPem: "x",
        jwk: "x",
        tokenHash: "x",
      }),
    ).toEqual({
      secret: MCP_REDACTED_VALUE,
      client_secret: MCP_REDACTED_VALUE,
      "auth-tag": MCP_REDACTED_VALUE,
      secretDigest: MCP_REDACTED_VALUE,
      refreshToken: MCP_REDACTED_VALUE,
      passwordHint: MCP_REDACTED_VALUE,
      api_key: MCP_REDACTED_VALUE,
      authorizationHeader: MCP_REDACTED_VALUE,
      bearerValue: MCP_REDACTED_VALUE,
      privateKeyPem: MCP_REDACTED_VALUE,
      jwk: MCP_REDACTED_VALUE,
      tokenHash: MCP_REDACTED_VALUE,
    });
  });

  it("redacts exact `token` and `credential` keys, but not descriptive metadata", () => {
    expect(
      redactSecrets({
        token: "raw-token",
        credential: "raw-credential",
        // Metadata that DESCRIBES secrets stays visible:
        credentialType: "BEARER",
        displaySuffix: "…abcd",
        keyVersion: "v1",
        lookupPrefix: "wsmp_mod",
        tokensTotal: 3,
      }),
    ).toEqual({
      token: MCP_REDACTED_VALUE,
      credential: MCP_REDACTED_VALUE,
      credentialType: "BEARER",
      displaySuffix: "…abcd",
      keyVersion: "v1",
      lookupPrefix: "wsmp_mod",
      tokensTotal: 3,
    });
  });

  it("redacts product-credential VALUES under any key", () => {
    expect(
      redactSecrets({
        name: "wsmp_model_AAAA.BBBB",
        note: "wsmp_cli_CCCC",
        other: "wsmp_device_DDDD",
        // The prefix must appear at the START of the value: a value that
        // merely mentions it is not a credential.
        harmless: "mentions-wsmp_model_midstring",
        plain: "ordinary string",
      }),
    ).toEqual({
      name: MCP_REDACTED_VALUE,
      note: MCP_REDACTED_VALUE,
      other: MCP_REDACTED_VALUE,
      harmless: "mentions-wsmp_model_midstring",
      plain: "ordinary string",
    });
  });

  it("recurses through nested rows and arrays; never mutates the input", () => {
    const input = {
      rows: [
        { id: "a", accessToken: "leak" },
        { id: "b", nested: [{ refreshToken: "leak" }] },
      ],
      skip: "keep",
    };
    const before = JSON.stringify(input);
    const output = redactSecrets(input);
    expect(output).toEqual({
      rows: [
        { id: "a", accessToken: MCP_REDACTED_VALUE },
        { id: "b", nested: [{ refreshToken: MCP_REDACTED_VALUE }] },
      ],
      skip: "keep",
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("passes Dates, Decimals, and byte containers through untouched for serialization", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    const bytes = new Uint8Array([9, 9]);
    // A class-instance-shaped Decimal (custom prototype): the redactor must
    // pass the SAME reference through; only plain rows are rebuilt.
    const decimal = Object.create({
      toFixed: () => "1",
      toSignificantDigits: () => ({ toString: () => "1" }),
    }) as Record<string, unknown>;
    decimal.d = [1];
    decimal.e = 0;
    decimal.s = 1;
    const output = redactSecrets({ when, bytes, decimal }) as Record<string, unknown>;
    expect(output.when).toBeInstanceOf(Date);
    expect(output.bytes).toBe(bytes);
    expect(output.decimal).toBe(decimal);
  });

  it("redacts secret-bearing fields on UNKNOWN CLASS INSTANCES the serializer would enumerate (G8b)", () => {
    class CredentialRow {
      id = "row-1";
      secret = "CLASS_SECRET_SENTINEL";
      ciphertext = "CLASS_CIPHERTEXT_SENTINEL";
      label = "visible";
    }
    const output = redactSecrets({ rows: [new CredentialRow()] }) as {
      rows: Record<string, unknown>[];
    };
    // The instance is rebuilt as a plain object with the SAME enumerable
    // field set the serializer emits — secret-bearing values redacted.
    expect(output.rows).toEqual([
      {
        id: "row-1",
        secret: MCP_REDACTED_VALUE,
        ciphertext: MCP_REDACTED_VALUE,
        label: "visible",
      },
    ]);
    // And the composed pipeline (redactor → serializer) never leaks it.
    expect(JSON.stringify(toJsonSafe(output))).not.toContain("CLASS_SECRET_SENTINEL");
    expect(JSON.stringify(toJsonSafe(output))).not.toContain("CLASS_CIPHERTEXT_SENTINEL");
  });

  it("never throws on hostile shapes", () => {
    expect(() => redactSecrets(undefined)).not.toThrow();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(42n)).toBe(42n);
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 100; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

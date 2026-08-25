import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
  },
}));

import {
  encryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import {
  claimPublicProviderCredentialForSend,
  conservativeProviderLiability,
  conservativeSerializedInputTokens,
  parseProviderUsage,
  providerHealthOutcome,
  publicTargetCompatibility,
} from "./public-overflow.js";

const request = {
  requestedProtocol: "openai" as const,
  requestedSurface: "openai-chat" as const,
  stream: false,
  requiredFeatures: [],
  adaptationEnabled: false,
  requestedOutputTokens: 80n,
  renderForTarget: undefined,
  liability: { tokens: 200n, accountingVersion: "provider-billable-v1" },
};

describe("public overflow compatibility", () => {
  it("treats ordinary client errors as health-neutral and 429 as failure", () => {
    expect(providerHealthOutcome(200)).toBe("SUCCESS");
    expect(providerHealthOutcome(400)).toBe("NEUTRAL");
    expect(providerHealthOutcome(401)).toBe("NEUTRAL");
    expect(providerHealthOutcome(429)).toBe("FAILURE");
    expect(providerHealthOutcome(503)).toBe("FAILURE");
  });
  it("commits the credential send-start claim before provider I/O can begin", async () => {
    const keyring = parseProviderCredentialKeyring(`v1:${Buffer.alloc(32, 7).toString("base64")}`);
    const identity = {
      credentialId: "credential",
      userId: "owner",
      providerAccountId: "account",
      credentialType: "BEARER" as const,
      aadVersion: 1,
    };
    const envelope = encryptProviderCredential("provider-secret", identity, keyring);
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push("lock");
        return [];
      }),
      providerCredential: {
        findFirst: vi.fn(async () => ({
          id: identity.credentialId,
          credentialType: identity.credentialType,
          aadVersion: identity.aadVersion,
          ...envelope,
        })),
        update: vi.fn(async () => {
          order.push("durable-claim");
          return { id: identity.credentialId };
        }),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) => {
      const result = await callback(tx);
      order.push("commit");
      return result;
    });
    const target = {
      poolMemberId: "member",
      executionTargetId: "target",
      publicOrder: 0,
      providerModelId: "model",
      upstreamModelId: "upstream",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      protocol: "openai" as const,
      providerAccountId: identity.providerAccountId,
      endpointIdentity: "provider-endpoint",
      endpointVersion: 1,
      concurrencyLimit: null,
      providerVersion: null,
      baseUrl: "https://provider.example",
      authType: "BEARER" as const,
      healthStatus: "HEALTHY" as const,
      nativeProtocols: ["openai" as const],
      nativeSurfaces: ["openai-chat" as const],
      supportsStreaming: true,
      supportedFeatures: [],
      credential: {
        id: identity.credentialId,
        credentialType: identity.credentialType,
        keyVersion: envelope.keyVersion,
        aadVersion: identity.aadVersion,
        algorithm: envelope.algorithm,
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
        authTag: envelope.authTag,
      },
    };

    const secret = await claimPublicProviderCredentialForSend({
      userId: identity.userId,
      target,
      keyring,
    });
    order.push("network-may-start");

    expect(secret).toBe("provider-secret");
    expect(order).toEqual(["lock", "lock", "durable-claim", "commit", "network-may-start"]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("fails a send-start claim when revocation won the lifecycle lock", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
    const keyring = parseProviderCredentialKeyring(`v1:${Buffer.alloc(32, 7).toString("base64")}`);

    await expect(
      claimPublicProviderCredentialForSend({
        userId: "owner",
        target: {
          poolMemberId: "member",
          executionTargetId: "target",
          publicOrder: 0,
          providerModelId: "model",
          upstreamModelId: "upstream",
          contextWindow: 1_000,
          maxOutputTokens: 100,
          protocol: "openai",
          providerAccountId: "account",
          endpointIdentity: "provider-endpoint",
          endpointVersion: 1,
          concurrencyLimit: null,
          providerVersion: null,
          baseUrl: "https://provider.example",
          authType: "BEARER",
          healthStatus: "HEALTHY",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
          credential: {
            id: "credential",
            credentialType: "BEARER",
            keyVersion: "v1",
            aadVersion: 1,
            algorithm: "AES-256-GCM",
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            authTag: new Uint8Array(),
          },
        },
        keyring,
      }),
    ).rejects.toThrow("no longer current");
    expect(tx.providerCredential.update).not.toHaveBeenCalled();
  });

  it("fails closed when context or native capability inventory is unknown", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: null,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        request,
      ),
    ).toBe("CONTEXT_UNKNOWN");
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 1000,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: [],
          nativeSurfaces: [],
          supportsStreaming: false,
          supportedFeatures: [],
        },
        request,
      ),
    ).toBe("PROTOCOL_UNAVAILABLE");
  });

  it("rejects an over-ceiling request before budget or egress", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 199,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        request,
      ),
    ).toBe("CONTEXT_EXCEEDED");
  });

  it("uses a context-only estimate when billable liability is unavailable", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 1_000,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        {
          ...request,
          liability: { accountingVersion: "provider-billable-v1" },
          contextTokens: 200n,
        },
      ),
    ).toBe("COMPATIBLE");
  });

  it("uses the selected model maximum when the client omits an output limit", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 1_001,
          maxOutputTokens: 1_000,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        {
          ...request,
          requestedOutputTokens: undefined,
          estimatedInputTokens: 1n,
          liability: { accountingVersion: "provider-billable-v1" },
        },
      ),
    ).toBe("COMPATIBLE");
  });

  it("requires both adaptation gates and a known native target protocol", () => {
    const target = {
      contextWindow: 1000,
      maxOutputTokens: 100,
      protocol: "anthropic" as const,
      nativeProtocols: ["anthropic" as const],
      nativeSurfaces: ["anthropic-messages" as const],
      supportsStreaming: true,
      supportedFeatures: [],
    };
    expect(publicTargetCompatibility(target, request)).toBe("PROTOCOL_UNAVAILABLE");
    expect(
      publicTargetCompatibility(target, {
        ...request,
        adaptationEnabled: true,
        renderForTarget: async () => {
          throw new Error("not invoked by prefilter");
        },
      }),
    ).toBe("COMPATIBLE");
  });

  it("rejects Anthropic streaming adaptation from OpenAI before commitment", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 1_000,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        {
          ...request,
          requestedProtocol: "anthropic",
          requestedSurface: "anthropic-messages",
          stream: true,
          adaptationEnabled: true,
          renderForTarget: async () => {
            throw new Error("not invoked by prefilter");
          },
        },
      ),
    ).toBe("PROTOCOL_UNAVAILABLE");
  });

  it("reserves conservative input plus requested output tokens", () => {
    expect(
      conservativeProviderLiability({
        estimatedInputTokens: 120n,
        requestedOutputTokens: 80n,
      }),
    ).toEqual({
      tokens: 200n,
      spend: undefined,
      currency: undefined,
      pricingVersion: undefined,
      accountingVersion: "provider-billable-v1",
    });
  });

  it("produces a non-zero, margin-bearing estimate when tokenizer context is missing", () => {
    expect(conservativeSerializedInputTokens(0)).toBe(64n);
    expect(conservativeSerializedInputTokens(100)).toBe(174n);
    expect(() => conservativeSerializedInputTokens(-1)).toThrow(/non-negative/u);
  });

  it("merges split Anthropic usage without erasing earlier billable categories", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    expect(
      parseProviderUsage([
        encode(
          'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n',
        ),
        encode('event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n'),
      ]),
    ).toMatchObject({
      inputTokens: 12n,
      outputTokens: 7n,
      cacheReadTokens: 3n,
      categoriesComplete: true,
      confidence: "REPORTED",
    });
  });
});

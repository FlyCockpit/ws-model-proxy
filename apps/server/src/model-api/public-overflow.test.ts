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
  exactResponsesNativeSurface,
  matchesExactResponsesBinding,
  parseProviderUsage,
  providerHealthCooldownElapsed,
  providerHealthOutcome,
  publicTargetCompatibility,
  resolvePublicProviderExecution,
} from "./public-overflow.js";

describe("provider health cooldown", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");

  it.each(["provider model", "provider account"])(
    "excludes an unavailable %s until its database cooldown is due",
    () => {
      expect(
        providerHealthCooldownElapsed("UNAVAILABLE", new Date("2026-08-25T12:00:01.000Z"), now),
      ).toBe(false);
      expect(providerHealthCooldownElapsed("UNAVAILABLE", null, now)).toBe(false);
      expect(providerHealthCooldownElapsed("UNAVAILABLE", now, now)).toBe(true);
      expect(
        providerHealthCooldownElapsed("UNAVAILABLE", new Date("2026-08-25T11:59:59.000Z"), now),
      ).toBe(true);
    },
  );
});

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
  it("carries the exact alternate surface selected for a streaming request", () => {
    const target = {
      capabilityInventory: {
        version: 4 as const,
        protocol: "openai-compatible" as const,
        surfaces: {
          openaiChatCompletions: {
            source: "provider" as const,
            confidence: "exact" as const,
            operations: ["create" as const],
            streaming: false,
          },
          openaiResponses: {
            source: "provider" as const,
            confidence: "exact" as const,
            operations: ["create" as const],
            streaming: true,
          },
        },
      },
    };
    expect(
      resolvePublicProviderExecution(target, {
        requestedSurface: "openai-chat",
        stream: true,
        requiredFeatures: [],
        adaptationEnabled: true,
      }),
    ).toMatchObject({ mode: "adapted", nativeSurface: "openai-responses" });
    expect(
      publicTargetCompatibility(
        {
          ...target,
          contextWindow: 1_000,
          maxOutputTokens: 100,
          protocol: "openai" as const,
          nativeProtocols: ["openai" as const],
          nativeSurfaces: ["openai-chat" as const, "openai-responses" as const],
          // The legacy aggregate describes the first/requested surface. The
          // inventory is authoritative when selecting an alternate surface.
          supportsStreaming: false,
          supportedFeatures: [],
        },
        { ...request, stream: true, adaptationEnabled: true },
      ),
    ).toBe("COMPATIBLE");
  });

  it.each([
    {
      name: "accepts the exact member ceiling after margin",
      target: { effectiveContextCeiling: 210, contextMargin: 10 },
      expected: "COMPATIBLE",
    },
    {
      name: "rejects one token beyond the member ceiling after margin",
      target: { effectiveContextCeiling: 209, contextMargin: 10 },
      expected: "CONTEXT_EXCEEDED",
    },
    {
      name: "rejects one token beyond the physical runtime maximum after margin",
      target: { physicalMaxContext: 209, contextMargin: 10 },
      expected: "CONTEXT_EXCEEDED",
    },
    {
      name: "still enforces the physical maximum when the policy ceiling is unlimited",
      target: { effectiveContextCeiling: null, physicalMaxContext: 209, contextMargin: 10 },
      expected: "CONTEXT_EXCEEDED",
    },
  ])("$name", ({ target, expected }) => {
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
          ...target,
        },
        request,
      ),
    ).toBe(expected);
  });

  it("fails closed when a v1-v4 inventory protocol disagrees with the provider account", () => {
    const target = {
      contextWindow: 1_000,
      maxOutputTokens: 100,
      protocol: "anthropic" as const,
      nativeProtocols: ["openai" as const],
      nativeSurfaces: ["openai-chat" as const],
      supportsStreaming: false,
      supportedFeatures: [],
    };
    for (const capabilityInventory of [
      { version: 1 as const, protocol: "openai-compatible" as const },
      { version: 2 as const, protocol: "openai-compatible" as const },
      {
        version: 3 as const,
        protocol: "openai-compatible" as const,
        surfaces: {},
      },
      {
        version: 4 as const,
        protocol: "openai-compatible" as const,
        surfaces: {
          openaiChatCompletions: {
            source: "provider" as const,
            confidence: "exact" as const,
            operations: ["create" as const],
          },
        },
      },
    ])
      expect(publicTargetCompatibility({ ...target, capabilityInventory }, request)).toBe(
        "PROTOCOL_UNAVAILABLE",
      );
  });

  it("decodes v1-v3 inventories through the shared resolver and fails closed per surface", () => {
    const inventories = [
      {
        version: 1 as const,
        protocol: "openai-compatible" as const,
        chatCompletions: { supported: true, vision: true },
      },
      {
        version: 2 as const,
        protocol: "openai-compatible" as const,
        chatCompletions: { supported: true, vision: true },
      },
      {
        version: 3 as const,
        protocol: "openai-compatible" as const,
        surfaces: {
          openaiChatCompletions: {
            source: "provider" as const,
            confidence: "exact" as const,
            supported: true,
            inputImages: true,
          },
        },
      },
    ];
    for (const capabilityInventory of inventories) {
      const target = {
        contextWindow: 1_000,
        maxOutputTokens: 100,
        protocol: "openai" as const,
        nativeProtocols: ["openai" as const],
        nativeSurfaces: ["openai-chat" as const],
        supportsStreaming: false,
        supportedFeatures: [],
        capabilityInventory,
      };
      expect(
        publicTargetCompatibility(target, { ...request, requiredFeatures: ["inputImages"] }),
      ).toBe("COMPATIBLE");
      expect(
        publicTargetCompatibility(
          {
            ...target,
            capabilityInventory:
              capabilityInventory.version === 3
                ? {
                    ...capabilityInventory,
                    surfaces: {
                      openaiChatCompletions: {
                        ...capabilityInventory.surfaces.openaiChatCompletions,
                        inputImages: false,
                      },
                    },
                  }
                : {
                    ...capabilityInventory,
                    chatCompletions: {
                      ...capabilityInventory.chatCompletions,
                      vision: false,
                    },
                  },
          },
          { ...request, requiredFeatures: ["inputImages"] },
        ),
      ).toBe("PROTOCOL_UNAVAILABLE");
    }
  });

  it("gates every profiled v4 request feature against the requested native surface", () => {
    const featureNames = [
      "inputImages",
      "outputImages",
      "inputAudio",
      "outputAudio",
      "inputVideo",
      "outputVideo",
      "tools",
      "parallelTools",
      "structuredOutput",
      "reasoning",
      "hostedTools",
    ] as const;
    for (const feature of featureNames) {
      const inventory = {
        version: 4 as const,
        protocol: "openai-compatible" as const,
        surfaces: {
          openaiChatCompletions: {
            source: "provider" as const,
            confidence: "exact" as const,
            operations: ["create" as const],
            [feature]: true,
          },
        },
      };
      const target = {
        contextWindow: 1_000,
        maxOutputTokens: 100,
        protocol: "openai" as const,
        nativeProtocols: ["openai" as const],
        nativeSurfaces: ["openai-chat" as const],
        supportsStreaming: false,
        supportedFeatures: [],
        capabilityInventory: inventory,
      };
      expect(publicTargetCompatibility(target, { ...request, requiredFeatures: [feature] })).toBe(
        "COMPATIBLE",
      );
      expect(
        publicTargetCompatibility(
          {
            ...target,
            capabilityInventory: {
              ...inventory,
              surfaces: {
                openaiChatCompletions: {
                  ...inventory.surfaces.openaiChatCompletions,
                  [feature]: false,
                },
              },
            },
          },
          { ...request, requiredFeatures: [feature] },
        ),
      ).toBe("PROTOCOL_UNAVAILABLE");
    }
  });

  it("fails closed on v4 operation and Anthropic version/beta mismatches", () => {
    const target = {
      contextWindow: 1_000,
      maxOutputTokens: 100,
      protocol: "anthropic" as const,
      nativeProtocols: ["anthropic" as const],
      nativeSurfaces: ["anthropic-messages" as const],
      supportsStreaming: true,
      supportedFeatures: [],
      capabilityInventory: {
        version: 4 as const,
        protocol: "anthropic-compatible" as const,
        surfaces: {
          anthropicMessages: {
            source: "provider" as const,
            confidence: "exact" as const,
            operations: ["create" as const],
            streaming: true,
            protocolVersions: [{ version: "2023-06-01", betaFeatures: ["cache-2026-01-01"] }],
          },
        },
      },
    };
    const headers = new Headers({ "anthropic-version": "2023-06-01" });
    expect(
      publicTargetCompatibility(target, {
        ...request,
        requestedProtocol: "anthropic",
        requestedSurface: "anthropic-messages",
        path: "/v1/messages",
        headers,
      }),
    ).toBe("COMPATIBLE");
    expect(
      publicTargetCompatibility(target, {
        ...request,
        requestedProtocol: "anthropic",
        requestedSurface: "anthropic-messages",
        path: "/v1/messages/count_tokens",
        headers,
      }),
    ).toBe("PROTOCOL_UNAVAILABLE");
    headers.set("anthropic-beta", "unsupported-beta");
    expect(
      publicTargetCompatibility(target, {
        ...request,
        requestedProtocol: "anthropic",
        requestedSurface: "anthropic-messages",
        path: "/v1/messages",
        headers,
      }),
    ).toBe("PROTOCOL_UNAVAILABLE");
  });

  it("matches provider Responses bindings only on the full immutable native tuple", () => {
    const target = {
      executionTargetId: "execution-target",
      providerAccountId: "account",
      providerModelId: "provider-model",
      endpointIdentity: "https://api.example/v1",
      endpointVersion: 7,
      upstreamModelId: "gpt-response",
      nativeSurfaces: ["openai-responses"],
      protocol: "openai",
    } satisfies Parameters<typeof matchesExactResponsesBinding>[0];
    const binding = {
      executionTargetId: "execution-target",
      providerAccountId: "account",
      providerModelId: "provider-model",
      endpointIdentity: "https://api.example/v1",
      endpointVersion: 7,
      upstreamModelId: "gpt-response",
    };
    expect(matchesExactResponsesBinding(target, binding)).toBe(true);
    for (const changed of [
      { endpointVersion: 8 },
      { endpointIdentity: "https://replacement.example/v1" },
      { providerAccountId: "replacement-account" },
      { providerModelId: "replacement-model" },
      { upstreamModelId: "same-looking-model" },
      { executionTargetId: "replacement-target" },
      { nativeSurfaces: ["openai-chat"] as const },
      { protocol: "anthropic" as const },
    ]) {
      expect(matchesExactResponsesBinding({ ...target, ...changed }, binding)).toBe(false);
    }
  });

  it("routes lifecycle-only Responses operations only through their exact native binding", () => {
    const capabilityInventory = {
      version: 4 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiResponses: {
          source: "provider" as const,
          confidence: "exact" as const,
          operations: [
            "retrieve" as const,
            "delete" as const,
            "cancel" as const,
            "listInputItems" as const,
            "countTokens" as const,
            "compact" as const,
          ],
        },
      },
    };
    const target = {
      executionTargetId: "execution-target",
      providerAccountId: "account",
      providerModelId: "provider-model",
      endpointIdentity: "https://api.example/v1",
      endpointVersion: 7,
      upstreamModelId: "gpt-response",
      nativeSurfaces: [],
      protocol: "openai" as const,
      capabilityInventory,
      contextWindow: 1_000,
      maxOutputTokens: 100,
      nativeProtocols: ["openai" as const],
      supportsStreaming: false,
      supportedFeatures: [],
    };
    const binding = {
      executionTargetId: "execution-target",
      providerAccountId: "account",
      providerModelId: "provider-model",
      endpointIdentity: "https://api.example/v1",
      endpointVersion: 7,
      upstreamModelId: "gpt-response",
    };
    expect(matchesExactResponsesBinding(target, binding)).toBe(true);
    expect(exactResponsesNativeSurface(target)).toBe("openai-responses");
    for (const [method, path] of [
      ["GET", "/v1/responses/response"],
      ["DELETE", "/v1/responses/response"],
      ["POST", "/v1/responses/response/cancel"],
      ["GET", "/v1/responses/response/input_items"],
      ["POST", "/v1/responses/count_tokens"],
      ["POST", "/v1/responses/response/compact"],
    ] as const)
      expect(
        publicTargetCompatibility(target, {
          ...request,
          requestedSurface: "openai-responses",
          method,
          path,
        }),
      ).toBe("COMPATIBLE");
    expect(
      publicTargetCompatibility(target, {
        ...request,
        requestedSurface: "openai-responses",
        method: "POST",
        path: "/v1/responses",
      }),
    ).toBe("PROTOCOL_UNAVAILABLE");
    expect(matchesExactResponsesBinding({ ...target, providerModelId: "other" }, binding)).toBe(
      false,
    );
  });
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

  it("preserves authoritative cost-only usage independently of token categories", () => {
    const usage = parseProviderUsage([
      new TextEncoder().encode(
        '{"usage":{"cost":1.25,"currency":"usd","pricing_version":"price-v2"}}',
      ),
    ]);
    expect(usage).toMatchObject({
      reportedCost: 1.25,
      reportedCostCurrency: "USD",
      reportedCostPricingVersion: "price-v2",
      categoriesComplete: undefined,
      confidence: "REPORTED",
    });
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.outputTokens).toBeUndefined();
  });
});

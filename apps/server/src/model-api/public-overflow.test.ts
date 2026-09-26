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
import { env } from "@ws-model-proxy/env/server";
import { type ExternalEgressConsent, evaluateExternalEgress } from "./external-route.js";
import { PROVIDER_HALF_OPEN_LEASE_MS, providerHealthCoolingDown } from "./provider-health-state.js";
import {
  claimPublicProviderCredentialForSend,
  conservativeProviderLiability,
  conservativeSerializedInputTokens,
  dispatchPublicOverflow,
  engineCacheConfirmedFromResponseChunks,
  engineCacheConfirmedFromRetainedResponse,
  engineCacheConfirmedFromUsage,
  exactResponsesNativeSurface,
  matchesExactResponsesBinding,
  parseProviderUsage,
  providerHealthOutcome,
  publicTargetCompatibility,
  resolvePublicProviderExecution,
} from "./public-overflow.js";

function overflowRequest(externalConsent: ExternalEgressConsent, poolId = "pool") {
  return {
    userId: "owner",
    poolId,
    requestId: "request",
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
    externalConsent,
    requesterUserId: "owner",
    requesterModelApiTokenId: "token",
    requestedProtocol: "openai" as const,
    requestedSurface: "openai-chat" as const,
    stream: false,
    requiredFeatures: [],
    path: "/v1/chat/completions",
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode("{}"),
    signal: new AbortController().signal,
    liability: { tokens: 1n, accountingVersion: "provider-billable-v1" },
    releaseLocalCapacity: async () => undefined,
    adaptationEnabled: false,
    retrySafe: false,
  };
}

function issuedConsent(poolId = "pool"): ExternalEgressConsent {
  // The consent is minted while the switch is on; dispatch must still
  // re-check the real deployment switch (off again below).
  const mutableEnv = env as { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: boolean };
  const previous = mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED;
  mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
  try {
    const decision = evaluateExternalEgress({
      requested: true,
      requester: { userId: "owner", source: "API_TOKEN", modelApiTokenId: "token" },
      tokenPermitsPool: true,
      pool: {
        id: poolId,
        ownerUserId: "owner",
        accessGrantId: null,
        fallbackEnabled: true,
        fallbackForGrantees: false,
      },
    });
    if (!decision.granted) throw new Error("expected an issued consent");
    return decision.consent;
  } finally {
    mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = previous;
  }
}

it("applies the deployment egress gate even with an issued caller consent", async () => {
  await expect(dispatchPublicOverflow(overflowRequest(issuedConsent()))).resolves.toEqual({
    dispatched: false,
    reason: "DEPLOYMENT_GATE_DISABLED",
  });
  expect(db.$transaction).not.toHaveBeenCalled();
});

it("fails closed without an issued caller consent for the exact pool", async () => {
  const mutableEnv = env as { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: boolean };
  mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
  try {
    const consent = issuedConsent();
    // A structurally identical object was never issued by the gate.
    await expect(dispatchPublicOverflow(overflowRequest({ ...consent }))).resolves.toEqual({
      dispatched: false,
      reason: "CALLER_CONSENT_MISSING",
    });
    // A consent for another pool never authorizes this one.
    await expect(
      dispatchPublicOverflow(overflowRequest(issuedConsent("other-pool"))),
    ).resolves.toEqual({ dispatched: false, reason: "CALLER_CONSENT_MISSING" });
    expect(db.$transaction).not.toHaveBeenCalled();
  } finally {
    mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;
  }
});

describe("provider health cooldown", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  it("cools a provider account or model until its backoff is due", () => {
    expect(
      providerHealthCoolingDown({ healthNextRetryAt: at(1_000), healthHalfOpenAt: null }, now),
    ).toBe(true);
    expect(
      providerHealthCoolingDown({ healthNextRetryAt: null, healthHalfOpenAt: null }, now),
    ).toBe(false);
    expect(providerHealthCoolingDown({ healthNextRetryAt: now, healthHalfOpenAt: null }, now)).toBe(
      false,
    );
    expect(
      providerHealthCoolingDown({ healthNextRetryAt: at(-1_000), healthHalfOpenAt: null }, now),
    ).toBe(false);
  });

  // R3: the same rule claimProviderHealthTrial enforces, so listing never
  // offers a target whose trial claim would answer COOLDOWN.
  it("keeps cooling while another half-open trial's lease is live, and not after it lapses", () => {
    const due = at(-1_000);
    expect(
      providerHealthCoolingDown({ healthNextRetryAt: due, healthHalfOpenAt: at(-5_000) }, now),
    ).toBe(true);
    expect(
      providerHealthCoolingDown(
        { healthNextRetryAt: due, healthHalfOpenAt: at(-PROVIDER_HALF_OPEN_LEASE_MS) },
        now,
      ),
    ).toBe(false);
    // A half-open stamp without a recorded failure is not a cooldown.
    expect(
      providerHealthCoolingDown({ healthNextRetryAt: null, healthHalfOpenAt: at(-5_000) }, now),
    ).toBe(false);
  });
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
      name: "accepts a request that exactly fits the context window",
      contextWindow: 200,
      expected: "COMPATIBLE",
    },
    {
      name: "rejects one token beyond the context window",
      contextWindow: 199,
      expected: "CONTEXT_EXCEEDED",
    },
  ])("$name", ({ contextWindow, expected }) => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
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
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        order.push(`lock:${lockedTable(strings)}`);
        return [];
      }),
      ...consentTx(order),
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

    const claim = await withEgressEnabled(() =>
      claimPublicProviderCredentialForSend({
        userId: identity.userId,
        target,
        keyring,
        consent: GRANTEE_TOKEN_CONSENT,
      }),
    );
    order.push("network-may-start");

    expect(claim).toEqual({ claimed: true, secret: "provider-secret" });
    // E0 send boundary: consent rows FOR SHARE in the canonical order, read
    // under those locks, then the provider account/credential lifecycle locks,
    // the durable claim, and commit, all before any network I/O.
    expect(order).toEqual([
      "lock:model_pool FOR SHARE",
      "lock:pool_grant FOR SHARE",
      "lock:model_api_token FOR SHARE",
      "lock:model_api_token_allowlist_entry FOR SHARE",
      "read:pool",
      "read:consent",
      "read:account",
      "read:consent",
      "read:consent",
      "lock:provider_account FOR UPDATE",
      "lock:provider_credential FOR UPDATE",
      // Time and the (unlocked) account row, re-read after the last wait.
      "read:consent",
      "read:account",
      "durable-claim",
      "commit",
      "network-may-start",
    ]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it.each([
    ["the owner turned fallback off", { pool: { fallbackEnabled: false } }, "POOL_PRIVATE"],
    [
      "the owner stopped covering grantees",
      { pool: { fallbackEnabled: true, fallbackForGrantees: false } },
      "GRANTEE_NOT_COVERED",
    ],
    ["the grant was deleted", { grant: null }, "REQUESTER_NOT_VISIBLE"],
    [
      "the grant was replaced by another grant",
      { grant: { id: "replacement-grant" } },
      "REQUESTER_NOT_VISIBLE",
    ],
    [
      "the requester's account is marked for deletion",
      { account: { deletionRequestedAt: new Date() } },
      "REQUESTER_ACCESS_BLOCKED",
    ],
    ["the requester is banned", { account: { banned: true } }, "REQUESTER_ACCESS_BLOCKED"],
    ["the token was revoked", { token: { revokedAt: new Date() } }, "CALLER_CONSENT_WITHDRAWN"],
    [
      "the token no longer allows external",
      { token: { allowExternal: false } },
      "CALLER_CONSENT_WITHDRAWN",
    ],
    [
      "the allowlist entry no longer includes external",
      { entry: { includeExternal: false } },
      "CALLER_CONSENT_WITHDRAWN",
    ],
  ] as const)(
    "refuses the send claim when %s, before any credential lock",
    async (_label, change, reason) => {
      const order: string[] = [];
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          order.push(`lock:${lockedTable(strings)}`);
          return [];
        }),
        ...consentTx(order, change),
        providerCredential: { findFirst: vi.fn(), update: vi.fn() },
      };
      db.$transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      );
      const keyring = parseProviderCredentialKeyring(
        `v1:${Buffer.alloc(32, 7).toString("base64")}`,
      );

      const claim = await withEgressEnabled(() =>
        claimPublicProviderCredentialForSend({
          userId: "owner",
          target: claimTarget(),
          keyring,
          consent: GRANTEE_TOKEN_CONSENT,
        }),
      );

      expect(claim).toEqual({ claimed: false, reason });
      expect(order.filter((step) => step.startsWith("lock:provider"))).toEqual([]);
      expect(tx.providerCredential.update).not.toHaveBeenCalled();
    },
  );

  // R1-B / R1-C: validity that lapses without a write to a locked row (time,
  // and the requester's account row, which the claim does not lock) is
  // re-evaluated after the provider account/credential lock waits, before
  // the durable claim.
  it.each([
    [
      "the token expired",
      (tx: ReturnType<typeof consentTx>) => {
        void tx;
        vi.setSystemTime(new Date(CLAIM_START.getTime() + 2_000));
      },
      "CALLER_CONSENT_WITHDRAWN",
    ],
    [
      "the requester's account was marked for deletion",
      (tx: ReturnType<typeof consentTx>) => {
        tx.user.findUnique.mockResolvedValue({
          banned: false,
          banExpires: null,
          deletionRequestedAt: new Date(),
        });
      },
      "REQUESTER_ACCESS_BLOCKED",
    ],
    [
      "the requester was banned",
      (tx: ReturnType<typeof consentTx>) => {
        tx.user.findUnique.mockResolvedValue({
          banned: true,
          banExpires: null,
          deletionRequestedAt: null,
        });
      },
      "REQUESTER_ACCESS_BLOCKED",
    ],
  ] as const)(
    "refuses the send claim when %s while it waited on the provider locks",
    async (_label, lapse, reason) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(CLAIM_START);
      try {
        const order: string[] = [];
        const consent = consentTx(order, {
          token: { expiresAt: new Date(CLAIM_START.getTime() + 1_000) },
        });
        const tx = {
          $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
            const table = lockedTable(strings);
            order.push(`lock:${table}`);
            // The change commits while the claim waits for the account lock.
            if (table === "provider_account FOR UPDATE") lapse(consent);
            return [];
          }),
          ...consent,
          providerCredential: { findFirst: vi.fn(), update: vi.fn() },
        };
        db.$transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) =>
          callback(tx),
        );
        const keyring = parseProviderCredentialKeyring(
          `v1:${Buffer.alloc(32, 7).toString("base64")}`,
        );

        const claim = await withEgressEnabled(() =>
          claimPublicProviderCredentialForSend({
            userId: "owner",
            target: claimTarget(),
            keyring,
            consent: GRANTEE_TOKEN_CONSENT,
          }),
        );

        expect(claim).toEqual({ claimed: false, reason });
        expect(order).toContain("lock:provider_credential FOR UPDATE");
        expect(tx.providerCredential.findFirst).not.toHaveBeenCalled();
        expect(tx.providerCredential.update).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("refuses the send claim with the deployment switch off without opening a transaction", async () => {
    db.$transaction.mockClear();
    const keyring = parseProviderCredentialKeyring(`v1:${Buffer.alloc(32, 7).toString("base64")}`);
    await expect(
      claimPublicProviderCredentialForSend({
        userId: "owner",
        target: claimTarget(),
        keyring,
        consent: GRANTEE_TOKEN_CONSENT,
      }),
    ).resolves.toEqual({ claimed: false, reason: "DEPLOYMENT_GATE_DISABLED" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("fails a send-start claim when revocation won the lifecycle lock", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      ...consentTx([]),
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
      withEgressEnabled(() =>
        claimPublicProviderCredentialForSend({
          userId: "owner",
          consent: GRANTEE_TOKEN_CONSENT,
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
      ),
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

  it("admits an adapted Anthropic stream from OpenAI only when the adaptation gates pass", () => {
    const target = {
      contextWindow: 1_000,
      maxOutputTokens: 100,
      protocol: "openai" as const,
      nativeProtocols: ["openai" as const],
      nativeSurfaces: ["openai-chat" as const],
      supportsStreaming: true,
      supportedFeatures: [],
    };
    const streamingAnthropic = {
      ...request,
      requestedProtocol: "anthropic" as const,
      requestedSurface: "anthropic-messages" as const,
      stream: true,
    };
    const renderForTarget = async () => {
      throw new Error("not invoked by prefilter");
    };
    expect(
      publicTargetCompatibility(target, {
        ...streamingAnthropic,
        adaptationEnabled: true,
        renderForTarget,
      }),
    ).toBe("COMPATIBLE");
    expect(
      publicTargetCompatibility(target, {
        ...streamingAnthropic,
        adaptationEnabled: false,
        renderForTarget,
      }),
    ).toBe("PROTOCOL_UNAVAILABLE");
    expect(
      publicTargetCompatibility(target, {
        ...streamingAnthropic,
        adaptationEnabled: true,
      }),
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

describe("engine cache confirmation evidence", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("confirms on every reported cache-hit wire shape", () => {
    // OpenAI Chat nonstream usage details.
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode(
          '{"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}}',
        ),
      ]),
    ).toBe(true);
    // OpenAI Responses terminal event nests usage under response.usage.
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode(
          '{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}}}',
        ),
      ]),
    ).toBe(true);
    // Anthropic reports the cache read directly on the usage object.
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode(
          'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n',
        ),
        encode('event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n'),
      ]),
    ).toBe(true);
  });

  it("resets on reported-zero cache reads", () => {
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode(
          '{"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":0}}}',
        ),
      ]),
    ).toBe(false);
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode(
          'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":0}}}\n\n',
        ),
      ]),
    ).toBe(false);
    // OpenAI Responses terminal event nests the zero under response.usage.
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode(
          '{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":0}}}}',
        ),
      ]),
    ).toBe(false);
  });

  it("leaves the flag untouched when the provider does not report cache usage", () => {
    // Usage is present but carries no cache fields on any known shape.
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode('{"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":3}}'),
      ]),
    ).toBeUndefined();
    expect(
      engineCacheConfirmedFromResponseChunks([
        encode('event: message_start\ndata: {"message":{"usage":{"input_tokens":12}}}\n\n'),
      ]),
    ).toBeUndefined();
    // Bodies without any usage object and absent usage entirely.
    expect(engineCacheConfirmedFromResponseChunks([encode('{"id":"chatcmpl-1"}')])).toBeUndefined();
    expect(engineCacheConfirmedFromResponseChunks([])).toBeUndefined();
    expect(engineCacheConfirmedFromUsage(undefined)).toBeUndefined();
    expect(engineCacheConfirmedFromUsage(parseProviderUsage([]))).toBeUndefined();
  });

  it("merges retained prefix evidence once the response exceeds the tail window", () => {
    const hitPrefix = [
      encode(
        'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n',
      ),
    ];
    const zeroPrefix = [
      encode(
        'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":0}}}\n\n',
      ),
    ];
    const tailWithoutCache = [
      encode('event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n'),
    ];
    const zeroTail = [
      encode(
        '{"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":0}}}',
      ),
    ];
    // Within the tail window the tail alone is authoritative and the prefix
    // is never consulted.
    expect(engineCacheConfirmedFromRetainedResponse(hitPrefix, tailWithoutCache, 32, 64)).toBe(
      undefined,
    );
    // Beyond the window the early message_start evidence survives via the
    // prefix for both polarities — this is what tail-only capture loses.
    expect(engineCacheConfirmedFromRetainedResponse(hitPrefix, tailWithoutCache, 128, 64)).toBe(
      true,
    );
    expect(engineCacheConfirmedFromRetainedResponse(zeroPrefix, tailWithoutCache, 128, 64)).toBe(
      false,
    );
    // Tail-defined categories still take precedence over the prefix.
    expect(engineCacheConfirmedFromRetainedResponse(hitPrefix, zeroTail, 128, 64)).toBe(false);
  });
});

const CLAIM_START = new Date("2026-09-26T12:00:00.000Z");

type AccountRow = { banned: boolean; banExpires: Date | null; deletionRequestedAt: Date | null };

/** A grantee's API-token request: every consent row kind is involved. */
const GRANTEE_TOKEN_CONSENT = {
  requesterUserId: "grantee",
  modelApiTokenId: "token",
  poolId: "pool",
  ownerUserId: "owner",
  accessGrantId: "grant",
};

function lockedTable(strings: TemplateStringsArray): string {
  const sql = strings.join("?").replace(/\s+/g, " ");
  const table = sql.match(/FROM (\w+)/)?.[1] ?? "?";
  const mode = sql.match(/FOR (SHARE|UPDATE|NO KEY UPDATE)/)?.[0] ?? "";
  return `${table} ${mode}`.trim();
}

async function withEgressEnabled<T>(work: () => Promise<T>): Promise<T> {
  const mutableEnv = env as { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: boolean };
  const previous = mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED;
  mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
  try {
    return await work();
  } finally {
    mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = previous;
  }
}

/** Consent rows as the send-claim transaction reads them, all granting by default. */
function consentTx(
  order: string[],
  change: {
    pool?: Record<string, unknown>;
    grant?: Record<string, unknown> | null;
    token?: Record<string, unknown>;
    entry?: Record<string, unknown>;
    account?: Record<string, unknown>;
  } = {},
) {
  const read = <T>(label: string, value: T) =>
    vi.fn(async () => {
      order.push(label);
      return value;
    });
  return {
    modelPool: {
      findFirst: read("read:pool", {
        fallbackEnabled: true,
        fallbackForGrantees: true,
        ...change.pool,
      }),
    },
    poolGrant: {
      findUnique: read(
        "read:consent",
        change.grant === null ? null : { id: "grant", ownerUserId: "owner", ...change.grant },
      ),
    },
    user: {
      findUnique: read<AccountRow>("read:account", {
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
        ...change.account,
      }),
    },
    modelApiToken: {
      findUnique: read("read:consent", {
        userId: "grantee",
        scopeMode: "ALLOWLIST",
        allowExternal: true,
        revokedAt: null,
        expiresAt: null,
        ...change.token,
      }),
    },
    modelApiTokenAllowlistEntry: {
      findUnique: read("read:consent", {
        target: "MODEL_POOL",
        includeExternal: true,
        ...change.entry,
      }),
    },
  };
}

function claimTarget() {
  return {
    poolMemberId: "member",
    executionTargetId: "target",
    publicOrder: 0,
    providerModelId: "model",
    upstreamModelId: "upstream",
    contextWindow: 1_000,
    maxOutputTokens: 100,
    protocol: "openai" as const,
    providerAccountId: "account",
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
      id: "credential",
      credentialType: "BEARER" as const,
      keyVersion: "v1",
      aadVersion: 1,
      algorithm: "AES-256-GCM" as const,
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
    },
  };
}

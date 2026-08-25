import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[provider-route] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

type Surface = "openai-chat" | "openai-responses" | "anthropic-messages";
type Behavior =
  | "json"
  | "stream"
  | "error"
  | "client-error"
  | "empty-error"
  | "overload-error"
  | "crash";

const protocolFor = (surface: Surface) =>
  surface === "anthropic-messages" ? "anthropic" : "openai";

const pathFor = (surface: Surface) =>
  surface === "openai-chat"
    ? "/chat/completions"
    : surface === "openai-responses"
      ? "/responses"
      : "/messages";

function jsonResponse(surface: Surface) {
  if (surface === "anthropic-messages")
    return {
      id: "msg_route",
      type: "message",
      role: "assistant",
      model: "upstream-model",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
  if (surface === "openai-responses")
    return {
      id: "resp_route",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "upstream-model",
      output: [
        {
          id: "item_route",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
  return {
    id: "chat_route",
    object: "chat.completion",
    created: 1,
    model: "upstream-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

integration("provider dispatch routes with real PostgreSQL", () => {
  const db = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  let upstream: ReturnType<typeof createServer> | undefined;
  let origin = "";
  const upstreamObservations: Array<{
    path: string;
    method?: string;
    authorization?: string;
    body: string;
  }> = [];
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        security: typeof import("@ws-model-proxy/db/forwarder-security");
        routes: typeof import("./routes.js");
        chatTest: typeof import("./chat-test.js");
        identifiers: typeof import("@ws-model-proxy/config/forwarder-identifiers");
        credentials: typeof import("@ws-model-proxy/api/lib/provider-credential-crypto");
        protocols: typeof import("./protocols/index.js");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    process.env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = "true";
    process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = `route-v1:${Buffer.alloc(32, 19).toString("base64")}`;
    process.env.MODEL_API_ANTHROPIC_ENABLED = "true";
    process.env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = "true";
    process.env.MODEL_API_GLOBAL_CAPACITY_ENABLED = "false";
    const [prismaModule, security, routes, chatTest, identifiers, credentials, protocols] =
      await Promise.all([
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/forwarder-security"),
        import("./routes.js"),
        import("./chat-test.js"),
        import("@ws-model-proxy/config/forwarder-identifiers"),
        import("@ws-model-proxy/api/lib/provider-credential-crypto"),
        import("./protocols/index.js"),
      ]);
    modules = {
      prisma: prismaModule.default,
      security,
      routes,
      chatTest,
      identifiers,
      credentials,
      protocols,
    };
    const streamResponse = (surface: Surface) => {
      const renderer = new protocols.CanonicalStreamRenderer(surface);
      const events: import("./protocols/index.js").CanonicalEvent[] = [
        {
          type: "message_start",
          id: "route-message",
          model: "upstream-model",
          ...(surface === "anthropic-messages"
            ? { usage: { inputTokens: 5, outputTokens: 0 } }
            : {}),
        },
        { type: "item_start", index: 0, id: "route-text", itemType: "text" },
        { type: "text_delta", index: 0, delta: "ok" },
        { type: "item_complete", index: 0 },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
        { type: "stop", reason: "stop" },
        { type: "complete" },
      ];
      const chunks = events.flatMap((event) => renderer.push(event));
      renderer.finish();
      return chunks;
    };
    upstream = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const body = await readBody(request);
      upstreamObservations.push({
        path: request.url ?? "",
        method: request.method,
        authorization: request.headers.authorization,
        body,
      });
      const segments = (request.url ?? "").split("/").filter(Boolean);
      const behavior = segments[0] as Behavior;
      const surface: Surface = request.url?.includes("/responses")
        ? "openai-responses"
        : request.url?.includes("/messages")
          ? "anthropic-messages"
          : "openai-chat";
      if (behavior === "empty-error") {
        response.writeHead(429, {
          "retry-after": "1s",
          "x-request-id": "secret https://10.0.0.8/private",
          "x-ratelimit-limit-requests": "1.5",
          "x-internal-secret": "must-not-pass",
        });
        response.end();
        return;
      }
      if (behavior === "overload-error") {
        response.writeHead(529, {
          "content-type": "application/json",
          "retry-after": "Tue, 25 Aug 2026 12:00:00 GMT",
          ...(surface === "anthropic-messages"
            ? { "request-id": "overload-request-529" }
            : { "x-request-id": "overload-request-529" }),
          "x-internal-secret": "must-not-pass",
        });
        response.end(
          JSON.stringify({
            error: {
              message: "route-provider-secret at http://10.0.0.8/private",
              nested: { tenant: "tenant-other" },
            },
            provider_debug: { credential: "route-provider-secret" },
          }),
        );
        return;
      }
      if (behavior === "error") {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after": "1",
          "request-id": "upstream-request-123",
          "x-internal-secret": "must-not-pass",
        });
        response.end(JSON.stringify({ error: { message: "temporary", type: "server_error" } }));
        return;
      }
      if (behavior === "client-error") {
        const requestIdHeader =
          surface === "anthropic-messages"
            ? {
                "request-id": "upstream-request-400",
                "x-request-id": "route-provider-secret http://10.0.0.8/private",
              }
            : {
                "x-request-id": "upstream-request-400",
                "request-id": "route-provider-secret http://10.0.0.8/private",
              };
        const rateHeaders =
          surface === "anthropic-messages"
            ? {
                "anthropic-ratelimit-requests-limit": "100",
                "anthropic-ratelimit-requests-remaining": "99",
                "anthropic-ratelimit-requests-reset": "2026-08-25T12:00:00Z",
                "anthropic-ratelimit-tokens-limit": "1000",
                "anthropic-ratelimit-tokens-remaining": "900",
                "anthropic-ratelimit-tokens-reset": "2026-08-25T12:01:00Z",
              }
            : {
                "x-ratelimit-limit-requests": "100",
                "x-ratelimit-remaining-requests": "99",
                "x-ratelimit-reset-requests": "1s",
                "x-ratelimit-limit-tokens": "1000",
                "x-ratelimit-remaining-tokens": "900",
                "x-ratelimit-reset-tokens": "2s",
              };
        response.writeHead(400, {
          "content-type": "application/json",
          "retry-after": "2",
          ...requestIdHeader,
          ...rateHeaders,
          "x-internal-secret": "must-not-pass",
        });
        response.end(
          JSON.stringify(
            surface === "anthropic-messages"
              ? {
                  type: "error",
                  error: {
                    type: "tenant-internal-secret-code",
                    message:
                      "credential route-provider-secret at http://10.0.0.8/private tenant tenant-other",
                  },
                }
              : {
                  error: {
                    type: "provider_internal_type",
                    code: "tenant-internal-secret-code",
                    param: "tenant-other.private_field",
                    message:
                      "credential route-provider-secret at http://10.0.0.8/private tenant tenant-other",
                  },
                },
          ),
        );
        return;
      }
      if (behavior === "crash") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamResponse(surface)[0]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        response.socket?.destroy();
        return;
      }
      if (behavior === "stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of streamResponse(surface)) response.write(chunk);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(jsonResponse(surface)));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("mock upstream did not listen");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
    await modules?.prisma.$disconnect();
    await db?.$disconnect();
  });

  async function waitForLedger(providerModelId: string) {
    if (!modules) throw new Error("modules unavailable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const ledger = await modules.prisma.providerUsageLedger.findFirst({
        where: { providerModelId },
        orderBy: { createdAt: "desc" },
      });
      if (ledger) return ledger;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for provider usage ledger");
  }

  async function waitForTerminalAttempt(providerModelId: string) {
    if (!modules) throw new Error("modules unavailable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const attempt = await modules.prisma.providerAttempt.findFirst({
        where: { providerModelId, state: { not: "ACTIVE" } },
        orderBy: { createdAt: "desc" },
      });
      if (attempt) return attempt;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for terminal provider attempt");
  }

  async function waitForTerminalEvent(providerModelId: string) {
    if (!modules) throw new Error("modules unavailable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const event = await modules.prisma.publicProviderAttemptEvent.findFirst({
        where: { providerModelId, eventType: "TERMINAL" },
      });
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for provider terminal event");
  }

  async function runCase(input: {
    requested: Surface;
    native: Surface;
    behavior: Behavior;
    expectRejected?: boolean;
    secondBehavior?: Behavior;
    statefulResponses?: boolean;
    grantee?: boolean;
    cookieAuth?: boolean;
    forceProviderMember?: boolean;
    memberTier?: "PRIMARY" | "PUBLIC_OVERFLOW";
    privatePool?: boolean;
    routingMode?: "PREFER_NATIVE" | "REQUIRE_NATIVE" | "REQUIRE_ADAPTED";
    multiSurfaceStreamingFallback?: boolean;
  }) {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const rawToken = `wsmp_model_${crypto.randomUUID().replaceAll("-", "")}`;
    const user = await modules.prisma.user.create({
      data: {
        name: "Provider route proof",
        email: `provider-route-${suffix}@example.test`,
        slug: `provider-route-${suffix}`,
      },
    });
    const requester = input.grantee
      ? await modules.prisma.user.create({
          data: {
            name: "Provider route grantee",
            email: `provider-route-grantee-${suffix}@example.test`,
            slug: `provider-route-grantee-${suffix}`,
          },
        })
      : user;
    const pool = await modules.prisma.modelPool.create({
      data: {
        userId: user.id,
        slug: `pool-${suffix}`,
        name: "Provider route pool",
        protocolAdaptationEnabled: true,
        publicEgressEnabled: !input.privatePool,
        publicEgressAcknowledged: !input.privatePool,
      },
    });
    expect(pool).toMatchObject({
      publicEgressEnabled: !input.privatePool,
      publicEgressAcknowledged: !input.privatePool,
    });
    const grant = input.grantee
      ? await modules.prisma.poolGrant.create({
          data: { poolId: pool.id, ownerUserId: user.id, granteeUserId: requester.id },
        })
      : undefined;
    const accountId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const keyring = modules.credentials.parseProviderCredentialKeyring(
      process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS!,
    );
    const encrypted = modules.credentials.encryptProviderCredential(
      "route-provider-secret",
      {
        userId: user.id,
        providerAccountId: accountId,
        credentialId,
        credentialType: "BEARER",
        aadVersion: 1,
      },
      keyring,
    );
    const account = await modules.prisma.providerAccount.create({
      data: {
        id: accountId,
        userId: user.id,
        providerType: protocolFor(input.native),
        label: `account-${suffix}`,
        baseUrl: `${origin}/${input.behavior}`,
        endpointIdentity: `${origin}/${input.behavior}`,
        authType: "BEARER",
        status: "ACTIVE",
        enabled: false,
        healthStatus: "HEALTHY",
      },
    });
    await modules.prisma.$transaction(async (transaction) => {
      await transaction.providerCredential.create({
        data: {
          id: credentialId,
          userId: user.id,
          providerAccountId: accountId,
          credentialType: "BEARER",
          ...encrypted,
        },
      });
      await transaction.providerAccount.update({
        where: { id: accountId },
        data: { currentCredentialId: credentialId, enabled: true },
      });
    });
    const model = await modules.prisma.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: "upstream-model",
        enabled: true,
        healthStatus: "HEALTHY",
        contextWindow: 8_192,
        maxOutputTokens: 256,
        nativeCapabilities: input.multiSurfaceStreamingFallback
          ? {
              version: 4,
              protocol: "openai-compatible",
              surfaces: {
                openaiChatCompletions: {
                  source: "provider",
                  confidence: "exact",
                  operations: ["create"],
                  streaming: false,
                },
                openaiResponses: {
                  source: "provider",
                  confidence: "exact",
                  operations: ["create"],
                  streaming: true,
                },
              },
            }
          : {
              protocols: [protocolFor(input.native)],
              surfaces: [input.native],
              streaming: true,
              features: [],
            },
      },
    });
    const target = await modules.prisma.executionTarget.create({
      data: { userId: user.id, kind: "PROVIDER_MODEL", providerModelId: model.id },
    });
    const primaryMember = await modules.prisma.poolMember.create({
      data: {
        poolId: pool.id,
        executionTargetId: target.id,
        tier: input.memberTier ?? "PUBLIC_OVERFLOW",
        publicOrder: (input.memberTier ?? "PUBLIC_OVERFLOW") === "PUBLIC_OVERFLOW" ? 0 : null,
        weight:
          (input.memberTier ?? "PUBLIC_OVERFLOW") === "PRIMARY"
            ? input.secondBehavior
              ? 2
              : 1
            : 0,
      },
    });
    await modules.prisma.providerPricingVersion.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: model.id,
        version: "route-v1",
        currency: "USD",
        status: "ACTIVE",
        accountingVersion: "provider-billable-v1",
        confidence: "CALCULATED",
        effectiveAt: new Date(Date.now() - 60_000),
        activatedAt: new Date(Date.now() - 60_000),
        pricing: { ratesPerMillion: { input: "1", output: "2", additional: "2" } },
        chargeRules: {
          inputIncludesCacheRead: false,
          inputIncludesCacheWrite: false,
          outputIncludesReasoning: false,
          outputIncludesTool: false,
          cacheReadAllowanceTokens: 0,
          cacheWriteAllowanceTokens: 0,
          reasoningAllowanceTokens: 0,
          toolAllowanceTokens: 0,
          additionalAllowanceTokens: 0,
          unknownCategories: "FAIL_CLOSED",
        },
      },
    });
    await modules.prisma.providerBudgetPolicy.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: model.id,
        poolId: pool.id,
        scopeType: "POOL_PROVIDER_MODEL",
        active: true,
        activatedAt: new Date(Date.now() - 60_000),
        Rules: {
          create: [
            { metric: "CONCURRENCY", period: "PER_ATTEMPT", mode: "UNLIMITED" },
            { metric: "TOKENS", period: "UTC_DAY", mode: "LIMITED", limitValue: 100_000 },
            {
              metric: "SPEND",
              period: "UTC_DAY",
              mode: "LIMITED",
              limitValue: "10",
              currency: "USD",
            },
          ],
        },
      },
    });
    let secondModel: typeof model | undefined;
    if (input.secondBehavior) {
      const secondAccountId = crypto.randomUUID();
      const secondAccount = await modules.prisma.providerAccount.create({
        data: {
          id: secondAccountId,
          userId: user.id,
          providerType: protocolFor(input.native),
          label: `account-second-${suffix}`,
          baseUrl: `${origin}/${input.secondBehavior}`,
          endpointIdentity: `${origin}/${input.secondBehavior}`,
          authType: "BEARER",
          status: "ACTIVE",
          enabled: false,
          healthStatus: "HEALTHY",
        },
      });
      const secondCredentialId = crypto.randomUUID();
      const secondEncrypted = modules.credentials.encryptProviderCredential(
        "route-provider-secret-second",
        {
          userId: user.id,
          providerAccountId: secondAccount.id,
          credentialId: secondCredentialId,
          credentialType: "BEARER",
          aadVersion: 1,
        },
        keyring,
      );
      await modules.prisma.$transaction(async (transaction) => {
        await transaction.providerCredential.create({
          data: {
            id: secondCredentialId,
            userId: user.id,
            providerAccountId: secondAccount.id,
            credentialType: "BEARER",
            ...secondEncrypted,
          },
        });
        await transaction.providerAccount.update({
          where: { id: secondAccount.id },
          data: { currentCredentialId: secondCredentialId, enabled: true },
        });
      });
      secondModel = await modules.prisma.providerModel.create({
        data: {
          userId: user.id,
          providerAccountId: secondAccount.id,
          upstreamModelId: "upstream-model-second",
          enabled: true,
          healthStatus: "HEALTHY",
          contextWindow: 8_192,
          maxOutputTokens: 256,
          nativeCapabilities: {
            protocols: [protocolFor(input.native)],
            surfaces: [input.native],
            streaming: true,
            features: [],
          },
        },
      });
      const secondTarget = await modules.prisma.executionTarget.create({
        data: { userId: user.id, kind: "PROVIDER_MODEL", providerModelId: secondModel.id },
      });
      const secondTier = input.memberTier ?? "PUBLIC_OVERFLOW";
      await modules.prisma.poolMember.create({
        data: {
          poolId: pool.id,
          executionTargetId: secondTarget.id,
          tier: secondTier,
          publicOrder: secondTier === "PUBLIC_OVERFLOW" ? 1 : null,
          // The first model's higher weight makes the initial selection
          // deterministic while this member remains a routable failover.
          weight: secondTier === "PRIMARY" ? 1 : 0,
        },
      });
      await modules.prisma.providerPricingVersion.create({
        data: {
          userId: user.id,
          providerAccountId: secondAccount.id,
          providerModelId: secondModel.id,
          version: "route-v1",
          currency: "USD",
          status: "ACTIVE",
          accountingVersion: "provider-billable-v1",
          confidence: "CALCULATED",
          effectiveAt: new Date(Date.now() - 60_000),
          activatedAt: new Date(Date.now() - 60_000),
          pricing: { ratesPerMillion: { input: "1", output: "2", additional: "2" } },
          chargeRules: {
            inputIncludesCacheRead: false,
            inputIncludesCacheWrite: false,
            outputIncludesReasoning: false,
            outputIncludesTool: false,
            cacheReadAllowanceTokens: 0,
            cacheWriteAllowanceTokens: 0,
            reasoningAllowanceTokens: 0,
            toolAllowanceTokens: 0,
            additionalAllowanceTokens: 0,
            unknownCategories: "FAIL_CLOSED",
          },
        },
      });
      await modules.prisma.providerBudgetPolicy.create({
        data: {
          userId: user.id,
          providerAccountId: secondAccount.id,
          providerModelId: secondModel.id,
          poolId: pool.id,
          scopeType: "POOL_PROVIDER_MODEL",
          active: true,
          activatedAt: new Date(Date.now() - 60_000),
          Rules: {
            create: [
              { metric: "CONCURRENCY", period: "PER_ATTEMPT", mode: "UNLIMITED" },
              { metric: "TOKENS", period: "UTC_DAY", mode: "LIMITED", limitValue: 100_000 },
              {
                metric: "SPEND",
                period: "UTC_DAY",
                mode: "LIMITED",
                limitValue: "10",
                currency: "USD",
              },
            ],
          },
        },
      });
    }
    await modules.prisma.modelApiToken.create({
      data: {
        userId: requester.id,
        name: "Provider route token",
        lookupPrefix: modules.security.credentialLookupPrefix(rawToken),
        secretDigest: modules.security.hmacDigestForForwarderPurpose({
          purpose: "modelApiToken",
          value: rawToken,
        }),
      },
    });
    const manager = {
      getActiveCliDeviceIds: () => [],
      registerRelayResponseHandlers: () => undefined,
      sendRelayRequest: () => undefined,
      cancelRelayRequest: () => undefined,
      completeRelayRequest: () => undefined,
    };
    const app = input.cookieAuth
      ? (() => {
          const cookieApp = new Hono<{
            Variables: { session: import("@ws-model-proxy/auth").Session | null };
          }>();
          cookieApp.use("*", async (context, next) => {
            context.set("session", {
              user: requester,
              session: {
                id: `session-${suffix}`,
                userId: requester.id,
                token: `cookie-${suffix}`,
                expiresAt: new Date(Date.now() + 60_000),
                ipAddress: "127.0.0.1",
                userAgent: "provider-route-integration",
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            } as import("@ws-model-proxy/auth").Session);
            await next();
          });
          cookieApp.route(
            "/",
            modules.chatTest.createChatTestRoutes({
              manager,
            }),
          );
          return cookieApp;
        })()
      : modules.routes.createModelApiRoutes({
          manager,
          anthropicEnabled: true,
          protocolAdaptationEnabled: true,
          capacityEnabled: false,
        });
    const modelId = modules.identifiers.poolModelId({
      userSlug: user.slug,
      poolSlug: pool.slug,
    });
    const stream = input.behavior === "stream" || input.behavior === "crash";
    const body =
      input.requested === "openai-chat"
        ? { model: modelId, stream, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
        : input.requested === "openai-responses"
          ? {
              model: modelId,
              stream,
              store: input.statefulResponses === true,
              max_output_tokens: 16,
              input: "hi",
            }
          : {
              model: modelId,
              stream,
              max_tokens: 16,
              messages: [{ role: "user", content: "hi" }],
            };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (input.cookieAuth) headers.cookie = `better-auth.session_token=cookie-${suffix}`;
    else headers.authorization = `Bearer ${rawToken}`;
    if (input.forceProviderMember) headers["x-wsmp-chat-test-member-id"] = primaryMember.id;
    if (input.routingMode) headers["x-wsmp-chat-test-routing-mode"] = input.routingMode;
    if (input.requested === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
    const observationIndex = upstreamObservations.length;
    const response = await app.request(pathFor(input.requested), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const responseText = await response.text().catch(() => "");
    if (input.expectRejected) {
      return {
        rejected: true as const,
        response,
        responseText,
        attemptCount: await modules.prisma.providerAttempt.count({
          where: { providerModelId: model.id },
        }),
        observation: upstreamObservations[observationIndex],
        ledger: undefined as never,
        attempt: undefined as never,
        reservations: [] as never[],
        settlements: [] as never[],
        attemptEvents: [] as never[],
        model,
        secondModel,
        user,
        requester,
        pool,
        account,
        target,
        grant,
        credentialId,
        rawToken,
        app,
        modelId,
      };
    }
    const ledger = await waitForLedger(model.id);
    const attempt = await waitForTerminalAttempt(model.id);
    await waitForTerminalEvent(model.id);
    const [reservations, settlements, attemptEvents] = await Promise.all([
      modules.prisma.providerBudgetReservation.findMany({
        where: { providerModelId: model.id },
        include: { Rule: true },
      }),
      modules.prisma.providerBudgetSettlement.findMany({ where: { providerModelId: model.id } }),
      modules.prisma.publicProviderAttemptEvent.findMany({
        where: { providerModelId: model.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      rejected: false as const,
      response,
      ledger,
      attempt,
      reservations,
      settlements,
      model,
      secondModel,
      responseText,
      attemptEvents,
      observation: upstreamObservations[observationIndex],
      user,
      requester,
      pool,
      account,
      target,
      grant,
      credentialId,
      rawToken,
      app,
      modelId,
    };
  }

  function expectEgressContract(result: Awaited<ReturnType<typeof runCase>>, native: Surface) {
    expect(result.observation).toBeDefined();
    expect(result.observation?.path).toContain(`/v1${pathFor(native)}`);
    expect(result.observation?.authorization).toBe("Bearer route-provider-secret");
    expect(JSON.parse(result.observation?.body ?? "{}")).toMatchObject({
      model: "upstream-model",
    });
  }

  function expectExactSuccessAccounting(result: Awaited<ReturnType<typeof runCase>>) {
    expect(result.ledger.billableTotal).toBe(7n);
    expect(result.ledger.settledCost?.toString()).toBe("0.000009");
    for (const reservation of result.reservations) {
      const settlement = result.settlements.find((row) => row.reservationId === reservation.id);
      expect(settlement).toBeDefined();
      expect(settlement?.settledValue.toString()).toBe(
        reservation.Rule.metric === "TOKENS" ? "7" : "0.000009",
      );
    }
  }

  function expectAdapterTelemetry(
    result: Awaited<ReturnType<typeof runCase>>,
    mode: "native" | "adapted",
    requested: Surface,
    native: Surface,
  ) {
    const terminals = result.attemptEvents.filter((event) => event.eventType === "TERMINAL");
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    expect(terminal).toMatchObject({
      requestedSurface: requested,
      nativeSurface: native,
      adapterMode: mode,
      adapterVersion: mode === "adapted" ? "1.0.0" : null,
    });
    for (const event of result.attemptEvents) {
      expect(event).toMatchObject({
        requestedSurface: requested,
        nativeSurface: native,
        adapterMode: mode,
        adapterVersion: mode === "adapted" ? "1.0.0" : null,
      });
    }
  }

  function expectJsonEnvelope(result: Awaited<ReturnType<typeof runCase>>, requested: Surface) {
    const payload = JSON.parse(result.responseText);
    if (requested === "openai-chat") {
      expect(payload).toMatchObject({
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    } else if (requested === "openai-responses") {
      expect(payload).toMatchObject({
        object: "response",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      });
    } else {
      expect(payload).toMatchObject({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      });
    }
  }

  function expectStreamEnvelope(result: Awaited<ReturnType<typeof runCase>>, requested: Surface) {
    if (requested === "openai-chat") {
      expect(result.responseText).toContain('"object":"chat.completion.chunk"');
      expect(result.responseText).toContain('"content":"ok"');
      expect(result.responseText).toContain("data: [DONE]");
      expect(result.responseText).toContain(
        '"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}',
      );
    } else if (requested === "openai-responses") {
      expect(result.responseText).toContain("event: response.created");
      expect(result.responseText).toContain('"type":"response.output_text.delta"');
      expect(result.responseText).toContain('"delta":"ok"');
      expect(result.responseText).toContain("event: response.completed");
      expect(result.responseText).toContain(
        '"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}',
      );
    } else {
      expect(result.responseText).toContain("event: message_start");
      expect(result.responseText).toContain('"type":"text_delta","text":"ok"');
      expect(result.responseText).toContain("event: message_stop");
    }
  }

  function expectConservativeAccounting(result: Awaited<ReturnType<typeof runCase>>) {
    for (const reservation of result.reservations) {
      const settlement = result.settlements.find((row) => row.reservationId === reservation.id);
      expect(settlement?.settledValue.equals(reservation.reservedValue)).toBe(true);
    }
  }

  const bearerHeaders = (token: string, json = false) => ({
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  });

  it("persists an exact grantee binding and pins every Responses lifecycle operation", async () => {
    if (!modules) throw new Error("modules unavailable");
    const result = await runCase({
      requested: "openai-responses",
      native: "openai-responses",
      behavior: "json",
      statefulResponses: true,
      grantee: true,
      secondBehavior: "json",
      memberTier: "PRIMARY",
      privatePool: true,
    });
    if (!result.grant) throw new Error("expected exact pool grant");
    expect(result.response.status).toBe(200);
    const binding = await modules.prisma.responseStickinessRecord.findFirstOrThrow({
      where: { userId: result.requester.id, providerModelId: result.model.id },
    });
    expect(binding).toMatchObject({
      routingVersion: 3,
      modelApiTokenId: expect.any(String),
      targetModelPoolId: result.pool.id,
      selectedExecutionTargetId: result.target.id,
      providerAccountId: result.account.id,
      providerModelId: result.model.id,
      providerEndpointIdentity: result.account.endpointIdentity,
      providerEndpointVersion: result.account.endpointVersion,
      providerUpstreamModelId: result.model.upstreamModelId,
      nativeSurface: "OPENAI_RESPONSES",
      poolGrantId: result.grant.id,
    });
    expect(result.attemptEvents.every((event) => event.memberTier === "PRIMARY")).toBe(true);
    const observationStart = upstreamObservations.length;
    const followUp = await result.app.request("/responses", {
      method: "POST",
      headers: bearerHeaders(result.rawToken, true),
      body: JSON.stringify({
        model: result.modelId,
        previous_response_id: "resp_route",
        input: "follow-up",
        store: true,
        max_output_tokens: 16,
      }),
    });
    expect(followUp.status).toBe(200);
    await followUp.text();
    const retrieve = await result.app.request("/responses/resp_route?include[]=output", {
      headers: bearerHeaders(result.rawToken),
    });
    expect(retrieve.status).toBe(200);
    await retrieve.text();

    const keyring = modules.credentials.parseProviderCredentialKeyring(
      process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS!,
    );
    const rotated = modules.credentials.encryptProviderCredential(
      "route-provider-secret-rotated",
      {
        userId: result.user.id,
        providerAccountId: result.account.id,
        credentialId: result.credentialId,
        credentialType: "BEARER",
        aadVersion: 1,
      },
      keyring,
    );
    await modules.prisma.providerCredential.update({
      where: { id: result.credentialId },
      data: rotated,
    });
    const lifecycle = [
      ["POST", "/responses/resp_route/cancel"],
      ["GET", "/responses/resp_route/input_items"],
      ["POST", "/responses/resp_route/compact"],
      ["DELETE", "/responses/resp_route"],
    ] as const;
    for (const [method, path] of lifecycle) {
      const response = await result.app.request(path, {
        method,
        headers: bearerHeaders(result.rawToken),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const pinned = upstreamObservations.slice(observationStart);
    expect(pinned.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/json/v1/responses"],
      ["GET", "/json/v1/responses/resp_route?include[]=output"],
      ["POST", "/json/v1/responses/resp_route/cancel"],
      ["GET", "/json/v1/responses/resp_route/input_items"],
      ["POST", "/json/v1/responses/resp_route/compact"],
      ["DELETE", "/json/v1/responses/resp_route"],
    ]);
    expect(
      pinned
        .slice(2)
        .every(({ authorization }) => authorization === "Bearer route-provider-secret-rotated"),
    ).toBe(true);
    expect(
      pinned.every(({ authorization }) => authorization !== "Bearer route-provider-secret-second"),
    ).toBe(true);
    if (!result.secondModel) throw new Error("expected competing provider model");
    expect(
      await modules.prisma.providerAttempt.count({
        where: { providerModelId: result.secondModel.id },
      }),
    ).toBe(0);

    const strangerSecret = `wsmp_model_${crypto.randomUUID().replaceAll("-", "")}`;
    const stranger = await modules.prisma.user.create({
      data: {
        name: "Provider route stranger",
        email: `provider-route-stranger-${crypto.randomUUID()}@example.test`,
        slug: `provider-route-stranger-${crypto.randomUUID()}`,
      },
    });
    await modules.prisma.modelApiToken.create({
      data: {
        userId: stranger.id,
        name: "Stranger token",
        lookupPrefix: modules.security.credentialLookupPrefix(strangerSecret),
        secretDigest: modules.security.hmacDigestForForwarderPurpose({
          purpose: "modelApiToken",
          value: strangerSecret,
        }),
      },
    });
    const guessed = await result.app.request("/responses/resp_route", {
      headers: bearerHeaders(strangerSecret),
    });
    expect(guessed.status).toBe(404);

    await modules.prisma.poolGrant.delete({ where: { id: result.grant.id } });
    expect(await modules.prisma.responseStickinessRecord.count({ where: { id: binding.id } })).toBe(
      0,
    );
    await modules.prisma.poolGrant.create({
      data: {
        poolId: result.pool.id,
        ownerUserId: result.user.id,
        granteeUserId: result.requester.id,
      },
    });
    const afterReplacement = await result.app.request("/responses/resp_route", {
      headers: bearerHeaders(result.rawToken),
    });
    expect(afterReplacement.status).toBe(404);
  }, 15_000);

  it.each([
    "expiry",
    "endpoint",
    "member",
    "target",
    "model",
    "account",
    "credential",
    "token",
  ] as const)("fails closed after bound provider %s invalidation", async (invalidation) => {
    if (!modules) throw new Error("modules unavailable");
    const result = await runCase({
      requested: "openai-responses",
      native: "openai-responses",
      behavior: "json",
      statefulResponses: true,
    });
    const binding = await modules.prisma.responseStickinessRecord.findFirstOrThrow({
      where: { userId: result.user.id, providerModelId: result.model.id },
    });
    if (invalidation === "expiry")
      await modules.prisma.responseStickinessRecord.update({
        where: { id: binding.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
    else if (invalidation === "endpoint")
      await modules.prisma.providerAccount.update({
        where: { id: result.account.id },
        data: {
          baseUrl: `${origin}/replacement`,
          endpointIdentity: `${origin}/replacement`,
          endpointVersion: { increment: 1 },
        },
      });
    else if (invalidation === "member")
      await modules.prisma.poolMember.deleteMany({
        where: { poolId: result.pool.id, executionTargetId: result.target.id },
      });
    else if (invalidation === "target")
      await modules.prisma.executionTarget.delete({ where: { id: result.target.id } });
    else if (invalidation === "model")
      await modules.prisma.providerModel.update({
        where: { id: result.model.id },
        data: { deletedAt: new Date(), enabled: false },
      });
    else if (invalidation === "account")
      await modules.prisma.providerAccount.update({
        where: { id: result.account.id },
        data: { deletedAt: new Date(), enabled: false },
      });
    else if (invalidation === "credential")
      await modules.prisma.$transaction(async (tx) => {
        await tx.providerAccount.update({
          where: { id: result.account.id },
          data: { currentCredentialId: null, enabled: false },
        });
        await tx.providerCredential.update({
          where: { id: result.credentialId },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
      });
    else
      await modules.prisma.modelApiToken.updateMany({
        where: { userId: result.user.id, name: "Provider route token" },
        data: { revokedAt: new Date() },
      });
    const observationCount = upstreamObservations.length;
    const response = await result.app.request("/responses/resp_route", {
      headers: bearerHeaders(result.rawToken),
    });
    expect(response.status).toBe(invalidation === "token" ? 401 : 404);
    expect(upstreamObservations).toHaveLength(observationCount);
  });

  const requestedSurfaces: Surface[] = ["openai-chat", "openai-responses", "anthropic-messages"];
  const crossPairs = requestedSurfaces.flatMap((requested) =>
    requestedSurfaces
      .filter((native) => native !== requested)
      .map((native) => ({ requested, native })),
  );
  const adaptedNative: Record<Surface, Surface> = {
    "openai-chat": "openai-responses",
    "openai-responses": "anthropic-messages",
    "anthropic-messages": "openai-chat",
  };

  for (const requested of requestedSurfaces) {
    it(`${requested} executes native non-stream pricing through durable settlement`, async () => {
      const result = await runCase({ requested, native: requested, behavior: "json" });
      expect(result.response.status).toBe(200);
      expect(result.ledger).toMatchObject({
        inputTokens: 5n,
        outputTokens: 2n,
        categoriesComplete: true,
        usageKnown: true,
        costKnown: true,
        pricingVersion: "route-v1",
      });
      expect(result.attempt.state).toBe("COMPLETED");
      expect(result.reservations).toHaveLength(2);
      expect(result.settlements).toHaveLength(2);
      expectEgressContract(result, requested);
      expectExactSuccessAccounting(result);
      expectJsonEnvelope(result, requested);
      expectAdapterTelemetry(result, "native", requested, requested);
    });

    it(`${requested} executes native streaming through terminal reconciliation`, async () => {
      const result = await runCase({ requested, native: requested, behavior: "stream" });
      expect(result.response.status).toBe(200);
      expect(result.ledger).toMatchObject({ categoriesComplete: true, usageKnown: true });
      expect(result.attempt.state).toBe("COMPLETED");
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectEgressContract(result, requested);
      expectExactSuccessAccounting(result);
      expectStreamEnvelope(result, requested);
      expectAdapterTelemetry(result, "native", requested, requested);
    });
  }

  for (const requested of requestedSurfaces) {
    it(`${requested} executes provider PRIMARY native JSON in a private pool`, async () => {
      const result = await runCase({
        requested,
        native: requested,
        behavior: "json",
        memberTier: "PRIMARY",
        privatePool: true,
      });
      expect(result.response.status).toBe(200);
      expect(result.pool).toMatchObject({
        publicEgressEnabled: false,
        publicEgressAcknowledged: false,
      });
      expect(result.attemptEvents).not.toHaveLength(0);
      expect(result.attemptEvents.every((event) => event.memberTier === "PRIMARY")).toBe(true);
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectExactSuccessAccounting(result);
      expectJsonEnvelope(result, requested);
      expectAdapterTelemetry(result, "native", requested, requested);
    });

    it(`${requested} executes provider PRIMARY native SSE in a private pool`, async () => {
      const result = await runCase({
        requested,
        native: requested,
        behavior: "stream",
        memberTier: "PRIMARY",
        privatePool: true,
      });
      expect(result.response.status).toBe(200);
      expect(result.attempt.state).toBe("COMPLETED");
      expect(result.attemptEvents.every((event) => event.memberTier === "PRIMARY")).toBe(true);
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectExactSuccessAccounting(result);
      expectStreamEnvelope(result, requested);
      expectAdapterTelemetry(result, "native", requested, requested);
    });
  }

  it.each(crossPairs)(
    "$requested executes provider PRIMARY adapted JSON from $native in a private pool",
    async ({ requested, native }) => {
      const result = await runCase({
        requested,
        native,
        behavior: "json",
        memberTier: "PRIMARY",
        privatePool: true,
      });
      expect(result.response.status).toBe(200);
      expect(result.attemptEvents.every((event) => event.memberTier === "PRIMARY")).toBe(true);
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectExactSuccessAccounting(result);
      expectJsonEnvelope(result, requested);
      expectAdapterTelemetry(result, "adapted", requested, native);
    },
  );

  it.each([
    ["openai-chat", "openai-responses"],
    ["openai-chat", "anthropic-messages"],
    ["openai-responses", "openai-chat"],
    ["openai-responses", "anthropic-messages"],
  ] as const)(
    "%s executes provider PRIMARY adapted SSE from %s in a private pool",
    async (requested, native) => {
      const result = await runCase({
        requested,
        native,
        behavior: "stream",
        memberTier: "PRIMARY",
        privatePool: true,
      });
      expect(result.response.status).toBe(200);
      expect(result.attemptEvents.every((event) => event.memberTier === "PRIMARY")).toBe(true);
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectExactSuccessAccounting(result);
      expectStreamEnvelope(result, requested);
      expectAdapterTelemetry(result, "adapted", requested, native);
    },
  );

  it.each(crossPairs)(
    "$requested executes the full non-stream matrix from $native",
    async ({ requested, native }) => {
      const result = await runCase({ requested, native, behavior: "json" });
      expect(result.response.status).toBe(200);
      expect(result.ledger.pricingVersion).toBe("route-v1");
      expect(result.ledger.accountingVersion).toBe("provider-billable-v1");
      expect(result.attempt.state).toBe("COMPLETED");
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectEgressContract(result, native);
      expectExactSuccessAccounting(result);
      expectJsonEnvelope(result, requested);
      expectAdapterTelemetry(result, "adapted", requested, native);
    },
  );

  it.each(requestedSurfaces)(
    "%s retains conservative liability for a truncated native provider stream",
    async (requested) => {
      const result = await runCase({ requested, native: requested, behavior: "crash" });
      expect(result.ledger.observationComplete).toBe(false);
      expect(result.ledger.usageKnown).toBe(false);
      expect(result.attempt.state).toBe("FAILED");
      expect(result.reservations.every((row) => row.state === "SETTLED")).toBe(true);
      expectConservativeAccounting(result);
    },
  );

  it.each(requestedSurfaces)(
    "%s durably settles a native retryable provider error",
    async (requested) => {
      const result = await runCase({ requested, native: requested, behavior: "error" });
      // Retry exhaustion is normalized by the public model API error renderer;
      // the durable provider attempt remains the authoritative upstream outcome.
      expect(result.response.status).toBeGreaterThanOrEqual(400);
      expect(result.ledger.usageKnown).toBe(false);
      expect(result.attempt.state).toBe("FAILED");
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectConservativeAccounting(result);
    },
  );

  it.each(requestedSurfaces)(
    "%s preserves pre-commit error semantics on an adapted provider route",
    async (requested) => {
      const native = adaptedNative[requested];
      const result = await runCase({ requested, native, behavior: "error" });
      expect(result.response.status).toBeGreaterThanOrEqual(400);
      expect(result.attempt.state).toBe("FAILED");
      expect(result.ledger.usageKnown).toBe(false);
      expectEgressContract(result, native);
      expectConservativeAccounting(result);
    },
  );

  it.each([
    ["openai-chat", "openai-responses"],
    ["openai-chat", "anthropic-messages"],
    ["openai-responses", "openai-chat"],
    ["openai-responses", "anthropic-messages"],
  ] as const)("%s successfully adapts a committed %s SSE stream", async (requested, native) => {
    const result = await runCase({ requested, native, behavior: "stream" });
    expect(result.response.status).toBe(200);
    expect(result.attempt.state).toBe("COMPLETED");
    expect(result.ledger.usageKnown).toBe(true);
    expectEgressContract(result, native);
    expectExactSuccessAccounting(result);
    expectStreamEnvelope(result, requested);
    expectAdapterTelemetry(result, "adapted", requested, native);
  });

  it("routes streaming Chat through resolver-selected Responses on a multi-surface provider", async () => {
    const result = await runCase({
      requested: "openai-chat",
      native: "openai-responses",
      behavior: "stream",
      multiSurfaceStreamingFallback: true,
    });
    expect(result.response.status).toBe(200);
    expect(result.observation?.path).toBe("/stream/v1/responses");
    expectAdapterTelemetry(result, "adapted", "openai-chat", "openai-responses");
    expectStreamEnvelope(result, "openai-chat");
  });

  it.each([
    ["anthropic-messages", "openai-chat"],
    ["anthropic-messages", "openai-responses"],
  ] as const)(
    "%s rejects unsupported streaming adaptation from %s before egress commitment",
    async (requested, native) => {
      const result = await runCase({
        requested,
        native,
        behavior: "stream",
        expectRejected: true,
      });
      expect(result.rejected).toBe(true);
      if (!result.rejected) throw new Error("expected pre-dispatch rejection");
      expect(result.response.status).toBe(400);
      expect(JSON.parse(result.responseText)).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error" },
      });
      expect(result.attemptCount).toBe(0);
      expect(result.observation).toBeUndefined();
    },
  );

  it("fails over in publicOrder from a retryable first target to a settled second target", async () => {
    if (!modules) throw new Error("modules unavailable");
    const observationStart = upstreamObservations.length;
    const first = await runCase({
      requested: "openai-chat",
      native: "openai-chat",
      behavior: "error",
      secondBehavior: "json",
    });
    if (!first.secondModel) throw new Error("second provider model was not created");
    const secondLedger = await waitForLedger(first.secondModel.id);
    await waitForTerminalAttempt(first.secondModel.id);
    await waitForTerminalEvent(first.secondModel.id);
    const [attempts, secondReservations, secondSettlements, secondEvents] = await Promise.all([
      modules.prisma.providerAttempt.findMany({
        where: { providerModelId: { in: [first.model.id, first.secondModel.id] } },
        orderBy: { createdAt: "asc" },
      }),
      modules.prisma.providerBudgetReservation.findMany({
        where: { providerModelId: first.secondModel.id },
      }),
      modules.prisma.providerBudgetSettlement.findMany({
        where: { providerModelId: first.secondModel.id },
      }),
      modules.prisma.publicProviderAttemptEvent.findMany({
        where: { providerModelId: first.secondModel.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    expect(first.response.status).toBe(200);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerModelId: first.model.id, state: "FAILED" }),
        expect.objectContaining({ providerModelId: first.secondModel.id, state: "COMPLETED" }),
      ]),
    );
    expect(
      upstreamObservations.slice(observationStart).map(({ path }) => path.split("/")[1]),
    ).toEqual(["error", "json"]);
    expect(first.reservations).toHaveLength(2);
    expect(first.settlements).toHaveLength(2);
    expectConservativeAccounting(first);
    expect(secondLedger).toMatchObject({ billableTotal: 7n, usageKnown: true, costKnown: true });
    expect(secondReservations).toHaveLength(2);
    expect(secondSettlements).toHaveLength(2);
    expect(secondSettlements.map((row) => row.settledValue.toString()).sort()).toEqual([
      "0.000009",
      "7",
    ]);
    expect(secondEvents.filter((event) => event.eventType === "TERMINAL")).toHaveLength(1);
    for (const event of secondEvents)
      expect(event).toMatchObject({
        requestedSurface: "openai-chat",
        nativeSurface: "openai-chat",
        adapterMode: "native",
        adapterVersion: null,
      });
  });

  it("never tries a second target after the first target commits a byte and crashes", async () => {
    if (!modules) throw new Error("modules unavailable");
    const observationStart = upstreamObservations.length;
    const first = await runCase({
      requested: "openai-chat",
      native: "openai-chat",
      behavior: "crash",
      secondBehavior: "json",
    });
    if (!first.secondModel) throw new Error("second provider model was not created");
    expect(upstreamObservations.slice(observationStart)).toHaveLength(1);
    expect(
      await modules.prisma.providerAttempt.count({
        where: { providerModelId: first.secondModel.id },
      }),
    ).toBe(0);
    expect(first.attempt).toMatchObject({ state: "FAILED" });
    expect(first.ledger.usageKnown).toBe(false);
    expectConservativeAccounting(first);
    expect(first.attemptEvents.some((event) => event.eventType === "FIRST_CLIENT_BYTE")).toBe(true);
  });

  it.each(
    requestedSurfaces.flatMap((requested) => [
      { requested, native: requested, mode: "native" as const },
      { requested, native: adaptedNative[requested], mode: "adapted" as const },
    ]),
  )(
    "$requested renders and redacts a $mode provider error from $native",
    async ({ requested, native, mode }) => {
      const result = await runCase({ requested, native, behavior: "client-error" });
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("retry-after")).toBe("2");
      const requestedRequestIdHeader =
        requested === "anthropic-messages" ? "request-id" : "x-request-id";
      const sourceRequestIdHeader = native === "anthropic-messages" ? "request-id" : "x-request-id";
      expect(result.response.headers.get(requestedRequestIdHeader)).toBe("upstream-request-400");
      if (sourceRequestIdHeader !== requestedRequestIdHeader)
        expect(result.response.headers.get(sourceRequestIdHeader)).toBeNull();
      expect(result.response.headers.get("x-internal-secret")).toBeNull();
      expect(result.responseText).not.toContain("route-provider-secret");
      expect(result.responseText).not.toContain("10.0.0.8");
      expect(result.responseText).not.toContain("tenant-other");
      expect(result.responseText).not.toContain("provider_internal_type");
      expect(result.responseText).not.toContain("tenant-internal-secret-code");
      const error = JSON.parse(result.responseText);
      if (requested === "anthropic-messages")
        expect(error).toMatchObject({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "The provider rejected the request.",
          },
        });
      else
        expect(error).toMatchObject({
          error: {
            type: "invalid_request_error",
            code: "invalid_request_error",
            param: null,
            message: "The provider rejected the request.",
          },
        });
      const requestedRateHeaders =
        requested === "anthropic-messages"
          ? [
              "anthropic-ratelimit-requests-limit",
              "anthropic-ratelimit-requests-remaining",
              "anthropic-ratelimit-requests-reset",
              "anthropic-ratelimit-tokens-limit",
              "anthropic-ratelimit-tokens-remaining",
              "anthropic-ratelimit-tokens-reset",
            ]
          : [
              "x-ratelimit-limit-requests",
              "x-ratelimit-remaining-requests",
              "x-ratelimit-reset-requests",
              "x-ratelimit-limit-tokens",
              "x-ratelimit-remaining-tokens",
              "x-ratelimit-reset-tokens",
            ];
      expect(requestedRateHeaders.map((name) => result.response.headers.get(name))).toEqual([
        "100",
        "99",
        native !== requested
          ? null
          : native === "anthropic-messages"
            ? "2026-08-25T12:00:00Z"
            : "1s",
        "1000",
        "900",
        native !== requested
          ? null
          : native === "anthropic-messages"
            ? "2026-08-25T12:01:00Z"
            : "2s",
      ]);
      const oppositeRateHeaders =
        requested === "anthropic-messages"
          ? [
              "x-ratelimit-limit-requests",
              "x-ratelimit-remaining-requests",
              "x-ratelimit-reset-requests",
              "x-ratelimit-limit-tokens",
              "x-ratelimit-remaining-tokens",
              "x-ratelimit-reset-tokens",
            ]
          : [
              "anthropic-ratelimit-requests-limit",
              "anthropic-ratelimit-requests-remaining",
              "anthropic-ratelimit-requests-reset",
              "anthropic-ratelimit-tokens-limit",
              "anthropic-ratelimit-tokens-remaining",
              "anthropic-ratelimit-tokens-reset",
            ];
      expect(oppositeRateHeaders.every((name) => !result.response.headers.has(name))).toBe(true);
      expect(result.attempt.state).toBe("FAILED");
      expectConservativeAccounting(result);
      expectAdapterTelemetry(result, mode, requested, native);
    },
  );

  it.each(
    [
      {
        behavior: "empty-error" as const,
        status: 429,
        code: "rate_limit_error",
        type: "rate_limit_error",
      },
      {
        behavior: "overload-error" as const,
        status: 529,
        code: "overloaded_error",
        type: "server_error",
      },
    ].flatMap((scenario) => [
      { ...scenario, native: "openai-chat" as const, mode: "native" as const },
      { ...scenario, native: "anthropic-messages" as const, mode: "adapted" as const },
    ]),
  )(
    "canonicalizes $behavior from a $mode actual provider route",
    async ({ behavior, status, code, type, native, mode }) => {
      const result = await runCase({ requested: "openai-chat", native, behavior });
      expect(result.response.status, result.responseText).toBe(status);
      expect(JSON.parse(result.responseText)).toMatchObject({
        error: { type, code, param: null },
      });
      expect(result.response.headers.get("x-internal-secret")).toBeNull();
      expect(result.response.headers.get("x-wsmp-adapter-version")).toBe(
        mode === "adapted" ? "1.0.0" : null,
      );
      expect(result.responseText).not.toContain("route-provider-secret");
      expect(result.responseText).not.toContain("10.0.0.8");
      expect(result.responseText).not.toContain("tenant-other");
      if (behavior === "empty-error") {
        expect(result.response.headers.get("retry-after")).toBeNull();
        expect(result.response.headers.get("x-request-id")).toBeNull();
        expect(result.response.headers.get("x-ratelimit-limit-requests")).toBeNull();
      } else {
        expect(result.response.headers.get("retry-after")).toBe("Tue, 25 Aug 2026 12:00:00 GMT");
        expect(result.response.headers.get("x-request-id")).toBe("overload-request-529");
      }
      expectConservativeAccounting(result);
      expectAdapterTelemetry(result, mode, "openai-chat", native);
    },
  );

  it("dispatches a provider-backed Responses request through the cookie-authenticated Chat Test route", async () => {
    const result = await runCase({
      requested: "openai-responses",
      native: "openai-responses",
      behavior: "json",
      cookieAuth: true,
      forceProviderMember: true,
      routingMode: "REQUIRE_NATIVE",
    });
    expect(result.response.status, result.responseText).toBe(200);
    expect(JSON.parse(result.responseText)).toMatchObject({
      id: "resp_route",
      status: "completed",
    });
    expect(result.observation?.authorization).toBe("Bearer route-provider-secret");
  });

  it("proves PostgreSQL removes guarded setup writes after an injected mid-transaction failure", async () => {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Guarded rollback proof",
        email: `guarded-rollback-${suffix}@example.test`,
        slug: `guarded-rollback-${suffix}`,
      },
    });
    const poolId = crypto.randomUUID();
    await expect(
      modules.prisma.$transaction(async (transaction) => {
        await transaction.modelPool.create({
          data: {
            id: poolId,
            userId: user.id,
            slug: `rollback-${suffix}`,
            name: "Must roll back",
            publicEgressEnabled: false,
            publicEgressAcknowledged: false,
          },
        });
        await transaction.capacityAuditEvent.create({
          data: {
            userId: user.id,
            actorUserId: user.id,
            action: "CREATE",
            resourceType: "MODEL_POOL",
            resourceId: poolId,
          },
        });
        throw new Error("injected guarded setup failure");
      }),
    ).rejects.toThrow("injected guarded setup failure");
    await expect(
      modules.prisma.modelPool.findUnique({ where: { id: poolId } }),
    ).resolves.toBeNull();
    await expect(
      modules.prisma.capacityAuditEvent.findMany({ where: { resourceId: poolId } }),
    ).resolves.toEqual([]);
  });
});

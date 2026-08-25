import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[provider-route] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

type Surface = "openai-chat" | "openai-responses" | "anthropic-messages";
type Behavior = "json" | "stream" | "error" | "client-error" | "crash";

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
    authorization?: string;
    body: string;
  }> = [];
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        security: typeof import("@ws-model-proxy/db/forwarder-security");
        routes: typeof import("./routes.js");
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
    const [prismaModule, security, routes, identifiers, credentials, protocols] = await Promise.all(
      [
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/forwarder-security"),
        import("./routes.js"),
        import("@ws-model-proxy/config/forwarder-identifiers"),
        import("@ws-model-proxy/api/lib/provider-credential-crypto"),
        import("./protocols/index.js"),
      ],
    );
    modules = {
      prisma: prismaModule.default,
      security,
      routes,
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
            ? { "request-id": "upstream-request-400" }
            : { "x-request-id": "upstream-request-400" };
        response.writeHead(400, {
          "content-type": "application/json",
          "retry-after": "2",
          ...requestIdHeader,
          "x-internal-secret": "must-not-pass",
        });
        response.end(
          JSON.stringify(
            surface === "anthropic-messages"
              ? {
                  type: "error",
                  error: { type: "invalid_request_error", message: "safe provider error" },
                }
              : {
                  error: {
                    type: "invalid_request_error",
                    message: "safe provider error",
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
    const pool = await modules.prisma.modelPool.create({
      data: {
        userId: user.id,
        slug: `pool-${suffix}`,
        name: "Provider route pool",
        protocolAdaptationEnabled: true,
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      },
    });
    const account = await modules.prisma.providerAccount.create({
      data: {
        userId: user.id,
        providerType: protocolFor(input.native),
        label: `account-${suffix}`,
        baseUrl: `${origin}/${input.behavior}`,
        endpointIdentity: `${origin}/${input.behavior}`,
        authType: "BEARER",
        status: "ACTIVE",
        enabled: true,
        healthStatus: "HEALTHY",
      },
    });
    const credentialId = crypto.randomUUID();
    const keyring = modules.credentials.parseProviderCredentialKeyring(
      process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS!,
    );
    const encrypted = modules.credentials.encryptProviderCredential(
      "route-provider-secret",
      {
        userId: user.id,
        providerAccountId: account.id,
        credentialId,
        credentialType: "BEARER",
        aadVersion: 1,
      },
      keyring,
    );
    await modules.prisma.providerCredential.create({
      data: {
        id: credentialId,
        userId: user.id,
        providerAccountId: account.id,
        credentialType: "BEARER",
        ...encrypted,
      },
    });
    await modules.prisma.providerAccount.update({
      where: { id: account.id },
      data: { currentCredentialId: credentialId },
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
        nativeCapabilities: {
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
    await modules.prisma.poolMember.create({
      data: {
        poolId: pool.id,
        executionTargetId: target.id,
        tier: "PUBLIC_OVERFLOW",
        publicOrder: 0,
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
      const secondAccount = await modules.prisma.providerAccount.create({
        data: {
          userId: user.id,
          providerType: protocolFor(input.native),
          label: `account-second-${suffix}`,
          baseUrl: `${origin}/${input.secondBehavior}`,
          endpointIdentity: `${origin}/${input.secondBehavior}`,
          authType: "BEARER",
          status: "ACTIVE",
          enabled: true,
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
      await modules.prisma.providerCredential.create({
        data: {
          id: secondCredentialId,
          userId: user.id,
          providerAccountId: secondAccount.id,
          credentialType: "BEARER",
          ...secondEncrypted,
        },
      });
      await modules.prisma.providerAccount.update({
        where: { id: secondAccount.id },
        data: { currentCredentialId: secondCredentialId },
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
      await modules.prisma.poolMember.create({
        data: {
          poolId: pool.id,
          executionTargetId: secondTarget.id,
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 1,
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
        userId: user.id,
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
    const app = modules.routes.createModelApiRoutes({
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
          ? { model: modelId, stream, store: false, max_output_tokens: 16, input: "hi" }
          : {
              model: modelId,
              stream,
              max_tokens: 16,
              messages: [{ role: "user", content: "hi" }],
            };
    const headers: Record<string, string> = {
      authorization: `Bearer ${rawToken}`,
      "content-type": "application/json",
    };
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
      expect(result.ledger.categoriesComplete).not.toBe(true);
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

  it.each(requestedSurfaces)(
    "%s renders and redacts an adapted provider error in the requested protocol",
    async (requested) => {
      const native = adaptedNative[requested];
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
      expect(result.responseText).not.toContain("internal_secret");
      const error = JSON.parse(result.responseText);
      if (requested === "anthropic-messages")
        expect(error).toMatchObject({
          type: "error",
          error: { type: "invalid_request_error", message: "safe provider error" },
        });
      else
        expect(error).toMatchObject({
          error: {
            type: "invalid_request_error",
            code: "invalid_request_error",
            message: "safe provider error",
          },
        });
      expect(result.attempt.state).toBe("FAILED");
      expectConservativeAccounting(result);
      expectAdapterTelemetry(result, "adapted", requested, native);
    },
  );
});

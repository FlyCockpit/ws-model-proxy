import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[provider-route] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

type Surface = "openai-chat" | "openai-responses" | "anthropic-messages";
type Behavior = "json" | "stream" | "error" | "crash";

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

function streamResponse(surface: Surface) {
  if (surface === "anthropic-messages")
    return [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_route","type":"message","role":"assistant","content":[],"model":"upstream-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
  if (surface === "openai-responses")
    return [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_route","object":"response","created_at":1,"status":"in_progress","model":"upstream-model","output":[]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_route","object":"response","created_at":1,"status":"completed","model":"upstream-model","output":[],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
    ];
  return [
    'data: {"id":"chat_route","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"id":"chat_route","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    "data: [DONE]\n\n",
  ];
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
    const [prismaModule, security, routes, identifiers, credentials] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/forwarder-security"),
      import("./routes.js"),
      import("@ws-model-proxy/config/forwarder-identifiers"),
      import("@ws-model-proxy/api/lib/provider-credential-crypto"),
    ]);
    modules = { prisma: prismaModule.default, security, routes, identifiers, credentials };
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
        response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        response.end(JSON.stringify({ error: { message: "temporary", type: "server_error" } }));
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

  async function runCase(input: { requested: Surface; native: Surface; behavior: Behavior }) {
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
    await response.text().catch(() => undefined);
    const ledger = await waitForLedger(model.id);
    const attempt = await waitForTerminalAttempt(model.id);
    const [reservations, settlements] = await Promise.all([
      modules.prisma.providerBudgetReservation.findMany({
        where: { providerModelId: model.id },
        include: { Rule: true },
      }),
      modules.prisma.providerBudgetSettlement.findMany({ where: { providerModelId: model.id } }),
    ]);
    return {
      response,
      ledger,
      attempt,
      reservations,
      settlements,
      model,
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

  function expectConservativeAccounting(result: Awaited<ReturnType<typeof runCase>>) {
    for (const reservation of result.reservations) {
      const settlement = result.settlements.find((row) => row.reservationId === reservation.id);
      expect(settlement?.settledValue.equals(reservation.reservedValue)).toBe(true);
    }
  }

  const requestedSurfaces: Surface[] = ["openai-chat", "openai-responses", "anthropic-messages"];
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
    });

    it(`${requested} executes an adapted non-stream route with pinned accounting`, async () => {
      const result = await runCase({
        requested,
        native: adaptedNative[requested],
        behavior: "json",
      });
      expect(result.response.status).toBe(200);
      expect(result.ledger.pricingVersion).toBe("route-v1");
      expect(result.ledger.accountingVersion).toBe("provider-billable-v1");
      expect(result.attempt.state).toBe("COMPLETED");
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectEgressContract(result, adaptedNative[requested]);
      expectExactSuccessAccounting(result);
    });

    it(`${requested} executes native streaming through terminal reconciliation`, async () => {
      const result = await runCase({ requested, native: requested, behavior: "stream" });
      expect(result.response.status).toBe(200);
      expect(result.ledger).toMatchObject({ categoriesComplete: true, usageKnown: true });
      expect(result.attempt.state).toBe("COMPLETED");
      expect(result.settlements).toHaveLength(result.reservations.length);
      expectEgressContract(result, requested);
      expectExactSuccessAccounting(result);
    });
  }

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
    ["openai-responses", "anthropic-messages"],
  ] as const)(
    "%s fences a malformed committed %s adapted SSE stream",
    async (requested, native) => {
      const result = await runCase({ requested, native, behavior: "stream" });
      expect(result.response.status).toBe(200);
      expect(result.attempt.state).toBe("FAILED");
      expect(result.ledger.usageKnown).toBe(false);
      expectEgressContract(result, native);
      expectConservativeAccounting(result);
    },
  );
});

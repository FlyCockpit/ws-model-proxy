import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("model API token allowlists with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        router: typeof import("./model-api-tokens");
        access: typeof import("../lib/model-api-token-access");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, router, access] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./model-api-tokens"),
      import("../lib/model-api-token-access"),
    ]);
    modules = { prisma: db.default, router, access };
  });

  afterAll(() => {
    // Integration fixtures use unique identities and remain available for audit history.
  });

  it("canonicalizes a direct allowlist entry and preserves an allowlisted pool", async () => {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Model API token integration",
        email: `model-api-token-${suffix}@example.test`,
        slug: `model-api-token-${suffix}`,
      },
    });
    const cli = await modules.prisma.cliDevice.create({
      data: { userId: user.id, slug: `cli-${suffix}` },
    });
    const endpoint = await modules.prisma.endpoint.create({
      data: {
        userId: user.id,
        cliDeviceId: cli.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
        published: true,
      },
    });
    const model = await modules.prisma.discoveredModel.create({
      data: {
        userId: user.id,
        endpointId: endpoint.id,
        upstreamModelId: "local-model",
        encodedModelId: "local-model",
        published: true,
      },
    });
    const pool = await modules.prisma.modelPool.create({
      data: { userId: user.id, slug: `pool-${suffix}`, name: "Allowlisted pool" },
    });
    const session = {
      user,
      session: {
        id: `session-${suffix}`,
        userId: user.id,
        token: `token-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "integration",
      },
    } as Session;
    const handler = new RPCHandler(modules.router.modelApiTokensRouter);
    const link = new RPCLink({
      url: "http://integration.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: { session } satisfies Context,
        });
        return result.matched ? result.response : new Response(null, { status: 404 });
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof modules.router.modelApiTokensRouter>
    >;

    const created = await client.create({
      name: "Allowlisted token",
      scopeMode: "ALLOWLIST",
      modelIds: [
        directModelId({
          userSlug: user.slug,
          cliSlug: cli.slug,
          endpointSlug: endpoint.slug,
          upstreamModelId: model.upstreamModelId,
        }),
        poolModelId({ userSlug: user.slug, poolSlug: pool.slug }),
      ],
    });
    const entry = await modules.prisma.modelApiTokenAllowlistEntry.findFirstOrThrow({
      where: { modelApiTokenId: created.token.id, target: "DIRECT_MODEL" },
      select: { discoveredModelId: true, executionTargetId: true },
    });
    const executionTarget = await modules.prisma.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
      select: { id: true },
    });
    expect(entry.discoveredModelId).toBe(model.id);
    expect(entry.executionTargetId).toBe(executionTarget.id);

    const { targets, externalPoolIds } =
      await modules.access.listVisibleModelTargetsWithExternalPermissionForToken({
        id: created.token.id,
        userId: user.id,
        scopeMode: "ALLOWLIST",
        allowExternal: created.token.allowExternal,
      });
    expect(targets.directModels.map((target) => target.id)).toEqual([model.id]);
    expect(targets.modelPools.map((target) => target.id)).toEqual([pool.id]);
    // New tokens are private only until a person allows external providers.
    expect(created.token.allowExternal).toBe(false);
    expect([...externalPoolIds]).toEqual([]);
  });

  it("refuses model API token authentication after the owner is marked for deletion", async () => {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Marked token owner",
        email: `marked-token-${suffix}@example.test`,
        slug: `marked-token-${suffix}`,
      },
    });
    const session = {
      user,
      session: {
        id: `session-${suffix}`,
        userId: user.id,
        token: `token-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "integration",
      },
    } as Session;
    const handler = new RPCHandler(modules.router.modelApiTokensRouter);
    const link = new RPCLink({
      url: "http://integration.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: { session } satisfies Context,
        });
        return result.matched ? result.response : new Response(null, { status: 404 });
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof modules.router.modelApiTokensRouter>
    >;
    const created = await client.create({ name: "token", scopeMode: "ALL_VISIBLE" });
    await modules.prisma.user.update({
      where: { id: user.id },
      data: { deletionRequestedAt: new Date(), banned: true },
    });
    expect(await modules.access.authenticateModelApiTokenSecret(created.secret)).toBeNull();
  });
});

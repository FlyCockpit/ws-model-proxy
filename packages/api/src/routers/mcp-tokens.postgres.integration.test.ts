import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("MCP personal tokens with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        router: typeof import("./mcp-tokens");
        access: typeof import("../lib/mcp-token-access");
        security: typeof import("@ws-model-proxy/db/forwarder-security");
        mcpConfig: typeof import("@ws-model-proxy/auth/mcp-config");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // The router gates create on WMP_MCP_ENABLED and the secret utils default
    // to the validated BETTER_AUTH_SECRET; env/server parses at import time,
    // so every required value must be set before the dynamic imports below.
    process.env.WMP_MCP_ENABLED = "true";
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-thirty-two";
    process.env.BETTER_AUTH_URL = "https://proxy.example.test";
    const [db, router, access, security, mcpConfig] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./mcp-tokens"),
      import("../lib/mcp-token-access"),
      import("@ws-model-proxy/db/forwarder-security"),
      import("@ws-model-proxy/auth/mcp-config"),
    ]);
    modules = { prisma: db.default, router, access, security, mcpConfig };
  });

  afterAll(() => {
    // Integration fixtures use unique identities and remain available for audit history.
  });

  async function createFixtureUser(label: string) {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    return modules.prisma.user.create({
      data: {
        name: "MCP personal token integration",
        email: `mcp-token-${label}-${suffix}@example.test`,
        slug: `mcp-token-${label}-${suffix}`,
        twoFactorEnabled: true,
      },
    });
  }

  function sessionFor(user: Awaited<ReturnType<typeof createFixtureUser>>): Session {
    const suffix = crypto.randomUUID();
    return {
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
  }

  function buildClient(session: Session) {
    if (!modules) throw new Error("modules unavailable");
    const handler = new RPCHandler(modules.router.mcpTokensRouter);
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
    return createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof modules.router.mcpTokensRouter>
    >;
  }

  /** Seeds an active token (live grant, unrevoked, unexpired) directly. */
  async function seedActiveToken(userId: string) {
    if (!modules) throw new Error("modules unavailable");
    const secret = modules.security.generateProductCredentialSecret("mcpToken");
    const tokenId = crypto.randomUUID();
    const grant = await modules.prisma.mcpGrant.create({
      data: {
        userId,
        clientId: modules.mcpConfig.mcpPatClientId(tokenId),
        referenceId: modules.mcpConfig.MCP_PAT_GRANT_REFERENCE,
      },
      select: { id: true },
    });
    await modules.prisma.mcpPersonalToken.create({
      data: {
        id: tokenId,
        userId,
        name: "Seeded token",
        lookupPrefix: modules.security.credentialLookupPrefix(secret),
        secretDigest: modules.access.digestMcpPersonalTokenSecret(secret),
        scopes: ["mcp:read"],
        expiresAt: null,
        grantId: grant.id,
      },
    });
    return { id: tokenId, secret, grantId: grant.id };
  }

  function orpcErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }

  it("create returns a wsmp_mcp_ secret that authenticates with a throttled lastUsedAt", async () => {
    if (!modules) throw new Error("modules unavailable");
    const user = await createFixtureUser("create");
    const client = buildClient(sessionFor(user));

    const t0 = new Date();
    const created = await client.create({ name: "Laptop", allowWrite: false });
    expect(created.secret.startsWith(modules.security.PRODUCT_CREDENTIAL_PREFIXES.mcpToken)).toBe(
      true,
    );

    const row = await modules.prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: created.token.id },
      select: { revokedAt: true, grantId: true, grant: { select: { revokedAt: true } } },
    });
    expect(row.revokedAt).toBeNull();
    expect(row.grant.revokedAt).toBeNull();

    const identity = await modules.access.authenticateMcpPersonalToken(created.secret, t0);
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({
      userId: user.id,
      grantId: row.grantId,
      scopes: ["mcp:read"],
    });

    const afterFirstUse = await modules.prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: created.token.id },
      select: { lastUsedAt: true },
    });
    expect(afterFirstUse.lastUsedAt?.toISOString()).toBe(t0.toISOString());

    // One minute later the throttled touch must NOT rewrite lastUsedAt.
    const identityAgain = await modules.access.authenticateMcpPersonalToken(
      created.secret,
      new Date(t0.getTime() + 60_000),
    );
    expect(identityAgain).not.toBeNull();
    const afterSecondUse = await modules.prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: created.token.id },
      select: { lastUsedAt: true },
    });
    expect(afterSecondUse.lastUsedAt?.toISOString()).toBe(t0.toISOString());
  });

  it("create with an expiry authenticates before expiry and is rejected after", async () => {
    if (!modules) throw new Error("modules unavailable");
    const user = await createFixtureUser("expiry");
    const client = buildClient(sessionFor(user));

    const now = new Date();
    const created = await client.create({
      name: "Expiring",
      allowWrite: false,
      // ISO string on purpose: proves the coerce.date() input survives the
      // RPC wire shape the browser actually sends.
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });

    const identity = await modules.access.authenticateMcpPersonalToken(created.secret, now);
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({ userId: user.id });

    const afterExpiry = await modules.access.authenticateMcpPersonalToken(
      created.secret,
      new Date(now.getTime() + 2 * 60 * 60 * 1000),
    );
    expect(afterExpiry).toBeNull();
  });

  it("revoke kills authentication, tombstones the grant, and stays idempotent", async () => {
    if (!modules) throw new Error("modules unavailable");
    const user = await createFixtureUser("revoke");
    const client = buildClient(sessionFor(user));

    const created = await client.create({ name: "Laptop", allowWrite: false });
    expect(
      await modules.access.authenticateMcpPersonalToken(created.secret, new Date()),
    ).not.toBeNull();

    const revoked = await client.revokeMine({ id: created.token.id });
    expect(revoked.revokedAt).not.toBeNull();

    expect(
      await modules.access.authenticateMcpPersonalToken(created.secret, new Date()),
    ).toBeNull();

    const row = await modules.prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: created.token.id },
      select: { revokedAt: true, grant: { select: { revokedAt: true } } },
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.grant.revokedAt).not.toBeNull();

    const active = await client.listMine();
    expect(active.map((token) => token.id)).not.toContain(created.token.id);
    const history = await client.listMine({ includeRevoked: true });
    expect(history.map((token) => token.id)).toContain(created.token.id);

    const revokedAgain = await client.revokeMine({ id: created.token.id });
    expect(revokedAgain.revokedAt?.toISOString()).toBe(revoked.revokedAt?.toISOString());
  });

  it("a grant-only tombstone hides the token from the active list", async () => {
    if (!modules) throw new Error("modules unavailable");
    const user = await createFixtureUser("grant-tombstone");
    const client = buildClient(sessionFor(user));
    const seeded = await seedActiveToken(user.id);

    // Simulate a manual database revocation of the grant only: the token row
    // itself stays unrevoked. /mcp admission re-checks the grant tombstone,
    // so the token must drop out of the active list.
    await modules.prisma.mcpGrant.update({
      where: { id: seeded.grantId },
      data: { revokedAt: new Date() },
    });

    const active = await client.listMine();
    expect(active.map((token) => token.id)).not.toContain(seeded.id);
    const history = await client.listMine({ includeRevoked: true });
    expect(history.map((token) => token.id)).toContain(seeded.id);

    // The credential lookup itself still resolves the identity — hiding the
    // token from the active list is the grant tombstone's job.
    const identity = await modules.access.authenticateMcpPersonalToken(seeded.secret, new Date());
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({ userId: user.id, grantId: seeded.grantId });
    const grantRow = await modules.prisma.mcpGrant.findUniqueOrThrow({
      where: { id: seeded.grantId },
      select: { revokedAt: true },
    });
    expect(grantRow.revokedAt).not.toBeNull();
  });

  it("concurrent create at the cap admits exactly one", async () => {
    if (!modules) throw new Error("modules unavailable");
    const user = await createFixtureUser("cap-race");
    const client = buildClient(sessionFor(user));

    for (let index = 0; index < modules.mcpConfig.MCP_PAT_MAX_ACTIVE_PER_USER - 1; index++) {
      await seedActiveToken(user.id);
    }

    // runSerializableTransaction retries serialization failures internally, so
    // allSettled settles without extra handling: exactly one creator commits
    // past the cap and the rest surface ORPCError CONFLICT.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => client.create({ name: "Race", allowWrite: false })),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    expect(rejected).toHaveLength(3);
    for (const reason of rejected) expect(orpcErrorCode(reason)).toBe("CONFLICT");

    const activeCount = await modules.prisma.mcpPersonalToken.count({
      where: modules.access.activeMcpPersonalTokenWhere(user.id, new Date()),
    });
    expect(activeCount).toBe(modules.mcpConfig.MCP_PAT_MAX_ACTIVE_PER_USER);
  });
});

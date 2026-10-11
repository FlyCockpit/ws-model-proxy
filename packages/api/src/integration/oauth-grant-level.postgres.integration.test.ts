/**
 * OAuth grant levels against real PostgreSQL with the schema hardening applied: the consent
 * page's write (`recordConsentedMcpGrantLevel`) and the Access page's `access.oauthGrants.
 * setLevel`, including their audit rows (`audit_event_shape`: a person's row names no agent
 * credential; the action shape) and the conditional update that never overwrites a revoked
 * grant.
 */
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Modules = {
  fixtures: ReturnType<typeof createFixturePrismaClient>;
  appRouter: typeof import("../routers/index")["appRouter"];
  grantLevel: typeof import("@ws-model-proxy/auth/mcp-grant-level");
};

integration("OAuth grant levels on PostgreSQL with the schema hardening", () => {
  let modules: Modules | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  let user: { id: string; email: string; name: string };

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [router, grantLevel] = await Promise.all([
      import("../routers/index"),
      import("@ws-model-proxy/auth/mcp-grant-level"),
    ]);
    modules = {
      fixtures: createFixturePrismaClient(databaseUrl),
      appRouter: router.appRouter,
      grantLevel,
    };
    user = await modules.fixtures.user.create({
      data: {
        name: "Grant levels",
        email: `grant-level-${suffix}@example.test`,
        emailVerified: true,
        slug: `grant-level-${suffix}`,
      },
      select: { id: true, email: true, name: true },
    });
  });

  afterAll(async () => {
    await modules?.fixtures.$disconnect();
  });

  function client(auth: CallerAuth) {
    const session = {
      user: { ...user, role: "user", emailVerified: true, twoFactorEnabled: false },
      session: { id: `s-${suffix}`, userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
    } as Session;
    const lowered: string[] = [];
    const context: Context = {
      auth,
      session,
      services: {
        onAccessLevelLowered: async (event) => {
          lowered.push(event.grantId);
        },
      },
    };
    if (!modules) throw new Error("modules unavailable");
    return { api: createRouterClient(modules.appRouter, { context }), lowered };
  }

  const person = (): CallerAuth => ({
    kind: "cookie_session",
    userId: user.id,
    sessionId: `s-${suffix}`,
    csrfVerified: true,
  });

  it("records the consent page's choice, then a person's change, with audit rows", async () => {
    if (!modules) throw new Error("modules unavailable");
    const clientId = `https://client-${suffix}.example/meta`;
    const referenceId = "a".repeat(64);

    // Consent: absent grant created at Full, audited as the person.
    const created = await modules.grantLevel.recordConsentedMcpGrantLevel({
      userId: user.id,
      clientId,
      referenceId,
      level: "FULL",
    });
    expect(created).toMatchObject({ before: null, after: "FULL", lowered: false });
    const grantId = created?.grantId ?? "";
    // Re-approval at the same level writes nothing.
    await modules.grantLevel.recordConsentedMcpGrantLevel({
      userId: user.id,
      clientId,
      referenceId,
      level: "FULL",
    });

    // Access page: a person lowers it; the lowered hook runs.
    const { api, lowered } = client(person());
    expect(await api.access.oauthGrants.setLevel({ grantId, level: "READ" })).toEqual({
      level: "READ",
    });
    expect(lowered).toEqual([grantId]);
    const listed = await api.access.oauthGrants.list();
    expect(listed.connections.find((row) => row.grantId === grantId)?.level).toBe("READ");

    // An agent can never reach it.
    const agent = client({ kind: "oauth_access_token", userId: user.id, grantId, level: "FULL" });
    await expect(
      agent.api.access.oauthGrants.setLevel({ grantId, level: "FULL" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const audits = await modules.fixtures.auditEvent.findMany({
      where: { userId: user.id, resourceType: "mcp_grant", resourceId: grantId },
      orderBy: { createdAt: "asc" },
      select: {
        actor: true,
        actorUserId: true,
        agentTokenId: true,
        mcpGrantId: true,
        action: true,
        before: true,
        after: true,
      },
    });
    expect(audits).toEqual([
      {
        actor: "USER",
        actorUserId: user.id,
        agentTokenId: null,
        mcpGrantId: null,
        action: "mcp_grant.consent",
        before: null,
        after: { level: "FULL" },
      },
      {
        actor: "USER",
        actorUserId: user.id,
        agentTokenId: null,
        mcpGrantId: null,
        action: "mcp_grant.level",
        before: { level: "FULL" },
        after: { level: "READ" },
      },
    ]);

    // A revoked grant is never re-levelled.
    await modules.fixtures.mcpGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date() },
    });
    await expect(api.access.oauthGrants.setLevel({ grantId, level: "FULL" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(
      await modules.grantLevel.recordConsentedMcpGrantLevel({
        userId: user.id,
        clientId,
        referenceId,
        level: "FULL",
      }),
    ).toBeNull();
    // Two approvals racing to create one generation both land (ON CONFLICT DO NOTHING), one row.
    const racingReference = "b".repeat(64);
    const raced = await Promise.all(
      (["READ", "FULL"] as const).map((level) =>
        modules?.grantLevel.recordConsentedMcpGrantLevel({
          userId: user.id,
          clientId,
          referenceId: racingReference,
          level,
        }),
      ),
    );
    expect(raced.every((change) => change !== null && change !== undefined)).toBe(true);
    expect(
      await modules.fixtures.mcpGrant.count({
        where: { userId: user.id, clientId, referenceId: racingReference },
      }),
    ).toBe(1);

    const row = await modules.fixtures.mcpGrant.findUnique({
      where: { id: grantId },
      select: { level: true },
    });
    expect(row?.level).toBe("READ");
  });
});

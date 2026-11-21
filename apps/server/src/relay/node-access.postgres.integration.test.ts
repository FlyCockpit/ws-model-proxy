import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TrackedFileOp } from "./session-manager.js";

// WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY=false on real PostgreSQL: an existing no-expiry agent token is
// refused at MCP authentication and at node file admission, a dated token is unaffected, and
// turning the flag back on restores the same token. Nothing is revoked or deleted.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const policy = vi.hoisted(() => ({ allow: true as boolean | undefined }));
vi.mock("@ws-model-proxy/env/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ws-model-proxy/env/server")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, key, receiver) {
        if (key === "WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY") return policy.allow;
        return Reflect.get(target, key, receiver);
      },
    }),
  };
});

const relay = vi.hoisted(() => ({
  getLiveNodeState: vi.fn(),
  dispatchFileOp: vi.fn(),
  dispatchFileCancel: vi.fn(),
  forgetFileOp: vi.fn(),
}));
vi.mock("./session-manager.js", () => ({ relaySessionManager: relay }));

type Modules = {
  ops: typeof import("./node-file-ops.js");
  audit: typeof import("./node-audit.js");
  tokens: typeof import("../mcp/agent-token-access.js");
  limits: typeof import("@ws-model-proxy/auth/mcp-pat-limits");
  fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
};

const ROOT = "/srv/policy";

integration("no-expiry agent token policy (PostgreSQL)", () => {
  let m: Modules;
  const suffix = randomUUID().slice(0, 8);
  const userId = `np-${suffix}`;
  const nodeId = `npnode${suffix}`;
  const never = { id: `npnever${suffix}`, grantId: `npg1${suffix}`, secret: "" };
  const dated = { id: `npdated${suffix}`, grantId: `npg2${suffix}`, secret: "" };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    // The modules under test read the validated server env, which needs the auth settings.
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    const security = await import("@ws-model-proxy/db/node-security");
    m = {
      ops: await import("./node-file-ops.js"),
      audit: await import("./node-audit.js"),
      tokens: await import("../mcp/agent-token-access.js"),
      limits: await import("@ws-model-proxy/auth/mcp-pat-limits"),
      fixture: createFixturePrismaClient(databaseUrl ?? ""),
      prisma: (await import("@ws-model-proxy/db")).default,
    };
    const db = m.fixture;
    await db.user.create({ data: { id: userId, name: "Policy", email: `${userId}@example.test` } });
    await db.node.create({
      data: {
        id: nodeId,
        userId,
        slug: `np-${suffix}`,
        connection: "ONLINE",
        connectionGeneration: 1,
        trust: "FULL",
      },
    });
    for (const [token, expiresAt] of [
      [never, null],
      [dated, new Date(Date.now() + 7 * 86_400_000)],
    ] as const) {
      token.secret = security.generateProductCredentialSecret("agentToken");
      await db.mcpGrant.create({
        data: {
          id: token.grantId,
          userId,
          clientId: `pat:${token.id}`,
          referenceId: token.id,
          scopes: ["READ", "FILES"],
          allNodes: true,
        },
      });
      await db.agentToken.create({
        data: {
          id: token.id,
          userId,
          name: token.id,
          lookupPrefix: security.credentialLookupPrefix(token.secret),
          secretDigest: security.credentialDigest("agentToken", token.secret),
          grantId: token.grantId,
          expiresAt,
        },
      });
    }
    relay.getLiveNodeState.mockReturnValue({
      nodeId,
      userId,
      trust: "full",
      features: { files: { roots: [ROOT], asRoot: false, source: "configured" } },
    });
  });

  afterEach(() => {
    policy.allow = true;
  });

  afterAll(async () => {
    if (!m) return;
    m.ops.resetFileOpsForTests();
    const db = m.fixture;
    try {
      await m.audit.flushNodeAudit();
      // Every delete scoped to this run (WHERE).
      await db.nodeAuditEvent.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
      await m.prisma.$disconnect();
    }
  });

  function answerMkdir() {
    relay.dispatchFileOp.mockImplementationOnce((op: TrackedFileOp) => {
      queueMicrotask(() =>
        op.markResult({
          type: "file.result",
          opId: op.opId,
          op: "mkdir",
          result: { created: true },
        }),
      );
      return true;
    });
  }

  function mkdir(token: { id: string }, expiresAt: Date | null, path: string) {
    return m.ops.runFileOp({
      userId,
      tokenId: token.id,
      expiresAt,
      nodeId,
      op: "mkdir",
      args: { path: `${ROOT}/${path}` },
    });
  }

  it("judges the no-expiry token blocked at MCP authentication while off, unchanged, and restores it once on", async () => {
    const now = new Date();
    await expect(m.tokens.authenticateAgentToken(never.secret, now)).resolves.toMatchObject({
      id: never.id,
      expiresAt: null,
    });
    policy.allow = false;
    const stampBefore = await m.fixture.agentToken.findUniqueOrThrow({ where: { id: never.id } });
    const blocked = await m.tokens.authenticateAgentToken(
      never.secret,
      new Date(now.getTime() + 3_600_000),
    );
    // Verified, then refused by the MCP handler's final fence (typed 401, see auth.test.ts).
    expect(blocked).toMatchObject({ id: never.id, expiresAt: null });
    expect(m.tokens.agentTokenBlockedByPolicy(blocked!)).toBe(true);
    // Kept as it was: not revoked, not deleted, not stamped as used.
    const kept = await m.fixture.agentToken.findUniqueOrThrow({ where: { id: never.id } });
    expect(kept).toMatchObject({ revokedAt: null, expiresAt: null });
    expect(kept.lastUsedAt).toEqual(stampBefore.lastUsedAt);
    // Dated tokens are unaffected.
    await expect(m.tokens.authenticateAgentToken(dated.secret, now)).resolves.toMatchObject({
      id: dated.id,
    });
    policy.allow = true;
    const restored = await m.tokens.authenticateAgentToken(never.secret, now);
    expect(restored).toMatchObject({ id: never.id });
    expect(m.tokens.agentTokenBlockedByPolicy(restored!)).toBe(false);
  });

  it("refuses node file work authorized by the no-expiry token while off, and admits it once on", async () => {
    policy.allow = false;
    const refused = await mkdir(never, null, "blocked");
    expect(refused).toMatchObject({ ok: false });
    expect(relay.dispatchFileOp).not.toHaveBeenCalled();
    answerMkdir();
    await expect(
      mkdir(dated, new Date(Date.now() + 7 * 86_400_000), "dated"),
    ).resolves.toMatchObject({ ok: true });
    policy.allow = true;
    answerMkdir();
    await expect(mkdir(never, null, "restored")).resolves.toMatchObject({ ok: true });
  });

  it("the live-token fragment excludes NULL expiry in SQL only while off", async () => {
    const ids = async (allow: boolean) =>
      (
        await m.prisma.agentToken.findMany({
          where: { userId, ...m.limits.liveAgentTokenWhere(new Date(), allow) },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((row) => row.id);
    expect(await ids(true)).toEqual([dated.id, never.id].sort());
    expect(await ids(false)).toEqual([dated.id]);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TrackedFileOp } from "./session-manager.js";

// Node file ops on real PostgreSQL: the admission reads (agent token, OAuth grant, node, owner)
// and the NodeAuditEvent rows the writer stores (the hardening CHECK: an agent row names
// exactly one credential). The relay is a fake that answers as the node would.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

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
  fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
};

const ROOT = "/srv/deploy";
const ETAG = `h:${"B".repeat(22)}`;
const CONTENT = "PG-SECRET-CONTENT";

integration("node file ops (PostgreSQL)", () => {
  let m: Modules;
  const suffix = randomUUID().slice(0, 8);
  const userId = `fo-${suffix}`;
  const nodeId = `fonode${suffix}`;
  const tokenId = `fotok${suffix}`;
  const tokenGrantId = `fotg${suffix}`;
  const oauthGrantId = `fog${suffix}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    m = {
      ops: await import("./node-file-ops.js"),
      audit: await import("./node-audit.js"),
      fixture: createFixturePrismaClient(databaseUrl ?? ""),
      prisma: (await import("@ws-model-proxy/db")).default,
    };
    const db = m.fixture;
    await db.user.create({ data: { id: userId, name: "Files", email: `${userId}@example.test` } });
    await db.node.create({
      data: {
        id: nodeId,
        userId,
        slug: `fo-${suffix}`,
        connection: "ONLINE",
        connectionGeneration: 1,
        trust: "FULL",
      },
    });
    await db.mcpGrant.create({
      data: { id: tokenGrantId, userId, clientId: "token", referenceId: tokenId, level: "FULL" },
    });
    await db.agentToken.create({
      data: {
        id: tokenId,
        userId,
        name: "files",
        level: "FULL",
        lookupPrefix: `lp${suffix}`,
        secretDigest: createHash("sha256").update(tokenId).digest("hex"),
        grantId: tokenGrantId,
      },
    });
    await db.mcpGrant.create({
      data: { id: oauthGrantId, userId, clientId: "client", referenceId: "ref", level: "FULL" },
    });
    relay.getLiveNodeState.mockReturnValue({
      nodeId,
      userId,
      trust: "full",
      features: { files: { roots: [ROOT], asRoot: false } },
    });
  });

  afterAll(async () => {
    if (!m) return;
    m.ops.resetFileOpsForTests();
    const db = m.fixture;
    try {
      // Every delete scoped to this run (WHERE).
      await db.nodeAuditEvent.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
      await m.prisma.$disconnect();
    }
  });

  /** Answer the next dispatched op the way the node would. */
  function answerWith(answer: (op: TrackedFileOp) => void) {
    relay.dispatchFileOp.mockImplementationOnce((op: TrackedFileOp) => {
      queueMicrotask(() => answer(op));
      return true;
    });
  }

  async function rows() {
    await m.audit.flushNodeAudit();
    return m.fixture.nodeAuditEvent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  }

  it("stores one metadata-only row per op, naming the agent token", async () => {
    answerWith((op) =>
      op.markResult({
        type: "file.result",
        opId: op.opId,
        op: "write",
        result: { etag: ETAG, size: CONTENT.length, created: true },
      }),
    );
    const outcome = await m.ops.runFileOp({
      userId,
      tokenId,
      expiresAt: null,
      nodeId,
      op: "write",
      args: { path: `${ROOT}/app.env`, ifExists: "fail" },
      body: new TextEncoder().encode(CONTENT),
    });
    expect(outcome).toMatchObject({ ok: true });
    const [row] = (await rows()).filter((entry) => entry.kind === "file_write");
    expect(row).toMatchObject({
      nodeId,
      actor: "AGENT",
      agentTokenId: tokenId,
      mcpGrantId: null,
      subject: `${ROOT}/app.env`,
      etagAfter: ETAG,
      bytes: BigInt(CONTENT.length),
      outcome: "completed",
    });
    expect(
      JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? 0 : value)),
    ).not.toContain(CONTENT);
  });

  it("admits an OAuth grant by its row and stores the grant id", async () => {
    answerWith((op) =>
      op.markResult({ type: "file.result", opId: op.opId, op: "mkdir", result: { created: true } }),
    );
    const outcome = await m.ops.runFileOp({
      userId,
      tokenId: oauthGrantId,
      credentialKind: "oauth_grant",
      expiresAt: null,
      nodeId,
      op: "mkdir",
      args: { path: `${ROOT}/conf.d` },
    });
    expect(outcome).toMatchObject({ ok: true });
    const row = (await rows()).find((entry) => entry.kind === "file_mkdir");
    expect(row).toMatchObject({ agentTokenId: null, mcpGrantId: oauthGrantId });
  });

  it("stores refusals: a path outside the roots and an unknown node", async () => {
    await expect(
      m.ops.runFileOp({
        userId,
        tokenId,
        expiresAt: null,
        nodeId,
        op: "read",
        args: { path: "/etc/shadow" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "path_denied" });
    await expect(
      m.ops.runFileOp({
        userId,
        tokenId,
        expiresAt: null,
        nodeId: "not-a-node",
        op: "read",
        args: { path: `${ROOT}/a` },
      }),
    ).resolves.toMatchObject({ ok: false, code: "unknown_node" });
    const refused = (await rows()).filter((entry) => entry.outcome === "refused");
    expect(refused).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId, subject: "/etc/shadow", reason: "path_denied" }),
        expect.objectContaining({
          nodeId: m.ops.NODE_AUDIT_UNKNOWN_NODE,
          reason: "unknown_node",
        }),
      ]),
    );
  });

  it("refuses a revoked token and a token of another level from the database", async () => {
    const sentBefore = relay.dispatchFileOp.mock.calls.length;
    await m.fixture.agentToken.update({ where: { id: tokenId }, data: { level: "READ" } });
    await expect(
      m.ops.runFileOp({
        userId,
        tokenId,
        expiresAt: null,
        nodeId,
        op: "read",
        args: { path: `${ROOT}/a` },
      }),
    ).resolves.toMatchObject({ ok: false, code: "token_inactive" });
    await m.fixture.agentToken.update({
      where: { id: tokenId },
      data: { level: "FULL", revokedAt: new Date() },
    });
    await expect(
      m.ops.runFileOp({
        userId,
        tokenId,
        expiresAt: null,
        nodeId,
        op: "read",
        args: { path: `${ROOT}/a` },
      }),
    ).resolves.toMatchObject({ ok: false, code: "token_inactive" });
    expect(relay.dispatchFileOp.mock.calls.length).toBe(sentBefore);
  });
});

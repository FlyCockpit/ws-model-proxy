/**
 * An agent withdrawing a command it queued for a person, on real PostgreSQL with the schema
 * hardening (shape CHECK: a decided row names who decided it; the decided-once trigger): only the
 * credential that queued it withdraws it, only while it is QUEUED, and the audit row names that
 * credential. Every row is removed afterwards, each delete scoped to this run's user.
 */
import { randomUUID } from "node:crypto";
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

const RUN = `qw${randomUUID().slice(0, 8)}`;
const USER = `${RUN}-u`;

const session = {
  user: {
    id: USER,
    email: `${USER}@example.test`,
    name: USER,
    role: "user",
    emailVerified: true,
    twoFactorEnabled: false,
  },
  session: { id: `s-${USER}`, userId: USER, expiresAt: new Date(Date.now() + 600_000) },
} as Session;

const TOKEN: CallerAuth = {
  kind: "agent_token",
  userId: USER,
  agentTokenId: `${RUN}-tok`,
  level: "FULL",
};
const OTHER_TOKEN: CallerAuth = { ...TOKEN, agentTokenId: `${RUN}-tok2` };
const GRANT: CallerAuth = {
  kind: "oauth_access_token",
  userId: USER,
  grantId: `${RUN}-grant`,
  level: "FULL",
};
const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: USER,
  sessionId: `s-${USER}`,
  csrfVerified: true,
};

integration("withdrawing a queued command (PostgreSQL)", () => {
  let fixtures: ReturnType<typeof createFixturePrismaClient>;
  let routers: typeof import("../routers/node-operator")["nodeOperatorRouters"];
  let nodeId = "";

  function client(auth: CallerAuth) {
    return createRouterClient(routers, { context: { session, auth } satisfies Context });
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    routers = (await import("../routers/node-operator")).nodeOperatorRouters;
    fixtures = createFixturePrismaClient(databaseUrl);
    await fixtures.user.create({
      data: {
        id: USER,
        name: USER,
        email: `${USER}@example.test`,
        emailVerified: true,
        slug: USER,
      },
    });
    nodeId = (
      await fixtures.node.create({
        data: { userId: USER, slug: `${RUN}-n`, connection: "OFFLINE", trust: "FULL" },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!fixtures) return;
    try {
      await fixtures.queuedNodeCommand.deleteMany({ where: { userId: USER } });
      await fixtures.node.deleteMany({ where: { userId: USER } });
      await fixtures.nodeAuditEvent.deleteMany({ where: { userId: USER } });
      await fixtures.user.deleteMany({ where: { id: USER } });
    } finally {
      await fixtures.$disconnect();
    }
  }, 60_000);

  async function enqueue(auth: CallerAuth): Promise<string> {
    const item = await client(auth).queued.enqueue({
      nodeId,
      command: "sudo apt install nvtop",
      note: "needs sudo",
      expiresInHours: 24,
    });
    return item.id;
  }

  it("withdraws the caller's own command and audits it under that credential", async () => {
    for (const auth of [TOKEN, GRANT]) {
      const id = await enqueue(auth);
      await expect(
        client(auth).commands.get({ commandId: id, cancel: true }),
      ).resolves.toMatchObject({ commandId: id, queuedForUser: true, state: "WITHDRAWN" });
      const row = await fixtures.queuedNodeCommand.findUniqueOrThrow({ where: { id } });
      const credential = auth.kind === "agent_token" ? auth.agentTokenId : auth.grantId;
      expect(row).toMatchObject({ state: "WITHDRAWN", decidedBy: credential });
      expect(row.decidedAt).not.toBeNull();
      const audit = await fixtures.nodeAuditEvent.findFirstOrThrow({
        where: { userId: USER, outcome: "cancelled", kind: "command_queued_for_user" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).toMatchObject({
        actor: "AGENT",
        agentTokenId: auth.kind === "agent_token" ? credential : null,
        mcpGrantId: auth.kind === "oauth_access_token" ? credential : null,
      });
      // Withdrawn is decided: the person can no longer dismiss it.
      await expect(client(PERSON).queued.dismiss({ queuedCommandId: id })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    }
  });

  it("leaves another credential's command and a dismissed one unchanged", async () => {
    const id = await enqueue(TOKEN);
    for (const auth of [OTHER_TOKEN, GRANT, PERSON]) {
      await expect(
        client(auth).commands.get({ commandId: id, cancel: true }),
      ).rejects.toMatchObject({ data: { reason: "not_your_command" } });
    }
    expect(await fixtures.queuedNodeCommand.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "QUEUED",
      decidedAt: null,
    });
    await client(PERSON).queued.dismiss({ queuedCommandId: id });
    await expect(client(TOKEN).commands.get({ commandId: id, cancel: true })).rejects.toMatchObject(
      { data: { reason: "command_not_running" } },
    );
    expect(await fixtures.queuedNodeCommand.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "DISMISSED",
      decidedBy: USER,
    });
  });

  it("lets exactly one of a racing withdrawal and dismissal win", async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await enqueue(TOKEN);
      const [withdraw, dismiss] = await Promise.allSettled([
        client(TOKEN).commands.get({ commandId: id, cancel: true }),
        client(PERSON).queued.dismiss({ queuedCommandId: id }),
      ]);
      expect([withdraw.status, dismiss.status].sort()).toEqual(["fulfilled", "rejected"]);
      const row = await fixtures.queuedNodeCommand.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe(withdraw.status === "fulfilled" ? "WITHDRAWN" : "DISMISSED");
    }
  });

  it("refuses to withdraw a command past its expiry", async () => {
    // A fixture row already past its expiry (a queued command is immutable once written).
    const now = Date.now();
    const { id } = await fixtures.queuedNodeCommand.create({
      data: {
        userId: USER,
        nodeId,
        agentTokenId: TOKEN.kind === "agent_token" ? TOKEN.agentTokenId : null,
        command: "sudo true",
        createdAt: new Date(now - 2 * 3_600_000),
        expiresAt: new Date(now - 3_600_000),
      },
      select: { id: true },
    });
    await expect(client(TOKEN).commands.get({ commandId: id, cancel: true })).rejects.toMatchObject(
      { data: { reason: "command_not_running" } },
    );
    expect(await fixtures.queuedNodeCommand.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "QUEUED",
    });
  });
});

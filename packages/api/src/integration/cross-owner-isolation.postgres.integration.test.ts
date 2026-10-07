/**
 * Cross-owner isolation on real PostgreSQL with the schema hardening applied (`pnpm
 * test:postgres`). User A owns a node with a running instance; user B, with each of their
 * credentials (a Full agent token, a Full OAuth grant, a cookie with its CSRF header), aims every
 * node, runtime, instance and profile procedure at A's ids. Every call is refused, no relay hook
 * runs and A's rows are exactly as they were.
 *
 * The second part writes the cross-owner rows directly (the fixture client, which passes the
 * graph-write fences) and proves the database refuses them on its own: a rank or a step of B's
 * instance on A's node, an operation of B's that stops A's instance, a node handed to B.
 *
 * Every row is removed afterwards, each delete scoped to this run's two users.
 */
import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context, ContextServices } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import type { RuntimeSpec } from "../lib/runtime-spec";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const RUN = `xo${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const A = `${RUN}-a`;
const B = `${RUN}-b`;

const SPEC: RuntimeSpec = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "m" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 16 }],
    labels: [],
    commands: [{ start: "vllm serve m --host 127.0.0.1 --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

function sessionOf(userId: string): Session {
  return {
    user: {
      id: userId,
      email: `${userId}@example.test`,
      name: userId,
      role: "user",
      emailVerified: true,
      twoFactorEnabled: false,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 600_000) },
  } as Session;
}

const person = (userId: string): CallerAuth => ({
  kind: "cookie_session",
  userId,
  sessionId: `s-${userId}`,
  csrfVerified: true,
});

/** A user's credentials: a Full agent token, a Full OAuth grant, a cookie with CSRF. */
function credentialsOf(userId: string): ReadonlyArray<[string, CallerAuth]> {
  return [
    [
      "Full agent token",
      { kind: "agent_token", userId, agentTokenId: `${userId}-tok`, level: "FULL" },
    ],
    [
      "Full OAuth grant",
      { kind: "oauth_access_token", userId, grantId: `${userId}-grant`, level: "FULL" },
    ],
    ["cookie with CSRF", person(userId)],
  ];
}

/** One user's node with a running instance, a profile and a command. */
type World = {
  userId: string;
  nodeId: string;
  runtimeId: string;
  runtimeModelId: string;
  instanceId: string;
  profileId: string;
  commandId: string;
  poolId: string;
};

integration("cross-owner isolation on PostgreSQL", () => {
  let modules: {
    fixtures: ReturnType<typeof createFixturePrismaClient>;
    appRouter: typeof import("../routers/index")["appRouter"];
  };
  const blank = (userId: string): World => ({
    userId,
    nodeId: "",
    runtimeId: "",
    runtimeModelId: "",
    instanceId: "",
    profileId: "",
    commandId: "",
    poolId: "",
  });
  const a = blank(A);
  const b = blank(B);
  /** B's own runtime (to aim at A's node); it also runs on B's node. */
  let runtimeOfB = "";

  const services = {
    nodes: {
      definitionChanged: vi.fn(async () => {}),
      writeSecrets: vi.fn(async () => []),
      rescan: vi.fn(async () => {}),
      lowerTrust: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      profileApplied: vi.fn(async () => {}),
    },
    nodeOperator: {
      openTerminalTicket: vi.fn(async () => ({
        ticket: "t".repeat(43),
        terminalId: "x",
        expiresAt: new Date(),
      })),
      startCommand: vi.fn(async () => ({ startedAt: new Date(), endsBy: new Date() })),
      pollCommand: vi.fn(async () => null),
    },
    dispatchRuntimeOperation: vi.fn(async () => {}),
    pushRuntimeDefinitions: vi.fn(async () => []),
    modelTest: vi.fn(async () => {
      throw new Error("a model test must not run");
    }),
  } satisfies ContextServices;

  function client(auth: CallerAuth, withServices = true) {
    const context: Context = {
      auth,
      session: sessionOf(auth.userId),
      ...(withServices ? { services } : {}),
    };
    return createRouterClient(modules.appRouter, { context });
  }

  /** What the target owns, as it stands: must not change while the other user tries. */
  async function snapshotOf(target: World, attacker: string) {
    const db = modules.fixtures;
    return {
      node: await db.node.findUnique({
        where: { id: target.nodeId },
        select: {
          userId: true,
          name: true,
          labels: true,
          holdAt: true,
          trustLowerRequestedAt: true,
        },
      }),
      instance: await db.runtimeInstance.findUnique({
        where: { id: target.instanceId },
        select: { userId: true, desiredState: true, phase: true, operationId: true },
      }),
      ranks: await db.instanceRank.findMany({
        where: { nodeId: target.nodeId },
        select: { instanceId: true, claim: true },
        orderBy: { id: "asc" },
      }),
      steps: await db.instanceStep.count({ where: { nodeId: target.nodeId } }),
      commands: await db.nodeCommand.count({ where: { nodeId: target.nodeId } }),
      queued: await db.queuedNodeCommand.count({ where: { nodeId: target.nodeId } }),
      runtimesOnNode: await db.runtime.count({ where: { nodeId: target.nodeId } }),
      profileNodes: await db.profileNode.count({ where: { nodeId: target.nodeId } }),
      models: await db.runtimeModel.findMany({
        where: { runtimeId: target.runtimeId },
        select: { capabilities: true, capabilitiesOverridden: true, retired: true },
      }),
      operationsOfAttacker: await db.runtimeOperation.count({ where: { userId: attacker } }),
      auditOfAttacker: await db.nodeAuditEvent.count({ where: { userId: attacker } }),
    };
  }

  /** The owner's node, runtime (started there), profile and a command, through the procedures. */
  async function seedWorld(world: World, tag: string) {
    const db = modules.fixtures;
    const node = await db.node.create({
      data: {
        userId: world.userId,
        slug: `${RUN}-${tag}`,
        connection: "ONLINE",
        trust: "FULL",
        declaredResources: { kind: "unified", memoryGb: 66 },
        portStart: 30000,
        portEnd: 30010,
      },
      select: { id: true },
    });
    world.nodeId = node.id;
    const owner = client(person(world.userId), false);
    const created = await owner.runtimes.create({
      slug: "model",
      name: "Model",
      kind: "STARTABLE",
      spec: SPEC,
    });
    world.runtimeId = created.runtime.id;
    world.runtimeModelId = (
      await db.runtimeModel.findFirstOrThrow({
        where: { runtimeId: world.runtimeId },
        select: { id: true },
      })
    ).id;
    const preview = await owner.runtimes.start({
      runtimeId: world.runtimeId,
      nodeIds: [world.nodeId],
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    const applied = await owner.runtimes.start({
      runtimeId: world.runtimeId,
      nodeIds: [world.nodeId],
      fingerprint: preview.preview.fingerprint,
    });
    if (applied.mode !== "applied") throw new Error("expected an applied start");
    world.instanceId = applied.operation.instances[0]?.id ?? "";
    const profile = await owner.profiles.save({
      slug: "day",
      name: "Day",
      nodeIds: [world.nodeId],
      items: [],
    });
    world.profileId = profile.id;
    world.commandId = `${tag.toUpperCase()}${"A".repeat(19)}${RUN.slice(-2)}`;
    await db.nodeCommand.create({
      data: {
        id: world.commandId,
        userId: world.userId,
        nodeId: world.nodeId,
        actor: "USER",
        subject: "hmac-sha256:00 ls",
        startedAt: new Date(),
        endsBy: new Date(Date.now() + 3_600_000),
      },
    });
    const pool = await db.pool.create({
      data: { userId: world.userId, slug: "shared", name: "Shared", modelType: "LLM" },
      select: { id: true },
    });
    world.poolId = pool.id;
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // Test-only values when the run does not set them (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const router = await import("../routers/index");
    modules = { fixtures: createFixturePrismaClient(databaseUrl), appRouter: router.appRouter };
    const db = modules.fixtures;
    for (const id of [A, B])
      await db.user.create({
        data: { id, name: id, email: `${id}@example.test`, emailVerified: true, slug: id },
      });
    await seedWorld(a, "a");
    await seedWorld(b, "b");
    runtimeOfB = b.runtimeId;
    // Everything the two may share, both ways: each one's pool shared with the other with use
    // and contribute, each one's model contributed to the other's pool (through the real
    // procedure), each one's runtime shared with the other.
    for (const [owner, grantee] of [
      [a, b],
      [b, a],
    ] as const) {
      await db.share.create({
        data: {
          poolId: owner.poolId,
          ownerUserId: owner.userId,
          granteeUserId: grantee.userId,
          canUse: true,
          canContribute: true,
        },
      });
      await client(person(grantee.userId), false).pools.members.addContributed({
        poolId: owner.poolId,
        runtimeModelId: grantee.runtimeModelId,
      });
      await db.runtimeShare.create({
        data: {
          runtimeId: owner.runtimeId,
          ownerUserId: owner.userId,
          granteeUserId: grantee.userId,
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!modules) return;
    const db = modules.fixtures;
    try {
      // Children first, every delete scoped to this run's two users (WHERE).
      const users = { in: [A, B] };
      await db.pool.deleteMany({ where: { userId: users } });
      await db.runtimeInstance.deleteMany({ where: { userId: users } });
      await db.runtimeOperation.deleteMany({ where: { userId: users } });
      await db.profile.deleteMany({ where: { userId: users } });
      await db.runtime.updateMany({ where: { userId: users }, data: { currentVersionId: null } });
      await db.runtime.deleteMany({ where: { userId: users } });
      await db.nodeCommand.deleteMany({ where: { userId: users } });
      await db.node.deleteMany({ where: { userId: users } });
      await db.nodeAuditEvent.deleteMany({ where: { userId: users } });
      await db.auditEvent.deleteMany({ where: { userId: users } });
      await db.user.deleteMany({ where: { id: users } });
      expect(await db.user.count({ where: { id: users } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  /** Every procedure that reaches a node, runtime, instance or profile, aimed at `t`'s ids. */
  const calls = (
    t: World,
    own: World,
  ): ReadonlyArray<[string, (c: ReturnType<typeof client>) => Promise<unknown>]> => [
    ["nodes.get", (c) => c.nodes.get({ nodeId: t.nodeId })],
    ["nodes.update", (c) => c.nodes.update({ nodeId: t.nodeId, labels: ["x"], rescan: true })],
    ["nodes.rename", (c) => c.nodes.rename({ nodeId: t.nodeId, name: "mine now" })],
    ["nodes.setHold", (c) => c.nodes.setHold({ nodeId: t.nodeId, hold: true })],
    ["nodes.lowerTrust", (c) => c.nodes.lowerTrust({ nodeId: t.nodeId })],
    ["nodes.delete", (c) => c.nodes.delete({ nodeId: t.nodeId })],
    [
      "nodes.secrets.set",
      (c) => c.nodes.secrets.set({ nodeId: t.nodeId, name: "WSMP_SECRET_X", value: "v" }),
    ],
    [
      "nodes.terminals.openTicket",
      (c) => c.nodes.terminals.openTicket({ nodeId: t.nodeId, cols: 80, rows: 24 }),
    ],
    [
      "nodes.commands.run",
      (c) =>
        c.nodes.commands.run({
          nodeId: t.nodeId,
          command: "id",
          timeoutMs: 10_000,
          confirm: "RUN",
        }),
    ],
    ["nodes.commands.get", (c) => c.nodes.commands.get({ commandId: t.commandId, cancel: true })],
    [
      "nodes.queued.enqueue",
      (c) =>
        c.nodes.queued.enqueue({ nodeId: t.nodeId, command: "id", note: "n", expiresInHours: 1 }),
    ],
    [
      "runtimes.start own runtime on the other's node",
      (c) => c.runtimes.start({ runtimeId: own.runtimeId, nodeIds: [t.nodeId] }),
    ],
    [
      "runtimes.start restart of the other's instance",
      (c) => c.runtimes.start({ runtimeId: own.runtimeId, instanceId: t.instanceId }),
    ],
    ["runtimes.start of the other's runtime", (c) => c.runtimes.start({ runtimeId: t.runtimeId })],
    ["runtimes.stop the other's instance", (c) => c.runtimes.stop({ instanceId: t.instanceId })],
    [
      "runtimes.stop the other's runtime on its node",
      (c) => c.runtimes.stop({ runtimeId: t.runtimeId, nodeId: t.nodeId }),
    ],
    ["runtimes.instances.forget", (c) => c.runtimes.instances.forget({ instanceId: t.instanceId })],
    [
      "runtimes.update the other's runtime",
      (c) => c.runtimes.update({ runtimeId: t.runtimeId, spec: SPEC }),
    ],
    [
      "runtimes.models.setCapabilities",
      (c) =>
        c.runtimes.models.setCapabilities({ runtimeModelId: t.runtimeModelId, capabilities: [] }),
    ],
    [
      "runtimes.create always-on on the other's node",
      (c) =>
        c.runtimes.create({
          slug: "squat",
          name: "Squat",
          kind: "ALWAYS_ON",
          nodeId: t.nodeId,
          spec: {
            api: "openai",
            engine: "vllm",
            modelType: "llm",
            address: { baseUrl: "http://127.0.0.1:8000" },
          },
        }),
    ],
    ["profiles.apply", (c) => c.profiles.apply({ profileId: t.profileId })],
    [
      "profiles.save with the other's node",
      (c) => c.profiles.save({ slug: "grab", name: "Grab", nodeIds: [t.nodeId], items: [] }),
    ],
    [
      "models.test on the other's runtime",
      (c) => c.models.test({ target: { runtimeId: t.runtimeId } }),
    ],
  ];

  /** Contributor and pool owner, both ways: each shares a pool with the other, both contribute. */
  const DIRECTIONS = [
    ["B (contributor to A's pool, A's runtime shared with B) on A's ids", () => [b, a] as const],
    ["A (owner of the pool B contributes to) on B's ids", () => [a, b] as const],
  ] as const;

  for (const [direction, pair] of DIRECTIONS) {
    describe(direction, () => {
      for (const [label] of credentialsOf(A)) {
        it(`${label}: every call is refused and nothing of the other's changes`, async () => {
          const [attacker, target] = pair();
          const auth = credentialsOf(attacker.userId).find(([name]) => name === label)?.[1];
          if (!auth) throw new Error(label);
          // The shares are really there.
          expect(
            await modules.fixtures.poolMember.count({
              where: { poolId: target.poolId, runtimeModelId: attacker.runtimeModelId },
            }),
          ).toBe(1);
          const before = await snapshotOf(target, attacker.userId);
          expect(before.instance).toMatchObject({
            userId: target.userId,
            desiredState: "RUNNING",
          });
          expect(before.ranks).toEqual([{ instanceId: target.instanceId, claim: "HELD" }]);
          const c = client(auth);
          for (const [name, call] of calls(target, attacker)) {
            const error = await call(c).then(
              () => new Error(`${name} succeeded`),
              (caught: unknown) => caught,
            );
            expect(error, name).toBeInstanceOf(ORPCError);
            const code = (error as ORPCError<string, unknown>).code;
            // CONFLICT: a person must preview a start first (preview_required).
            expect(
              ["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST", "CONFLICT"],
              `${name}: ${code}`,
            ).toContain(code);
            expect((error as Error).message, name).not.toBe("Input validation failed");
          }
          for (const hook of [
            ...Object.values(services.nodes),
            ...Object.values(services.nodeOperator),
            services.dispatchRuntimeOperation,
            services.pushRuntimeDefinitions,
            services.modelTest,
          ])
            expect(hook).not.toHaveBeenCalled();
          expect(await snapshotOf(target, attacker.userId)).toEqual(before);
        });
      }
    });
  }

  describe("start previews", () => {
    it("a person's start preview places nothing of B's on A's node", async () => {
      const result = await client(person(B)).runtimes.start({
        runtimeId: runtimeOfB,
        nodeIds: [a.nodeId],
        preview: true,
      });
      if (result.mode !== "preview") throw new Error("expected a preview");
      expect(result.preview.starts).toEqual([]);
      expect(result.preview.stops).toEqual([]);
      expect(result.preview.refusals).toEqual([
        expect.objectContaining({ reason: "unknown_node", subjectId: a.nodeId }),
      ]);
    });
  });

  describe("the database refuses cross-owner rows on its own", () => {
    /** The trigger's refusal, whatever Prisma wraps it in. */
    async function refused(write: Promise<unknown>, message: RegExp) {
      const error = await write.then(
        () => new Error("the write succeeded"),
        (caught: unknown) => caught,
      );
      // The database's own message (Prisma's error text also quotes this file's source).
      const text = String((error as Error).message);
      expect(/Message: `([^`]*)`/.exec(text)?.[1] ?? text.slice(0, 200)).toMatch(message);
    }

    it("no rank or step of B's instance on A's node", async () => {
      const db = modules.fixtures;
      const version = await db.runtime.findUniqueOrThrow({
        where: { id: runtimeOfB },
        select: { currentVersionId: true },
      });
      const instance = await db.runtimeInstance.create({
        data: {
          userId: B,
          runtimeId: runtimeOfB,
          versionId: version.currentVersionId ?? "",
          launchVersionId: version.currentVersionId ?? "",
          handle: `i-${RUN.slice(-12).padStart(12, "0")}`,
          startedBy: "AGENT",
          desiredState: "RUNNING",
          phase: "STARTING",
        },
        select: { id: true, handle: true },
      });
      await refused(
        db.instanceRank.create({
          data: {
            instanceId: instance.id,
            nodeId: a.nodeId,
            unitName: `wsmp-${instance.handle}-r0`,
            rank: 0,
            resources: {},
            port: 30009,
          },
        }),
        /an instance runs only on nodes of its owner/,
      );
      await refused(
        db.instanceStep.create({
          data: {
            instanceId: instance.id,
            nodeId: a.nodeId,
            rank: 0,
            phase: "START",
            sequence: 120,
            generation: 1,
            intent: {},
            intentHash: "d".repeat(64),
          },
        }),
        /an instance runs only on nodes of its owner/,
      );
      // A's own rank cannot be moved under B's instance either.
      const rank = await db.instanceRank.findFirstOrThrow({
        where: { instanceId: a.instanceId },
        select: { id: true },
      });
      await refused(
        db.instanceRank.update({ where: { id: rank.id }, data: { instanceId: instance.id } }),
        /an instance runs only on nodes of its owner/,
      );
      expect(await db.instanceRank.count({ where: { instanceId: instance.id } })).toBe(0);
      expect(await db.instanceStep.count({ where: { instanceId: instance.id } })).toBe(0);
    });

    it("no operation of B's stops A's instance", async () => {
      const db = modules.fixtures;
      const operation = await db.runtimeOperation.create({
        data: {
          userId: B,
          kind: "STOP",
          actor: "AGENT",
          actorUserId: B,
          agentTokenId: `${RUN}-tok`,
          summary: { stops: [a.instanceId] },
          fingerprint: "e".repeat(64),
        },
        select: { id: true },
      });
      await refused(
        db.runtimeInstance.update({
          where: { id: a.instanceId },
          data: { desiredState: "STOPPED", phase: "STOPPING", operationId: operation.id },
        }),
        /an instance is changed only by an operation of its owner/,
      );
      expect(
        await db.runtimeInstance.findUnique({
          where: { id: a.instanceId },
          select: { desiredState: true },
        }),
      ).toEqual({ desiredState: "RUNNING" });
    });

    it("a node keeps its owner", async () => {
      const db = modules.fixtures;
      // A bare node of A's (nothing that would follow it to B through a cascade).
      const bare = await db.node.create({
        data: { userId: A, slug: `${RUN}-bare`, trust: "FULL" },
        select: { id: true },
      });
      await refused(
        db.node.update({ where: { id: bare.id }, data: { userId: B } }),
        /a node keeps its owner/,
      );
      expect(
        await db.node.findUnique({ where: { id: bare.id }, select: { userId: true } }),
      ).toEqual({ userId: A });
    });
  });
});

import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeSpec } from "../lib/runtime-spec";
import { CALLERS, contextFor } from "./lane-c-test-helpers";

// Lane F on real PostgreSQL: a start that preempts, a multi-node start on a fabric, a stop and a
// profile apply all write through the graph-write fences the hardening triggers enforce
// (`enforce_graph_write_fence`), the reserved-port index and the instance shape checks.
// Mocked router tests cannot see any of these.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const RUN = `lf${Date.now().toString(36)}`;
const USER = `${RUN}-user`;

function spec(groupSize: number, memoryGb: number): RuntimeSpec {
  return {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: `m-${groupSize}-${memoryGb}` }],
    launch: {
      management: "process",
      groupSize,
      resources: [{ kind: "unified", memoryGb }],
      labels: [],
      commands: [
        {
          start: `vllm serve m --host ${groupSize > 1 ? "{{fabric_ip}}" : "127.0.0.1"} --port {{port}}`,
          stop: "true",
        },
      ],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
    },
  };
}

integration("placement writes on PostgreSQL", () => {
  let modules: {
    prisma: typeof import("@ws-model-proxy/db").default;
    graph: typeof import("../lib/graph-write");
    runtimes: typeof import("./runtimes");
    profiles: typeof import("../profiles/procedures");
  };
  const nodeIds: string[] = [];
  let fabricId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const [db, graph, runtimes, profiles] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("../lib/graph-write"),
      import("./runtimes"),
      import("../profiles/procedures"),
    ]);
    modules = { prisma: db.default, graph, runtimes, profiles };
    await modules.prisma.user.create({
      data: { id: USER, name: "Lane F", email: `${USER}@example.test`, emailVerified: true },
    });
    // Two 66 GiB "sparks" on one fabric (64 usable after the unified headroom).
    await graph.graphWrite([USER], async (tx) => {
      for (const slug of ["spark-a", "spark-b"]) {
        const node = await tx.node.create({
          data: {
            userId: USER,
            slug,
            connection: "ONLINE",
            trust: "FULL",
            declaredResources: { kind: "unified", memoryGb: 66 },
            portStart: 30000,
            portEnd: 30010,
          },
          select: { id: true },
        });
        nodeIds.push(node.id);
      }
      const fabric = await tx.fabric.create({
        data: { userId: USER, name: "pair" },
        select: { id: true },
      });
      fabricId = fabric.id;
      await tx.fabricMember.createMany({
        data: nodeIds.map((nodeId, index) => ({
          userId: USER,
          fabricId,
          nodeId,
          ip: `10.77.0.${index + 1}`,
        })),
      });
    });
  });

  afterAll(async () => {
    // Remove every row this run seeded, children first, each delete scoped to this run's user
    // (WHERE). The fixture client is for test setup and teardown only.
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    const fixture = createFixturePrismaClient(databaseUrl ?? "");
    try {
      // Operations first: a profile apply's operation must name its profile.
      await fixture.runtimeOperation.deleteMany({ where: { userId: USER } });
      await fixture.profile.deleteMany({ where: { userId: USER } });
      await fixture.runtimeInstance.deleteMany({ where: { userId: USER } });
      await fixture.user.deleteMany({ where: { id: USER } });
      expect(await fixture.node.count({ where: { userId: USER } })).toBe(0);
      expect(await fixture.runtime.count({ where: { userId: USER } })).toBe(0);
    } finally {
      await fixture.$disconnect();
      await modules?.prisma.$disconnect();
    }
  });

  const client = (auth = CALLERS.person(USER)) =>
    createRouterClient(modules.runtimes.runtimesRouter, { context: contextFor(auth) });

  /** What the relay does once a node proves a stop: the claims are released. */
  async function nodeProvesStops() {
    await modules.graph.graphWrite([USER], async (tx) => {
      const stopping = await tx.runtimeInstance.findMany({
        where: { userId: USER, desiredState: "STOPPED", phase: "STOPPING" },
        select: { id: true },
      });
      const ids = stopping.map((instance) => instance.id);
      await tx.instanceRank.updateMany({
        where: { instanceId: { in: ids }, claim: "HELD" },
        data: { claim: "RELEASED", claimChangedAt: new Date(), stoppedAt: new Date() },
      });
      await tx.runtimeInstance.updateMany({
        where: { id: { in: ids } },
        data: { phase: "STOPPED", fabricId: null },
      });
    });
  }

  async function createRuntime(slug: string, groupSize: number, memoryGb: number) {
    const created = await client().create({
      slug,
      name: slug,
      kind: "STARTABLE",
      spec: spec(groupSize, memoryGb),
    });
    return created.runtime.id;
  }

  it("an agent's start, then a two-node start that preempts it, a person's confirmed start and a stop", async () => {
    const small = await createRuntime(`${RUN}-small`, 1, 40);
    const pair = await createRuntime(`${RUN}-pair`, 2, 50);

    const first = await client(CALLERS.fullAgent(USER)).start({ runtimeId: small });
    if (first.mode !== "applied") throw new Error("expected an applied start");
    const smallInstance = first.operation.instances[0]?.id;
    expect(smallInstance).toBeDefined();

    // 64 - 40 = 24 left on one spark: the pair needs 50 on both, so the small one is stopped.
    const second = await client(CALLERS.fullAgent(USER)).start({ runtimeId: pair });
    if (second.mode !== "applied") throw new Error("expected an applied start");
    const stopped = await modules.prisma.runtimeInstance.findUniqueOrThrow({
      where: { id: smallInstance ?? "" },
      select: { desiredState: true, phase: true, phaseReason: true, operationId: true },
    });
    expect(stopped).toEqual({
      desiredState: "STOPPED",
      phase: "STOPPING",
      phaseReason: "preempted",
      operationId: second.operation.id,
    });
    const pairInstance = await modules.prisma.runtimeInstance.findFirstOrThrow({
      where: { runtimeId: pair },
      select: {
        id: true,
        fabricId: true,
        Ranks: {
          orderBy: { rank: "asc" },
          select: { nodeId: true, port: true, distPort: true, blockedBy: true },
        },
      },
    });
    expect(pairInstance.fabricId).toBe(fabricId);
    expect(pairInstance.Ranks).toHaveLength(2);
    for (const rank of pairInstance.Ranks) {
      expect(rank.distPort).not.toBeNull();
      expect(rank.port).not.toBe(rank.distPort);
    }
    // The stopped instance still holds its claim until the node proves the stop: one rank of
    // the pair waits behind it.
    expect(pairInstance.Ranks.flatMap((rank) => rank.blockedBy)).toContain(smallInstance);

    // A person: preview (the pair is preempted), then apply exactly that preview.
    const preview = await client().start({ runtimeId: small, preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.stops.map((stop) => stop.instanceId)).toEqual([pairInstance.id]);
    const applied = await client().start({
      runtimeId: small,
      fingerprint: preview.preview.fingerprint,
    });
    expect(applied.mode).toBe("applied");
    const pairNow = await modules.prisma.runtimeInstance.findUniqueOrThrow({
      where: { id: pairInstance.id },
      select: { desiredState: true, phaseReason: true },
    });
    expect(pairNow).toEqual({ desiredState: "STOPPED", phaseReason: "preempted" });

    // Stop what runs (fenced on the instance's capacity fence).
    const stop = await client(CALLERS.fullAgent(USER)).stop({ runtimeId: small });
    expect(stop.kind).toBe("STOP");
    const running = await modules.prisma.runtimeInstance.count({
      where: { userId: USER, desiredState: "RUNNING" },
    });
    expect(running).toBe(0);
  });

  it("a restart retakes its own claim on its own port", async () => {
    await nodeProvesStops();
    const solo = await createRuntime(`${RUN}-solo`, 1, 4);
    const started = await client(CALLERS.fullAgent(USER)).start({ runtimeId: solo });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = started.operation.instances[0]?.id ?? "";
    const before = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { instanceId },
      select: { port: true },
    });
    const restarted = await client(CALLERS.fullAgent(USER)).start({
      runtimeId: solo,
      instanceId,
    });
    expect(restarted.mode).toBe("applied");
    const after = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { instanceId },
      select: { port: true, claim: true },
    });
    expect(after).toEqual({ port: before.port, claim: "HELD" });
  });

  it("a Full agent forgets an unprovable stop on a Full-control node, audited on the node", async () => {
    await nodeProvesStops();
    const lone = await createRuntime(`${RUN}-lone`, 1, 4);
    const started = await client(CALLERS.fullAgent(USER)).start({ runtimeId: lone });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = started.operation.instances[0]?.id ?? "";
    await client(CALLERS.fullAgent(USER)).stop({ instanceId });
    const view = await client(CALLERS.fullAgent(USER)).instances.forget({
      instanceId,
      confirm: "FORGET",
      note: "process already gone",
    });
    expect(view.id).toBe(instanceId);
    const rank = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { instanceId },
      select: { claim: true, nodeId: true },
    });
    expect(rank.claim).toBe("HELD_UNKNOWN");
    const audit = await modules.prisma.nodeAuditEvent.findFirstOrThrow({
      where: { userId: USER, kind: "claim_forget", instanceId },
    });
    expect(audit).toMatchObject({
      nodeId: rank.nodeId,
      actor: "AGENT",
      agentTokenId: "tok-1",
      subject: `instance:${instanceId} rank:0`,
      reason: "process already gone",
    });
  });

  it("a person's profile apply commits its operation and holds through the fences", async () => {
    await nodeProvesStops();
    const profileRuntime = await createRuntime(`${RUN}-profile`, 1, 8);
    const profiles = createRouterClient(modules.profiles.profileProcedures, {
      context: contextFor(CALLERS.person(USER)),
    });
    const saved = await profiles.save({
      slug: `${RUN}-p`,
      name: "Lane F profile",
      nodeIds,
      items: [{ runtimeId: profileRuntime, count: 2 }],
    });
    const preview = await profiles.apply({ profileId: saved.id, preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals).toEqual([]);
    expect(preview.preview.starts).toHaveLength(2);
    const applied = await profiles.apply({
      profileId: saved.id,
      fingerprint: preview.preview.fingerprint,
    });
    expect(applied.mode).toBe("applied");
    const operation = await modules.prisma.runtimeOperation.findFirstOrThrow({
      where: { userId: USER, kind: "PROFILE_APPLY" },
      select: { fingerprint: true },
    });
    expect(operation.fingerprint).toBe(preview.preview.fingerprint);
  });
});

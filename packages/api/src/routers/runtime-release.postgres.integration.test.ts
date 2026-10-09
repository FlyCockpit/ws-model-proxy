import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeSpec } from "../lib/runtime-spec";
import { CALLERS, contextFor } from "./lane-c-test-helpers";

// "I've checked, release it" on real PostgreSQL: a node part marked stopped keeps its resources
// and its port until a person releases it without proof (or approves an agent's request); then
// a new instance is placed into exactly that capacity. The hardening triggers (graph-write
// fences, the reserved-port index, the claim and request shapes) see every write.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const RUN = `ru${Date.now().toString(36)}`;
const USER = `${RUN}-user`;

function spec(model: string): RuntimeSpec {
  return {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: model }],
    launch: {
      management: "process",
      groupSize: 1,
      // 40 of the node's 64 usable GiB: two never fit at once.
      resources: [{ kind: "unified", memoryGb: 40 }],
      labels: [],
      commands: [{ start: "vllm serve m --host 127.0.0.1 --port {{port}}", stop: "true" }],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
    },
  };
}

integration("releasing a claim whose stop cannot be proven, on PostgreSQL", () => {
  let modules: {
    prisma: typeof import("@ws-model-proxy/db").default;
    graph: typeof import("../lib/graph-write");
    release: typeof import("../lib/claim-release");
    runtimes: typeof import("./runtimes");
  };
  let nodeId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [db, graph, release, runtimes] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("../lib/graph-write"),
      import("../lib/claim-release"),
      import("./runtimes"),
    ]);
    modules = { prisma: db.default, graph, release, runtimes };
    await modules.prisma.user.create({
      data: { id: USER, name: "Release", email: `${USER}@example.test`, emailVerified: true },
    });
    // One node with one port: the held claim blocks both the memory and the port.
    nodeId = await graph.graphWrite([USER], async (tx) => {
      const node = await tx.node.create({
        data: {
          userId: USER,
          slug: "spark",
          connection: "ONLINE",
          trust: "FULL",
          declaredResources: { kind: "unified", memoryGb: 66 },
          portStart: 30000,
          portEnd: 30000,
        },
        select: { id: true },
      });
      return node.id;
    });
  });

  afterAll(async () => {
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    const fixture = createFixturePrismaClient(databaseUrl ?? "");
    try {
      await fixture.runtimeOperation.deleteMany({ where: { userId: USER } });
      await fixture.runtimeInstance.deleteMany({ where: { userId: USER } });
      await fixture.nodeAuditEvent.deleteMany({ where: { userId: USER } });
      await fixture.user.deleteMany({ where: { id: USER } });
      expect(await fixture.claimReleaseRequest.count({ where: { userId: USER } })).toBe(0);
      expect(await fixture.node.count({ where: { userId: USER } })).toBe(0);
    } finally {
      await fixture.$disconnect();
      await modules?.prisma.$disconnect();
    }
  });

  const client = (auth = CALLERS.person(USER)) =>
    createRouterClient(modules.runtimes.runtimesRouter, { context: contextFor(auth) });
  const agent = () => client(CALLERS.fullAgent(USER));

  async function startOne(slug: string) {
    const created = await client().create({
      slug,
      name: slug,
      kind: "STARTABLE",
      spec: spec(slug),
    });
    const started = await agent().start({ runtimeId: created.runtime.id });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    return { runtimeId: created.runtime.id, instanceId: started.operation.instances[0]?.id ?? "" };
  }

  /** Stopped, its stop never proven, then marked stopped by a person: HELD_UNKNOWN. */
  async function markedStopped(instanceId: string) {
    await agent().stop({ instanceId });
    await client().instances.markStopped({ instanceId });
    const rank = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { instanceId },
      select: { id: true, claim: true, port: true },
    });
    expect(rank.claim).toBe("HELD_UNKNOWN");
    return rank;
  }

  it("a person's release frees the capacity for a new instance; a late proof changes nothing", async () => {
    const old = await startOne(`${RUN}-old`);
    const held = await markedStopped(old.instanceId);
    const next = await client().create({
      slug: `${RUN}-next`,
      name: "next",
      kind: "STARTABLE",
      spec: spec(`${RUN}-next`),
    });
    // The held claim still counts: nothing fits.
    await expect(agent().start({ runtimeId: next.runtime.id })).rejects.toBeDefined();

    // Agents may only ask; a person decides.
    await expect(
      agent().instances.releaseUnproven({ instanceId: old.instanceId, nodeNumber: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const asked = await agent().releaseRequests.create({
      instanceId: old.instanceId,
      findings: "ss -ltnp shows nothing on 30000; no vllm process left",
      evidence: [{ command: "ss -ltnp", output: "State Recv-Q" }],
    });
    expect(asked.state).toBe("PENDING");
    await expect(
      agent().releaseRequests.create({ instanceId: old.instanceId, findings: "again" }),
    ).rejects.toMatchObject({ data: { reason: "release_request_pending" } });
    const pending = await client().releaseRequests.list({ instanceId: old.instanceId });
    expect(pending.items).toMatchObject([
      { id: asked.requestId, nodeNumber: 1, nodeSlug: "spark", agentName: null },
    ]);

    const view = await client().releaseRequests.approve({ requestId: asked.requestId });
    expect(view.ranks[0]).toMatchObject({ reserved: "RELEASED", releaseRequestId: null });
    const released = await modules.prisma.instanceRank.findUniqueOrThrow({
      where: { id: held.id },
      select: {
        claim: true,
        releasedUnprovenAt: true,
        releasedUnprovenBy: true,
        releasedUnprovenReason: true,
        lastStopCheckAt: true,
      },
    });
    expect(released).toMatchObject({
      claim: "RELEASED",
      releasedUnprovenBy: USER,
      // No status probe ever finished on this node.
      releasedUnprovenReason: "no_check",
    });
    expect(released.releasedUnprovenAt).toBeInstanceOf(Date);
    expect(
      await modules.prisma.claimReleaseRequest.findUniqueOrThrow({
        where: { id: asked.requestId },
        select: { state: true, pendingRankId: true, decidedBy: true },
      }),
    ).toEqual({ state: "APPROVED", pendingRankId: null, decidedBy: USER });
    const audit = await modules.prisma.nodeAuditEvent.findMany({
      where: {
        userId: USER,
        instanceId: old.instanceId,
        kind: { in: ["claim_released", "claim_release_request"] },
      },
      orderBy: { createdAt: "asc" },
      select: { kind: true, actor: true, outcome: true, nodeId: true },
    });
    expect(audit).toEqual([
      { kind: "claim_release_request", actor: "AGENT", outcome: "opened", nodeId },
      { kind: "claim_released", actor: "USER", outcome: "completed", nodeId },
    ]);
    // Out of the periodic stop-proof rotation: it only takes claims marked stopped.
    expect(
      await modules.prisma.instanceRank.count({ where: { id: held.id, claim: "HELD_UNKNOWN" } }),
    ).toBe(0);

    // A real proof arriving late: the proven-stop release finds nothing to release.
    const late = await modules.graph.graphWrite(
      [USER],
      (tx) => modules.release.releaseClaim(tx, held.id, new Date()),
      async () => modules.graph.instanceCapacityFences([old.instanceId]),
    );
    expect(late).toBe(false);
    expect(
      await modules.prisma.instanceRank.findUniqueOrThrow({
        where: { id: held.id },
        select: { claim: true, releasedUnprovenBy: true },
      }),
    ).toEqual({ claim: "RELEASED", releasedUnprovenBy: USER });
    // Releasing again is refused, never a second record.
    await expect(
      client().instances.releaseUnproven({ instanceId: old.instanceId, nodeNumber: 1 }),
    ).rejects.toMatchObject({ data: { reason: "already_released" } });

    // The capacity (memory and the node's only port) is placed again.
    const started = await agent().start({ runtimeId: next.runtime.id });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const placed = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { instanceId: started.operation.instances[0]?.id ?? "" },
      select: { nodeId: true, port: true, claim: true },
    });
    expect(placed).toEqual({ nodeId, port: held.port, claim: "HELD" });
    await agent().stop({ instanceId: started.operation.instances[0]?.id ?? "" });
    await client().instances.markStopped({ instanceId: started.operation.instances[0]?.id ?? "" });
  });

  it("a person releases directly; a declined, withdrawn or expired request releases nothing", async () => {
    // The previous case left its instance marked stopped on the node: release it directly.
    const leftover = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { nodeId, claim: "HELD_UNKNOWN" },
      select: { id: true, instanceId: true },
    });
    const asked = await agent().releaseRequests.create({
      instanceId: leftover.instanceId,
      findings: "checked",
    });
    await expect(
      agent().releaseRequests.withdraw({ instanceId: leftover.instanceId }),
    ).resolves.toMatchObject({ requestId: asked.requestId, state: "WITHDRAWN" });
    const again = await agent().releaseRequests.create({
      instanceId: leftover.instanceId,
      findings: "checked again",
    });
    const declined = await client().releaseRequests.decline({ requestId: again.requestId });
    expect(declined.state).toBe("DECLINED");
    await expect(
      client().releaseRequests.approve({ requestId: again.requestId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await modules.prisma.instanceRank.findUniqueOrThrow({
        where: { id: leftover.id },
        select: { claim: true },
      }),
    ).toEqual({ claim: "HELD_UNKNOWN" });

    // A request whose claim a proof released meanwhile is cleared by the sweep.
    const third = await agent().releaseRequests.create({
      instanceId: leftover.instanceId,
      findings: "third look",
    });
    await client().instances.releaseUnproven({
      instanceId: leftover.instanceId,
      nodeNumber: 1,
      note: "checked with nvidia-smi",
    });
    expect(
      await modules.prisma.claimReleaseRequest.findUniqueOrThrow({
        where: { id: third.requestId },
        select: { state: true },
      }),
    ).toEqual({ state: "CLEARED" });
    expect(await modules.release.sweepReleaseRequests(modules.prisma, new Date())).toBe(0);
    expect(
      await modules.prisma.instanceRank.count({ where: { nodeId, claim: { not: "RELEASED" } } }),
    ).toBe(0);

    // Restarting the released instance retakes its claim: the release record is cleared (the
    // claim shape allows it only on a released claim).
    const instance = await modules.prisma.runtimeInstance.findUniqueOrThrow({
      where: { id: leftover.instanceId },
      select: { runtimeId: true },
    });
    const restarted = await agent().start({
      runtimeId: instance.runtimeId,
      instanceId: leftover.instanceId,
    });
    expect(restarted.mode).toBe("applied");
    expect(
      await modules.prisma.instanceRank.findUniqueOrThrow({
        where: { id: leftover.id },
        select: { claim: true, releasedUnprovenAt: true, releasedUnprovenBy: true },
      }),
    ).toEqual({ claim: "HELD", releasedUnprovenAt: null, releasedUnprovenBy: null });
  });
});

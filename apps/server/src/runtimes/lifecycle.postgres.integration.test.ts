import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The runtime lifecycle engine on real PostgreSQL: the graph-write fences, the step/claim/
// instance CHECKs and triggers. The relay is a fake that records every job and answers as the
// node would; the engine runs tick by tick (runOnce).

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

type Modules = {
  lifecycle: typeof import("./lifecycle.js");
  frames: typeof import("../relay/frames.js");
  fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
};

type Job = import("../relay/frames.js").RuntimeJobFrame;

integration("runtime lifecycle (PostgreSQL)", () => {
  let m: Modules;
  const suffix = randomUUID().slice(0, 8);
  const userId = `lc-${suffix}`;
  const nodeId = `lcnode${suffix}`;
  let runtimeId = "";
  let versionId = "";
  const sent: Job[] = [];
  const session = { connectionGeneration: 1, trust: "full" as "full" | "relay", online: true };
  const ref = () => ({
    nodeId,
    userId,
    slug: `lc-${suffix}`,
    connectionGeneration: 1,
    trust: session.trust,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    m = {
      lifecycle: await import("./lifecycle.js"),
      frames: await import("../relay/frames.js"),
      fixture: createFixturePrismaClient(databaseUrl ?? ""),
      prisma: (await import("@ws-model-proxy/db")).default,
    };
    const db = m.fixture;
    await db.user.create({
      data: { id: userId, name: "Lifecycle", email: `${userId}@example.test` },
    });
    await db.node.create({
      data: {
        id: nodeId,
        userId,
        slug: `lc-${suffix}`,
        connection: "ONLINE",
        connectionGeneration: 1,
        trust: "FULL",
      },
    });
    const spec = {
      api: "openai",
      engine: "vllm",
      modelType: "llm",
      models: [{ id: "m" }],
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "none" }],
        labels: [],
        commands: [{ start: "serve --port {{port}}", stop: "true" }],
        readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
        health: { intervalMs: 15_000, failureThreshold: 2, successThreshold: 1 },
      },
    };
    const runtime = await db.runtime.create({
      data: { userId, slug: `lc-${suffix}`, name: "LC", kind: "STARTABLE", origin: "SERVER" },
    });
    runtimeId = runtime.id;
    const version = await db.runtimeVersion.create({
      data: {
        runtimeId,
        version: 1,
        editor: "USER",
        editorUserId: userId,
        contentHash: hex(`content-${suffix}`),
        launchHash: hex(`launch-${suffix}`),
        spec,
        api: "OPENAI",
        engine: "VLLM",
        modelType: "LLM",
        // One automatic restart at most.
        advanced: { restartBudget: 1 },
      },
    });
    versionId = version.id;
    await db.runtime.update({ where: { id: runtimeId }, data: { currentVersionId: versionId } });
    await db.runtimeModel.create({
      data: { userId, runtimeId, upstreamModelId: "m", type: "LLM" },
    });
  });

  afterAll(async () => {
    if (!m) return;
    const db = m.fixture;
    try {
      // Children first, every delete scoped to this run (WHERE).
      await db.runtimeInstance.deleteMany({ where: { userId } });
      await db.runtimeOperation.deleteMany({ where: { userId } });
      await db.runtime.updateMany({ where: { userId }, data: { currentVersionId: null } });
      await db.runtime.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } });
      expect(await db.node.count({ where: { userId } })).toBe(0);
    } finally {
      await db.$disconnect();
      await m.prisma.$disconnect();
    }
  });

  function engine() {
    return new m.lifecycle.RuntimeLifecycle({
      sendToNode: (_nodeId, frame) => {
        if (frame.type === "runtime.job") sent.push(frame);
        return true;
      },
      nodeSession: (id) =>
        id === nodeId && session.online
          ? { connectionGeneration: session.connectionGeneration, trust: session.trust }
          : null,
    });
  }

  async function startInstance(port: number, startedBy: "USER" | "AGENT" = "USER") {
    const db = m.fixture;
    const operation = await db.runtimeOperation.create({
      data: {
        userId,
        kind: "START",
        actor: "USER",
        actorUserId: userId,
        summary: {},
        fingerprint: hex(`op-${port}`),
      },
    });
    const id = `c${hex(`${suffix}-${port}`).slice(0, 23)}`;
    const handle = `i-${id.slice(0, 12)}`;
    await db.runtimeInstance.create({
      data: {
        id,
        userId,
        runtimeId,
        versionId,
        launchVersionId: versionId,
        handle,
        operationId: operation.id,
        startedBy,
        desiredState: "RUNNING",
        phase: "STARTING",
        Ranks: {
          create: [
            { nodeId, rank: 0, unitName: `wsmp-${handle}-r0`, port, resources: { kind: "none" } },
          ],
        },
      },
    });
    return id;
  }

  async function answer(
    lc: InstanceType<Modules["lifecycle"]["RuntimeLifecycle"]>,
    job: Job,
    status: "succeeded" | "failed",
    extra: { stopped?: boolean; error?: "command_failed" } = {},
  ) {
    await lc.handleJobResult(ref(), {
      type: "runtime.job.result",
      stepId: job.stepId,
      instanceId: job.instanceId,
      rank: job.rank,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      status,
      stopped: extra.stopped ?? false,
      ...(status === "failed" ? { error: extra.error ?? "command_failed" } : {}),
    });
  }

  const lastJob = (instanceId: string, phase: Job["phase"]) => {
    const job = [...sent].reverse().find((j) => j.instanceId === instanceId && j.phase === phase);
    if (!job) throw new Error(`no ${phase} job for ${instanceId}`);
    return job;
  };

  const instance = (id: string) =>
    m.fixture.runtimeInstance.findUniqueOrThrow({ where: { id }, include: { Ranks: true } });

  it("starts, becomes READY with targets, probes health and stops with proof", async () => {
    const lc = engine();
    const id = await startInstance(30_101);
    await lc.runOnce();
    const start = lastJob(id, "start");
    expect(m.frames.runtimeJobFrameSchema.safeParse(start).success).toBe(true);
    expect(start.placeholders.port).toBe(30_101);
    // Readiness waits for the start.
    expect(sent.some((j) => j.instanceId === id && j.phase === "readiness")).toBe(false);
    await answer(lc, start, "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
    expect(await m.fixture.executionTarget.count({ where: { instanceId: id } })).toBe(1);

    // Two failed probes make it UNHEALTHY.
    for (let n = 0; n < 2; n++) {
      await m.fixture.runtimeInstance.update({
        where: { id },
        data: { lastHealthAt: new Date(Date.now() - 60_000) },
      });
      await lc.runOnce();
      await answer(lc, lastJob(id, "health"), "failed", { error: "command_failed" });
    }
    expect((await instance(id)).phase).toBe("UNHEALTHY");

    // A person stops it: a stop step, then the proof releases the claim.
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
    });
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    const stopped = await instance(id);
    expect(stopped.phase).toBe("STOPPED");
    expect(stopped.Ranks[0]?.claim).toBe("RELEASED");
  });

  it("gang-stops a failed start, restarts it once with a leading stop, then fails", async () => {
    const lc = engine();
    const id = await startInstance(30_102);
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "failed", { error: "command_failed" });
    let row = await instance(id);
    expect(row.phase).toBe("STOPPING");
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.nextRestartAt).not.toBeNull();

    // The backoff passed: the claim is retaken and generation 2 starts with a stop.
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { nextRestartAt: new Date(Date.now() - 1_000) },
    });
    const before = sent.length;
    await lc.runOnce();
    row = await instance(id);
    expect(row.phase).toBe("STARTING");
    expect(row.Ranks[0]?.claim).toBe("HELD");
    const leading = sent.slice(before).find((j) => j.instanceId === id);
    expect(leading?.phase).toBe("stop");
    expect(leading?.generation).toBe(2);
    if (!leading) return;
    await answer(lc, leading, "succeeded", { stopped: true });
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "failed", { error: "command_failed" });
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    row = await instance(id);
    // The budget (1) is used up.
    expect(row.phase).toBe("FAILED");
    expect(row.phaseReason).toBe("restart_budget_exhausted");
  });

  it("never runs an agent's start on a Relay-only node; the claim is released", async () => {
    session.trust = "relay";
    await m.fixture.node.update({ where: { id: nodeId }, data: { trust: "RELAY" } });
    try {
      const lc = engine();
      const id = await startInstance(30_103, "AGENT");
      const before = sent.length;
      await lc.runOnce();
      await lc.runOnce();
      expect(sent.slice(before).some((j) => j.instanceId === id)).toBe(false);
      const row = await instance(id);
      expect(row.Ranks[0]?.claim).toBe("RELEASED");
      const step = await m.fixture.instanceStep.findFirst({
        where: { instanceId: id, phase: "START" },
      });
      expect(step?.errorCode).toBe("trust_relay");
    } finally {
      session.trust = "full";
      await m.fixture.node.update({ where: { id: nodeId }, data: { trust: "FULL" } });
    }
  });

  it("settles a forgotten stop and releases it once a status probe proves it", async () => {
    const lc = engine();
    const id = await startInstance(30_104);
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
    });
    await lc.runOnce();
    // The stop cannot be proven; a person forgets it (what instances.forget writes).
    await answer(lc, lastJob(id, "stop"), "failed", { error: "command_failed" });
    await m.fixture.instanceRank.updateMany({
      where: { instanceId: id },
      data: { claim: "HELD_UNKNOWN", forgottenAt: new Date(), forgottenBy: userId },
    });
    await lc.runOnce();
    let row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    // The probe (status) proves it stopped: the claim is released.
    const status = lastJob(id, "status");
    await answer(lc, status, "succeeded", { stopped: true });
    row = await instance(id);
    expect(row.Ranks[0]?.claim).toBe("RELEASED");
  });

  async function ready(lc: ReturnType<typeof engine>, port: number) {
    const id = await startInstance(port);
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
    return id;
  }

  it("asks a person to Forget a stop whose node stays offline", async () => {
    const lc = engine();
    const id = await ready(lc, 30_105);
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
    });
    await lc.runOnce();
    lastJob(id, "stop");
    // The node goes away before answering, and stays away.
    session.online = false;
    await lc.nodeDisconnected(ref());
    await m.fixture.node.update({
      where: { id: nodeId },
      data: { connection: "OFFLINE", lastDisconnectedAt: new Date(Date.now() - 11 * 60_000) },
    });
    try {
      await lc.runOnce();
      const row = await instance(id);
      expect(row.phase).toBe("STOPPING");
      expect(row.needsOperator).toBe("FORGET");
      expect(row.Ranks[0]?.claim).toBe("HELD");
    } finally {
      session.online = true;
      await m.fixture.node.update({
        where: { id: nodeId },
        data: { connection: "ONLINE", lastDisconnectedAt: null },
      });
    }
    // Back online: the queued stop goes out and its proof settles it.
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    expect((await instance(id)).phase).toBe("STOPPED");
  });

  it("a new server process re-sends steps the old one never saw answered", async () => {
    const first = engine();
    const id = await startInstance(30_106);
    await first.runOnce();
    const lost = lastJob(id, "start");
    // A restart: a new process (new epoch) sees the node reconnect.
    const second = engine();
    await second.requeueStale(ref());
    await second.runOnce();
    const again = lastJob(id, "start");
    expect(again.ownerEpoch).not.toBe(lost.ownerEpoch);
    // The old process's answer is not this process's: ignored.
    await answer(second, lost, "failed", { error: "command_failed" });
    expect((await instance(id)).phase).toBe("STARTING");
    await answer(second, again, "succeeded");
    await second.runOnce();
    await answer(second, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
  });

  it("gang-stops a ready instance whose rank the node no longer runs", async () => {
    const lc = engine();
    const id = await ready(lc, 30_107);
    await lc.runtimeInventory(ref(), { snapshotId: "s1", alwaysOn: [], instances: [] });
    const row = await instance(id);
    expect(row.phase).toBe("STOPPING");
    expect(row.phaseReason).toBe("crashed");
  });
});

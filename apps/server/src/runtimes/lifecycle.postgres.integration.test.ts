import { createHash, randomUUID } from "node:crypto";
import { runtimeLaunchHash } from "@ws-model-proxy/api/lib/runtime-launch-hash";
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
  /** A service runtime whose start a person runs in an operator terminal. */
  let operatorRuntimeId = "";
  let operatorVersionId = "";
  /** A service whose stop a person runs in an operator terminal. */
  let stopperRuntimeId = "";
  let stopperVersionId = "";
  /** A runtime whose stop, status and health commands are all the stub `true`. */
  let stubRuntimeId = "";
  let stubVersionId = "";
  const sent: Job[] = [];
  const session = { connectionGeneration: 1, trust: "full" as "full" | "relay", online: true };
  /** The fake relay's operator-terminal side. */
  const operatorRelay = {
    supported: true,
    room: true,
    closeAnswer: "closed" as "closed" | "running" | "absent",
    closed: [] as string[],
    closedTerminals: [] as string[],
  };
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
    const operatorSpec = {
      ...spec,
      launch: {
        ...spec.launch,
        management: "service",
        commands: [
          {
            start: "sudo systemctl start llm --port {{port}}",
            stop: "sudo systemctl stop llm",
            status: "systemctl is-active llm",
            interactive: { start: true },
          },
        ],
      },
    };
    const operatorRuntime = await db.runtime.create({
      data: { userId, slug: `lco-${suffix}`, name: "LCO", kind: "STARTABLE", origin: "SERVER" },
    });
    operatorRuntimeId = operatorRuntime.id;
    const operatorVersion = await db.runtimeVersion.create({
      data: {
        runtimeId: operatorRuntimeId,
        version: 1,
        // A system-written version: its command's author is "unknown" to the person.
        editor: "SYSTEM",
        editorUserId: userId,
        contentHash: hex(`content-op-${suffix}`),
        launchHash: hex(`launch-op-${suffix}`),
        spec: operatorSpec,
        api: "OPENAI",
        engine: "VLLM",
        modelType: "LLM",
      },
    });
    operatorVersionId = operatorVersion.id;
    await db.runtime.update({
      where: { id: operatorRuntimeId },
      data: { currentVersionId: operatorVersionId },
    });
    // A service whose stop a person runs in an operator terminal (its start is automatic).
    const stopperSpec = {
      ...spec,
      launch: {
        ...spec.launch,
        management: "service",
        commands: [
          {
            start: "systemctl start llm --port {{port}}",
            stop: "sudo systemctl stop llm",
            status: "systemctl is-active llm",
            interactive: { stop: true },
          },
        ],
      },
    };
    const stopperRuntime = await db.runtime.create({
      data: { userId, slug: `lcs-${suffix}`, name: "LCS", kind: "STARTABLE", origin: "SERVER" },
    });
    stopperRuntimeId = stopperRuntime.id;
    const stopperVersion = await db.runtimeVersion.create({
      data: {
        runtimeId: stopperRuntimeId,
        version: 1,
        editor: "USER",
        editorUserId: userId,
        contentHash: hex(`content-stop-${suffix}`),
        launchHash: hex(`launch-stop-${suffix}`),
        spec: stopperSpec,
        api: "OPENAI",
        engine: "VLLM",
        modelType: "LLM",
      },
    });
    stopperVersionId = stopperVersion.id;
    await db.runtime.update({
      where: { id: stopperRuntimeId },
      data: { currentVersionId: stopperVersionId },
    });
  });

  beforeAll(async () => {
    const db = m.fixture;
    const stub = await db.runtime.create({
      data: { userId, slug: `lct-${suffix}`, name: "LCT", kind: "STARTABLE", origin: "SERVER" },
    });
    stubRuntimeId = stub.id;
    const version = await db.runtimeVersion.create({
      data: {
        runtimeId: stubRuntimeId,
        version: 1,
        editor: "USER",
        editorUserId: userId,
        contentHash: hex(`content-stub-${suffix}`),
        launchHash: hex(`launch-stub-${suffix}`),
        spec: {
          api: "openai",
          engine: "other",
          modelType: "llm",
          models: [{ id: "m" }],
          launch: {
            management: "process",
            groupSize: 1,
            resources: [{ kind: "none" }],
            labels: [],
            commands: [
              {
                start: "python3 -m http.server {{port}}",
                stop: "true",
                status: "true",
                health: "true",
              },
            ],
            readiness: { path: "/", expectedStatus: 200, timeoutMs: 60_000 },
            health: { intervalMs: 15_000, failureThreshold: 2, successThreshold: 1 },
          },
        },
        api: "OPENAI",
        engine: "OTHER",
        modelType: "LLM",
      },
    });
    stubVersionId = version.id;
    await db.runtime.update({
      where: { id: stubRuntimeId },
      data: { currentVersionId: stubVersionId },
    });
  });

  afterAll(async () => {
    if (!m) return;
    await retireEngines();
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

  /** Engines of earlier tests are stopped: their result handlers wake ticks of their own. */
  const engines: Array<InstanceType<Modules["lifecycle"]["RuntimeLifecycle"]>> = [];

  async function retireEngines() {
    for (const old of engines.splice(0)) await old.stop();
  }

  async function engine() {
    await retireEngines();
    const created = new m.lifecycle.RuntimeLifecycle({
      sendToNode: (_nodeId, frame) => {
        if (frame.type === "runtime.job") sent.push(frame);
        return true;
      },
      nodeSession: (id) =>
        id === nodeId && session.online
          ? {
              userId,
              connectionGeneration: session.connectionGeneration,
              trust: session.trust,
              operatorTerminals: operatorRelay.supported,
            }
          : null,
      operatorRoom: () => operatorRelay.room,
      closeOperatorStep: (stepId) => {
        operatorRelay.closed.push(stepId);
        return operatorRelay.closeAnswer;
      },
      closeOperatorTerminal: (_node, terminalId) => {
        operatorRelay.closedTerminals.push(terminalId);
      },
    });
    engines.push(created);
    return created;
  }

  async function startInstance(
    port: number,
    startedBy: "USER" | "AGENT" = "USER",
    which: "plain" | "operator" | "stopper" | "stub" = "plain",
  ) {
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
    const [instanceRuntime, instanceVersion] =
      which === "operator"
        ? [operatorRuntimeId, operatorVersionId]
        : which === "stopper"
          ? [stopperRuntimeId, stopperVersionId]
          : which === "stub"
            ? [stubRuntimeId, stubVersionId]
            : [runtimeId, versionId];
    await db.runtimeInstance.create({
      data: {
        id,
        userId,
        runtimeId: instanceRuntime,
        versionId: instanceVersion,
        launchVersionId: instanceVersion,
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
    extra: {
      stopped?: boolean;
      error?: "command_failed" | "health_failed" | "process_detached";
      detail?: string;
    } = {},
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
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
  }

  /** Five minutes on: the instance's status probes, and its ranks' last checks, are old. */
  async function ageProbes(id: string) {
    const ago = new Date(Date.now() - 6 * 60_000);
    await m.fixture.instanceStep.updateMany({
      where: { instanceId: id, phase: "STATUS" },
      data: { updatedAt: ago },
    });
    await m.fixture.instanceRank.updateMany({
      where: { instanceId: id, lastStopCheckAt: { not: null } },
      data: { lastStopCheckAt: ago },
    });
  }

  /** A STATUS step's error code (what the stop evidence shows as the check's reason). */
  const stepCode = async (stepId: string) =>
    (await m.fixture.instanceStep.findUniqueOrThrow({ where: { id: stepId } })).errorCode;

  const lastJob = (instanceId: string, phase: Job["phase"]) => {
    const job = [...sent].reverse().find((j) => j.instanceId === instanceId && j.phase === phase);
    if (!job) throw new Error(`no ${phase} job for ${instanceId}`);
    return job;
  };

  const instance = (id: string) =>
    m.fixture.runtimeInstance.findUniqueOrThrow({ where: { id }, include: { Ranks: true } });

  it("starts, becomes READY with targets, probes health and stops with proof", async () => {
    const lc = await engine();
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

    // Two failed probes make it UNHEALTHY, and the node's reason is kept.
    for (const detail of ["serving_unconfirmed", "http_503"]) {
      await m.fixture.runtimeInstance.update({
        where: { id },
        data: { lastHealthAt: new Date(Date.now() - 60_000) },
      });
      await lc.runOnce();
      await answer(lc, lastJob(id, "health"), "failed", { error: "health_failed", detail });
    }
    let unhealthy = await instance(id);
    expect(unhealthy.phase).toBe("UNHEALTHY");
    expect(unhealthy.phaseReason).toBe("health_failed");
    expect(unhealthy.healthDetail).toBe("http_503");
    // A reason this server does not know is not stored.
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { lastHealthAt: new Date(Date.now() - 60_000) },
    });
    await lc.runOnce();
    await answer(lc, lastJob(id, "health"), "failed", {
      error: "health_failed",
      detail: "something_new",
    });
    unhealthy = await instance(id);
    expect(unhealthy.healthDetail).toBeNull();

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
    const lc = await engine();
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

  it("fails a start that handed its server off, without restarting it", async () => {
    const lc = await engine();
    const id = await startInstance(30_190);
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "failed", { error: "process_detached" });
    let row = await instance(id);
    expect(row.phase).toBe("STOPPING");
    expect(row.phaseReason).toBe("process_detached");
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    row = await instance(id);
    expect(row.phase).toBe("FAILED");
    expect(row.phaseReason).toBe("process_detached");
    expect(row.nextRestartAt).toBeNull();
  });

  it("never runs an agent's start on a Relay-only node; the claim is released", async () => {
    session.trust = "relay";
    await m.fixture.node.update({ where: { id: nodeId }, data: { trust: "RELAY" } });
    try {
      const lc = await engine();
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

  it("settles a stop marked stopped and releases it once a status probe proves it", async () => {
    const lc = await engine();
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
    // The stop cannot be proven; a person marks it stopped (what instances.markStopped writes).
    await answer(lc, lastJob(id, "stop"), "failed", { error: "command_failed" });
    await m.fixture.instanceRank.updateMany({
      where: { instanceId: id },
      data: { claim: "HELD_UNKNOWN", markedStoppedAt: new Date(), markedStoppedBy: userId },
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

  it("proves and releases a hold left on a STOPPED instance; a failed proof says why", async () => {
    const lc = await engine();
    const id = await ready(lc, 30_111);
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await lc.runOnce();
      await answer(lc, lastJob(id, "stop"), "failed", { error: "command_failed" });
    }
    await lc.runOnce();
    // The node cannot prove it and says why: the step keeps the reason as its code.
    const first = lastJob(id, "status");
    await answer(lc, first, "succeeded", { stopped: false, detail: "port_in_use" });
    expect(await stepCode(first.stepId)).toBe("port_in_use");
    // The row the preview server was left with: marked stopped, settled STOPPED, nobody asked.
    await m.fixture.instanceRank.updateMany({
      where: { instanceId: id },
      data: { claim: "HELD_UNKNOWN", markedStoppedAt: new Date(), markedStoppedBy: userId },
    });
    await lc.runOnce();
    let row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.needsOperator).toBeNull();
    expect(row.Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    // The sweep probes it again on the online node (5 minutes on: one pass queues, one sends).
    await ageProbes(id);
    const before = sent.length;
    await lc.runOnce();
    await lc.runOnce();
    const probe = sent.slice(before).find((job) => job.instanceId === id && job.phase === "status");
    if (!probe) throw new Error("the STOPPED instance's hold was not probed");
    await answer(lc, probe, "succeeded", { stopped: false, detail: "process_alive" });
    expect(await stepCode(probe.stepId)).toBe("process_alive");
    expect((await instance(id)).Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    // An older node gives no reason: the code stays not_stopped.
    await ageProbes(id);
    await lc.runOnce();
    await lc.runOnce();
    const old = lastJob(id, "status");
    await answer(lc, old, "succeeded", { stopped: false });
    expect(await stepCode(old.stepId)).toBe("not_stopped");
    // Later the process is gone and the port free: the proof releases the hold at once.
    await ageProbes(id);
    await lc.runOnce();
    await lc.runOnce();
    const proof = lastJob(id, "status");
    expect(proof.stepId).not.toBe(old.stepId);
    await answer(lc, proof, "succeeded", { stopped: true });
    row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.Ranks[0]?.claim).toBe("RELEASED");
    expect(row.Ranks[0]?.stoppedAt).not.toBeNull();
    expect(
      await m.fixture.instanceRank.count({
        where: { nodeId, port: 30_111, claim: { not: "RELEASED" } },
      }),
    ).toBe(0);
  });

  /**
   * The state spark-1958 was left in (live report on a6f2bbfb): a runtime whose stop, status and
   * health commands are all `true`. Its stop step hung RUNNING (the old node waited for status to
   * say stopped), a person marked it stopped while STOPPING, it settled STOPPED with nobody asked
   * and the rank HELD_UNKNOWN, and every probe of the old node failed (`health_failed`). Once the
   * node runs the fixed CLI (no process left, port free: proven whatever status says), the next
   * sweep's probe releases the hold with no person.
   */
  it("releases a stub runtime's rank marked stopped once the node proves the stop", async () => {
    const lc = await engine();
    const id = await startInstance(30_112, "USER", "stub");
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
    });
    await lc.runOnce();
    const hung = lastJob(id, "stop");
    // Marked stopped while the stop still runs (what instances.markStopped writes).
    await m.fixture.instanceRank.updateMany({
      where: { instanceId: id, claim: "HELD" },
      data: { claim: "HELD_UNKNOWN", markedStoppedAt: new Date(), markedStoppedBy: userId },
    });
    await lc.runOnce();
    let row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.needsOperator).toBeNull();
    expect(row.Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    // The hung stop fails at its deadline; the old node's probes fail too. Nothing is released.
    await answer(lc, hung, "failed", { error: "command_failed" });
    await lc.runOnce();
    await lc.runOnce();
    const old = lastJob(id, "status");
    await lc.handleJobResult(ref(), {
      type: "runtime.job.result",
      stepId: old.stepId,
      instanceId: old.instanceId,
      rank: old.rank,
      intentHash: old.intentHash,
      ownerEpoch: old.ownerEpoch,
      status: "failed",
      stopped: false,
      error: "health_failed",
    });
    expect(await stepCode(old.stepId)).toBe("health_failed");
    row = await instance(id);
    expect(row.Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    expect(row.needsOperator).toBeNull();
    // Deployed with the fixed node: the next sweep (5 minutes on, node online) probes again.
    await ageProbes(id);
    const before = sent.length;
    await lc.runOnce();
    await lc.runOnce();
    const probe = sent.slice(before).find((job) => job.instanceId === id && job.phase === "status");
    if (!probe) throw new Error("the held rank was not probed");
    expect(probe.stepId).not.toBe(old.stepId);
    // No process left in the rank's unit, port free: proven although status says "alive".
    await answer(lc, probe, "succeeded", { stopped: true });
    row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.Ranks[0]?.claim).toBe("RELEASED");
    expect(
      await m.fixture.instanceRank.count({
        where: { nodeId, port: 30_112, claim: { not: "RELEASED" } },
      }),
    ).toBe(0);
  });

  async function ready(lc: Awaited<ReturnType<typeof engine>>, port: number) {
    const id = await startInstance(port);
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
    return id;
  }

  it("completes a stop its failed stops could not prove once a status probe proves it", async () => {
    const lc = await engine();
    const id = await ready(lc, 30_109);
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
    });
    // Every stop fails (say its stop command errors because the process is already gone).
    for (let attempt = 0; attempt < 3; attempt++) {
      await lc.runOnce();
      await answer(lc, lastJob(id, "stop"), "failed", { error: "command_failed" });
    }
    // No person yet: the node is asked for proof first.
    await lc.runOnce();
    let row = await instance(id);
    expect(row.needsOperator).toBeNull();
    expect(row.Ranks[0]?.claim).toBe("HELD");
    const first = lastJob(id, "status");
    // The node cannot prove it (still alive, or unknown): now a person may mark it stopped.
    await answer(lc, first, "succeeded", { stopped: false });
    await lc.runOnce();
    row = await instance(id);
    expect(row.phase).toBe("STOPPING");
    expect(row.needsOperator).toBe("MARK_STOPPED");
    expect(sent.filter((job) => job.instanceId === id && job.phase === "status")).toHaveLength(1);
    // Later the probe is repeated; its proof completes the stop with no person.
    await ageProbes(id);
    await lc.runOnce();
    const second = lastJob(id, "status");
    expect(second.stepId).not.toBe(first.stepId);
    await answer(lc, second, "succeeded", { stopped: true });
    row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.needsOperator).toBeNull();
    expect(row.Ranks[0]?.claim).toBe("RELEASED");
  });

  it("probes a stop again in a later run of the same instance (probe sequences never clash)", async () => {
    const lc = await engine();
    const id = await startInstance(30_110);
    const failStopsThenProve = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await lc.runOnce();
        await answer(lc, lastJob(id, "stop"), "failed", { error: "command_failed" });
      }
      await lc.runOnce();
      const probe = lastJob(id, "status");
      await answer(lc, probe, "succeeded", { stopped: true });
      return probe;
    };
    // Run 1 fails to start; its stops fail; the probe proves the stop.
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "failed", { error: "command_failed" });
    const first = await failStopsThenProve();
    let row = await instance(id);
    expect(row.phase).toBe("STOPPED");
    expect(row.Ranks[0]?.claim).toBe("RELEASED");
    // Run 2 (the automatic restart) fails the same way: its probe gets a sequence of its own.
    await m.fixture.runtimeInstance.update({
      where: { id },
      data: { nextRestartAt: new Date(Date.now() - 1_000) },
    });
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "failed", { error: "command_failed" });
    const second = await failStopsThenProve();
    expect(second.generation).toBe(2);
    expect(second.stepId).not.toBe(first.stepId);
    row = await instance(id);
    expect(row.Ranks[0]?.claim).toBe("RELEASED");
    expect(row.phase).toBe("FAILED");
  });

  it("reaches every rank marked stopped when there are more than one pass takes, oldest first", async () => {
    const lc = await engine();
    const ids: string[] = [];
    for (let index = 0; index < 70; index++) ids.push(await startInstance(31_000 + index));
    await m.fixture.runtimeInstance.updateMany({
      where: { id: { in: ids } },
      data: { desiredState: "STOPPED", phase: "STOPPED", phaseReason: "stop_requested" },
    });
    await m.fixture.instanceRank.updateMany({
      where: { instanceId: { in: ids } },
      data: { claim: "HELD_UNKNOWN", markedStoppedAt: new Date(), markedStoppedBy: userId },
    });
    const ranks = () =>
      m.fixture.instanceRank.findMany({
        where: { instanceId: { in: ids } },
        select: { instanceId: true, lastStopCheckAt: true },
      });
    const probed = async () =>
      new Set(
        (
          await m.fixture.instanceStep.findMany({
            where: { instanceId: { in: ids }, phase: "STATUS" },
            select: { instanceId: true },
          })
        ).map((step) => step.instanceId),
      );
    try {
      // One pass takes 64 at most: some are left for the next one, which reaches them.
      await lc.runOnce();
      const first = (await ranks()).filter((rank) => rank.lastStopCheckAt !== null);
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThanOrEqual(64);
      await lc.runOnce();
      expect((await ranks()).every((rank) => rank.lastStopCheckAt !== null)).toBe(true);
      expect((await probed()).size).toBe(70);
      // Later, the least recently checked go first: ids[69] oldest, ids[0] newest of the old.
      const base = Date.now() - 10 * 60_000;
      for (const [index, id] of ids.entries())
        await m.fixture.instanceRank.updateMany({
          where: { instanceId: id },
          data: { lastStopCheckAt: new Date(base - index * 1_000) },
        });
      await lc.runOnce();
      const stale = (await ranks())
        .filter((rank) => (rank.lastStopCheckAt?.getTime() ?? 0) <= base)
        .map((rank) => rank.instanceId)
        .sort();
      expect(stale).toEqual(ids.slice(0, 6).sort());
    } finally {
      await m.fixture.instanceStep.updateMany({
        where: { instanceId: { in: ids }, state: { in: ["PENDING", "RUNNING"] } },
        data: {
          state: "FAILED",
          errorCode: "superseded",
          ownerEpoch: null,
          deadline: null,
          leaseExpiresAt: null,
        },
      });
      const now = new Date();
      await m.fixture.instanceRank.updateMany({
        where: { instanceId: { in: ids } },
        data: { claim: "RELEASED", claimChangedAt: now, stoppedAt: now },
      });
    }
  });

  it("asks a person to mark stopped a stop whose node stays offline", async () => {
    const lc = await engine();
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
      expect(row.needsOperator).toBe("MARK_STOPPED");
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
    const first = await engine();
    const id = await startInstance(30_106);
    await first.runOnce();
    const lost = lastJob(id, "start");
    // A restart: a new process (new epoch) sees the node reconnect.
    const second = await engine();
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
    const lc = await engine();
    const id = await ready(lc, 30_107);
    await lc.runtimeInventory(ref(), { snapshotId: "s1", alwaysOn: [], instances: [] });
    const row = await instance(id);
    expect(row.phase).toBe("STOPPING");
    expect(row.phaseReason).toBe("crashed");
  });

  // ── Interactive steps (operator terminals) ──

  async function progress(
    lc: Awaited<ReturnType<typeof engine>>,
    job: Job,
    status: "awaiting_operator" | "operator_running" | "operator_closed" | "succeeded" | "failed",
    extra: { exitCode?: number; terminalId?: string; error?: "command_failed" } = {},
  ) {
    await lc.handleJobResult(ref(), {
      type: "runtime.job.result",
      stepId: job.stepId,
      instanceId: job.instanceId,
      rank: job.rank,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      status,
      stopped: false,
      terminalId: extra.terminalId ?? job.operator?.terminalId,
      ...(status === "failed" ? { error: extra.error ?? "command_failed" } : {}),
      ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    });
  }

  const step = (id: string, phase: "START" | "STOP" | "READINESS") =>
    m.fixture.instanceStep.findFirstOrThrow({
      where: { instanceId: id, phase },
      orderBy: { createdAt: "desc" },
    });

  /** What `markInstancesStopping` writes. */
  const stopInstance = (id: string) =>
    m.fixture.runtimeInstance.update({
      where: { id },
      data: {
        desiredState: "STOPPED",
        phase: "STOPPING",
        phaseReason: "stop_requested",
        needsOperator: null,
        needsOperatorSince: null,
      },
    });

  it("runs an interactive start in an operator terminal a person answers", async () => {
    const lc = await engine();
    const id = await startInstance(30_201, "USER", "operator");
    await lc.runOnce();
    const start = lastJob(id, "start");
    expect(m.frames.runtimeJobFrameSchema.safeParse(start).success).toBe(true);
    // A fresh terminal for the dispatch; the command's author is the launched version's editor.
    expect(start.operator?.commandAuthor).toBe("unknown");
    expect(start.operator?.terminalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    let row = await step(id, "START");
    expect(row.state).toBe("RUNNING");
    expect(row.operatorTerminalId).toBe(start.operator?.terminalId);

    await progress(lc, start, "awaiting_operator");
    row = await step(id, "START");
    expect(row.state).toBe("AWAITING_OPERATOR");
    expect(row.deadline).toBeNull();
    expect(row.operatorSince).not.toBeNull();
    expect((await instance(id)).needsOperator).toBe("STEP");

    // A result naming another terminal settles nothing.
    await progress(lc, start, "succeeded", { terminalId: "A".repeat(22) });
    expect((await step(id, "START")).state).toBe("AWAITING_OPERATOR");

    await progress(lc, start, "operator_running");
    row = await step(id, "START");
    expect(row.state).toBe("RUNNING");
    expect(row.operatorAcceptedAt).not.toBeNull();
    expect(row.deadline).not.toBeNull();
    expect((await instance(id)).needsOperator).toBeNull();

    // A person's run is never cut off by its deadline; past it, it needs its person again.
    await m.fixture.instanceStep.update({
      where: { id: row.id },
      data: { deadline: new Date(Date.now() - 1_000) },
    });
    await lc.runOnce();
    row = await step(id, "START");
    expect(row.state).toBe("RUNNING");
    expect((await instance(id)).needsOperator).toBe("STEP");

    await progress(lc, start, "succeeded");
    row = await step(id, "START");
    expect(row.state).toBe("SUCCEEDED");
    expect(row.operatorTerminalId).toBeNull();
    expect((await instance(id)).needsOperator).toBeNull();
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
  });

  it("a decline gives its attempt back; reopen uses a fresh terminal; cancel gives up", async () => {
    const lc = await engine();
    const id = await startInstance(30_202, "USER", "operator");
    await lc.runOnce();
    const first = lastJob(id, "start");
    await progress(lc, first, "awaiting_operator");
    await progress(lc, first, "operator_closed");
    let row = await step(id, "START");
    expect(row.state).toBe("AWAITING_OPERATOR");
    expect(row.operatorTerminalId).toBeNull();
    expect(row.attempts).toBe(0);
    expect((await instance(id)).needsOperator).toBe("STEP");
    // Nothing is retried on its own.
    const before = sent.length;
    await lc.runOnce();
    expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);

    await lc.reopenStep({ userId, stepId: row.id });
    expect((await step(id, "START")).state).toBe("PENDING");
    await lc.runOnce();
    const second = lastJob(id, "start");
    expect(second.operator?.terminalId).not.toBe(first.operator?.terminalId);
    // The first terminal's answers are stale now.
    await progress(lc, first, "awaiting_operator");
    expect((await step(id, "START")).state).toBe("RUNNING");
    await progress(lc, second, "awaiting_operator");
    // The command ran and failed: the attempt counts and the exit code is kept.
    await progress(lc, second, "operator_running");
    await progress(lc, second, "operator_closed", { exitCode: 1 });
    row = await step(id, "START");
    expect(row.state).toBe("AWAITING_OPERATOR");
    expect(row.operatorLastExit).toBe(1);
    expect(row.attempts).toBe(1);
    await expect(lc.reopenStep({ userId: "someone-else", stepId: row.id })).rejects.toMatchObject({
      code: "not_found",
    });

    await lc.cancelStep({ userId, stepId: row.id });
    row = await step(id, "START");
    expect(row.state).toBe("FAILED");
    expect(row.errorCode).toBe("operator_cancelled");
    // The start ran once: its rank needs a stop; the interactive start then waits for a
    // person's restart.
    let inst = await instance(id);
    expect(inst.phase).toBe("STOPPING");
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    inst = await instance(id);
    expect(inst.phase).toBe("STOPPED");
    expect(inst.needsOperator).toBe("RESTART");
  });

  it("holds an interactive step until the node can hold its terminal", async () => {
    operatorRelay.supported = false;
    const lc = await engine();
    let id = "";
    try {
      id = await startInstance(30_203, "USER", "operator");
      const before = sent.length;
      await lc.runOnce();
      expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);
      const held = await step(id, "START");
      expect(held.state).toBe("PENDING");
      expect(held.operatorHold).toBe("operator_capability_missing");
      expect((await instance(id)).needsOperator).toBe("STEP");
    } finally {
      operatorRelay.supported = true;
    }
    await lc.runOnce();
    const row = await step(id, "START");
    expect(row.state).toBe("RUNNING");
    expect(row.operatorHold).toBeNull();
    expect(row.errorCode).toBeNull();
    expect((await instance(id)).needsOperator).toBeNull();
    // A stop cancels the waiting start: its terminal closes, the rank never ran it.
    await stopInstance(id);
    operatorRelay.closed.length = 0;
    await lc.runOnce();
    expect(operatorRelay.closed).toContain(row.id);
    expect((await step(id, "START")).state).toBe("CANCELLED");
    const inst = await instance(id);
    expect(inst.phase).toBe("STOPPED");
    expect(inst.Ranks[0]?.claim).toBe("RELEASED");
    expect(inst.needsOperator).toBeNull();
  });

  it("a stop waits behind a person's run, then goes out", async () => {
    const lc = await engine();
    const id = await startInstance(30_204, "USER", "operator");
    await lc.runOnce();
    const start = lastJob(id, "start");
    await progress(lc, start, "awaiting_operator");
    await progress(lc, start, "operator_running");
    operatorRelay.closeAnswer = "running";
    try {
      await stopInstance(id);
      const before = sent.length;
      await lc.runOnce();
      await lc.runOnce();
      // The run is left alone; its stop waits, unsent.
      expect((await step(id, "START")).state).toBe("RUNNING");
      expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);
      expect((await step(id, "STOP")).state).toBe("PENDING");
    } finally {
      operatorRelay.closeAnswer = "closed";
    }
    await progress(lc, start, "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    expect((await instance(id)).phase).toBe("STOPPED");
  });

  it("reissues a terminal lost with its session; only a screen that never came up is free", async () => {
    const lc = await engine();
    const id = await startInstance(30_205, "USER", "operator");
    await lc.runOnce();
    const lost = lastJob(id, "start");
    await progress(lc, lost, "awaiting_operator");
    await lc.nodeDisconnected(ref());
    let row = await step(id, "START");
    expect(row.state).toBe("PENDING");
    // The screen was up: a person may have pressed Enter before the session went away.
    expect(row.attempts).toBe(1);
    expect(row.operatorTerminalId).toBeNull();
    expect(row.operatorSince).toBeNull();
    await lc.runOnce();
    const fresh = lastJob(id, "start");
    expect(fresh.operator?.terminalId).not.toBe(lost.operator?.terminalId);
    row = await step(id, "START");
    expect(row.attempts).toBe(2);
    // A terminal whose screen never came up is sent again with a fresh one, for free.
    await m.fixture.instanceStep.update({
      where: { id: row.id },
      data: {
        deadline: new Date(Date.now() - 1_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    await lc.runOnce();
    const third = lastJob(id, "start");
    expect(third.operator?.terminalId).not.toBe(fresh.operator?.terminalId);
    expect((await step(id, "START")).attempts).toBe(2);
    // Stopped now: the first dispatch may have run, so the rank needs a (proven) stop.
    await stopInstance(id);
    await lc.runOnce();
    expect((await step(id, "START")).state).toBe("FAILED");
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    expect((await instance(id)).phase).toBe("STOPPED");
  });

  it("a stop while the screen is up keeps the attempt and closes stale terminals", async () => {
    const lc = await engine();
    const id = await startInstance(30_206, "USER", "operator");
    await lc.runOnce();
    const start = lastJob(id, "start");
    await progress(lc, start, "awaiting_operator");
    operatorRelay.closed.length = 0;
    await stopInstance(id);
    await lc.runOnce();
    const row = await step(id, "START");
    expect(operatorRelay.closed).toContain(row.id);
    expect(row.state).toBe("FAILED");
    expect(row.errorCode).toBe("stopped");
    expect(row.attempts).toBe(1);
    expect(row.operatorTerminalId).toBeNull();
    // Enter won the race on the node: its screen report for the settled step closes it.
    operatorRelay.closedTerminals.length = 0;
    await progress(lc, start, "awaiting_operator");
    expect(operatorRelay.closedTerminals).toEqual([start.operator?.terminalId]);
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    const inst = await instance(id);
    expect(inst.phase).toBe("STOPPED");
    expect(inst.desiredState).toBe("STOPPED");
    expect(inst.needsOperator).toBeNull();
  });

  // ── Inactive (banned or deleting) owners ──

  const ban = (until: Date | null) =>
    m.fixture.user.update({ where: { id: userId }, data: { banned: true, banExpires: until } });
  const unban = () =>
    m.fixture.user.update({ where: { id: userId }, data: { banned: false, banExpires: null } });
  const markDeleting = () =>
    m.fixture.user.update({
      where: { id: userId },
      data: { deletionRequestedAt: new Date() },
    });
  /** Only the deletion subsystem may clear the marker (user_deletion_marker_guard). */
  const clearDeleting = () =>
    m.fixture.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('wsmp.user_deletion_writer', 'on', true)`;
      await tx.user.update({ where: { id: userId }, data: { deletionRequestedAt: null } });
    });

  it("cancels a banned owner's held interactive start: no terminal, nothing sent", async () => {
    const lc = await engine();
    const id = await startInstance(30_207, "USER", "operator");
    await ban(null);
    try {
      const before = sent.length;
      await lc.runOnce();
      expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);
      const start = await step(id, "START");
      expect(start.state).toBe("CANCELLED");
      expect(start.errorCode).toBe("owner_inactive");
      // The start never ran: the claim is released and the interactive start waits for a
      // person's restart.
      const inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.Ranks[0]?.claim).toBe("RELEASED");
      expect(inst.needsOperator).toBe("RESTART");
    } finally {
      await unban();
    }
    await stopInstance(id);
    await lc.runOnce();
    expect((await instance(id)).phase).toBe("STOPPED");
  });

  it("closes a deleting owner's open start terminal; the plain stop still goes out", async () => {
    const lc = await engine();
    const id = await startInstance(30_208, "USER", "operator");
    await lc.runOnce();
    const start = lastJob(id, "start");
    await progress(lc, start, "awaiting_operator");
    await markDeleting();
    try {
      operatorRelay.closed.length = 0;
      await lc.runOnce();
      const row = await step(id, "START");
      expect(operatorRelay.closed).toContain(row.id);
      expect(row.state).toBe("FAILED");
      expect(row.errorCode).toBe("owner_inactive");
      // The screen was up: a person may have pressed Enter, so the rank needs a proven stop.
      expect(row.attempts).toBe(1);
      expect(row.operatorTerminalId).toBeNull();
      const stop = lastJob(id, "stop");
      expect(stop.operator).toBeUndefined();
      await answer(lc, stop, "succeeded", { stopped: true });
      const inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.Ranks[0]?.claim).toBe("RELEASED");
    } finally {
      await clearDeleting();
    }
  });

  it("never starts an inactive owner's instance; a stop still settles it", async () => {
    const lc = await engine();
    const id = await startInstance(30_209);
    await ban(new Date(Date.now() + 3_600_000));
    try {
      const before = sent.length;
      await lc.runOnce();
      await lc.runOnce();
      expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);
      expect((await step(id, "START")).state).toBe("PENDING");
      expect((await instance(id)).phase).toBe("STARTING");
      await stopInstance(id);
      await lc.runOnce();
      const inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.Ranks[0]?.claim).toBe("RELEASED");
    } finally {
      await unban();
    }
  });

  it("sends an inactive owner's ready instance no health probe and never restarts it", async () => {
    const lc = await engine();
    const id = await ready(lc, 30_218);
    await ban(null);
    try {
      await m.fixture.runtimeInstance.update({
        where: { id },
        data: { lastHealthAt: new Date(Date.now() - 60_000) },
      });
      const before = sent.length;
      await lc.runOnce();
      expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);
      // Crashed (the node no longer runs it): the stop goes out, the restart never does.
      await m.fixture.instanceStep.updateMany({
        where: { instanceId: id, phase: "HEALTH", state: "PENDING" },
        data: { state: "CANCELLED" },
      });
      await lc.runtimeInventory(ref(), { snapshotId: "s-ban", alwaysOn: [], instances: [] });
      await lc.runOnce();
      await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
      let inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.desiredState).toBe("RUNNING");
      await m.fixture.runtimeInstance.update({
        where: { id },
        data: { nextRestartAt: new Date(Date.now() - 1_000) },
      });
      await lc.runOnce();
      inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.Ranks[0]?.claim).toBe("RELEASED");
    } finally {
      await unban();
    }
    // Active again: the restart rule applies.
    await lc.runOnce();
    expect((await instance(id)).phase).toBe("STARTING");
    await stopInstance(id);
    await lc.runOnce();
    const stop = [...sent].reverse().find((job) => job.instanceId === id && job.phase === "stop");
    if (stop && (await instance(id)).phase === "STOPPING")
      await answer(lc, stop, "succeeded", { stopped: true });
  });

  it("leaves a person's run alone, and counts a terminal the ban fence already closed", async () => {
    const lc = await engine();
    const running = await startInstance(30_219, "USER", "operator");
    const spawning = await startInstance(30_220, "USER", "operator");
    await lc.runOnce();
    const run = lastJob(running, "start");
    await progress(lc, run, "awaiting_operator");
    // The person pressed Enter; the node's report has not arrived yet.
    operatorRelay.closeAnswer = "running";
    await ban(null);
    try {
      await lc.runOnce();
      expect((await step(running, "START")).state).toBe("AWAITING_OPERATOR");
      // The other terminal's screen never came up, and the ban fence already cancelled it
      // ("absent"): it may have run, so the attempt counts and the rank needs a proven stop.
      operatorRelay.closeAnswer = "absent";
      await lc.runOnce();
      const row = await step(spawning, "START");
      expect(row.state).toBe("FAILED");
      expect(row.errorCode).toBe("owner_inactive");
      expect(row.attempts).toBe(1);
      expect((await instance(spawning)).phase).toBe("STOPPING");
    } finally {
      operatorRelay.closeAnswer = "closed";
      await unban();
    }
    for (const id of [running, spawning]) {
      await stopInstance(id);
      await lc.runOnce();
      const stop = [...sent].reverse().find((job) => job.instanceId === id && job.phase === "stop");
      if (stop) await answer(lc, stop, "succeeded", { stopped: true });
    }
  });

  it("a terminal this close ends before its screen came up gives its attempt back", async () => {
    const lc = await engine();
    const id = await startInstance(30_221, "USER", "operator");
    await lc.runOnce();
    const start = await step(id, "START");
    expect(start.state).toBe("RUNNING");
    await ban(null);
    try {
      operatorRelay.closed.length = 0;
      await lc.runOnce();
      expect(operatorRelay.closed).toContain(start.id);
      const row = await step(id, "START");
      expect(row.state).toBe("CANCELLED");
      expect(row.attempts).toBe(0);
      // Nothing ran: the claim is released without a stop.
      const inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.Ranks[0]?.claim).toBe("RELEASED");
    } finally {
      await unban();
    }
  });

  it("an expired ban is no ban: the start goes out", async () => {
    const lc = await engine();
    const id = await startInstance(30_215);
    await ban(new Date(Date.now() - 60_000));
    try {
      await lc.runOnce();
      expect(lastJob(id, "start").instanceId).toBe(id);
    } finally {
      await unban();
    }
    await stopInstance(id);
    await lc.runOnce();
    await answer(lc, lastJob(id, "stop"), "succeeded", { stopped: true });
    expect((await instance(id)).phase).toBe("STOPPED");
  });

  it("marks stopped an inactive owner's unanswerable interactive stop; a status probe proves it", async () => {
    const lc = await engine();
    const id = await startInstance(30_216, "USER", "stopper");
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
    await ban(null);
    try {
      await stopInstance(id);
      const before = sent.length;
      await lc.runOnce();
      // No terminal for the stop: it is cancelled and the rank marked stopped by the engine.
      expect(sent.slice(before).some((job) => job.instanceId === id && job.phase === "stop")).toBe(
        false,
      );
      const stop = await step(id, "STOP");
      expect(stop.state).toBe("CANCELLED");
      expect(stop.errorCode).toBe("owner_inactive");
      let inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.needsOperator).toBeNull();
      expect(inst.Ranks[0]).toMatchObject({
        claim: "HELD_UNKNOWN",
        markedStoppedBy: "system:owner_inactive",
      });
      expect(inst.Ranks[0]?.markedStoppedAt).not.toBeNull();
      // The status probe goes out for the inactive owner and proves the stop.
      await lc.runOnce();
      const status = lastJob(id, "status");
      expect(status.operator).toBeUndefined();
      await answer(lc, status, "succeeded", { stopped: true });
      inst = await instance(id);
      expect(inst.Ranks[0]?.claim).toBe("RELEASED");
    } finally {
      await unban();
    }
  });

  it("marks stopped a stop a person gave up on once the owner is inactive", async () => {
    const lc = await engine();
    const id = await startInstance(30_217, "USER", "stopper");
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    await stopInstance(id);
    await lc.runOnce();
    const job = lastJob(id, "stop");
    expect(job.operator).toBeDefined();
    await progress(lc, job, "awaiting_operator");
    await lc.cancelStep({ userId, stepId: job.stepId });
    let inst = await instance(id);
    expect(inst.needsOperator).toBe("MARK_STOPPED");
    expect(inst.Ranks[0]?.claim).toBe("HELD");
    await markDeleting();
    try {
      await lc.runOnce();
      inst = await instance(id);
      expect(inst.phase).toBe("STOPPED");
      expect(inst.Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    } finally {
      await clearDeleting();
    }
  });

  it("opens at most four operator terminals per node; the rest are held", async () => {
    const lc = await engine();
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await startInstance(30_210 + n, "USER", "operator"));
    await lc.runOnce();
    const rows = await Promise.all(ids.map((id) => step(id, "START")));
    expect(rows.filter((row) => row.state === "RUNNING")).toHaveLength(4);
    expect(rows.find((row) => row.state === "PENDING")?.operatorHold).toBe("operator_node_full");
    // Stopping them closes the waiting terminals; ranks that never ran are released.
    for (const id of ids) await stopInstance(id);
    await lc.runOnce();
    for (const id of ids) expect((await instance(id)).phase).toBe("STOPPED");
  });

  // ── Always-on runtimes from inventory ──

  const alwaysOnSpec = (port: number) => ({
    api: "openai" as const,
    engine: "vllm" as const,
    modelType: "llm" as const,
    address: { baseUrl: `http://127.0.0.1:${port}/v1` },
  });

  function nodeEntry(
    slug: string,
    port: number,
    extra: Partial<import("../relay/frames.js").AlwaysOnInventory> = {},
  ): import("../relay/frames.js").AlwaysOnInventory {
    const spec = alwaysOnSpec(port);
    return {
      slug,
      origin: "node",
      launchHash: runtimeLaunchHash(spec),
      spec,
      status: "online",
      models: [{ id: "local-model", capabilities: ["text_generation"] }],
      ...extra,
    };
  }

  const inventory = (
    lc: Awaited<ReturnType<typeof engine>>,
    alwaysOn: import("../relay/frames.js").AlwaysOnInventory[],
    instances: import("../relay/frames.js").InstanceRecord[] = [],
  ) => lc.runtimeInventory(ref(), { snapshotId: randomUUID(), alwaysOn, instances });

  const nodeRuntime = (slug: string) =>
    m.fixture.runtime.findFirst({
      where: { userId, slug },
      include: {
        Versions: { orderBy: { version: "asc" } },
        Models: true,
        Instances: { include: { Targets: true } },
      },
    });

  it("creates a node-origin always-on runtime from inventory, versions it and removes it", async () => {
    const lc = await engine();
    const slug = `ao-${suffix}`;
    await inventory(lc, [
      nodeEntry(slug, 18_001, {
        engineFacts: {
          slots: { value: 8, source: "probe" },
          kvTokens: { value: 400_000, source: "probe" },
        },
      }),
    ]);
    let runtime = await nodeRuntime(slug);
    expect(runtime).toMatchObject({ kind: "ALWAYS_ON", origin: "NODE", nodeId });
    expect(runtime?.Versions).toHaveLength(1);
    const first = runtime?.Versions[0];
    expect(first?.launchHash).toBe(runtimeLaunchHash(alwaysOnSpec(18_001)));
    expect(first?.editor).toBe("SYSTEM");
    expect(runtime?.currentVersionId).toBe(first?.id);
    expect(runtime?.Models.map((model) => model.upstreamModelId)).toEqual(["local-model"]);
    expect(runtime?.Models[0]?.detectedCapabilities).toEqual(["TEXT_GENERATION"]);
    let inst = runtime?.Instances[0];
    expect(runtime?.Instances).toHaveLength(1);
    expect(inst).toMatchObject({
      handle: slug,
      desiredState: null,
      phase: "READY",
      versionId: first?.id,
      launchVersionId: first?.id,
      engineSlots: 8,
      observedKvBudgetTokens: 400_000,
    });
    expect(inst?.Targets).toHaveLength(1);

    // The same report again changes nothing.
    await inventory(lc, [nodeEntry(slug, 18_001)]);
    expect((await nodeRuntime(slug))?.Versions).toHaveLength(1);

    // A person set a limit in the browser (version 2, same launch).
    const limited = await m.fixture.runtimeVersion.create({
      data: {
        runtimeId: runtime?.id ?? "",
        version: 2,
        editor: "USER",
        editorUserId: userId,
        contentHash: hex(`content-ao-2-${suffix}`),
        launchHash: first?.launchHash ?? "",
        spec: alwaysOnSpec(18_001),
        api: "OPENAI",
        engine: "VLLM",
        modelType: "LLM",
        concurrencyLimit: 3,
      },
    });
    await m.fixture.runtime.update({
      where: { id: runtime?.id ?? "" },
      data: { currentVersionId: limited.id },
    });
    // The definition changed on the node: version 3 (the limit carried over), adopted at once;
    // its status degraded; a second discovered model (a degraded server's list retires nothing).
    await inventory(lc, [
      nodeEntry(slug, 18_002, {
        status: "degraded",
        models: [{ id: "other-model", capabilities: [] }],
      }),
    ]);
    runtime = await nodeRuntime(slug);
    expect(runtime?.Versions.map((version) => version.version)).toEqual([1, 2, 3]);
    const second = runtime?.Versions[2];
    expect(second?.concurrencyLimit).toBe(3);
    expect(second?.launchHash).toBe(runtimeLaunchHash(alwaysOnSpec(18_002)));
    expect(runtime?.currentVersionId).toBe(second?.id);
    inst = runtime?.Instances[0];
    expect(inst).toMatchObject({
      phase: "UNHEALTHY",
      phaseReason: "node_degraded",
      versionId: second?.id,
      launchVersionId: second?.id,
    });
    const retired = async () =>
      new Map(
        (await nodeRuntime(slug))?.Models.map((model) => [model.upstreamModelId, model.retired]),
      );
    expect(await retired()).toEqual(
      new Map([
        ["local-model", false],
        ["other-model", false],
      ]),
    );
    expect(inst?.Targets).toHaveLength(2);
    // Online, the list is the whole served set: the first model is gone.
    await inventory(lc, [
      nodeEntry(slug, 18_002, { models: [{ id: "other-model", capabilities: [] }] }),
    ]);
    expect(await retired()).toEqual(
      new Map([
        ["local-model", true],
        ["other-model", false],
      ]),
    );

    // A truncated entry, or a server that is offline (it lists nothing), keeps the models the
    // server knows.
    await inventory(lc, [nodeEntry(slug, 18_002, { models: [], truncated: true })]);
    await inventory(lc, [nodeEntry(slug, 18_002, { models: [], status: "offline" })]);
    runtime = await nodeRuntime(slug);
    expect(runtime?.Models.find((model) => model.upstreamModelId === "other-model")?.retired).toBe(
      false,
    );
    expect(runtime?.Instances[0]).toMatchObject({
      phase: "UNAVAILABLE",
      phaseReason: "node_offline",
    });

    // No longer reported while a profile pins it: kept, but no longer routed to.
    const profile = await m.fixture.profile.create({
      data: { userId, slug: `ao-${suffix}`, name: "AO", editor: "USER", editorUserId: userId },
    });
    await m.fixture.profileItem.create({
      data: {
        profileId: profile.id,
        position: 0,
        runtimeId: runtime?.id ?? "",
        versionId: runtime?.currentVersionId ?? "",
      },
    });
    await inventory(lc, [nodeEntry(slug, 18_002)]);
    expect((await nodeRuntime(slug))?.Instances[0]?.phase).toBe("READY");
    await inventory(lc, []);
    expect((await nodeRuntime(slug))?.Instances[0]).toMatchObject({
      phase: "UNAVAILABLE",
      phaseReason: "node_removed",
    });
    await m.fixture.profile.delete({ where: { id: profile.id } });

    // No longer reported: the runtime and its instance are removed.
    await inventory(lc, []);
    expect(await nodeRuntime(slug)).toBeNull();
    expect(await m.fixture.runtimeInstance.count({ where: { userId, handle: slug } })).toBe(0);
  });

  it("skips a node-origin slug another runtime of the user has, and a bad hash", async () => {
    const lc = await engine();
    // The startable runtime's slug is taken (server origin).
    const taken = `lc-${suffix}`;
    // Another node of the user already added a runtime with this slug.
    const otherNode = await m.fixture.node.create({
      data: { userId, slug: `lc2-${suffix}`, connection: "ONLINE", trust: "FULL" },
    });
    const elsewhere = `ae-${suffix}`;
    await m.fixture.runtime.create({
      data: {
        userId,
        slug: elsewhere,
        name: "elsewhere",
        kind: "ALWAYS_ON",
        origin: "NODE",
        nodeId: otherNode.id,
      },
    });
    const before = await m.fixture.runtime.count({ where: { userId } });
    await inventory(lc, [
      nodeEntry(elsewhere, 18_006),
      nodeEntry(taken, 18_003),
      nodeEntry(`bad-${suffix}`, 18_004, { launchHash: "0".repeat(64) }),
    ]);
    expect(await m.fixture.runtime.count({ where: { userId } })).toBe(before);
    const kept = await m.fixture.runtime.findFirstOrThrow({ where: { userId, slug: taken } });
    expect(kept).toMatchObject({ origin: "SERVER", kind: "STARTABLE" });
    // The other node's runtime is untouched (still there, no version, on its node).
    const theirs = await m.fixture.runtime.findFirstOrThrow({
      where: { userId, slug: elsewhere },
      include: { Versions: true },
    });
    expect(theirs).toMatchObject({ nodeId: otherNode.id, currentVersionId: null });
    expect(theirs.Versions).toHaveLength(0);
    await m.fixture.runtime.delete({ where: { id: theirs.id } });
    await m.fixture.node.delete({ where: { id: otherNode.id } });
  });

  it("follows a server-origin always-on runtime's status, models and engine facts", async () => {
    const lc = await engine();
    const slug = `aos-${suffix}`;
    const spec = alwaysOnSpec(18_005);
    const db = m.fixture;
    const runtime = await db.runtime.create({
      data: { userId, slug, name: "AOS", kind: "ALWAYS_ON", origin: "SERVER", nodeId },
    });
    const version = await db.runtimeVersion.create({
      data: {
        runtimeId: runtime.id,
        version: 1,
        editor: "USER",
        editorUserId: userId,
        contentHash: hex(`content-aos-${suffix}`),
        launchHash: runtimeLaunchHash(spec),
        spec,
        api: "OPENAI",
        engine: "VLLM",
        modelType: "LLM",
      },
    });
    await db.runtime.update({ where: { id: runtime.id }, data: { currentVersionId: version.id } });
    await db.runtimeInstance.create({
      data: {
        userId,
        runtimeId: runtime.id,
        versionId: version.id,
        launchVersionId: version.id,
        handle: slug,
        startedBy: "USER",
        phase: "UNAVAILABLE",
        phaseReason: "awaiting_node",
      },
    });
    await inventory(lc, [
      {
        slug,
        origin: "server",
        runtimeId: runtime.id,
        versionId: version.id,
        launchHash: version.launchHash,
        status: "online",
        models: [
          {
            id: "served",
            capabilities: ["text_generation"],
            engineFacts: { maxModelLen: { value: 65_536, source: "probe" } },
          },
        ],
      },
    ]);
    const row = await nodeRuntime(slug);
    expect(row?.Models.map((model) => model.upstreamModelId)).toEqual(["served"]);
    expect(row?.Instances[0]).toMatchObject({ phase: "READY", maxModelLen: 65_536 });
    expect(row?.Instances[0]?.Targets).toHaveLength(1);
    // It stays: server-origin runtimes are never removed by inventory.
    await inventory(lc, []);
    expect(await nodeRuntime(slug)).not.toBeNull();
  });

  it("records a managed instance's engine facts from its head rank", async () => {
    const lc = await engine();
    const id = await ready(lc, 30_301);
    const row = await instance(id);
    await inventory(
      lc,
      [],
      [
        {
          instanceId: id,
          launchVersionId: row.launchVersionId,
          launchHash: hex(`launch-${suffix}`),
          rank: 0,
          intentHash: hex("intent"),
          phase: "ready",
          unitName: `wsmp-${row.handle}-r0`,
          port: 30_301,
          handle: row.handle,
          models: ["m"],
          engineFacts: { kvTokens: { value: 123_456, source: "probe" } },
        },
      ],
    );
    const after = await instance(id);
    expect(after.phase).toBe("READY");
    expect(after.observedKvBudgetTokens).toBe(123_456);
    expect(after.factsAt).not.toBeNull();
  });
});

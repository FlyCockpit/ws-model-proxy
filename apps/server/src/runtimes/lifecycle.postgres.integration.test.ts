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
  /** A service runtime whose start a person runs in an operator terminal. */
  let operatorRuntimeId = "";
  let operatorVersionId = "";
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
    which: "plain" | "operator" = "plain",
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
      which === "operator" ? [operatorRuntimeId, operatorVersionId] : [runtimeId, versionId];
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

  it("settles a forgotten stop and releases it once a status probe proves it", async () => {
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

  async function ready(lc: Awaited<ReturnType<typeof engine>>, port: number) {
    const id = await startInstance(port);
    await lc.runOnce();
    await answer(lc, lastJob(id, "start"), "succeeded");
    await lc.runOnce();
    await answer(lc, lastJob(id, "readiness"), "succeeded");
    expect((await instance(id)).phase).toBe("READY");
    return id;
  }

  it("asks a person to Forget a stop whose node stays offline", async () => {
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

  const stopInstance = (id: string) =>
    m.fixture.runtimeInstance.update({
      where: { id },
      data: { desiredState: "STOPPED", phase: "STOPPING", phaseReason: "stop_requested" },
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

  it("opens no terminal for a banned owner", async () => {
    const lc = await engine();
    const id = await startInstance(30_207, "USER", "operator");
    await m.fixture.user.update({ where: { id: userId }, data: { banned: true } });
    try {
      const before = sent.length;
      await lc.runOnce();
      expect(sent.slice(before).some((job) => job.instanceId === id)).toBe(false);
      expect((await step(id, "START")).state).toBe("PENDING");
    } finally {
      await m.fixture.user.update({ where: { id: userId }, data: { banned: false } });
    }
    await stopInstance(id);
    await lc.runOnce();
    expect((await instance(id)).phase).toBe("STOPPED");
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
});

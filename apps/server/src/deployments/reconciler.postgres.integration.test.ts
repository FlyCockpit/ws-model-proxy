import { deploymentFingerprint } from "@ws-model-proxy/api/lib/deployment-planner";
import {
  deploymentJobIntentSchema,
  deploymentSpecSchema,
  originalDeploymentStopIntent,
} from "@ws-model-proxy/api/lib/deployment-spec";
import type {
  DeploymentJob,
  DeploymentJobResult,
} from "@ws-model-proxy/config/deployment-protocol";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeploymentLiveSocket } from "./reconciler.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("Postgres fixture URL required");
const integration = databaseUrl ? describe : describe.skip;
// Loaded after the skip guard: `./reconciler.js` and the deployment service
// import the production Prisma client, whose env validation fails in a unit
// run with no database.
type DeploymentService = typeof import("@ws-model-proxy/api/lib/deployment-service");
let loadDeploymentState: DeploymentService["loadDeploymentState"];
let reopenDeploymentOperatorStep: DeploymentService["reopenDeploymentOperatorStep"];
let restartDeploymentInstance: DeploymentService["restartDeploymentInstance"];
let DeploymentReconciler: typeof import("./reconciler.js").DeploymentReconciler;
let flushDeploymentOperatorAudit: typeof import("./operator-audit.js").flushDeploymentOperatorAudit;
let createDeploymentPlan: DeploymentService["createDeploymentPlan"];
let applyDeploymentPlan: DeploymentService["applyDeploymentPlan"];

integration("deployment result fencing at PostgreSQL", () => {
  let fixture: ReturnType<typeof createFixturePrismaClient>;
  let production: ReturnType<typeof createPrismaClient>;
  const users: string[] = [];
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("fixture missing");
    fixture = createFixturePrismaClient(databaseUrl);
    production = createPrismaClient(databaseUrl);
    ({ DeploymentReconciler } = await import("./reconciler.js"));
  });
  afterAll(async () => {
    // Synthetic jobs only; this fixture transport never launches operating-system processes.
    await fixture.deploymentInstanceNode.updateMany({
      where: { Instance: { userId: { in: users } } },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    for (const id of users) await fixture.user.delete({ where: { id } });
    await Promise.all([fixture?.$disconnect(), production?.$disconnect()]);
  });
  async function seed(pending = false) {
    const suffix = crypto.randomUUID();
    const user = await fixture.user.create({
      data: {
        name: "Deployment fence",
        email: `deployment-${suffix}@example.test`,
        slug: `deployment-${suffix}`,
      },
    });
    users.push(user.id);
    const pool = await fixture.modelPool.create({
      data: { userId: user.id, name: "Deployment test", slug: `pool-${suffix}` },
    });
    const device = await fixture.cliDevice.create({
      data: {
        userId: user.id,
        slug: `node-${suffix}`,
        status: "CONNECTED",
        connectionGeneration: 1,
        allowDeployments: true,
        reportedDeployments: true,
      },
    });
    const config = await fixture.deploymentConfig.create({
      data: { userId: user.id, poolId: pool.id, slug: `recipe-${suffix}`, name: "Recipe" },
    });
    const revision = await fixture.deploymentConfigRevision.create({
      data: {
        configId: config.id,
        revision: 1,
        editorId: user.id,
        editorKind: "USER",
        contentHash: "a".repeat(64),
        spec: { variants: [] },
      },
    });
    const plan = await fixture.deploymentPlan.create({
      data: {
        userId: user.id,
        requesterId: user.id,
        requesterKind: "USER",
        state: "APPLIED",
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: "b".repeat(64),
        contents: { affectedNodeIds: [device.id] },
      },
    });
    const run = await fixture.deploymentRun.create({ data: { planId: plan.id } });
    const instance = await fixture.deploymentInstance.create({
      data: {
        userId: user.id,
        configId: config.id,
        revisionId: revision.id,
        runId: run.id,
        variantKey: "one",
        endpointSlug: `inst-${suffix}`,
        startedBy: "USER",
        desiredState: "STOPPED",
        observedState: "STOPPING",
      },
    });
    const node = await fixture.deploymentInstanceNode.create({
      data: {
        instanceId: instance.id,
        cliDeviceId: device.id,
        rank: 0,
        port: 30000,
        resources: { kind: "unified", memoryGb: 1, ramGb: 0, gpus: [] },
      },
    });
    const intent = {
      type: "deployment.job",
      attachment: "llm",
      engine: "other",
      management: "ownedProcess",
      stopCommand: "true",
      instanceId: instance.id,
      revisionId: revision.id,
      rank: 0,
      action: "stop",
      command: "true",
      timeoutMs: 300_000,
      unitName: `wsmp-i-${instance.id}-r0`,
      port: 30000,
      endpointSlug: instance.endpointSlug,
      models: ["test"],
      contextWindow: null,
      readiness: { path: "/health", expectedStatus: 200 },
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
    };
    const step = await fixture.deploymentStep.create({
      data: {
        runId: run.id,
        instanceId: instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "stop",
        sequence: 0,
        state: pending ? "PENDING" : "RUNNING",
        intent,
        intentHash: deploymentFingerprint(intent),
        ownerEpoch: pending ? null : "stale:1",
        deadline: pending ? null : new Date(Date.now() + 300_000),
      },
    });
    return { user, device, instance, node, step };
  }
  it("rejects a stale owner epoch and another device without releasing claims", async () => {
    const s = await seed();
    const socket: DeploymentLiveSocket = {
      userId: s.user.id,
      cliDeviceId: s.device.id,
      generation: 1,
      inventoryComplete: true,
    };
    const reconciler = new DeploymentReconciler(
      { current: () => socket, send: () => true },
      production,
    );
    const result = {
      type: "deployment.job.result" as const,
      stepId: s.step.id,
      instanceId: s.instance.id,
      rank: 0,
      intentHash: s.step.intentHash,
      ownerEpoch: "stale:1",
      status: "succeeded" as const,
      stopped: true,
    };
    expect(await reconciler.acceptResult(socket, result)).toBe(false);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.node.id } }))
        .claimHeld,
    ).toBe(true);
    const foreign = { ...socket, cliDeviceId: `foreign-${crypto.randomUUID()}` };
    expect(await reconciler.acceptResult(foreign, result)).toBe(false);
    await reconciler.stop();
  });
  it("a replacement generation fences an already received old-socket result", async () => {
    const s = await seed();
    const socket: DeploymentLiveSocket = {
      userId: s.user.id,
      cliDeviceId: s.device.id,
      generation: 1,
      inventoryComplete: true,
    };
    const reconciler = new DeploymentReconciler(
      { current: () => socket, send: () => true },
      production,
    );
    await fixture.cliDevice.update({
      where: { id: s.device.id },
      data: { connectionGeneration: 2 },
    });
    expect(
      await reconciler.acceptResult(socket, {
        type: "deployment.job.result",
        stepId: s.step.id,
        instanceId: s.instance.id,
        rank: 0,
        intentHash: s.step.intentHash,
        ownerEpoch: "stale:1",
        status: "succeeded",
        stopped: true,
      }),
    ).toBe(false);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.node.id } }))
        .claimHeld,
    ).toBe(true);
    await reconciler.stop();
  });
  it("commits the dispatch lease before sending and releases only a confirmed owned stop", async () => {
    const s = await seed(true);
    const socket: DeploymentLiveSocket = {
      userId: s.user.id,
      cliDeviceId: s.device.id,
      generation: 1,
      inventoryComplete: true,
    };
    const jobs: DeploymentJob[] = [];
    const reconciler = new DeploymentReconciler(
      {
        current: () => socket,
        send: (_socket, job) => {
          jobs.push(job);
          return true;
        },
      },
      production,
    );
    await reconciler.acceptInventory(socket, []);
    await reconciler.runOnce();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    if (!job) throw new Error("dispatch missing");
    const persisted = await fixture.deploymentStep.findUniqueOrThrow({ where: { id: s.step.id } });
    expect(persisted.state).toBe("RUNNING");
    expect(persisted.ownerEpoch).toBe(job.ownerEpoch);
    const base = {
      type: "deployment.job.result" as const,
      stepId: job.stepId,
      instanceId: job.instanceId,
      rank: job.rank,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      status: "succeeded" as const,
    };
    expect(await reconciler.acceptResult(socket, { ...base, stopped: false })).toBe(true);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.node.id } }))
        .claimHeld,
    ).toBe(true);
    await fixture.deploymentStep.update({
      where: { id: s.step.id },
      data: { state: "RUNNING", ownerEpoch: job.ownerEpoch },
    });
    expect(await reconciler.acceptResult(socket, { ...base, stopped: true })).toBe(true);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.node.id } }))
        .claimHeld,
    ).toBe(false);
    expect(await reconciler.acceptResult(socket, { ...base, stopped: true })).toBe(false);
    await reconciler.stop();
  });
  it("operator progress never settles, fails or mutates a running step", async () => {
    const s = await seed(true);
    const socket: DeploymentLiveSocket = {
      userId: s.user.id,
      cliDeviceId: s.device.id,
      generation: 1,
      inventoryComplete: true,
    };
    const jobs: DeploymentJob[] = [];
    const reconciler = new DeploymentReconciler(
      {
        current: () => socket,
        send: (_socket, job) => {
          jobs.push(job);
          return true;
        },
      },
      production,
    );
    await reconciler.acceptInventory(socket, []);
    await reconciler.runOnce();
    const job = jobs[0];
    if (!job) throw new Error("dispatch missing");
    const before = await fixture.deploymentStep.findUniqueOrThrow({ where: { id: s.step.id } });
    const instanceBefore = await fixture.deploymentInstance.findUniqueOrThrow({
      where: { id: s.instance.id },
    });
    expect(before.state).toBe("RUNNING");
    const base = {
      type: "deployment.job.result" as const,
      stepId: job.stepId,
      instanceId: job.instanceId,
      rank: job.rank,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      stopped: false,
      terminalId: "AAECAwQFBgcICQoLDA0ODw",
    };
    for (const result of [
      { ...base, status: "awaiting_operator" as const },
      { ...base, status: "operator_running" as const },
      { ...base, status: "operator_closed" as const, exitCode: 1 },
      { ...base, status: "operator_closed" as const },
    ])
      expect(await reconciler.acceptResult(socket, result)).toBe(false);
    expect(await fixture.deploymentStep.findUniqueOrThrow({ where: { id: s.step.id } })).toEqual(
      before,
    );
    expect(
      await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }),
    ).toEqual(instanceBefore);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.node.id } }))
        .claimHeld,
    ).toBe(true);
    // The real final result still settles the step.
    const { terminalId: _terminalId, ...final } = base;
    expect(
      await reconciler.acceptResult(socket, { ...final, status: "succeeded", stopped: true }),
    ).toBe(true);
    await reconciler.stop();
  });
});

integration("interactive operator steps at PostgreSQL", () => {
  let fixture: ReturnType<typeof createFixturePrismaClient>;
  let production: ReturnType<typeof createPrismaClient>;
  const users: string[] = [];
  const reconcilers: InstanceType<typeof DeploymentReconciler>[] = [];
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("fixture missing");
    fixture = createFixturePrismaClient(databaseUrl);
    production = createPrismaClient(databaseUrl);
    ({ DeploymentReconciler } = await import("./reconciler.js"));
    ({ flushDeploymentOperatorAudit } = await import("./operator-audit.js"));
    ({
      loadDeploymentState,
      reopenDeploymentOperatorStep,
      restartDeploymentInstance,
      createDeploymentPlan,
      applyDeploymentPlan,
    } = await import("@ws-model-proxy/api/lib/deployment-service"));
  });
  afterAll(async () => {
    for (const reconciler of reconcilers) await reconciler.stop();
    await flushDeploymentOperatorAudit();
    await fixture.deploymentOperatorEvent.deleteMany({ where: { userId: { in: users } } });
    // Synthetic jobs only; this fixture transport never launches operating-system processes.
    await fixture.deploymentInstanceNode.updateMany({
      where: { Instance: { userId: { in: users } } },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    for (const id of users) await fixture.user.delete({ where: { id } });
    await Promise.all([fixture?.$disconnect(), production?.$disconnect()]);
  });

  async function owner() {
    const suffix = crypto.randomUUID();
    const user = await fixture.user.create({
      data: { name: "Operator", email: `operator-${suffix}@example.test`, slug: `op-${suffix}` },
    });
    users.push(user.id);
    return user;
  }
  async function node(userId: string) {
    return fixture.cliDevice.create({
      data: {
        userId,
        slug: `node-${crypto.randomUUID()}`,
        status: "CONNECTED",
        connectionGeneration: 1,
        lastHeartbeatAt: new Date(),
        allowDeployments: true,
        reportedDeployments: true,
        relayProtocolVersion: "2.4",
        usableMemoryGb: 64,
        deploymentPortStart: 30000,
        deploymentPortEnd: 30999,
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 64 * 1024,
          executionMechanism: "systemd+linger",
        },
      },
    });
  }
  /**
   * An instance whose every rank starts with an interactive command (sequence 0, so ranks
   * compete for the one-terminal-at-a-time rule), then readiness. `desired: "STOPPED"` with
   * `stop` seeds a pending stop per rank instead (interactive when `stopInteractive`).
   */
  async function instance(
    userId: string,
    devices: string[],
    options: {
      port?: number;
      interactiveStart?: boolean;
      stopInteractive?: boolean;
      stopping?: boolean;
    } = {},
  ) {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const interactiveStart = options.interactiveStart ?? true;
    const pool = await fixture.modelPool.create({
      data: { userId, name: "Operator", slug: `pool-${suffix}` },
    });
    const config = await fixture.deploymentConfig.create({
      data: { userId, poolId: pool.id, slug: `recipe-${suffix}`, name: "Recipe" },
    });
    const spec = deploymentSpecSchema.parse({
      variants: [
        {
          key: "one",
          engine: "other",
          groupSize: devices.length,
          resources: [{ kind: "unified", memoryGb: 10 }],
          commands: [
            {
              management: "externalService",
              start: "sudo systemctl start model",
              stop: "sudo systemctl stop model",
              status: "systemctl is-active model",
              ...(interactiveStart || options.stopInteractive
                ? {
                    interactive: {
                      ...(interactiveStart ? { start: true } : {}),
                      ...(options.stopInteractive ? { stop: true } : {}),
                    },
                  }
                : {}),
            },
          ],
          readiness: { path: "/health" },
          health: { intervalMs: 60_000, failureThreshold: 3, successThreshold: 1 },
          models: ["model"],
          attachment: { type: "llm", poolId: pool.id },
          hardConcurrencyLimit: 1,
          ...(devices.length > 1 ? { iface: "eth0" } : {}),
        },
      ],
    });
    const revision = await fixture.deploymentConfigRevision.create({
      data: {
        configId: config.id,
        revision: 1,
        editorId: userId,
        editorKind: "USER",
        contentHash: deploymentFingerprint(spec),
        spec,
      },
    });
    const plan = await fixture.deploymentPlan.create({
      data: {
        userId,
        requesterId: userId,
        requesterKind: "USER",
        state: "APPLIED",
        expiresAt: new Date(Date.now() + 60_000),
        fingerprint: "c".repeat(64),
        contents: { affectedNodeIds: [...new Set(devices)] },
      },
    });
    const run = await fixture.deploymentRun.create({ data: { planId: plan.id } });
    const created = await fixture.deploymentInstance.create({
      data: {
        userId,
        configId: config.id,
        revisionId: revision.id,
        runId: run.id,
        variantKey: "one",
        endpointSlug: `inst-${suffix}`,
        startedBy: "USER",
        ...(options.stopping ? { desiredState: "STOPPED", observedState: "STOPPING" } : {}),
      },
    });
    const starts = [];
    const stops = [];
    for (const [rank, deviceId] of devices.entries()) {
      const port = (options.port ?? 30000) + rank;
      await fixture.deploymentInstanceNode.create({
        data: {
          instanceId: created.id,
          cliDeviceId: deviceId,
          rank,
          port,
          resources: { kind: "unified", memoryGb: 10, ramGb: 0, gpus: [] },
        },
      });
      const intent = deploymentJobIntentSchema.parse({
        type: "deployment.job",
        instanceId: created.id,
        revisionId: revision.id,
        rank,
        action: "start",
        attachment: "llm",
        engine: "other",
        management: "externalService",
        command: "sudo systemctl start model",
        ...(interactiveStart ? { interactive: true } : {}),
        ...(options.stopInteractive ? { stopInteractive: true } : {}),
        stopCommand: "sudo systemctl stop model",
        statusCommand: "systemctl is-active model",
        timeoutMs: 120_000,
        unitName: `wsmp-i-${created.id}-r${rank}`,
        port,
        endpointSlug: created.endpointSlug,
        models: ["model"],
        contextWindow: null,
        readiness: { path: "/health", expectedStatus: 200 },
        health: { intervalMs: 60_000, failureThreshold: 3, successThreshold: 1 },
      });
      starts.push(
        await fixture.deploymentStep.create({
          data: {
            runId: run.id,
            instanceId: created.id,
            cliDeviceId: deviceId,
            rank,
            phase: "start",
            sequence: 0,
            intent,
            intentHash: deploymentFingerprint(intent),
            state: options.stopping ? "SUCCEEDED" : "PENDING",
          },
        }),
      );
      const { interactive: _i, stopInteractive: _s, ...plain } = intent;
      const ready = { ...plain, action: "readiness" as const, command: "" };
      await fixture.deploymentStep.create({
        data: {
          runId: run.id,
          instanceId: created.id,
          cliDeviceId: deviceId,
          rank,
          phase: "readiness",
          sequence: 3,
          intent: ready,
          intentHash: deploymentFingerprint(ready),
          state: options.stopping ? "SUCCEEDED" : "PENDING",
        },
      });
      if (options.stopping) {
        const stop = originalDeploymentStopIntent(intent);
        stops.push(
          await fixture.deploymentStep.create({
            data: {
              runId: run.id,
              instanceId: created.id,
              cliDeviceId: deviceId,
              rank,
              phase: "stop",
              sequence: 100,
              intent: stop,
              intentHash: deploymentFingerprint(stop),
            },
          }),
        );
      }
    }
    return { instance: created, starts, stops };
  }
  function socketFor(userId: string, cliDeviceId: string, generation = 1): DeploymentLiveSocket {
    return {
      userId,
      cliDeviceId,
      generation,
      inventoryComplete: true,
      deploymentOperator: true,
      operatorRoom: true,
    };
  }
  /** A reconciler over the real database with a recording transport. */
  function harness(sockets: DeploymentLiveSocket[]) {
    const live = new Map(sockets.map((socket) => [socket.cliDeviceId, socket]));
    const jobs: DeploymentJob[] = [];
    const deviceOf = new Map<string, string>();
    const closes: Array<{ stepId: string; keepRunning: boolean }> = [];
    /** Sends and closes in the order they happened. */
    const log: string[] = [];
    const control = {
      closeAnswer: "absent" as "closed" | "running" | "absent",
      sendOk: true,
    };
    const reconciler = new DeploymentReconciler(
      {
        current: (id) => live.get(id) ?? null,
        send: (socket, job) => {
          jobs.push(job);
          log.push(`send:${job.stepId}`);
          deviceOf.set(job.stepId, socket.cliDeviceId);
          return control.sendOk;
        },
        closeOperatorStep: (stepId, options) => {
          closes.push({ stepId, keepRunning: options?.keepRunning === true });
          log.push(`close:${stepId}`);
          return control.closeAnswer;
        },
      },
      production,
    );
    reconcilers.push(reconciler);
    async function ticks(count = 3) {
      for (let k = 0; k < count; k++) await reconciler.runOnce();
    }
    async function tickUntil(predicate: () => boolean | Promise<boolean>) {
      for (let k = 0; k < 20; k++) {
        await reconciler.runOnce();
        if (await predicate()) return;
      }
      throw new Error("condition not reached");
    }
    function report(
      job: DeploymentJob,
      status: DeploymentJobResult["status"],
      extra: Partial<DeploymentJobResult> = {},
    ) {
      const socket = live.get(deviceOf.get(job.stepId) ?? "");
      if (!socket) throw new Error("socket missing");
      return reconciler.acceptResult(socket, {
        type: "deployment.job.result",
        stepId: job.stepId,
        instanceId: job.instanceId,
        rank: job.rank,
        intentHash: job.intentHash,
        ownerEpoch: job.ownerEpoch,
        status,
        stopped: false,
        // Every result of an interactive job names its dispatch's terminal.
        ...(job.operator ? { terminalId: job.operator.terminalId } : {}),
        ...extra,
      });
    }
    return { reconciler, jobs, closes, log, control, live, ticks, tickUntil, report };
  }
  const step = (id: string) => fixture.deploymentStep.findUniqueOrThrow({ where: { id } });
  const need = async (id: string) =>
    (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id } })).needsOperator;
  const inst = (id: string) => fixture.deploymentInstance.findUniqueOrThrow({ where: { id } });

  it("waits for its person, records acceptance and retries, then readiness publishes", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const start = s.starts[0]!;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(job).toMatchObject({ stepId: start.id, action: "start", interactive: true });
    expect(job.operator?.terminalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(job.operator?.commandAuthor).toBe("user");
    let row = await step(start.id);
    expect(row).toMatchObject({
      state: "RUNNING",
      operatorTerminalId: job.operator?.terminalId,
      operatorSince: null,
      attempts: 1,
    });
    // The spawn deadline: the CLI's budget for the job (120 s here) plus a minute of grace.
    expect(row.deadline!.getTime()).toBeGreaterThan(Date.now() + 170_000);
    expect(row.deadline!.getTime()).toBeLessThanOrEqual(Date.now() + 180_000);

    expect(await h.report(job, "awaiting_operator")).toBe(true);
    row = await step(start.id);
    expect(row).toMatchObject({ state: "AWAITING_OPERATOR", deadline: null, leaseExpiresAt: null });
    const since = row.operatorSince;
    expect(since).not.toBeNull();
    expect(await need(s.instance.id)).toBe("STEP");
    // A repeated screen changes nothing; a waiting step has no wall-clock deadline.
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    await h.ticks();
    expect(await step(start.id)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorSince: since,
    });
    expect(h.jobs).toHaveLength(1);

    expect(await h.report(job, "operator_running")).toBe(true);
    row = await step(start.id);
    expect(row).toMatchObject({ state: "RUNNING", operatorSince: since });
    expect(row.operatorAcceptedAt).not.toBeNull();
    expect(row.deadline!.getTime()).toBeGreaterThan(Date.now() + 100_000);
    expect(await need(s.instance.id)).toBeNull();

    // A failed run shows the retry screen in the same terminal: the open time is kept.
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    expect(await step(start.id)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorSince: since,
    });
    expect(await need(s.instance.id)).toBe("STEP");
    expect(await h.report(job, "operator_running")).toBe(true);
    // Stale progress naming another terminal is ignored.
    expect(await h.report(job, "operator_closed", { terminalId: "AAECAwQFBgcICQoLDA0ODw" })).toBe(
      false,
    );
    expect((await step(start.id)).state).toBe("RUNNING");

    expect(await h.report(job, "succeeded")).toBe(true);
    expect(await step(start.id)).toMatchObject({ state: "SUCCEEDED", operatorTerminalId: null });
    expect(await need(s.instance.id)).toBeNull();
    await h.tickUntil(() => h.jobs.length > 1);
    const readiness = h.jobs[1]!;
    expect(readiness.action).toBe("readiness");
    expect(readiness.operator).toBeUndefined();
    expect(await h.report(readiness, "succeeded")).toBe(true);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .observedState,
    ).toBe("RUNNING");
  });

  it("holds interactive and stop-interactive steps on a node without the capability or room", async () => {
    const user = await owner();
    const device = await node(user.id);
    const interactive = await instance(user.id, [device.id]);
    const stopOnly = await instance(user.id, [device.id], {
      port: 30100,
      interactiveStart: false,
      stopInteractive: true,
    });
    const socket = { ...socketFor(user.id, device.id), deploymentOperator: false };
    const h = harness([socket]);
    await h.ticks(4);
    expect(h.jobs).toEqual([]);
    for (const id of [interactive.starts[0]!.id, stopOnly.starts[0]!.id])
      expect(await step(id)).toMatchObject({ state: "PENDING", attempts: 0, ownerEpoch: null });
    // Capable, but the session tracks as many terminals as it can: only the plain job goes.
    h.live.set(device.id, { ...socket, deploymentOperator: true, operatorRoom: false });
    await h.tickUntil(() => h.jobs.length > 0);
    await h.ticks(2);
    expect(h.jobs.map((job) => job.stepId)).toEqual([stopOnly.starts[0]!.id]);
    expect(h.jobs[0]!.operator).toBeUndefined();
    expect(h.jobs[0]!.stopInteractive).toBe(true);
    expect((await step(interactive.starts[0]!.id)).state).toBe("PENDING");
    h.live.set(device.id, socketFor(user.id, device.id));
    await h.tickUntil(() => h.jobs.length > 1);
    expect(h.jobs[1]!.stepId).toBe(interactive.starts[0]!.id);
  });

  it("a final success that overtakes its run report records the acceptance", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    expect(await h.report(job, "succeeded")).toBe(true);
    const row = await step(s.starts[0]!.id);
    expect(row.state).toBe("SUCCEEDED");
    expect(row.operatorAcceptedAt).not.toBeNull();
    expect(await need(s.instance.id)).toBeNull();
    // The late run report finds nothing to move.
    expect(await h.report(job, "operator_running")).toBe(false);
  });

  it("a closed terminal waits for its person; spawn failures and a switched-off node too", async () => {
    const user = await owner();
    const device = await node(user.id);
    const declined = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    expect(await h.report(job, "operator_closed")).toBe(true);
    let row = await step(declined.starts[0]!.id);
    expect(row).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorTerminalId: null,
      // A decline is not an attempt.
      attempts: 0,
    });
    expect(row.operatorSince).not.toBeNull();
    expect(await need(declined.instance.id)).toBe("STEP");
    // Nothing more is accepted from the closed terminal, and nothing reopens by itself,
    // not even after a reconnect.
    expect(await h.report(job, "operator_running")).toBe(false);
    await fixture.cliDevice.update({
      where: { id: device.id },
      data: { connectionGeneration: 2 },
    });
    h.live.set(device.id, socketFor(user.id, device.id, 2));
    await h.ticks(4);
    expect(h.jobs).toHaveLength(1);
    expect((await step(declined.starts[0]!.id)).state).toBe("AWAITING_OPERATOR");
    // Claims stay held while it waits.
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { instanceId: declined.instance.id, claimHeld: true },
      }),
    ).toBe(1);

    // A terminal that never opened (the CLI could not spawn it) waits the same way.
    const unopened = await instance(user.id, [device.id], { port: 30200 });
    await h.tickUntil(() => h.jobs.length > 1);
    const second = h.jobs[1]!;
    expect(second.stepId).toBe(unopened.starts[0]!.id);
    expect(await h.report(second, "operator_closed", { error: "operator_terminal_limit" })).toBe(
      true,
    );
    row = await step(unopened.starts[0]!.id);
    expect(row).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorTerminalId: null,
      errorCode: "operator_terminal_limit",
    });
    expect(row.operatorSince).not.toBeNull();

    // The node's operator-terminal switch is off: waits for its person, no gang stop.
    const disabled = await instance(user.id, [device.id], { port: 30300 });
    await h.tickUntil(() => h.jobs.length > 2);
    const third = h.jobs[2]!;
    expect(await h.report(third, "failed", { error: "operator_terminals_disabled" })).toBe(true);
    expect(await step(disabled.starts[0]!.id)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorTerminalId: null,
      errorCode: "operator_terminals_disabled",
    });
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: disabled.instance.id } }))
        .observedState,
    ).toBe("STARTING");
  });

  it("a reconnect reopens a waiting terminal afresh, but never one whose command runs", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    await fixture.cliDevice.update({
      where: { id: device.id },
      data: { connectionGeneration: 2 },
    });
    const next = socketFor(user.id, device.id, 2);
    h.live.set(device.id, next);
    // The old session's terminal still runs a command: keep the step.
    h.control.closeAnswer = "running";
    await h.ticks(3);
    expect((await step(s.starts[0]!.id)).state).toBe("AWAITING_OPERATOR");
    expect(h.closes.at(-1)).toEqual({ stepId: s.starts[0]!.id, keepRunning: true });
    h.control.closeAnswer = "absent";
    await h.tickUntil(() => h.jobs.length > 1);
    const again = h.jobs[1]!;
    expect(again.stepId).toBe(s.starts[0]!.id);
    expect(again.ownerEpoch.endsWith(":2")).toBe(true);
    expect(again.operator?.terminalId).not.toBe(job.operator?.terminalId);
    const row = await step(s.starts[0]!.id);
    expect(row).toMatchObject({
      state: "RUNNING",
      operatorTerminalId: again.operator?.terminalId,
      operatorSince: null,
      attempts: 1,
    });
    expect(await need(s.instance.id)).toBeNull();
    // Progress from the old dispatch no longer matches.
    expect(
      await h.reconciler.acceptResult(next, {
        type: "deployment.job.result",
        stepId: job.stepId,
        instanceId: job.instanceId,
        rank: job.rank,
        intentHash: job.intentHash,
        ownerEpoch: job.ownerEpoch,
        status: "awaiting_operator",
        stopped: false,
        terminalId: job.operator?.terminalId,
      }),
    ).toBe(false);
  });

  it("re-sends on the spawn deadline, never cuts off a person's run on its deadline", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const first = h.jobs[0]!;
    await fixture.deploymentStep.update({
      where: { id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    h.control.closeAnswer = "running";
    await h.ticks(3);
    expect((await step(id)).state).toBe("RUNNING");
    h.control.closeAnswer = "closed";
    await h.tickUntil(() => h.jobs.length > 1);
    expect(h.closes).toContainEqual({ stepId: id, keepRunning: true });
    const second = h.jobs[1]!;
    expect(second.operator?.terminalId).not.toBe(first.operator?.terminalId);
    expect((await step(id)).attempts).toBe(1);

    expect(await h.report(second, "awaiting_operator")).toBe(true);
    expect(await h.report(second, "operator_running")).toBe(true);
    await fixture.deploymentStep.update({
      where: { id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    const closes = h.closes.length;
    await h.ticks(3);
    expect(await step(id)).toMatchObject({ state: "RUNNING" });
    expect(h.closes).toHaveLength(closes);
    expect(h.jobs).toHaveLength(2);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .observedState,
    ).toBe("STARTING");
  });

  it("asks one person at a time per instance, lowest rank first", async () => {
    const user = await owner();
    const head = await node(user.id);
    const worker = await node(user.id);
    const s = await instance(user.id, [head.id, worker.id]);
    const h = harness([socketFor(user.id, head.id), socketFor(user.id, worker.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    await h.ticks(3);
    expect(h.jobs.map((job) => job.rank)).toEqual([0]);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    await h.ticks(3);
    expect(h.jobs).toHaveLength(1);
    expect(await h.report(job, "operator_running")).toBe(true);
    await h.ticks(3);
    expect(h.jobs).toHaveLength(1);
    expect(await h.report(job, "succeeded")).toBe(true);
    await h.tickUntil(() => h.jobs.length > 1);
    expect(h.jobs[1]).toMatchObject({ rank: 1, stepId: s.starts[1]!.id });
  });

  it("opens at most four start terminals per node, says why, and never starves stops", async () => {
    const user = await owner();
    const device = await node(user.id);
    const starting = [];
    for (let k = 0; k < 5; k++)
      starting.push(await instance(user.id, [device.id], { port: 30400 + k * 10 }));
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length >= 4);
    await h.ticks(3);
    expect(h.jobs).toHaveLength(4);
    const held = starting.find((s) => !h.jobs.some((job) => job.stepId === s.starts[0]!.id))!;
    expect(await step(held.starts[0]!.id)).toMatchObject({
      state: "PENDING",
      errorCode: "operator_node_full",
    });
    // Interactive stops of other instances on the full node still open.
    const stops = await instance(user.id, [device.id], {
      port: 30600,
      stopInteractive: true,
      stopping: true,
    });
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === stops.stops[0]!.id));
    // One start answered: its slot frees for the fifth, and the hold reason is cleared.
    const done = h.jobs[0]!;
    expect(await h.report(done, "awaiting_operator")).toBe(true);
    expect(await h.report(done, "succeeded")).toBe(true);
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === held.starts[0]!.id));
    expect(await step(held.starts[0]!.id)).toMatchObject({ state: "RUNNING", errorCode: null });
  });

  it("opens every node's interactive stop at once", async () => {
    const user = await owner();
    const head = await node(user.id);
    const worker = await node(user.id);
    const s = await instance(user.id, [head.id, worker.id], {
      stopInteractive: true,
      stopping: true,
    });
    const h = harness([socketFor(user.id, head.id), socketFor(user.id, worker.id)]);
    await h.reconciler.runOnce();
    await h.tickUntil(() => h.jobs.length >= 2);
    expect(new Set(h.jobs.map((job) => job.stepId))).toEqual(new Set(s.stops.map((x) => x.id)));
  });

  it("a stop waits behind a person's run on that node and is re-sent, not failed", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const start = h.jobs[0]!;
    expect(await h.report(start, "awaiting_operator")).toBe(true);
    expect(await h.report(start, "operator_running")).toBe(true);
    const stopIntent = originalDeploymentStopIntent(s.starts[0]!.intent);
    const stop = await fixture.deploymentStep.create({
      data: {
        runId: s.instance.runId,
        instanceId: s.instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "stop",
        sequence: 100,
        intent: stopIntent,
        intentHash: deploymentFingerprint(stopIntent),
      },
    });
    await h.ticks(4);
    expect(h.jobs).toHaveLength(1);
    expect((await step(stop.id)).state).toBe("PENDING");
    // Sent before the run began (the CLI holds it): its deadline re-sends it later.
    await fixture.deploymentStep.update({
      where: { id: stop.id },
      data: {
        state: "RUNNING",
        ownerEpoch: start.ownerEpoch,
        attempts: 1,
        deadline: new Date(Date.now() - 1000),
      },
    });
    await h.ticks(3);
    expect(await step(stop.id)).toMatchObject({ state: "PENDING", attempts: 0 });
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { instanceId: s.instance.id, claimHeld: true },
      }),
    ).toBe(1);
    expect(h.jobs).toHaveLength(1);
    // The run ends (closed): the stop goes.
    expect(await h.report(start, "operator_closed", { exitCode: 1 })).toBe(true);
    expect(await step(s.starts[0]!.id)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorLastExit: 1,
      attempts: 1,
    });
    await h.tickUntil(() => h.jobs.length > 1);
    expect(h.jobs[1]!.stepId).toBe(stop.id);
  });
  it("a late final from an earlier copy of the step settles nothing (H1)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const first = h.jobs[0]!;
    await fixture.deploymentStep.update({
      where: { id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    h.control.closeAnswer = "closed";
    await h.tickUntil(() => h.jobs.length > 1);
    const second = h.jobs[1]!;
    expect(second.ownerEpoch).toBe(first.ownerEpoch);
    // The first copy expired in the CLI's queue and answers now, naming its own terminal.
    expect(await h.report(first, "failed", { error: "state_unavailable" })).toBe(false);
    expect(await h.report(first, "succeeded")).toBe(false);
    // A final naming no terminal cannot settle an interactive step either.
    const { operator: _operator, ...unbound } = second;
    expect(await h.report(unbound as DeploymentJob, "failed")).toBe(false);
    expect(await step(id)).toMatchObject({
      state: "RUNNING",
      operatorTerminalId: second.operator?.terminalId,
    });
    expect((await inst(s.instance.id)).observedState).toBe("STARTING");
    expect(await h.report(second, "awaiting_operator")).toBe(true);
    expect(await h.report(second, "succeeded")).toBe(true);
    expect((await step(id)).state).toBe("SUCCEEDED");
  });

  it("a reset never brings back a step a gang stop or restart replaced (H2)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    // Another failure gang-stopped the instance while the start was spawning.
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { observedState: "STOP_PENDING" },
    });
    await fixture.deploymentStep.updateMany({
      where: { instanceId: s.instance.id, state: "PENDING" },
      data: { state: "FAILED", errorCode: "startup_failed" },
    });
    await fixture.deploymentStep.update({
      where: { id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    h.control.closeAnswer = "closed";
    await h.ticks(3);
    expect(await step(id)).toMatchObject({ state: "FAILED", errorCode: "operator_superseded" });
    expect(h.closes).toContainEqual({ stepId: id, keepRunning: true });
    // Restart generation 1: only its own start is dispatched.
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { observedState: "STARTING", restartAttempts: 1 },
    });
    // Even a PENDING step of the earlier generation is never dispatched.
    await fixture.deploymentStep.update({
      where: { id },
      data: { state: "PENDING", errorCode: null },
    });
    await h.ticks(3);
    expect(h.jobs).toHaveLength(1);
    const old = await step(id);
    const fresh = await fixture.deploymentStep.create({
      data: {
        runId: old.runId,
        instanceId: s.instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "start",
        sequence: 10,
        intent: old.intent as object,
        intentHash: old.intentHash,
      },
    });
    await h.tickUntil(() => h.jobs.length > 1);
    await h.ticks(2);
    expect(h.jobs.slice(1).map((job) => job.stepId)).toEqual([fresh.id]);
  });

  it("a person's run past its timeout needs them again; its end clears it", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    expect(await h.report(job, "operator_running")).toBe(true);
    expect(await need(s.instance.id)).toBeNull();
    await fixture.deploymentStep.update({
      where: { id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    await h.ticks(3);
    expect((await step(id)).state).toBe("RUNNING");
    expect(await need(s.instance.id)).toBe("STEP");
    expect(await h.report(job, "succeeded")).toBe(true);
    expect(await need(s.instance.id)).toBeNull();
  });

  it("records why a step is held and clears it on dispatch", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    const socket = socketFor(user.id, device.id);
    const h = harness([{ ...socket, deploymentOperator: false }]);
    await h.ticks(3);
    expect(await step(id)).toMatchObject({
      state: "PENDING",
      errorCode: "operator_capability_missing",
    });
    h.live.set(device.id, { ...socket, operatorRoom: false });
    await h.ticks(3);
    expect(await step(id)).toMatchObject({ state: "PENDING", errorCode: "operator_session_full" });
    h.live.set(device.id, socket);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(await step(id)).toMatchObject({ state: "RUNNING", errorCode: null });
  });

  it("applies a step's results in arrival order", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    // Both arrive before either is applied; the screen report must not overtake the run.
    const [awaiting, running] = await Promise.all([
      h.report(job, "awaiting_operator"),
      h.report(job, "operator_running"),
    ]);
    expect([awaiting, running]).toEqual([true, true]);
    const row = await step(s.starts[0]!.id);
    expect(row.state).toBe("RUNNING");
    expect(row.operatorAcceptedAt).not.toBeNull();
  });

  it("closes the terminal of a job the CLI never received", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    h.control.sendOk = false;
    await h.tickUntil(() => h.jobs.length > 0);
    expect(h.closes).toContainEqual({ stepId: s.starts[0]!.id, keepRunning: false });
    expect(await step(s.starts[0]!.id)).toMatchObject({
      state: "PENDING",
      attempts: 0,
      operatorTerminalId: null,
    });
  });

  it("a higher rank waits while a lower rank of its sequence cannot open yet", async () => {
    const user = await owner();
    const head = await node(user.id);
    const worker = await node(user.id);
    const s = await instance(user.id, [head.id, worker.id]);
    const h = harness([
      { ...socketFor(user.id, head.id), deploymentOperator: false },
      socketFor(user.id, worker.id),
    ]);
    await h.ticks(4);
    expect(h.jobs).toEqual([]);
    expect((await step(s.starts[0]!.id)).errorCode).toBe("operator_capability_missing");
    expect(await step(s.starts[1]!.id)).toMatchObject({ state: "PENDING", errorCode: null });
  });

  it("an interactive stop held behind a run is re-sent, then settles and releases claims", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const start = h.jobs[0]!;
    expect(await h.report(start, "awaiting_operator")).toBe(true);
    expect(await h.report(start, "operator_running")).toBe(true);
    const stopIntent = originalDeploymentStopIntent(s.starts[0]!.intent);
    const stop = await fixture.deploymentStep.create({
      data: {
        runId: s.instance.runId,
        instanceId: s.instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "stop",
        sequence: 100,
        intent: stopIntent,
        intentHash: deploymentFingerprint(stopIntent),
      },
    });
    // Sent before the run began; the CLI holds it, and its spawn deadline passes.
    await fixture.deploymentStep.update({
      where: { id: stop.id },
      data: {
        state: "RUNNING",
        ownerEpoch: start.ownerEpoch,
        attempts: 1,
        deadline: new Date(Date.now() - 1000),
        operatorTerminalId: "AAECAwQFBgcICQoLDA0ODw",
      },
    });
    h.control.closeAnswer = "closed";
    await h.ticks(3);
    expect(await step(stop.id)).toMatchObject({
      state: "PENDING",
      attempts: 0,
      operatorTerminalId: null,
    });
    expect(h.jobs).toHaveLength(1);
    expect(await h.report(start, "operator_closed", { exitCode: 3 })).toBe(true);
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === stop.id));
    const sent = h.jobs.find((job) => job.stepId === stop.id)!;
    expect(sent.operator).toBeDefined();
    expect(await h.report(sent, "awaiting_operator")).toBe(true);
    expect(await h.report(sent, "succeeded", { stopped: true })).toBe(true);
    expect((await step(stop.id)).state).toBe("SUCCEEDED");
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { instanceId: s.instance.id, claimHeld: true },
      }),
    ).toBe(0);
    expect((await inst(s.instance.id)).observedState).toBe("STOPPED");
  });

  it("a run closed while opening keeps its exit code; an unverified run fails the start", async () => {
    const user = await owner();
    const device = await node(user.id);
    const a = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(await h.report(h.jobs[0]!, "operator_closed", { exitCode: 7 })).toBe(true);
    expect(await step(a.starts[0]!.id)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorLastExit: 7,
      // Something ran: the attempt counts.
      attempts: 1,
    });
    const b = await instance(user.id, [device.id], { port: 30500 });
    await h.tickUntil(() => h.jobs.length > 1);
    const job = h.jobs[1]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    expect(await h.report(job, "failed", { error: "operator_unverified" })).toBe(true);
    expect(await step(b.starts[0]!.id)).toMatchObject({
      state: "FAILED",
      errorCode: "operator_unverified",
    });
    expect((await inst(b.instance.id)).observedState).toBe("STOP_PENDING");
    expect(await need(b.instance.id)).toBeNull();
    expect(
      await fixture.deploymentStep.count({ where: { instanceId: b.instance.id, phase: "stop" } }),
    ).toBe(1);
  });

  // ---- Chunk 8: lifecycle (gang stop, desired stop, restart policy, inactive owners) ----

  /** Steps of the instance's rank in a phase, oldest first. */
  const stepsOf = (instanceId: string, phase: string) =>
    fixture.deploymentStep.findMany({
      where: { instanceId, phase },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  /** Make the instance's node look offline long enough for maintenance's gang stop. */
  async function offline(deviceId: string, instanceId: string) {
    await fixture.cliDevice.update({
      where: { id: deviceId },
      data: { lastHeartbeatAt: new Date(Date.now() - 300_000) },
    });
    await fixture.$executeRaw`UPDATE deployment_instance SET "updatedAt" = now() - interval '5 minutes' WHERE id = ${instanceId}`;
  }

  it("a gang stop waits for an interactive stop's person, never adds a second stop, and never restarts an interactive start on its own", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const start = h.jobs[0]!;
    expect(await h.report(start, "awaiting_operator")).toBe(true);
    // The person's run exited 0 but status never showed the service: startup failed.
    expect(await h.report(start, "failed", { error: "operator_unverified" })).toBe(true);
    let row = await inst(s.instance.id);
    expect(row).toMatchObject({ observedState: "STOP_PENDING", nextRestartAt: null });
    const [stop] = await stepsOf(s.instance.id, "stop");
    expect(stop).toMatchObject({ state: "PENDING", errorCode: "startup_failed" });
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === stop!.id));
    const stopJob = h.jobs.find((job) => job.stepId === stop!.id)!;
    expect(stopJob).toMatchObject({ action: "stop", interactive: true });
    expect(await h.report(stopJob, "awaiting_operator")).toBe(true);
    expect(await need(s.instance.id)).toBe("STEP");
    // The node goes away while the stop waits: maintenance gang-stops again, which must
    // treat the waiting stop as live (no second stop), with claims still held.
    await offline(device.id, s.instance.id);
    await h.ticks(3);
    expect(await stepsOf(s.instance.id, "stop")).toHaveLength(1);
    expect((await step(stop!.id)).state).toBe("AWAITING_OPERATOR");
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { instanceId: s.instance.id, claimHeld: true },
      }),
    ).toBe(1);
    expect((await inst(s.instance.id)).nextRestartAt).toBeNull();
    await fixture.cliDevice.update({
      where: { id: device.id },
      data: { lastHeartbeatAt: new Date() },
    });
    // The person stops it: claims are released, and the instance waits for a restart.
    expect(await h.report(stopJob, "succeeded", { stopped: true })).toBe(true);
    row = await inst(s.instance.id);
    expect(row).toMatchObject({
      observedState: "STOPPED",
      desiredState: "RUNNING",
      needsOperator: "RESTART",
      nextRestartAt: null,
    });
    expect(row.needsOperatorSince).not.toBeNull();
    const sent = h.jobs.length;
    await h.ticks(4);
    expect(h.jobs).toHaveLength(sent);
    expect((await inst(s.instance.id)).restartAttempts).toBe(0);

    // A person's restart goes past the automatic three attempts.
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { restartAttempts: 3 },
    });
    const restarted = await restartDeploymentInstance(user.id, s.instance.id, production);
    expect(restarted).toMatchObject({ needsOperator: null, needsOperatorSince: null });
    expect(restarted.operatorRestartRequestedAt).not.toBeNull();
    await expect(
      restartDeploymentInstance(user.id, s.instance.id, production),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await h.tickUntil(() => h.jobs.length > sent);
    row = await inst(s.instance.id);
    expect(row.restartAttempts).toBe(4);
    expect(h.jobs.at(-1)).toMatchObject({ action: "start", interactive: true });
    const fresh = await step(h.jobs.at(-1)!.stepId);
    expect(fresh.sequence).toBe(40);
  }, 30_000);

  it("an automatic start whose stop is interactive still restarts on its own", async () => {
    const user = await owner();
    const device = await node(user.id);
    // Start not interactive, stop interactive: an automatic restart needs nobody.
    const plain = await instance(user.id, [device.id], {
      interactiveStart: false,
      stopInteractive: true,
    });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(await h.report(h.jobs[0]!, "failed", { error: "launch_failed" })).toBe(true);
    const row = await inst(plain.instance.id);
    expect(row.observedState).toBe("STOP_PENDING");
    expect(row.nextRestartAt).not.toBeNull();
    expect(row.needsOperator).toBeNull();
  }, 30_000);

  it("a desired stop cancels a waiting start and clears its need; the stop settles it (probe C)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const open = await instance(user.id, [device.id]);
    const declined = await instance(user.id, [device.id], { port: 30400 });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const first = h.jobs[0]!;
    expect(await h.report(first, "awaiting_operator")).toBe(true);
    expect(await h.report(first, "operator_closed")).toBe(true);
    await h.tickUntil(() => h.jobs.length > 1);
    const second = h.jobs[1]!;
    expect(await h.report(second, "awaiting_operator")).toBe(true);
    const byStep = new Map([
      [first.stepId, first.instanceId],
      [second.stepId, second.instanceId],
    ]);
    expect(new Set(byStep.values())).toEqual(new Set([open.instance.id, declined.instance.id]));
    // The owner stops both (as applyDeploymentPlan does: desired STOPPED + a stop per rank).
    for (const target of [open, declined]) {
      await fixture.deploymentInstance.update({
        where: { id: target.instance.id },
        data: { desiredState: "STOPPED", observedState: "STOPPING" },
      });
      const stopIntent = originalDeploymentStopIntent(target.starts[0]!.intent);
      await fixture.deploymentStep.create({
        data: {
          runId: target.instance.runId,
          instanceId: target.instance.id,
          cliDeviceId: device.id,
          rank: 0,
          phase: "stop",
          sequence: 0,
          intent: stopIntent,
          intentHash: deploymentFingerprint(stopIntent),
        },
      });
    }
    h.control.closeAnswer = "closed";
    await h.tickUntil(async () =>
      (await Promise.all([first.stepId, second.stepId].map((id) => step(id)))).every(
        (row) => row.state === "FAILED",
      ),
    );
    for (const id of [first.stepId, second.stepId]) {
      expect(await step(id)).toMatchObject({ state: "FAILED", operatorTerminalId: null });
      expect(h.closes).toContainEqual({ stepId: id, keepRunning: true });
    }
    expect(await need(open.instance.id)).toBeNull();
    expect(await need(declined.instance.id)).toBeNull();
    // The stops go (non-interactive here) and settle; nothing waits afterwards.
    await h.tickUntil(() => h.jobs.filter((job) => job.action === "stop").length === 2);
    for (const job of h.jobs.filter((j) => j.action === "stop"))
      expect(await h.report(job, "succeeded", { stopped: true })).toBe(true);
    for (const target of [open, declined]) {
      expect(await inst(target.instance.id)).toMatchObject({
        observedState: "STOPPED",
        needsOperator: null,
      });
    }
  }, 30_000);

  it("a waiting start that outlives its instance's stop is settled, even with its node away", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    expect(await h.report(job, "operator_closed")).toBe(true);
    // Probe C: the instance's stop completed behind the waiting start's back.
    await fixture.deploymentInstanceNode.updateMany({
      where: { instanceId: s.instance.id },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { observedState: "STOPPED" },
    });
    expect(await need(s.instance.id)).toBe("STEP");
    h.live.delete(device.id);
    await h.tickUntil(async () => (await step(job.stepId)).state === "FAILED");
    expect((await step(job.stepId)).errorCode).toBe("operator_superseded");
    // Stopped, meant to run, interactive start: it now waits for a person's restart.
    expect(await need(s.instance.id)).toBe("RESTART");
    await flushDeploymentOperatorAudit();
    expect(
      (
        await fixture.deploymentOperatorEvent.findMany({
          where: { stepId: job.stepId },
          select: { outcome: true },
        })
      ).map((row) => row.outcome),
    ).toContain("cancelled");
  }, 30_000);

  it("a banned owner's waiting steps are cancelled, claims released but held unknown, until a status check", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const start = h.jobs[0]!;
    expect(await h.report(start, "awaiting_operator")).toBe(true);
    await fixture.user.update({ where: { id: user.id }, data: { banned: true, banExpires: null } });
    await h.tickUntil(
      async () =>
        (await fixture.deploymentInstanceNode.count({
          where: { instanceId: s.instance.id, claimHeld: true },
        })) === 0,
    );
    expect(await step(start.stepId)).toMatchObject({
      state: "FAILED",
      errorCode: "owner_inactive",
    });
    const stops = await stepsOf(s.instance.id, "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ state: "FAILED", errorCode: "owner_inactive" });
    // Nobody may answer a terminal now: the stop was never sent.
    expect(h.jobs.map((job) => job.stepId)).toEqual([start.stepId]);
    const released = await fixture.deploymentInstanceNode.findFirstOrThrow({
      where: { instanceId: s.instance.id },
    });
    expect(released.claimHeld).toBe(false);
    expect(released.heldUnknownSince).not.toBeNull();
    expect(await inst(s.instance.id)).toMatchObject({ observedState: "STOPPED" });
    await flushDeploymentOperatorAudit();
    expect(
      (
        await fixture.deploymentOperatorEvent.findMany({
          where: { stepId: start.stepId },
          select: { outcome: true },
        })
      ).map((row) => row.outcome),
    ).toContain("cancelled");
    // Placement still counts the resources (and their port), which nobody can stop.
    const held = await production.$transaction((tx) => loadDeploymentState(tx, user.id));
    expect(held.held).toEqual([
      expect.objectContaining({ instanceId: s.instance.id, nodeId: device.id, port: 30000 }),
    ]);
    expect(held.existing.flatMap((i) => i.nodes)).toEqual([]);
    await h.ticks(3);
    expect(await stepsOf(s.instance.id, "stop")).toHaveLength(1);

    // The ban is lifted: a status check (the rank's stop, status first) is sent; its proof
    // frees the resources.
    await fixture.user.update({ where: { id: user.id }, data: { banned: false } });
    await h.tickUntil(() => h.jobs.length > 1);
    const probe = h.jobs[1]!;
    expect(probe).toMatchObject({ action: "stop", interactive: true });
    expect(await step(probe.stepId)).toMatchObject({
      errorCode: "held_unknown_probe",
      sequence: 5000,
    });
    expect(await h.report(probe, "succeeded", { stopped: true })).toBe(true);
    expect(
      (
        await fixture.deploymentInstanceNode.findFirstOrThrow({
          where: { instanceId: s.instance.id },
        })
      ).heldUnknownSince,
    ).toBeNull();
    const after = await production.$transaction((tx) => loadDeploymentState(tx, user.id));
    expect(after.held).toEqual([]);
    expect(await inst(s.instance.id)).toMatchObject({
      observedState: "STOPPED",
      needsOperator: "RESTART",
    });
  }, 30_000);

  it("revoking the deployments grant closes the node's waiting terminals", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(await h.report(h.jobs[0]!, "awaiting_operator")).toBe(true);
    await fixture.cliDevice.update({ where: { id: device.id }, data: { allowDeployments: false } });
    await h.tickUntil(() => h.closes.some((close) => close.stepId === s.starts[0]!.id));
    expect(h.closes).toContainEqual({ stepId: s.starts[0]!.id, keepRunning: true });
  }, 30_000);

  it("a person reopens a closed waiting step; an open one is answered in its terminal", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const first = h.jobs[0]!;
    expect(await h.report(first, "awaiting_operator")).toBe(true);
    await expect(reopenDeploymentOperatorStep(user.id, id, production)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await h.report(first, "operator_closed", { error: "operator_terminal_limit" })).toBe(
      true,
    );
    expect(await reopenDeploymentOperatorStep(user.id, id, production)).toMatchObject({
      stepId: id,
    });
    // The spawn failure already gave its attempt back.
    expect(await step(id)).toMatchObject({ state: "PENDING", errorCode: null, attempts: 0 });
    expect(await need(s.instance.id)).toBeNull();
    await h.tickUntil(() => h.jobs.length > 1);
    expect(h.jobs[1]!.stepId).toBe(id);
    expect(h.jobs[1]!.operator?.terminalId).not.toBe(first.operator?.terminalId);
  }, 30_000);

  it("the turn waits only on the current generation's terminals (N4)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const old = s.starts[0]!;
    // Generation 0's start was left waiting with its terminal closed; generation 1 runs.
    await fixture.deploymentStep.update({
      where: { id: old.id },
      data: {
        state: "RUNNING",
        ownerEpoch: "stale:1",
        deadline: new Date(Date.now() + 60_000),
        operatorTerminalId: "AAECAwQFBgcICQoLDA0ODw",
      },
    });
    await fixture.deploymentStep.update({
      where: { id: old.id },
      data: {
        state: "AWAITING_OPERATOR",
        deadline: null,
        operatorTerminalId: null,
        operatorSince: new Date(),
      },
    });
    await fixture.deploymentStep.updateMany({
      where: { instanceId: s.instance.id, phase: "readiness" },
      data: { state: "FAILED", errorCode: "startup_failed" },
    });
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { restartAttempts: 1, observedState: "PENDING" },
    });
    const fresh = await fixture.deploymentStep.create({
      data: {
        runId: old.runId,
        instanceId: s.instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "start",
        sequence: 10,
        intent: old.intent as object,
        intentHash: old.intentHash,
      },
    });
    // Touched last, so the tick reaches the new generation's start first.
    await fixture.deploymentStep.update({
      where: { id: old.id },
      data: { operatorLastExit: 1 },
    });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(h.jobs[0]!.stepId).toBe(fresh.id);
    // Dispatched without waiting for the old generation's step to be settled.
    const sent = h.log.indexOf(`send:${fresh.id}`);
    const closed = h.log.indexOf(`close:${old.id}`);
    expect(closed === -1 || sent < closed).toBe(true);
    await h.ticks(2);
    expect(await step(old.id)).toMatchObject({ state: "FAILED", errorCode: "operator_superseded" });
  }, 30_000);

  it("a hold reason never overwrites a real error code, and the claim keeps it (N8)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const id = s.starts[0]!.id;
    await fixture.deploymentStep.update({ where: { id }, data: { errorCode: "some_real_code" } });
    const socket = socketFor(user.id, device.id);
    const h = harness([{ ...socket, deploymentOperator: false }]);
    await h.ticks(3);
    expect(await step(id)).toMatchObject({ state: "PENDING", errorCode: "some_real_code" });
    h.live.set(device.id, { ...socket, operatorRoom: false });
    await h.ticks(3);
    expect(await step(id)).toMatchObject({ state: "PENDING", errorCode: "some_real_code" });
    h.live.set(device.id, socket);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(await step(id)).toMatchObject({ state: "RUNNING", errorCode: "some_real_code" });
  }, 30_000);

  it("only the rank's latest stop, newer than its latest start, is re-sent after a reconnect (N17)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const terminal = "AAECAwQFBgcICQoLDA0ODw";
    const spawning = (id: string) =>
      fixture.deploymentStep.update({
        where: { id },
        data: {
          state: "RUNNING",
          ownerEpoch: "stale:1",
          attempts: 1,
          deadline: new Date(Date.now() + 60_000),
          operatorTerminalId: terminal,
        },
      });
    // An older stop, replaced by a newer one.
    const replaced = await instance(user.id, [device.id], {
      stopInteractive: true,
      stopping: true,
    });
    const older = replaced.stops[0]!;
    await spawning(older.id);
    await fixture.deploymentStep.create({
      data: {
        runId: older.runId,
        instanceId: replaced.instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "stop",
        sequence: 101,
        intent: older.intent as object,
        intentHash: older.intentHash,
      },
    });
    // The latest stop, but older than the rank's latest start.
    const restarted = await instance(user.id, [device.id], {
      port: 30600,
      stopInteractive: true,
      stopping: true,
    });
    const behind = restarted.stops[0]!;
    await spawning(behind.id);
    await fixture.deploymentStep.create({
      data: {
        runId: behind.runId,
        instanceId: restarted.instance.id,
        cliDeviceId: device.id,
        rank: 0,
        phase: "start",
        sequence: 10,
        intent: restarted.starts[0]!.intent as object,
        intentHash: restarted.starts[0]!.intentHash,
        state: "SUCCEEDED",
      },
    });
    // The current stop: re-sent under the new session.
    const current = await instance(user.id, [device.id], {
      port: 30700,
      stopInteractive: true,
      stopping: true,
    });
    const latest = current.stops[0]!;
    await spawning(latest.id);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(async () => (await step(behind.id)).state !== "RUNNING");
    await h.ticks(2);
    expect(await step(older.id)).toMatchObject({
      state: "FAILED",
      errorCode: "operator_superseded",
    });
    expect(await step(behind.id)).toMatchObject({
      state: "FAILED",
      errorCode: "operator_superseded",
    });
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === latest.id));
    expect(h.jobs.some((job) => job.stepId === older.id || job.stepId === behind.id)).toBe(false);
  }, 30_000);

  it("a gang stop ends the waiting start with its own reason", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const job = h.jobs[0]!;
    expect(await h.report(job, "awaiting_operator")).toBe(true);
    // The node stops heartbeating while the start waits: maintenance gang-stops the instance.
    await fixture.cliDevice.update({
      where: { id: device.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 300_000) },
    });
    await fixture.$executeRaw`UPDATE deployment_instance SET "createdAt" = now() - interval '5 minutes' WHERE id = ${s.instance.id}`;
    h.control.closeAnswer = "closed";
    await h.tickUntil(async () => (await step(job.stepId)).state === "FAILED");
    expect(await step(job.stepId)).toMatchObject({ state: "FAILED", errorCode: "node_offline" });
    expect(h.closes).toContainEqual({ stepId: job.stepId, keepRunning: true });
    expect(await inst(s.instance.id)).toMatchObject({
      observedState: "STOP_PENDING",
      nextRestartAt: null,
      needsOperator: null,
    });
  }, 30_000);

  it("never opens an interactive stop for a banned owner", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true, stopping: true });
    await fixture.user.update({ where: { id: user.id }, data: { banned: true, banExpires: null } });
    const h = harness([socketFor(user.id, device.id)]);
    await h.ticks(1);
    expect(h.jobs).toEqual([]);
    expect(await step(s.stops[0]!.id)).toMatchObject({
      state: "FAILED",
      errorCode: "owner_inactive",
    });
    const released = await fixture.deploymentInstanceNode.findFirstOrThrow({
      where: { instanceId: s.instance.id },
    });
    expect(released).toMatchObject({ claimHeld: false });
    expect(released.heldUnknownSince).not.toBeNull();
    // A deletion is no longer blocked by the claim.
    expect(await inst(s.instance.id)).toMatchObject({ observedState: "STOPPED" });
    await h.ticks(2);
    expect(h.jobs).toEqual([]);
    // The CLI's verified `stopped` inventory for that stop is the proof that frees them.
    const stop = await step(s.stops[0]!.id);
    expect(
      await h.reconciler.acceptInventory(socketFor(user.id, device.id), [
        {
          stepId: stop.id,
          instanceId: s.instance.id,
          revisionId: s.instance.revisionId,
          rank: 0,
          intentHash: stop.intentHash,
          phase: "stopped",
          unitName: `wsmp-i-${s.instance.id}-r0`,
          port: 30000,
          endpointSlug: s.instance.endpointSlug,
          models: ["model"],
          contextWindow: null,
        },
      ]),
    ).toBe(true);
    expect(await step(stop.id)).toMatchObject({ state: "SUCCEEDED" });
    expect(
      (
        await fixture.deploymentInstanceNode.findFirstOrThrow({
          where: { instanceId: s.instance.id },
        })
      ).heldUnknownSince,
    ).toBeNull();
  }, 30_000);

  // ---- Chunk 8 review fixes ----

  /** Release an instance's rank-0 claim as held unknown after a cancelled stop (the drain's write). */
  async function heldUnknown(target: Awaited<ReturnType<typeof instance>>, memoryGb = 10) {
    await fixture.deploymentStep.updateMany({
      where: { instanceId: target.instance.id, phase: "stop" },
      data: { state: "FAILED", errorCode: "owner_inactive" },
    });
    await fixture.deploymentInstanceNode.updateMany({
      where: { instanceId: target.instance.id },
      data: {
        claimHeld: false,
        stoppedAt: new Date(),
        heldUnknownSince: new Date(),
        resources: { kind: "unified", memoryGb, ramGb: 0, gpus: [] },
      },
    });
    await fixture.deploymentInstance.update({
      where: { id: target.instance.id },
      data: { observedState: "STOPPED" },
    });
  }

  it("an interactive stop whose run is not verified waits for its person again (M1)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true, stopping: true });
    const stopId = s.stops[0]!.id;
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    const first = h.jobs[0]!;
    expect(first.stepId).toBe(stopId);
    expect(await h.report(first, "awaiting_operator")).toBe(true);
    expect(await h.report(first, "operator_running")).toBe(true);
    expect(await h.report(first, "failed", { error: "operator_unverified" })).toBe(true);
    expect(await step(stopId)).toMatchObject({
      state: "AWAITING_OPERATOR",
      operatorTerminalId: null,
      errorCode: "operator_unverified",
    });
    expect(await need(s.instance.id)).toBe("STEP");
    expect((await inst(s.instance.id)).observedState).toBe("STOPPING");
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { instanceId: s.instance.id, claimHeld: true },
      }),
    ).toBe(1);
    // Nothing re-sends it by itself: it waits for its person.
    await h.ticks(2);
    expect(h.jobs).toHaveLength(1);
    // The person reopens it; status decides again.
    await reopenDeploymentOperatorStep(user.id, stopId, production);
    await h.tickUntil(() => h.jobs.length > 1);
    const second = h.jobs[1]!;
    expect(second.stepId).toBe(stopId);
    expect(await h.report(second, "succeeded", { stopped: true })).toBe(true);
    expect(await inst(s.instance.id)).toMatchObject({
      observedState: "STOPPED",
      needsOperator: null,
    });
  }, 30_000);

  it("held-unknown resources block another instance's budget; a failed check is retried after a pause", async () => {
    const user = await owner();
    const device = await node(user.id);
    const held = await instance(user.id, [device.id], { interactiveStart: false, stopping: true });
    await heldUnknown(held, 40);
    const other = await instance(user.id, [device.id], { port: 30100, interactiveStart: false });
    await fixture.deploymentInstanceNode.updateMany({
      where: { instanceId: other.instance.id },
      data: { resources: { kind: "unified", memoryGb: 40, ramGb: 0, gpus: [] } },
    });
    const h = harness([socketFor(user.id, device.id)]);
    const probes = () =>
      fixture.deploymentStep.findMany({
        where: { instanceId: held.instance.id, phase: "stop", sequence: { gte: 5000 } },
        orderBy: { sequence: "asc" },
      });
    await h.tickUntil(() => h.jobs.length > 0);
    const probe = h.jobs[0]!;
    expect(probe).toMatchObject({ action: "stop", instanceId: held.instance.id });
    expect((await step(probe.stepId)).sequence).toBe(5000);
    // 40 + 40 GB exceed the node's 64: the other start waits while the resources are held.
    await h.ticks(3);
    expect(h.jobs.some((job) => job.stepId === other.starts[0]!.id)).toBe(false);
    // The check fails: the rank stays held and the check is not re-created at once.
    expect(await h.report(probe, "failed", { error: "execution_unconfirmed" })).toBe(true);
    expect((await inst(held.instance.id)).observedState).toBe("STOPPED");
    await h.ticks(3);
    expect(await probes()).toHaveLength(1);
    expect(h.jobs.some((job) => job.stepId === other.starts[0]!.id)).toBe(false);
    // After the pause a new check goes; its proof frees the resources for the other start.
    await fixture.$executeRaw`UPDATE deployment_step SET "updatedAt" = now() - interval '6 minutes' WHERE id = ${probe.stepId}`;
    await h.tickUntil(async () => (await probes()).length === 2);
    const retry = (await probes())[1]!;
    expect(retry.sequence).toBe(5001);
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === retry.id));
    const retryJob = h.jobs.find((job) => job.stepId === retry.id)!;
    expect(await h.report(retryJob, "succeeded", { stopped: true })).toBe(true);
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === other.starts[0]!.id));
  }, 30_000);

  it("a check that cannot open says why, and a person's restart waits for it instead of clearing the need (L1)", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true, stopping: true });
    await heldUnknown(s);
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { desiredState: "RUNNING", observedState: "STOPPED" },
    });
    const socket = socketFor(user.id, device.id);
    const h = harness([{ ...socket, deploymentOperator: false }]);
    const probe = async () =>
      fixture.deploymentStep.findFirst({
        where: { instanceId: s.instance.id, phase: "stop", sequence: { gte: 5000 } },
      });
    await h.tickUntil(async () => (await probe())?.errorCode === "operator_capability_missing");
    expect(await probe()).toMatchObject({
      state: "PENDING",
      operatorHold: "operator_capability_missing",
    });
    // The held check needs its person first (turn on the node's operator terminal): STEP, not
    // RESTART (security review L1), so a restart is refused.
    expect(await need(s.instance.id)).toBe("STEP");
    await expect(
      restartDeploymentInstance(user.id, s.instance.id, production),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.jobs).toEqual([]);
    // The node can open terminals: the check goes, the need is RESTART again, and a restart
    // still waits for the check instead of clearing the need.
    h.live.set(device.id, socket);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(await need(s.instance.id)).toBe("RESTART");
    await expect(
      restartDeploymentInstance(user.id, s.instance.id, production),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "deployment_stop_pending" } });
    expect(await inst(s.instance.id)).toMatchObject({
      needsOperator: "RESTART",
      nextRestartAt: null,
    });
  }, 30_000);

  it("deleting the device clears its held-unknown resources", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { interactiveStart: false, stopping: true });
    await heldUnknown(s);
    expect(
      (await production.$transaction((tx) => loadDeploymentState(tx, user.id))).held,
    ).toHaveLength(1);
    await fixture.cliDevice.delete({ where: { id: device.id } });
    expect(
      await fixture.deploymentInstanceNode.count({ where: { instanceId: s.instance.id } }),
    ).toBe(0);
    expect((await production.$transaction((tx) => loadDeploymentState(tx, user.id))).held).toEqual(
      [],
    );
  }, 30_000);

  // ---- Chunk 9: the planner lifts the interactive refusal behind the capability gate ----

  it("plans and starts an interactive recipe only on a node that can open operator terminals", async () => {
    const user = await owner();
    const device = await node(user.id);
    // Only the recipe (config, revision, pool) of this fixture is used; its own instance is
    // stopped and released so the node is free.
    const recipe = await instance(user.id, [device.id], { stopInteractive: true, stopping: true });
    await fixture.deploymentStep.updateMany({
      where: { instanceId: recipe.instance.id, phase: "stop" },
      data: { state: "FAILED", errorCode: "fixture" },
    });
    await fixture.deploymentInstanceNode.updateMany({
      where: { instanceId: recipe.instance.id },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    await fixture.deploymentInstance.update({
      where: { id: recipe.instance.id },
      data: { observedState: "STOPPED" },
    });
    const requester = { userId: user.id, id: user.id, kind: "USER" as const };
    const start = { revisionId: recipe.instance.revisionId, variantKey: "one", groupCount: 1 };
    await expect(createDeploymentPlan(requester, { start })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "deployment_operator_unavailable", nodeIds: [device.id] },
    });
    await fixture.cliDevice.update({
      where: { id: device.id },
      data: { reportedDeploymentOperator: true, reportedTerminalSupported: true },
    });
    const plan = await createDeploymentPlan(requester, { start });
    expect(plan.contents).toMatchObject({
      warnings: ["interactive_operator_required"],
      operatorSteps: [
        { instanceId: null, nodeId: device.id, action: "start", nodeReady: true },
        { instanceId: null, nodeId: device.id, action: "stop", nodeReady: true },
      ],
    });
    await applyDeploymentPlan(requester, plan.id, false);
    const started = await fixture.deploymentInstance.findFirstOrThrow({
      where: { userId: user.id, id: { not: recipe.instance.id } },
    });
    const h = harness([socketFor(user.id, device.id)]);
    await h.tickUntil(() => h.jobs.length > 0);
    expect(h.jobs[0]).toMatchObject({
      instanceId: started.id,
      action: "start",
      interactive: true,
      stopInteractive: true,
    });
    expect(h.jobs[0]!.operator?.commandAuthor).toBe("user");
  }, 30_000);

  // ---- Chunk 10: "needs you" email notices ----

  it("emails a settled need once, in the owner's locale, and only to an active verified owner", async () => {
    const { notifyDeploymentOperatorNeeds } = await import(
      "@ws-model-proxy/api/lib/deployment-operator-notify"
    );
    const user = await owner();
    await fixture.user.update({
      where: { id: user.id },
      data: { emailVerified: true, locale: "es-MX" },
    });
    const device = await node(user.id);
    const s = await instance(user.id, [device.id]);
    const since = new Date(Date.now() - 10 * 60_000);
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { needsOperator: "STEP", needsOperatorSince: since },
    });
    const sent: Array<{ to: string; subject: string; html: string }> = [];
    const send = async (message: { to: string; subject: string; html: string }) => {
      sent.push(message);
    };
    const notify = () => notifyDeploymentOperatorNeeds({ db: production, send, configured: true });
    const before = (await inst(s.instance.id)).updatedAt;
    await notify();
    // The claim keeps updatedAt: the offline grace and maintenance order are not reset.
    expect((await inst(s.instance.id)).updatedAt).toEqual(before);
    const mine = () => sent.filter((message) => message.to === user.email);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]?.subject).toBe("Un despliegue te necesita");
    expect(mine()[0]?.html).toContain(s.instance.endpointSlug);
    // Claimed: a second sweep (or another replica) sends nothing more.
    await notify();
    expect(mine()).toHaveLength(1);
    expect((await inst(s.instance.id)).needsOperatorNotifiedAt?.getTime()).toBeGreaterThan(
      since.getTime(),
    );
    // A banned owner gets nothing, even for a fresh need.
    const other = await instance(user.id, [device.id], { port: 30900 });
    await fixture.deploymentInstance.update({
      where: { id: other.instance.id },
      data: { needsOperator: "STEP", needsOperatorSince: since },
    });
    await fixture.user.update({ where: { id: user.id }, data: { banned: true } });
    await notify();
    expect(mine()).toHaveLength(1);
  }, 30_000);

  // ---- Security review L1: a step held before its terminal can open needs its person ----

  it("an automatic stop held for a node without the capability raises needs-you and keeps its reason", async () => {
    const user = await owner();
    const device = await node(user.id);
    const s = await instance(user.id, [device.id], { stopInteractive: true, stopping: true });
    const stopId = s.stops[0]!.id;
    await fixture.deploymentStep.update({
      where: { id: stopId },
      data: { errorCode: "node_offline" },
    });
    const socket = socketFor(user.id, device.id);
    const h = harness([{ ...socket, deploymentOperator: false }]);
    await h.tickUntil(async () => (await need(s.instance.id)) === "STEP");
    expect(await step(stopId)).toMatchObject({
      state: "PENDING",
      operatorHold: "operator_capability_missing",
      // The gang-stop reason stays.
      errorCode: "node_offline",
    });
    expect(h.jobs).toEqual([]);
    // The node can open terminals again: the claim clears the hold, and the need follows.
    h.live.set(device.id, socket);
    await h.tickUntil(() => h.jobs.some((job) => job.stepId === stopId));
    expect(await step(stopId)).toMatchObject({ state: "RUNNING", operatorHold: null });
    expect(await need(s.instance.id)).toBeNull();
  }, 30_000);
});

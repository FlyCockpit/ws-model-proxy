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
// Loaded after the skip guard: `./reconciler.js` imports the production
// Prisma client, whose env validation fails in a unit run with no database.
let DeploymentReconciler: typeof import("./reconciler.js").DeploymentReconciler;

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
  });
  afterAll(async () => {
    for (const reconciler of reconcilers) await reconciler.stop();
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
    const control = {
      closeAnswer: "absent" as "closed" | "running" | "absent",
      sendOk: true,
    };
    const reconciler = new DeploymentReconciler(
      {
        current: (id) => live.get(id) ?? null,
        send: (socket, job) => {
          jobs.push(job);
          deviceOf.set(job.stepId, socket.cliDeviceId);
          return control.sendOk;
        },
        closeOperatorStep: (stepId, options) => {
          closes.push({ stepId, keepRunning: options?.keepRunning === true });
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
    return { reconciler, jobs, closes, control, live, ticks, tickUntil, report };
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
});

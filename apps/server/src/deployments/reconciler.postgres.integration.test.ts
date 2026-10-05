import { deploymentFingerprint } from "@ws-model-proxy/api/lib/deployment-planner";
import type { DeploymentJob } from "@ws-model-proxy/config/deployment-protocol";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DeploymentLiveSocket, DeploymentReconciler } from "./reconciler.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("Postgres fixture URL required");
const integration = databaseUrl ? describe : describe.skip;

integration("deployment result fencing at PostgreSQL", () => {
  let fixture: ReturnType<typeof createFixturePrismaClient>;
  let production: ReturnType<typeof createPrismaClient>;
  const users: string[] = [];
  beforeAll(() => {
    if (!databaseUrl) throw new Error("fixture missing");
    fixture = createFixturePrismaClient(databaseUrl);
    production = createPrismaClient(databaseUrl);
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

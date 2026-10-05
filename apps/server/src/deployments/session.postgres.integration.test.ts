import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { deploymentFingerprint } from "@ws-model-proxy/api/lib/deployment-planner";
import {
  applyDeploymentPlan,
  createDeploymentPlan,
  lockDeploymentOwner,
} from "@ws-model-proxy/api/lib/deployment-service";
import {
  type DeploymentClaim,
  deploymentJobIntentSchema,
  deploymentSpecSchema,
  storedDeploymentSpecSchema,
} from "@ws-model-proxy/api/lib/deployment-spec";
import {
  DEPLOYMENT_JOB_FRAME_MAX_BYTES,
  type DeploymentJob,
  type DeploymentObservedInstance,
  deploymentJobFrameBytes,
} from "@ws-model-proxy/config/deployment-protocol";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { type DeploymentLiveSocket, DeploymentReconciler } from "./reconciler.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL fixture required");
const integration = databaseUrl ? describe : describe.skip;
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Deployment boundary handshake timed out");
}
integration("deployment lifecycle on PostgreSQL and real manager/WebSocket", () => {
  let fixture: ReturnType<typeof createFixturePrismaClient>;
  let production: ReturnType<typeof createPrismaClient>;
  let Manager: typeof import("../relay/session-manager.js").RelaySessionManager;
  let helloIdentity: typeof import("../relay/hello-identity.js").generateTestHelloIdentity;
  const users: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("fixture missing");
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "deployment-fixture-secret-not-production";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    fixture = createFixturePrismaClient(databaseUrl);
    production = createPrismaClient(databaseUrl);
    ({ RelaySessionManager: Manager } = await import("../relay/session-manager.js"));
    ({ generateTestHelloIdentity: helloIdentity } = await import("../relay/hello-identity.js"));
  });
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    // No processes are launched by these synthetic relay peers. Only this suite's fixtures are removed.
    await fixture.deploymentInstanceNode.updateMany({
      where: { Instance: { userId: { in: users } } },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    for (const id of users) await fixture.user.delete({ where: { id } });
    await Promise.all([fixture.$disconnect(), production.$disconnect()]);
  });
  async function arrangement() {
    const suffix = randomUUID();
    const user = await fixture.user.create({
      data: { name: "deployment-boundary", email: `${suffix}@example.test`, slug: `dep-${suffix}` },
    });
    users.push(user.id);
    const token = await fixture.cliToken.create({
      data: {
        userId: user.id,
        name: "test",
        lookupPrefix: randomUUID(),
        secretDigest: randomUUID(),
      },
    });
    const manager = new Manager();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const frames: Record<string, unknown>[] = [];
    /** Exact UTF-8 size of each received text frame, aligned with `frames`. */
    const frameBytes: number[] = [];
    const jobs: DeploymentJob[] = [];
    const commitReads: Array<Promise<boolean>> = [];
    const errors: unknown[] = [];
    const sockets: WebSocket[] = [];
    const clients: WebSocket[] = [];
    let received = 0;
    let inventoryCalls = 0;
    const reconciler = new DeploymentReconciler(
      {
        current: (id) => manager.deploymentSocket(id),
        send: (socket, job) => {
          // The independent client issues this query at the actual synchronous send boundary.
          commitReads.push(
            fixture.deploymentStep
              .findUniqueOrThrow({ where: { id: job.stepId } })
              .then(
                (row) =>
                  row.state === "RUNNING" &&
                  row.ownerEpoch === job.ownerEpoch &&
                  row.intentHash ===
                    deploymentFingerprint(deploymentJobIntentSchema.parse(row.intent)),
              ),
          );
          jobs.push(job);
          return manager.sendDeploymentJob(socket, job);
        },
      },
      production,
    );
    manager.setDeploymentHandlers({
      inventory: async (socket, instances) => {
        inventoryCalls++;
        return reconciler.acceptInventory(socket, instances);
      },
      result: (socket, result) => reconciler.acceptResult(socket, result),
    });
    server.on("connection", (socket) => {
      sockets.push(socket);
      manager.acceptAuthenticatedSocket({
        socket,
        identity: {
          kind: "cliToken",
          id: token.id,
          userId: user.id,
          lookupPrefix: token.lookupPrefix,
          cliDeviceId: null,
        },
      });
      socket.on("message", (data) => {
        void manager
          .handleTextFrame(socket, data.toString())
          .catch((error: unknown) => errors.push(error))
          .finally(() => received++);
      });
      socket.on("close", () => {
        void manager.removeSession(socket).catch((error: unknown) => errors.push(error));
      });
    });
    async function connect(helloEndpoints: unknown[] = []) {
      const identity = helloIdentityKey;
      const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      clients.push(client);
      let hello = false;
      client.on("message", (data, binary) => {
        if (binary) return;
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        frameBytes.push(Buffer.byteLength(data.toString()));
        if (frame.type === "hello.ok") hello = true;
        if (frame.type === "hello.challenge")
          client.send(
            JSON.stringify({
              type: "hello",
              id: "deployment-hello",
              protocolVersion: "2.11",
              cli: {
                slug: "node",
                hostname: "fixture",
                identityPublicKey: identity.publicKey,
                identitySignature: identity.sign(String(frame.nonce), "node", String(frame.origin)),
                capabilities: {
                  terminalPublicKey: identity.publicKey,
                  features: {
                    humanTerminal: false,
                    mcpCommandMode: "off",
                    terminalApproval: false,
                    terminalSupported: false,
                    remoteMetricSources: false,
                    remoteEngineAdapters: false,
                    mcpFileRead: false,
                    fileRootsConfigured: false,
                    allowFileToolsAsRoot: false,
                    deployments: true,
                  },
                },
              },
              endpoints: helloEndpoints,
            }),
          );
      });
      await until(() => hello || client.readyState === WebSocket.CLOSED);
      expect(hello, JSON.stringify(frames)).toBe(true);
      return client;
    }
    const helloIdentityKey = helloIdentity();
    const client = await connect();
    const deviceId = manager.getActiveCliDeviceIds()[0];
    if (!deviceId) throw new Error("device missing");
    await fixture.cliDevice.update({
      where: { id: deviceId },
      data: {
        allowDeployments: true,
        reportedDeployments: true,
        relayProtocolVersion: "2.11",
        usableMemoryGb: 20,
        deploymentPortStart: 30000,
        deploymentPortEnd: 30999,
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 32 * 1024,
          executionMechanism: "systemd+linger",
        },
      },
    });
    async function frame(value: unknown, target = client) {
      const count = received;
      target.send(JSON.stringify(value));
      await until(() => received > count || target.readyState === WebSocket.CLOSED);
      if (errors.length) throw errors[0];
    }
    async function snapshot(instances: DeploymentObservedInstance[] = [], target = client) {
      await frame(
        {
          type: "deployment.instances",
          snapshotId: randomUUID().replaceAll("-", ""),
          chunkIndex: 0,
          final: true,
          instances,
        },
        target,
      );
      await reconciler.runOnce();
    }
    async function settle(
      job: DeploymentJob,
      stopped = false,
      status: "succeeded" | "failed" = "succeeded",
      target = client,
    ) {
      await frame(
        {
          type: "deployment.job.result",
          stepId: job.stepId,
          instanceId: job.instanceId,
          rank: job.rank,
          intentHash: job.intentHash,
          ownerEpoch: job.ownerEpoch,
          status,
          stopped,
        },
        target,
      );
      await reconciler.runOnce();
    }
    async function tickUntil(predicate: () => boolean | Promise<boolean>) {
      await until(async () => {
        await reconciler.runOnce();
        return predicate();
      }, 60_000);
    }
    cleanups.push(async () => {
      await reconciler.stop();
      for (const peer of clients) peer.terminate();
      for (const peer of sockets) peer.terminate();
      await manager.closeRelaySessions();
      manager.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return {
      user,
      token,
      manager,
      reconciler,
      client,
      deviceId,
      jobs,
      commitReads,
      frame,
      snapshot,
      settle,
      tickUntil,
      connect,
      inventoryCalls: () => inventoryCalls,
      frames,
      frameBytes,
    };
  }
  async function seed(
    a: Awaited<ReturnType<typeof arrangement>>,
    options: {
      management?: "ownedProcess" | "externalService";
      stopped?: boolean;
      group?: number;
      port?: number;
      devices?: string[];
      resources?: DeploymentClaim;
      health?: { intervalMs: number; failureThreshold: number; successThreshold: number };
      models?: string[];
      editorKind?: "USER" | "AGENT";
    } = {},
  ) {
    const suffix = randomUUID().replaceAll("-", "");
    const devices = options.devices ?? [a.deviceId];
    for (let rank = 1; rank < (options.group ?? 1); rank++) {
      const device = await fixture.cliDevice.create({
        data: {
          userId: a.user.id,
          slug: `rank-${suffix}-${rank}`,
          status: "CONNECTED",
          connectionGeneration: 1,
          lastHeartbeatAt: new Date(),
          allowDeployments: true,
          reportedDeployments: true,
          relayProtocolVersion: "2.11",
          usableMemoryGb: 20,
          nodeInfo: {
            nodeKind: "unified",
            memoryTotalMiB: 32 * 1024,
            executionMechanism: "systemd+linger",
          },
        },
      });
      devices.push(device.id);
    }
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Deployment", slug: `pool-${suffix}` },
    });
    const config = await fixture.deploymentConfig.create({
      data: { userId: a.user.id, poolId: pool.id, name: "Recipe", slug: `recipe-${suffix}` },
    });
    const spec = deploymentSpecSchema.parse({
      variants: [
        {
          key: "one",
          engine: "other",
          groupSize: devices.length,
          resources: [
            options.resources?.kind === "discrete"
              ? {
                  kind: "discrete",
                  gpuCount: options.resources.gpus.length,
                  vramGb: options.resources.gpus[0]?.vramGb,
                  ramGb: options.resources.ramGb,
                }
              : options.resources?.kind === "cpu"
                ? { kind: "cpu", ramGb: options.resources.ramGb }
                : { kind: "unified", memoryGb: options.resources?.memoryGb ?? 10 },
          ],
          commands: [
            {
              management: options.management ?? "ownedProcess",
              start: "old-start",
              stop: "old-stop",
              status: "old-status",
              health: "old-health",
            },
          ],
          readiness: { path: "/old-ready" },
          health: options.health ?? { intervalMs: 5000, failureThreshold: 1, successThreshold: 1 },
          models: ["old-model"],
          attachment: { type: "llm", poolId: pool.id },
          hardConcurrencyLimit: 1,
          ...(devices.length > 1 ? { iface: "eth0" } : {}),
        },
      ],
    });
    // Stored as given, so a test can seed a revision saved before current rules.
    if (options.models) spec.variants[0]!.models = options.models;
    const revision = await fixture.deploymentConfigRevision.create({
      data: {
        configId: config.id,
        revision: 1,
        editorId: a.user.id,
        editorKind: options.editorKind ?? "USER",
        contentHash: deploymentFingerprint(spec),
        spec,
      },
    });
    const plan = await fixture.deploymentPlan.create({
      data: {
        userId: a.user.id,
        requesterId: a.user.id,
        requesterKind: "USER",
        state: "APPLIED",
        fingerprint: "a".repeat(64),
        contents: { affectedNodeIds: devices },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const run = await fixture.deploymentRun.create({ data: { planId: plan.id } });
    const instance = await fixture.deploymentInstance.create({
      data: {
        userId: a.user.id,
        configId: config.id,
        revisionId: revision.id,
        runId: run.id,
        variantKey: "one",
        endpointSlug: `inst-${suffix}`,
        startedBy: "USER",
        observedState: options.stopped ? "STOPPED" : "PENDING",
        ...(options.stopped ? { nextRestartAt: new Date(Date.now() - 1000) } : {}),
      },
    });
    const nodes = [];
    const starts = [];
    for (let rank = 0; rank < devices.length; rank++) {
      const deviceId = devices[rank];
      if (!deviceId) throw new Error("rank missing");
      nodes.push(
        await fixture.deploymentInstanceNode.create({
          data: {
            instanceId: instance.id,
            cliDeviceId: deviceId,
            rank,
            port: options.port ?? 30000,
            resources: options.resources ?? { kind: "unified", memoryGb: 10, ramGb: 0, gpus: [] },
            claimHeld: !options.stopped,
            stoppedAt: options.stopped ? new Date() : null,
          },
        }),
      );
      const variant = spec.variants[0];
      if (!variant) throw new Error("variant missing");
      const intent = deploymentJobIntentSchema.parse({
        type: "deployment.job",
        instanceId: instance.id,
        revisionId: revision.id,
        rank,
        action: "start",
        attachment: "llm",
        engine: "other",
        management: options.management ?? "ownedProcess",
        command: "old-start",
        stopCommand: "old-stop",
        statusCommand: "old-status",
        healthCommand: "old-health",
        timeoutMs: 60_000,
        unitName: `wsmp-i-${instance.id}-r${rank}`,
        port: options.port ?? 30000,
        endpointSlug: instance.endpointSlug,
        models: ["old-model"],
        contextWindow: null,
        readiness: variant.readiness,
        health: variant.health,
      });
      starts.push(
        await fixture.deploymentStep.create({
          data: {
            runId: run.id,
            instanceId: instance.id,
            cliDeviceId: deviceId,
            rank,
            phase: "start",
            sequence: 0,
            intent,
            intentHash: deploymentFingerprint(intent),
            state: options.stopped ? "SUCCEEDED" : "PENDING",
          },
        }),
      );
      const ready = { ...intent, action: "readiness" as const, command: "" };
      await fixture.deploymentStep.create({
        data: {
          runId: run.id,
          instanceId: instance.id,
          cliDeviceId: deviceId,
          rank,
          phase: "readiness",
          sequence: 3,
          intent: ready,
          intentHash: deploymentFingerprint(ready),
          state: options.stopped ? "SUCCEEDED" : "PENDING",
        },
      });
    }
    return { instance, nodes, starts, run, revision, config, pool, devices, spec };
  }

  it("durable snapshot ACK waits for actual PostgreSQL commit, then permits repeated publication", async () => {
    const a = await arrangement();
    const held = deferred();
    const release = deferred();
    const writer = fixture.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${a.deviceId} FOR UPDATE`;
        held.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    await held.promise;
    const id = randomUUID().replaceAll("-", "");
    a.client.send(
      JSON.stringify({
        type: "deployment.instances",
        snapshotId: id,
        chunkIndex: 0,
        final: true,
        instances: [],
      }),
    );
    try {
      await until(
        async () =>
          a.inventoryCalls() === 1 &&
          (
            await fixture.$queryRaw<
              Array<{ waiting: bigint }>
            >`SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'`
          ).some((row) => row.waiting > 0n),
      );
      expect(a.frames.filter((frame) => frame.type === "deployment.instances.ok")).toEqual([]);
      expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(false);
    } finally {
      release.resolve();
      await writer;
    }
    await until(() =>
      a.frames.some((frame) => frame.type === "deployment.instances.ok" && frame.snapshotId === id),
    );
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(true);
    await a.snapshot();
    await until(
      () => a.frames.filter((frame) => frame.type === "deployment.instances.ok").length === 2,
    );
    expect(a.client.readyState).toBe(WebSocket.OPEN);
  }, 50_000);

  it("disconnect during a real pending commit suppresses its late ACK and leaves successor publication intact", async () => {
    const a = await arrangement();
    const held = deferred();
    const release = deferred();
    const writer = fixture.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${a.deviceId} FOR UPDATE`;
        held.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    await held.promise;
    const oldId = randomUUID().replaceAll("-", "");
    a.client.send(
      JSON.stringify({
        type: "deployment.instances",
        snapshotId: oldId,
        chunkIndex: 0,
        final: true,
        instances: [],
      }),
    );
    try {
      await until(() => a.inventoryCalls() === 1);
      a.client.terminate();
      await until(() => a.manager.deploymentSocket(a.deviceId) === null);
      expect(
        a.frames.some(
          (frame) => frame.type === "deployment.instances.ok" && frame.snapshotId === oldId,
        ),
      ).toBe(false);
    } finally {
      release.resolve();
      await writer;
    }
    const successor = await a.connect();
    await a.snapshot([], successor);
    await until(() =>
      a.frames.some(
        (frame) => frame.type === "deployment.instances.ok" && frame.snapshotId !== oldId,
      ),
    );
    expect(
      a.frames.some(
        (frame) => frame.type === "deployment.instances.ok" && frame.snapshotId === oldId,
      ),
    ).toBe(false);
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(true);
  }, 50_000);

  it("a real durable commit timeout is reconnectable and never acknowledges or readies its old socket", async () => {
    const a = await arrangement();
    const s = await seed(a);
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    const job = a.jobs[0]!;
    const intent = deploymentJobIntentSchema.parse(s.starts[0]!.intent);
    const held = deferred();
    const release = deferred();
    const writer = fixture.$transaction(
      async (tx) => {
        await lockDeploymentOwner(tx, a.user.id);
        held.resolve();
        await release.promise;
      },
      { timeout: 40_000 },
    );
    await held.promise;
    const id = randomUUID().replaceAll("-", "");
    a.client.send(
      JSON.stringify({
        type: "deployment.instances",
        snapshotId: id,
        chunkIndex: 0,
        final: true,
        instances: [
          {
            stepId: job.stepId,
            instanceId: job.instanceId,
            revisionId: intent.revisionId,
            rank: job.rank,
            intentHash: job.intentHash,
            phase: "ready",
            unitName: intent.unitName,
            port: intent.port,
            endpointSlug: intent.endpointSlug,
            models: intent.models,
            contextWindow: intent.contextWindow,
          },
        ],
      }),
    );
    try {
      await until(async () =>
        (
          await fixture.$queryRaw<
            Array<{ waiting: bigint }>
          >`SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event = 'advisory' AND state = 'active'`
        ).some((row) => row.waiting > 0n),
      );
      await until(() => a.client.readyState === WebSocket.CLOSED, 35_000);
      expect(
        a.frames.some((frame) => frame.type === "protocol.error" && frame.code === "internal"),
      ).toBe(true);
      expect(
        a.frames.some(
          (frame) => frame.type === "deployment.instances.ok" && frame.snapshotId === id,
        ),
      ).toBe(false);
    } finally {
      release.resolve();
      await writer;
    }
    const successor = await a.connect();
    await a.snapshot([], successor);
    // The old socket's handler finishes once the lock is released and also advances the shared
    // frame counter, so wait for the successor's own commit rather than the next counter step.
    await until(() => a.manager.deploymentSocket(a.deviceId)?.inventoryComplete === true);
  }, 90_000);

  it("complete final snapshot gates actual dispatch and adoption; partial/omitted records never release claims", async () => {
    const a = await arrangement();
    const s = await seed(a);
    const id = randomUUID().replaceAll("-", "");
    await a.frame({
      type: "deployment.instances",
      snapshotId: id,
      chunkIndex: 0,
      final: false,
      instances: [],
    });
    await a.reconciler.runOnce();
    expect(a.inventoryCalls()).toBe(0);
    expect(a.jobs).toHaveLength(0);
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(false);
    await a.frame({
      type: "deployment.instances",
      snapshotId: id,
      chunkIndex: 1,
      final: true,
      instances: [],
    });
    await a.tickUntil(() => a.jobs.length === 1);
    expect(a.inventoryCalls()).toBe(1);
    expect(a.jobs[0]?.management).toBe("ownedProcess");
    expect(await Promise.all(a.commitReads)).toEqual([true]);
    const held = await fixture.deploymentInstanceNode.findUniqueOrThrow({
      where: { id: s.nodes[0]?.id },
    });
    expect(held.claimHeld).toBe(true);
    // A new incomplete snapshot closes the previous generation's dispatch barrier.
    const replacement = randomUUID().replaceAll("-", "");
    await a.frame({
      type: "deployment.instances",
      snapshotId: replacement,
      chunkIndex: 0,
      final: false,
      instances: [],
    });
    await a.settle(a.jobs[0]!);
    expect(a.jobs).toHaveLength(1);
    await a.frame({
      type: "deployment.instances",
      snapshotId: replacement,
      chunkIndex: 1,
      final: true,
      instances: [],
    });
    await a.tickUntil(() => a.jobs.length === 2);
    await a.settle(a.jobs[1]!);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .observedState,
    ).toBe("RUNNING");
  }, 60_000);

  it("a new snapshot start replaces partial data; duplicate/out-of-order and foreign ID frames close without adoption", async () => {
    for (const invalid of ["duplicate", "gap", "foreign"] as const) {
      const a = await arrangement();
      await seed(a);
      const id = randomUUID().replaceAll("-", "");
      await a.frame({
        type: "deployment.instances",
        snapshotId: id,
        chunkIndex: 0,
        final: false,
        instances: [],
      });
      const replacement = randomUUID().replaceAll("-", "");
      await a.frame({
        type: "deployment.instances",
        snapshotId: replacement,
        chunkIndex: 0,
        final: false,
        instances: [],
      });
      await a.frame({
        type: "deployment.instances",
        snapshotId: invalid === "foreign" ? id : replacement,
        chunkIndex: invalid === "duplicate" ? 0 : invalid === "gap" ? 2 : 1,
        final: true,
        instances: [],
      });
      await until(() => a.client.readyState === WebSocket.CLOSED);
      expect(a.inventoryCalls()).toBe(0);
      expect(a.jobs).toHaveLength(0);
      expect(a.frames.some((f) => f.type === "protocol.error")).toBe(true);
    }
  });

  it("snapshot byte limit and timeout close real sockets without committing partial data", async () => {
    const a = await arrangement();
    const id = randomUUID().replaceAll("-", "");
    for (
      let chunkIndex = 0;
      chunkIndex < 190 && a.client.readyState === WebSocket.OPEN;
      chunkIndex++
    ) {
      const instances = Array.from({ length: 3 }, (_, rank) => ({
        instanceId: `snapshot${chunkIndex}rank${rank}`,
        revisionId: "snapshotrevision",
        rank: 0,
        intentHash: "a".repeat(64),
        phase: "unknown",
        unitName: `wsmp-i-snapshot${chunkIndex}rank${rank}-r0`,
        port: 30000,
        endpointSlug: "snapshot",
        models: Array.from({ length: 64 }, () => "m".repeat(256)),
        contextWindow: null,
      }));
      const value = {
        type: "deployment.instances",
        snapshotId: id,
        chunkIndex,
        final: false,
        instances,
      };
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(65536);
      await a.frame(value);
    }
    await until(() => a.client.readyState === WebSocket.CLOSED);
    expect(a.inventoryCalls()).toBe(0);
    const timeout = await arrangement();
    await timeout.frame({
      type: "deployment.instances",
      snapshotId: randomUUID().replaceAll("-", ""),
      chunkIndex: 0,
      final: false,
      instances: [],
    });
    await until(() => timeout.client.readyState === WebSocket.CLOSED, 35_000);
    expect(timeout.inventoryCalls()).toBe(0);
    expect(timeout.frames.some((f) => f.type === "protocol.error")).toBe(true);
  }, 80_000);

  it("actual current-epoch callbacks are fenced by a newer hello and final snapshot belongs only to its socket", async () => {
    const a = await arrangement();
    const s = await seed(a);
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    const oldJob = a.jobs[0]!;
    const oldSocket = a.manager.deploymentSocket(a.deviceId)!;
    const oldId = randomUUID().replaceAll("-", "");
    await a.frame({
      type: "deployment.instances",
      snapshotId: oldId,
      chunkIndex: 0,
      final: false,
      instances: [],
    });
    const newer = await a.connect();
    expect(a.manager.deploymentSocket(a.deviceId)?.generation).toBeGreaterThan(
      oldSocket.generation,
    );
    expect(
      await a.reconciler.acceptResult(oldSocket, {
        type: "deployment.job.result",
        stepId: oldJob.stepId,
        instanceId: oldJob.instanceId,
        rank: oldJob.rank,
        intentHash: oldJob.intentHash,
        ownerEpoch: oldJob.ownerEpoch,
        status: "succeeded",
        stopped: true,
      }),
    ).toBe(false);
    expect(
      (await fixture.deploymentStep.findUniqueOrThrow({ where: { id: s.starts[0]?.id } })).state,
    ).toBe("RUNNING");
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(false);
    await a.snapshot([], newer);
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(true);
    expect(a.inventoryCalls()).toBe(2);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
        .claimHeld,
    ).toBe(true);
  });

  it("budget/grant/port changes race automatic restart under actual PostgreSQL row locks, then legitimate restart works", async () => {
    const a = await arrangement();
    const s = await seed(a, { stopped: true });
    const held = deferred();
    const release = deferred();
    const writer = fixture.$transaction(
      async (tx) => {
        await lockDeploymentOwner(tx, a.user.id);
        await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${a.deviceId} FOR UPDATE`;
        await tx.cliDevice.update({
          where: { id: a.deviceId },
          data: {
            usableMemoryGb: 5,
            allowDeployments: false,
            deploymentPortStart: 31000,
            deploymentPortEnd: 31999,
          },
        });
        held.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    await held.promise;
    let done = false;
    const tick = a.reconciler.runOnce().then(() => {
      done = true;
    });
    await until(async () =>
      (
        await fixture.$queryRaw<
          Array<{ waiting: bigint }>
        >`SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event = 'advisory' AND state = 'active'`
      ).some((r) => r.waiting > 0n),
    );
    expect(done).toBe(false);
    release.resolve();
    await writer;
    await tick;
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
        .claimHeld,
    ).toBe(false);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .restartAttempts,
    ).toBe(0);
    // Each individual changed gate refuses reclaim, including changed physical capacity.
    for (const data of [
      {
        usableMemoryGb: 5,
        allowDeployments: true,
        deploymentPortStart: 30000,
        deploymentPortEnd: 30999,
      },
      { usableMemoryGb: 20, allowDeployments: false },
      { allowDeployments: true, deploymentPortStart: 31000, deploymentPortEnd: 31999 },
      {
        deploymentPortStart: 30000,
        deploymentPortEnd: 30999,
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 4 * 1024,
          executionMechanism: "systemd+linger",
        },
      },
    ]) {
      await fixture.cliDevice.update({ where: { id: a.deviceId }, data });
      for (let i = 0; i < 4; i++) await a.reconciler.runOnce();
      expect(
        (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
          .claimHeld,
      ).toBe(false);
    }
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: {
        usableMemoryGb: 20,
        allowDeployments: true,
        deploymentPortStart: 30000,
        deploymentPortEnd: 30999,
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 32 * 1024,
          executionMechanism: "systemd+linger",
        },
      },
    });
    await a.snapshot();
    await a.tickUntil(
      async () =>
        (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
          .restartAttempts === 1,
    );
    await a.tickUntil(() => a.jobs.length === 1);
    expect(a.jobs[0]?.action).toBe("start");
    expect(a.jobs[0]?.management).toBe("ownedProcess");
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
        .claimHeld,
    ).toBe(true);
    const currentJob = a.jobs[0]!;
    const oldStart = deploymentJobIntentSchema.parse(s.starts[0]?.intent);
    const oldIntent = {
      ...oldStart,
      action: "stop" as const,
      command: oldStart.stopCommand,
      timeoutMs: 300_000,
    };
    const oldStop = await fixture.deploymentStep.create({
      data: {
        runId: s.run.id,
        instanceId: s.instance.id,
        cliDeviceId: a.deviceId,
        rank: 0,
        phase: "stop",
        sequence: 100,
        state: "RUNNING",
        ownerEpoch: currentJob.ownerEpoch,
        intent: oldIntent,
        intentHash: deploymentFingerprint(oldIntent),
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { observedState: "STOP_PENDING" },
    });
    expect(
      await a.reconciler.acceptResult(a.manager.deploymentSocket(a.deviceId)!, {
        type: "deployment.job.result",
        stepId: oldStop.id,
        instanceId: s.instance.id,
        rank: 0,
        intentHash: oldStop.intentHash,
        ownerEpoch: currentJob.ownerEpoch,
        status: "succeeded",
        stopped: true,
      }),
    ).toBe(false);
    await a.snapshot([
      {
        stepId: oldStop.id,
        instanceId: s.instance.id,
        revisionId: oldStart.revisionId,
        rank: 0,
        intentHash: oldStop.intentHash,
        phase: "stopped",
        unitName: oldStart.unitName,
        port: oldStart.port,
        endpointSlug: oldStart.endpointSlug,
        models: oldStart.models,
        contextWindow: oldStart.contextWindow,
      },
    ]);
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
        .claimHeld,
    ).toBe(true);
  }, 60_000);

  it("a received valid-current-epoch result loses to a concurrently committed newer hello", async () => {
    const a = await arrangement();
    const s = await seed(a);
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    const job = a.jobs[0]!;
    const oldSocket = a.manager.deploymentSocket(a.deviceId)!;
    const held = deferred();
    const release = deferred();
    const writer = fixture.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${a.deviceId} FOR UPDATE`;
        held.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    await held.promise;
    const hello = a.connect();
    // Registration owns its graph fence while its device row waits for this fixture transaction.
    await until(async () =>
      (
        await fixture.$queryRaw<
          Array<{ waiting: bigint }>
        >`SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event = 'transactionid' AND state = 'active'`
      ).some((r) => r.waiting > 0n),
    );
    const pending = a.reconciler.acceptResult(oldSocket, {
      type: "deployment.job.result",
      stepId: job.stepId,
      instanceId: job.instanceId,
      rank: job.rank,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      status: "succeeded",
      stopped: false,
    });
    release.resolve();
    await writer;
    await hello;
    expect(await pending).toBe(false);
    expect(
      (await fixture.deploymentStep.findUniqueOrThrow({ where: { id: s.starts[0]?.id } })).state,
    ).toBe("RUNNING");
    expect(a.manager.deploymentSocket(a.deviceId)?.generation).toBeGreaterThan(
      oldSocket.generation,
    );
  }, 60_000);

  it("legitimate restart permits an offline former conflict node after its confirmed stop", async () => {
    const a = await arrangement();
    const s = await seed(a, { stopped: true });
    const former = await fixture.cliDevice.create({
      data: {
        userId: a.user.id,
        slug: `former-${randomUUID()}`,
        status: "DISCONNECTED",
        allowDeployments: true,
        reportedDeployments: true,
        relayProtocolVersion: "2.11",
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 32 * 1024,
          executionMechanism: "systemd+linger",
        },
      },
    });
    await fixture.deploymentPlan.update({
      where: { id: s.run.planId },
      data: { contents: { affectedNodeIds: [a.deviceId, former.id] } },
    });
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .restartAttempts,
    ).toBe(1);
    expect(a.jobs[0]?.action).toBe("start");
  }, 60_000);

  it("automatic restart validates discrete RAM, concrete VRAM and physical hardware while retaining failed-stop claims", async () => {
    const a = await arrangement();
    const hardware = {
      nodeKind: "discrete",
      memoryTotalMiB: 32 * 1024,
      executionMechanism: "systemd+linger",
      gpus: [{ index: 0, vramTotalMiB: 16 * 1024 }],
    };
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: {
        nodeInfo: hardware,
        usableMemoryGb: null,
        usableRamGb: 20,
        usableVramGb: { "index:0": 12 },
      },
    });
    const s = await seed(a, {
      stopped: true,
      resources: {
        kind: "discrete",
        memoryGb: 0,
        ramGb: 10,
        gpus: [{ key: "index:0", index: 0, vramGb: 10 }],
      },
    });
    for (const data of [
      { usableRamGb: 5 },
      { usableRamGb: 20, usableVramGb: { "index:0": 5 } },
      {
        usableVramGb: { "index:0": 12 },
        nodeInfo: { ...hardware, gpus: [{ index: 0, vramTotalMiB: 4 * 1024 }] },
      },
      { nodeInfo: { ...hardware, gpus: [{ index: 1, vramTotalMiB: 16 * 1024 }] } },
    ]) {
      await fixture.cliDevice.update({ where: { id: a.deviceId }, data });
      for (let i = 0; i < 4; i++) await a.reconciler.runOnce();
      expect(
        (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
          .claimHeld,
      ).toBe(false);
      expect(
        (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
          .restartAttempts,
      ).toBe(0);
    }
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: { nodeInfo: hardware, usableRamGb: 20, usableVramGb: { "index:0": 12 } },
    });
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    expect(a.jobs[0]?.action).toBe("start");
    await a.settle(a.jobs[0]!, false, "failed");
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: { allowDeployments: false, usableRamGb: 5 },
    });
    for (let i = 0; i < 4; i++) await a.reconciler.runOnce();
    expect(
      (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
        .claimHeld,
    ).toBe(true);
  }, 60_000);

  it("fair step sweeps reach a runnable stop behind 65 blocked instances and release only its own claim", async () => {
    const a = await arrangement();
    const blocked: Awaited<ReturnType<typeof seed>>[] = [];
    for (let i = 0; i < 65; i++) {
      const s = await seed(a, { port: 30000 + i });
      blocked.push(s);
      await fixture.deploymentStep.updateMany({
        where: { instanceId: s.instance.id },
        data: { notBefore: new Date(Date.now() + 600_000) },
      });
    }
    const target = await seed(a, { port: 30100 });
    const original = deploymentJobIntentSchema.parse(target.starts[0]?.intent);
    const intent = {
      ...original,
      action: "stop" as const,
      command: original.stopCommand,
      timeoutMs: 300_000,
    };
    await fixture.deploymentInstance.update({
      where: { id: target.instance.id },
      data: { desiredState: "STOPPED", observedState: "STOPPING" },
    });
    await fixture.deploymentStep.create({
      data: {
        runId: target.run.id,
        instanceId: target.instance.id,
        cliDeviceId: a.deviceId,
        rank: 0,
        phase: "stop",
        sequence: 100,
        intent,
        intentHash: deploymentFingerprint(intent),
      },
    });
    await a.snapshot();
    await a.tickUntil(() =>
      a.jobs.some((j) => j.instanceId === target.instance.id && j.action === "stop"),
    );
    const stop = a.jobs.find((j) => j.instanceId === target.instance.id && j.action === "stop");
    if (!stop) throw new Error("fair stop missing");
    await a.settle(stop, true);
    expect(
      (
        await fixture.deploymentInstanceNode.findUniqueOrThrow({
          where: { id: target.nodes[0]?.id },
        })
      ).claimHeld,
    ).toBe(false);
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { instanceId: { in: blocked.map((s) => s.instance.id) }, claimHeld: true },
      }),
    ).toBe(65);
    expect(a.jobs.every((j) => j.action === "stop")).toBe(true);
  }, 120_000);

  it("managed registration accepts the original model and leaves out a wrong model or spoofed identity", async () => {
    const a = await arrangement();
    const s = await seed(a);
    const endpoint = {
      slug: s.instance.endpointSlug,
      label: "Managed",
      kind: "openai-compatible",
      status: "online",
      deploymentInstanceId: s.instance.id,
      defaultCapabilities: {
        version: 1,
        protocol: "openai-compatible",
        chatCompletions: { supported: true, streaming: true },
        embeddings: { supported: true },
      },
      models: [{ upstreamModelId: "old-model" }],
    };
    await a.frame({ type: "inventory.update", id: "managed-correct", endpoints: [endpoint] });
    const row = await fixture.endpoint.findFirstOrThrow({
      where: { deploymentInstanceId: s.instance.id },
    });
    expect(row.published).toBe(false);
    await a.frame({
      type: "inventory.update",
      id: "managed-wrong-model",
      endpoints: [{ ...endpoint, models: [{ upstreamModelId: "stranger-model" }] }],
    });
    // Refused for that endpoint only: the inventory itself is acknowledged.
    await until(() =>
      a.frames.some((f) => f.type === "inventory.ok" && f.id === "managed-wrong-model"),
    );
    expect(
      await fixture.discoveredModel.count({
        where: { endpointId: row.id, upstreamModelId: "stranger-model" },
      }),
    ).toBe(0);
    await a.frame({
      type: "inventory.update",
      id: "managed-spoof",
      endpoints: [{ ...endpoint, deploymentInstanceId: "stranger" }],
    });
    await until(() => a.frames.some((f) => f.type === "inventory.ok" && f.id === "managed-spoof"));
    // The spoofed claim neither rebinds the endpoint nor publishes it.
    expect(await fixture.endpoint.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      deploymentInstanceId: s.instance.id,
      published: false,
    });
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    await a.settle(a.jobs[0]!);
    await a.tickUntil(() => a.jobs.length === 2);
    await a.settle(a.jobs[1]!);
    expect((await fixture.endpoint.findUniqueOrThrow({ where: { id: row.id } })).published).toBe(
      true,
    );
  }, 60_000);

  it("human STOP preserves old owned/external immutable recipe identity and failed STOP holds only its claims", async () => {
    for (const management of ["ownedProcess", "externalService"] as const) {
      const a = await arrangement();
      const s = await seed(a, { management });
      const untouched = await seed(a, { port: 30005 });
      const requester = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
      const plan = await createDeploymentPlan(requester, { stopInstanceId: s.instance.id });
      await applyDeploymentPlan(requester, plan.id, true);
      const stop = await fixture.deploymentStep.findFirstOrThrow({
        where: { instanceId: s.instance.id, phase: "stop" },
      });
      const original = deploymentJobIntentSchema.parse(s.starts[0]?.intent);
      expect(stop.intent).toEqual({
        ...original,
        action: "stop",
        command: original.stopCommand,
        timeoutMs: 300_000,
      });
      expect(stop.intentHash).toBe(deploymentFingerprint(stop.intent));
      await a.snapshot();
      await a.tickUntil(() => a.jobs.some((j) => j.action === "stop"));
      const job = a.jobs.find((j) => j.action === "stop")!;
      expect(job.management).toBe(management);
      expect(job.statusCommand).toBe("old-status");
      await a.settle(job, false, "failed");
      expect(
        (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
          .claimHeld,
      ).toBe(true);
      await fixture.deploymentStep.update({
        where: { id: job.stepId },
        data: { state: "RUNNING", ownerEpoch: job.ownerEpoch },
      });
      await a.settle(job, true);
      expect(
        (await fixture.deploymentInstanceNode.findUniqueOrThrow({ where: { id: s.nodes[0]?.id } }))
          .claimHeld,
      ).toBe(false);
      expect(
        (
          await fixture.deploymentInstanceNode.findUniqueOrThrow({
            where: { id: untouched.nodes[0]?.id },
          })
        ).claimHeld,
      ).toBe(true);
    }
  }, 60_000);

  it("switch stops the whole old conflict gang using original contracts and preserves unrelated instances", async () => {
    for (const management of ["ownedProcess", "externalService"] as const) {
      const a = await arrangement();
      const old = await seed(a, { group: 2, management });
      const unaffectedDevice = await fixture.cliDevice.create({
        data: {
          userId: a.user.id,
          slug: `unaffected-${randomUUID()}`,
          status: "CONNECTED",
          allowDeployments: true,
          reportedDeployments: true,
          relayProtocolVersion: "2.11",
          nodeInfo: {
            nodeKind: "unified",
            memoryTotalMiB: 32 * 1024,
            executionMechanism: "systemd+linger",
          },
          usableMemoryGb: 20,
        },
      });
      const unaffected = await seed(a, { devices: [unaffectedDevice.id] });
      const variant = old.spec.variants[0];
      if (!variant) throw new Error("variant missing");
      const spec = deploymentSpecSchema.parse({
        variants: [
          {
            ...variant,
            groupSize: 1,
            resources: [{ kind: "unified", memoryGb: 15 }],
            commands: [
              {
                management: management === "ownedProcess" ? "externalService" : "ownedProcess",
                start: "replacement-start",
                stop: "replacement-stop",
                status: "replacement-status",
                health: "replacement-health",
              },
            ],
            readiness: { path: "/replacement-readiness" },
            models: ["replacement-model"],
          },
        ],
      });
      const replacement = await fixture.deploymentConfigRevision.create({
        data: {
          configId: old.config.id,
          revision: 2,
          editorId: a.user.id,
          editorKind: "USER",
          spec,
          contentHash: deploymentFingerprint(spec),
        },
      });
      const requester = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
      const plan = await createDeploymentPlan(requester, {
        start: {
          revisionId: replacement.id,
          variantKey: "one",
          groupCount: 1,
          nodeIds: [a.deviceId],
        },
      });
      expect(plan.contents.stopIds).toEqual([old.instance.id]);
      await applyDeploymentPlan(requester, plan.id, true);
      const stops = await fixture.deploymentStep.findMany({
        where: { instanceId: old.instance.id, phase: "stop" },
        orderBy: { rank: "asc" },
      });
      expect(stops).toHaveLength(2);
      for (const stop of stops) {
        const original = deploymentJobIntentSchema.parse(old.starts[stop.rank]?.intent);
        expect(stop.intent).toEqual({
          ...original,
          action: "stop",
          command: "old-stop",
          timeoutMs: 300_000,
        });
        expect(stop.intentHash).toBe(deploymentFingerprint(stop.intent));
        expect(stop.runId).not.toBe(old.run.id);
      }
      expect(
        (
          await fixture.deploymentInstance.findUniqueOrThrow({
            where: { id: unaffected.instance.id },
          })
        ).desiredState,
      ).toBe("RUNNING");
      expect(
        await fixture.deploymentStep.count({
          where: { instanceId: unaffected.instance.id, phase: "stop" },
        }),
      ).toBe(0);
      expect(
        (
          await fixture.deploymentInstanceNode.findUniqueOrThrow({
            where: { id: unaffected.nodes[0]?.id },
          })
        ).claimHeld,
      ).toBe(true);
      await a.snapshot();
      await a.tickUntil(() => a.jobs.some((j) => j.action === "stop"));
      const stop = a.jobs.find((j) => j.action === "stop");
      if (!stop) throw new Error("stop missing");
      expect(stop.management).toBe(management);
      expect(stop.stopCommand).toBe("old-stop");
      expect(stop.statusCommand).toBe("old-status");
      expect(stop.readiness.path).toBe("/old-ready");
      expect(stop.models).toEqual(["old-model"]);
      expect(a.jobs.some((j) => j.revisionId === replacement.id)).toBe(false);
    }
  }, 60_000);

  it("gang readiness waits for all ranks and shutdown joins a slow actual inventory callback", async () => {
    const a = await arrangement();
    const s = await seed(a, { group: 2 });
    await a.snapshot();
    await a.tickUntil(() => a.jobs.length === 1);
    await a.settle(a.jobs[0]!);
    expect(a.jobs).toHaveLength(1);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .observedState,
    ).toBe("STARTING");
    const socket = a.manager.deploymentSocket(a.deviceId)!;
    const held = deferred();
    const release = deferred();
    const writer = fixture.$transaction(
      async (tx) => {
        await lockDeploymentOwner(tx, a.user.id);
        held.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    await held.promise;
    const start = s.starts[0]!;
    const intent = deploymentJobIntentSchema.parse(start.intent);
    const pending = a.reconciler.acceptInventory(socket, [
      {
        stepId: start.id,
        instanceId: start.instanceId,
        revisionId: intent.revisionId,
        rank: 0,
        intentHash: start.intentHash,
        phase: "ready",
        unitName: intent.unitName,
        port: intent.port,
        endpointSlug: intent.endpointSlug,
        models: intent.models,
        contextWindow: intent.contextWindow,
      },
    ]);
    let stopped = false;
    const shutdown = a.reconciler.stop().then(() => {
      stopped = true;
    });
    await until(async () =>
      (
        await fixture.$queryRaw<
          Array<{ waiting: bigint }>
        >`SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event = 'advisory' AND state = 'active'`
      ).some((r) => r.waiting > 0n),
    );
    expect(stopped).toBe(false);
    release.resolve();
    await writer;
    await pending;
    await shutdown;
    expect(stopped).toBe(true);
    expect(a.jobs).toHaveLength(1);
  }, 60_000);

  it("65+ terminal health histories are swept fairly while active/recovery startup/stop intents survive", async () => {
    const a = await arrangement();
    const seeded: Awaited<ReturnType<typeof seed>>[] = [];
    for (let i = 0; i < 65; i++) seeded.push(await seed(a, { stopped: true, port: 30000 + i }));
    for (const s of seeded) {
      const start = deploymentJobIntentSchema.parse(s.starts[0]?.intent);
      const intent = {
        ...start,
        action: "health" as const,
        command: start.healthCommand ?? "",
        timeoutMs: 30_000,
      };
      await fixture.deploymentStep.createMany({
        data: Array.from({ length: 131 }, (_, i) => ({
          runId: s.run.id,
          instanceId: s.instance.id,
          cliDeviceId: a.deviceId,
          rank: 0,
          phase: "health",
          sequence: 1000 + i,
          state: i === 130 ? ("RUNNING" as const) : ("SUCCEEDED" as const),
          intent,
          intentHash: deploymentFingerprint(intent),
          ...(i === 130 ? { leaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
        })),
      });
      await fixture.deploymentInstance.update({
        where: { id: s.instance.id },
        data: { desiredState: "STOPPED", nextRestartAt: null },
      });
    }
    await a.tickUntil(
      async () =>
        (await fixture.deploymentStep.count({
          where: {
            instanceId: { in: seeded.map((s) => s.instance.id) },
            phase: "health",
            state: "SUCCEEDED",
          },
        })) ===
        65 * 128,
    );
    expect(
      await fixture.deploymentStep.count({
        where: {
          instanceId: { in: seeded.map((s) => s.instance.id) },
          state: "RUNNING",
          phase: "health",
        },
      }),
    ).toBe(65);
    expect(
      await fixture.deploymentStep.count({
        where: { instanceId: { in: seeded.map((s) => s.instance.id) }, phase: "start" },
      }),
    ).toBe(65);
    expect(
      await fixture.deploymentStep.count({
        where: { instanceId: { in: seeded.map((s) => s.instance.id) }, phase: "readiness" },
      }),
    ).toBe(65);
    const one = seeded[0];
    if (!one) throw new Error("retention fixture missing");
    await fixture.deploymentStep.updateMany({
      where: { instanceId: one.instance.id, phase: "health", state: "RUNNING" },
      data: { state: "FAILED", leaseExpiresAt: null },
    });
    await fixture.deploymentInstanceNode.updateMany({
      where: { instanceId: one.instance.id },
      data: { claimHeld: true, stoppedAt: null },
    });
    await fixture.deploymentInstance.update({
      where: { id: one.instance.id },
      data: {
        desiredState: "RUNNING",
        observedState: "RUNNING",
        lastHealthAt: new Date(Date.now() - 60_000),
      },
    });
    await a.snapshot();
    await a.tickUntil(
      async () =>
        (await fixture.deploymentStep.count({
          where: { instanceId: one.instance.id, phase: "health", sequence: 1131 },
        })) === 1,
    );
    expect(
      await fixture.deploymentStep.count({
        where: { instanceId: one.instance.id, phase: "health", sequence: 1131 },
      }),
    ).toBe(1);
  }, 120_000);
  /** Releases the seeded instance's claims so new plans may use its device. */
  async function retire(s: Awaited<ReturnType<typeof seed>>) {
    await fixture.deploymentInstanceNode.updateMany({
      where: { instanceId: s.instance.id },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    await fixture.deploymentStep.updateMany({
      where: { instanceId: s.instance.id },
      data: { state: "SUCCEEDED" },
    });
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { desiredState: "STOPPED", observedState: "STOPPED", nextRestartAt: null },
    });
  }
  async function revise(
    a: Awaited<ReturnType<typeof arrangement>>,
    s: Awaited<ReturnType<typeof seed>>,
    changes: Record<string, unknown>,
    options: { legacy?: boolean } = {},
  ) {
    // `legacy` stores a revision saved before the current rules, as a database
    // upgraded from an earlier release may hold.
    const schema = options.legacy ? storedDeploymentSpecSchema : deploymentSpecSchema;
    const spec = schema.parse({ variants: [{ ...s.spec.variants[0], ...changes }] });
    return fixture.deploymentConfigRevision.create({
      data: {
        configId: s.config.id,
        revision: 2,
        editorId: a.user.id,
        editorKind: "USER",
        contentHash: deploymentFingerprint(spec),
        spec,
      },
    });
  }
  async function publishManagedEndpoint(
    a: Awaited<ReturnType<typeof arrangement>>,
    s: Awaited<ReturnType<typeof seed>>,
  ) {
    await a.frame({
      type: "inventory.update",
      id: `managed-${randomUUID()}`,
      endpoints: [
        {
          slug: s.instance.endpointSlug,
          label: "Managed",
          kind: "openai-compatible",
          status: "online",
          deploymentInstanceId: s.instance.id,
          defaultCapabilities: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true },
          },
          models: [{ upstreamModelId: "old-model" }],
        },
      ],
    });
  }
  async function startServing(a: Awaited<ReturnType<typeof arrangement>>) {
    await a.snapshot();
    await a.tickUntil(() => a.jobs.some((j) => j.action === "start"));
    await a.settle(a.jobs.find((j) => j.action === "start")!);
    await a.tickUntil(() => a.jobs.some((j) => j.action === "readiness"));
    await a.settle(a.jobs.find((j) => j.action === "readiness")!);
  }
  function observation(job: DeploymentJob, phase: DeploymentObservedInstance["phase"]) {
    return {
      stepId: job.stepId,
      instanceId: job.instanceId,
      revisionId: job.revisionId,
      rank: job.rank,
      intentHash: job.intentHash,
      phase,
      unitName: job.unitName,
      port: job.port,
      endpointSlug: job.endpointSlug,
      models: job.models,
      contextWindow: job.contextWindow,
    };
  }
  async function servingState(s: Awaited<ReturnType<typeof seed>>) {
    return {
      instance: await fixture.deploymentInstance.findUniqueOrThrow({
        where: { id: s.instance.id },
        select: { observedState: true, healthFailures: true, healthSuccesses: true },
      }),
      gate: (await fixture.poolMember.findFirstOrThrow({ where: { poolId: s.pool.id } }))
        .instanceGate,
      endpoint: await fixture.endpoint.findFirstOrThrow({
        where: { deploymentInstanceId: s.instance.id },
        select: { published: true, status: true },
      }),
      modelsPublished: (
        await fixture.discoveredModel.findMany({
          where: { Endpoint: { deploymentInstanceId: s.instance.id } },
          select: { published: true },
        })
      ).map((m) => m.published),
    };
  }

  it("an unhealthy inventory observation is durable: maintenance cannot reopen it and only fresh health recovers", async () => {
    const a = await arrangement();
    const s = await seed(a, {
      health: { intervalMs: 5000, failureThreshold: 3, successThreshold: 1 },
    });
    await publishManagedEndpoint(a, s);
    await startServing(a);
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { lastHealthAt: new Date(Date.now() - 60_000) },
    });
    await a.tickUntil(() => a.jobs.some((j) => j.action === "health"));
    const health = a.jobs.find((j) => j.action === "health")!;
    expect((await servingState(s)).gate).toBe("OPEN");

    // Actual relay send attempts through the production authorization boundary.
    const { startAuthorizedLocalRelayAttempt: send } = await import("../model-api/local-send.js");
    const endpoint = await fixture.endpoint.findFirstOrThrow({
      where: { deploymentInstanceId: s.instance.id },
    });
    const model = await fixture.discoveredModel.findFirstOrThrow({
      where: { endpointId: endpoint.id },
      include: { ExecutionTarget: true },
    });
    const member = await fixture.poolMember.findFirstOrThrow({ where: { poolId: s.pool.id } });
    const binding = {
      requesterUserId: a.user.id,
      engineOwnerUserId: a.user.id,
      discoveredModelId: model.id,
      executionTargetId: model.ExecutionTarget!.id,
      capacityId: model.ExecutionTarget!.inferenceCapacityId,
      endpointId: endpoint.id,
      cliDeviceId: a.deviceId,
      endpointSlug: endpoint.slug,
      upstreamModelId: model.upstreamModelId,
      pool: { id: s.pool.id, ownerUserId: a.user.id, accessGrantId: null, memberId: member.id },
    };
    const args = () => ({
      manager: a.manager,
      cliDeviceId: a.deviceId,
      endpointSlug: endpoint.slug,
      family: "chat.completions" as const,
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode("{}"),
      timeoutMs: 5000,
    });
    const controls = () => a.frames.filter((f) => f.type === "relay.request").length;
    const accepted = async () => {
      const count = controls();
      const attempt = await send(binding, args(), production);
      await until(() => controls() === count + 1);
      attempt.cancel("cancelled");
      await attempt.terminal;
    };
    await accepted();

    // The health result is lost; the reconnect inventory reports the CLI's threshold crossing.
    const paused = vi.spyOn(a.reconciler, "wake").mockImplementation(() => {});
    try {
      await a.snapshot([observation(health, "unhealthy")]);
    } finally {
      paused.mockRestore();
    }
    const unhealthy = {
      instance: { observedState: "UNHEALTHY", healthFailures: 3, healthSuccesses: 0 },
      gate: "CLOSED",
      endpoint: { published: false, status: "DEGRADED" },
      modelsPublished: [false],
    };
    expect(await servingState(s)).toEqual(unhealthy);
    // The snapshot is threshold evidence, not this step's outcome: its result is still in flight.
    expect(
      (await fixture.deploymentStep.findUniqueOrThrow({ where: { id: health.stepId } })).state,
    ).toBe("RUNNING");
    await expect(send(binding, args(), production)).rejects.toMatchObject({
      denial: "MEMBER_UNAVAILABLE",
    });

    for (let i = 0; i < 3; i++) await a.reconciler.runOnce();
    expect(await servingState(s)).toEqual(unhealthy);
    await expect(send(binding, args(), production)).rejects.toMatchObject({
      denial: "MEMBER_UNAVAILABLE",
    });
    // The in-flight result of the current session is accepted and counted once.
    await a.settle(health, false, "failed");
    expect((await servingState(s)).instance).toEqual({
      observedState: "UNHEALTHY",
      healthFailures: 4,
      healthSuccesses: 0,
    });
    expect(controls()).toBe(1);

    // Repeated identical snapshots (the CLI resends after every job on the device) neither
    // recount nor postpone the next health check.
    const due = new Date(Date.now() - 60_000);
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { lastHealthAt: due },
    });
    const paused2 = vi.spyOn(a.reconciler, "wake").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) await a.snapshot([observation(health, "unhealthy")]);
    } finally {
      paused2.mockRestore();
    }
    const repeated = await fixture.deploymentInstance.findUniqueOrThrow({
      where: { id: s.instance.id },
    });
    expect(repeated.lastHealthAt?.getTime()).toBe(due.getTime());
    expect(repeated.healthFailures).toBe(4);
    await a.tickUntil(() =>
      a.jobs.some((j) => j.action === "health" && j.stepId !== health.stepId),
    );
    const fresh = a.jobs.find((j) => j.action === "health" && j.stepId !== health.stepId)!;
    await a.settle(fresh);
    expect(await servingState(s)).toEqual({
      instance: { observedState: "RUNNING", healthFailures: 0, healthSuccesses: 1 },
      gate: "OPEN",
      endpoint: { published: true, status: "ONLINE" },
      modelsPublished: [true],
    });
    await accepted();
    expect(controls()).toBe(2);

    // A stale observation of the older health step cannot override the newer evidence.
    await a.snapshot([observation(health, "unhealthy")]);
    expect((await servingState(s)).instance.observedState).toBe("RUNNING");
    expect((await servingState(s)).gate).toBe("OPEN");
  }, 90_000);

  it("periodic health keeps failure and success hysteresis and publication in step", async () => {
    const a = await arrangement();
    const s = await seed(a, {
      health: { intervalMs: 5000, failureThreshold: 3, successThreshold: 2 },
    });
    await publishManagedEndpoint(a, s);
    await startServing(a);
    const states = [];
    for (const success of [false, false, false, true, true]) {
      const previous = new Set(a.jobs.map((j) => j.stepId));
      await fixture.deploymentInstance.update({
        where: { id: s.instance.id },
        data: { lastHealthAt: new Date(Date.now() - 60_000) },
      });
      await a.tickUntil(() => a.jobs.some((j) => j.action === "health" && !previous.has(j.stepId)));
      await a.settle(
        a.jobs.find((j) => j.action === "health" && !previous.has(j.stepId))!,
        false,
        success ? "succeeded" : "failed",
      );
      const state = await servingState(s);
      states.push([state.instance.observedState, state.gate, state.endpoint.published]);
    }
    expect(states).toEqual([
      ["RUNNING", "OPEN", true],
      ["RUNNING", "OPEN", true],
      ["UNHEALTHY", "CLOSED", false],
      ["UNHEALTHY", "CLOSED", false],
      ["RUNNING", "OPEN", true],
    ]);
  }, 90_000);

  it("refuses an over-limit command when saved, and a stored legacy one while planning, before any claim", async () => {
    const a = await arrangement();
    const s = await seed(a);
    await retire(s);
    // One byte over the shared CLI/server command limit is refused at save.
    await expect(
      revise(a, s, {
        commands: [{ management: "ownedProcess", start: "x".repeat(4_097), stop: "true" }],
      }),
    ).rejects.toThrow();
    const revision = await revise(
      a,
      s,
      { commands: [{ management: "ownedProcess", start: "true", stop: "z".repeat(32_768) }] },
      { legacy: true },
    );
    const actor = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const plans = await fixture.deploymentPlan.count({ where: { userId: a.user.id } });
    await expect(
      createDeploymentPlan(actor, {
        start: { revisionId: revision.id, variantKey: "one", groupCount: 1, nodeIds: [a.deviceId] },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fixture.deploymentPlan.count({ where: { userId: a.user.id } })).toBe(plans);
    expect(await fixture.deploymentInstance.count({ where: { revisionId: revision.id } })).toBe(0);
    expect(
      await fixture.deploymentInstanceNode.count({
        where: { cliDeviceId: a.deviceId, claimHeld: true },
      }),
    ).toBe(0);
  }, 60_000);

  it("admitted large commands produce START and STOP frames within the admission bound and CLI cap", async () => {
    const a = await arrangement();
    const s = await seed(a);
    await retire(s);
    const revision = await revise(a, s, {
      commands: [
        // Each command exactly at the shared 4096-byte limit (é is two bytes).
        { management: "ownedProcess", start: `é${"s".repeat(4_094)}`, stop: "t".repeat(4_096) },
      ],
    });
    const actor = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const plan = await createDeploymentPlan(actor, {
      start: { revisionId: revision.id, variantKey: "one", groupCount: 1, nodeIds: [a.deviceId] },
    });
    await applyDeploymentPlan(actor, plan.id, false);
    await a.snapshot();
    await a.tickUntil(() => a.jobs.some((j) => j.action === "start"));
    const start = a.jobs.find((j) => j.action === "start")!;
    const bytesOf = (action: string) =>
      a.frameBytes[a.frames.findIndex((f) => f.type === "deployment.job" && f.action === action)]!;
    const startIntent = deploymentJobIntentSchema.parse(
      (await fixture.deploymentStep.findUniqueOrThrow({ where: { id: start.stepId } })).intent,
    );
    expect(bytesOf("start")).toBeLessThanOrEqual(deploymentJobFrameBytes(startIntent)!);
    await a.settle(start);
    const stopPlan = await createDeploymentPlan(actor, { stopInstanceId: start.instanceId });
    await applyDeploymentPlan(actor, stopPlan.id, true);
    const stop = await fixture.deploymentStep.findFirstOrThrow({
      where: { instanceId: start.instanceId, phase: "stop" },
    });
    await fixture.deploymentStep.update({
      where: { id: stop.id },
      data: { notBefore: new Date(0) },
    });
    await a.tickUntil(() => a.jobs.some((j) => j.action === "stop"));
    const stopIntent = deploymentJobIntentSchema.parse(stop.intent);
    expect(bytesOf("stop")).toBeLessThanOrEqual(deploymentJobFrameBytes(stopIntent)!);
    expect(bytesOf("stop")).toBeLessThanOrEqual(DEPLOYMENT_JOB_FRAME_MAX_BYTES);
    // The frame really carries both maximum-size commands (2 x 4096 bytes).
    expect(bytesOf("stop")).toBeGreaterThan(8_192);
  }, 60_000);

  async function routers(a: Awaited<ReturnType<typeof arrangement>>) {
    const { createRouterClient } = await import("@orpc/server");
    const { appRouter } = await import("@ws-model-proxy/api/routers/index");
    const context = {
      session: {
        user: { ...a.user, twoFactorEnabled: true },
        session: {
          id: randomUUID(),
          userId: a.user.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    } as unknown as import("@ws-model-proxy/api/context").Context;
    const client = createRouterClient(appRouter, { context });
    return { pools: client.forwarderManagement, recipes: client.deployments };
  }
  function recipeSpec(poolId: string) {
    return deploymentSpecSchema.parse({
      variants: [
        {
          key: "one",
          groupSize: 1,
          resources: [{ kind: "unified", memoryGb: 1 }],
          commands: [{ management: "ownedProcess", start: "true", stop: "true" }],
          readiness: {},
          models: ["model"],
          attachment: { type: "llm", poolId },
          hardConcurrencyLimit: 1,
        },
      ],
    });
  }

  it("deleting a pool detaches never-launched recipes, which can be rebound or deleted", async () => {
    const a = await arrangement();
    const { pools, recipes } = await routers(a);
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Recipe pool", slug: `recipe-pool-${randomUUID()}` },
    });
    const recipe = await recipes.createConfig({
      poolId: pool.id,
      name: "Never launched",
      slug: `unused-${randomUUID().slice(0, 20)}`,
      spec: recipeSpec(pool.id),
    });
    const revisionId = recipe.Revisions[0]!.id;
    expect(await pools.deleteModelPool({ id: pool.id })).toEqual({ deleted: true });
    expect(await fixture.modelPool.count({ where: { id: pool.id } })).toBe(0);
    const detached = await fixture.deploymentConfig.findUniqueOrThrow({
      where: { id: recipe.id },
      include: { Revisions: true },
    });
    expect(detached.poolId).toBeNull();
    expect(detached.Revisions).toHaveLength(1);

    const actor = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const start = { revisionId, variantKey: "one", groupCount: 1, nodeIds: [a.deviceId] };
    await expect(createDeploymentPlan(actor, { start })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // The database refuses an instance for a detached recipe even if admission were bypassed.
    const run = await fixture.deploymentRun.create({
      data: {
        Plan: {
          create: {
            userId: a.user.id,
            requesterId: a.user.id,
            requesterKind: "USER",
            state: "APPLIED",
            fingerprint: "f".repeat(64),
            contents: { affectedNodeIds: [] },
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });
    await expect(
      fixture.deploymentInstance.create({
        data: {
          userId: a.user.id,
          configId: recipe.id,
          revisionId,
          runId: run.id,
          variantKey: "one",
          endpointSlug: `inst-detached-${randomUUID().slice(0, 12)}`,
          startedBy: "USER",
        },
      }),
    ).rejects.toThrow(/detached deployment recipes cannot start instances/);

    await expect(
      recipes.updateConfig({ id: recipe.id, expectedRevision: 1, spec: recipeSpec(pool.id) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const next = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Next pool", slug: `next-pool-${randomUUID()}` },
    });
    const rebound = await recipes.updateConfig({
      id: recipe.id,
      expectedRevision: 1,
      poolId: next.id,
      spec: recipeSpec(next.id),
    });
    // The old revision still names the deleted pool, so only the rebound revision can start.
    await expect(createDeploymentPlan(actor, { start })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const plan = await createDeploymentPlan(actor, {
      start: { ...start, revisionId: rebound.id },
    });
    expect(plan.contents.placements).toHaveLength(1);

    expect(await recipes.deleteConfig({ id: recipe.id })).toEqual({ deleted: true });
    expect(await fixture.deploymentConfig.count({ where: { id: recipe.id } })).toBe(0);
    expect(await fixture.deploymentConfigRevision.count({ where: { configId: recipe.id } })).toBe(
      0,
    );
  }, 60_000);

  it("a pool with live deployments refuses deletion; once stopped its history survives detached", async () => {
    const a = await arrangement();
    const { pools, recipes } = await routers(a);
    const s = await seed(a);
    await expect(pools.deleteModelPool({ id: s.pool.id })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "deployments_running" },
    });
    expect(await fixture.modelPool.count({ where: { id: s.pool.id } })).toBe(1);
    const other = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Other", slug: `other-${randomUUID()}` },
    });
    await expect(
      recipes.updateConfig({
        id: s.config.id,
        expectedRevision: 1,
        poolId: other.id,
        spec: {
          variants: [{ ...s.spec.variants[0]!, attachment: { type: "llm", poolId: other.id } }],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "deployments_running" } });

    await retire(s);
    expect(await pools.deleteModelPool({ id: s.pool.id })).toEqual({ deleted: true });
    const config = await fixture.deploymentConfig.findUniqueOrThrow({ where: { id: s.config.id } });
    expect(config.poolId).toBeNull();
    expect(await fixture.deploymentInstance.count({ where: { id: s.instance.id } })).toBe(1);
    expect(
      await fixture.deploymentStep.count({ where: { instanceId: s.instance.id } }),
    ).toBeGreaterThan(0);
    await expect(recipes.deleteConfig({ id: s.config.id })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "deployment_history" },
    });
  }, 60_000);

  it("inventories from 4096 other devices never evict a live device's dispatch readiness", async () => {
    const a = await arrangement();
    await a.reconciler.stop();
    const virtual = new Map<string, DeploymentLiveSocket>();
    const next = new DeploymentReconciler(
      {
        current: (id) =>
          id === a.deviceId ? a.manager.deploymentSocket(id) : (virtual.get(id) ?? null),
        send: (socket, job) => {
          a.jobs.push(job);
          return a.manager.sendDeploymentJob(socket, job);
        },
      },
      production,
    );
    cleanups.push(() => next.stop());
    a.manager.setDeploymentHandlers({
      inventory: (socket, items) => next.acceptInventory(socket, items),
      result: (socket, result) => next.acceptResult(socket, result),
    });
    const seeded = await seed(a);
    await a.snapshot();
    await until(async () => {
      await next.runOnce();
      return a.jobs.some((j) => j.action === "start");
    });
    // Secondary transports are synthetic; each commits a real inventory transaction, then leaves.
    const ids = Array.from({ length: 4096 }, () => randomUUID().replaceAll("-", ""));
    await fixture.cliDevice.createMany({
      data: ids.map((id) => ({
        id,
        userId: a.user.id,
        slug: `churn-${id}`,
        status: "CONNECTED" as const,
        connectionGeneration: 1,
      })),
    });
    for (const id of ids) {
      const socket = { userId: a.user.id, cliDeviceId: id, generation: 1, inventoryComplete: true };
      virtual.set(id, socket);
      expect(await next.acceptInventory(socket, [])).toBe(true);
      virtual.delete(id);
    }
    const actor = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const plan = await createDeploymentPlan(actor, { stopInstanceId: seeded.instance.id });
    await applyDeploymentPlan(actor, plan.id, true);
    const stop = await fixture.deploymentStep.findFirstOrThrow({
      where: { instanceId: seeded.instance.id, phase: "stop" },
    });
    await fixture.deploymentStep.update({
      where: { id: stop.id },
      data: { notBefore: new Date(0) },
    });
    // No fresh primary snapshot: its own committed inventory still authorizes dispatch.
    await until(async () => {
      await next.runOnce();
      return a.jobs.some((j) => j.action === "stop");
    });
    expect((await fixture.deploymentStep.findUniqueOrThrow({ where: { id: stop.id } })).state).toBe(
      "RUNNING",
    );
  }, 180_000);
  it("an unhealthy snapshot never turns an in-flight health success into a failure", async () => {
    const a = await arrangement();
    const s = await seed(a, {
      health: { intervalMs: 5000, failureThreshold: 1, successThreshold: 2 },
    });
    await publishManagedEndpoint(a, s);
    await startServing(a);
    const nextHealth = async () => {
      const previous = new Set(a.jobs.map((j) => j.stepId));
      await fixture.deploymentInstance.update({
        where: { id: s.instance.id },
        data: { lastHealthAt: new Date(Date.now() - 60_000) },
      });
      await a.tickUntil(() => a.jobs.some((j) => j.action === "health" && !previous.has(j.stepId)));
      return a.jobs.find((j) => j.action === "health" && !previous.has(j.stepId))!;
    };
    await a.settle(await nextHealth(), false, "failed");
    expect((await servingState(s)).instance.observedState).toBe("UNHEALTHY");
    // First success below the success threshold: the CLI phase is still "unhealthy" and its
    // snapshot (naming this step) reaches the server before the result.
    const first = await nextHealth();
    await a.snapshot([observation(first, "unhealthy")]);
    await a.settle(first);
    expect(
      (await fixture.deploymentStep.findUniqueOrThrow({ where: { id: first.stepId } })).state,
    ).toBe("SUCCEEDED");
    expect((await servingState(s)).instance).toMatchObject({
      observedState: "UNHEALTHY",
      healthSuccesses: 1,
    });
    await a.settle(await nextHealth());
    expect((await servingState(s)).instance.observedState).toBe("RUNNING");
  }, 90_000);

  it("a reconnect snapshot settles a health result lost with the previous session", async () => {
    const a = await arrangement();
    const s = await seed(a, {
      health: { intervalMs: 5000, failureThreshold: 3, successThreshold: 1 },
    });
    await publishManagedEndpoint(a, s);
    await startServing(a);
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { lastHealthAt: new Date(Date.now() - 60_000) },
    });
    await a.tickUntil(() => a.jobs.some((j) => j.action === "health"));
    const health = a.jobs.find((j) => j.action === "health")!;
    // The result never arrives: a successor connection reports the threshold crossing.
    const successor = await a.connect();
    await a.snapshot([observation(health, "unhealthy")], successor);
    const step = await fixture.deploymentStep.findUniqueOrThrow({ where: { id: health.stepId } });
    expect([step.state, step.errorCode]).toEqual(["FAILED", "result_lost"]);
    expect((await servingState(s)).instance).toEqual({
      observedState: "UNHEALTHY",
      healthFailures: 3,
      healthSuccesses: 0,
    });
  }, 90_000);

  it("an unclaimed restart-pending instance settles STOPPED and its owner can stop it to free the pool", async () => {
    const a = await arrangement();
    const { pools } = await routers(a);
    const s = await seed(a, { stopped: true });
    // The node is offline past the grace period while the restart waits.
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: { lastHeartbeatAt: new Date(Date.now() - 120_000) },
    });
    await fixture.$executeRaw`UPDATE deployment_instance SET "updatedAt" = now() - interval '2 minutes' WHERE id = ${s.instance.id}`;
    await a.reconciler.runOnce();
    const offline = await fixture.deploymentInstance.findUniqueOrThrow({
      where: { id: s.instance.id },
    });
    expect([offline.desiredState, offline.observedState]).toEqual(["RUNNING", "STOPPED"]);
    // A row left STOP_PENDING without claims by older code is repaired by maintenance.
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { observedState: "STOP_PENDING", nextRestartAt: new Date(Date.now() + 600_000) },
    });
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: { lastHeartbeatAt: new Date() },
    });
    await until(async () => {
      await a.reconciler.runOnce();
      return (
        (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
          .observedState === "STOPPED"
      );
    });
    await expect(pools.deleteModelPool({ id: s.pool.id })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "deployments_running" },
    });
    const actor = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const plan = await createDeploymentPlan(actor, { stopInstanceId: s.instance.id });
    expect(plan.contents).toMatchObject({
      stopIds: [s.instance.id],
      affectedNodeIds: [],
    });
    await applyDeploymentPlan(actor, plan.id, true);
    await until(async () => {
      await a.reconciler.runOnce();
      const row = await fixture.deploymentInstance.findUniqueOrThrow({
        where: { id: s.instance.id },
      });
      return row.desiredState === "STOPPED" && row.observedState === "STOPPED";
    });
    expect(await pools.deleteModelPool({ id: s.pool.id })).toEqual({ deleted: true });
    expect(
      (await fixture.deploymentConfig.findUniqueOrThrow({ where: { id: s.config.id } })).poolId,
    ).toBeNull();
  }, 90_000);

  it("dispatch readiness belongs to the generation that committed the inventory", async () => {
    const a = await arrangement();
    await a.snapshot();
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(true);
    const generation = a.manager.deploymentSocket(a.deviceId)!.generation;
    // A detached registration settles a newer generation onto the live session in place.
    const internals = a.manager as unknown as {
      settleDetachedRegistration(id: string, now: Date, generation: number): Promise<void>;
    };
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: { connectionGeneration: generation + 1 },
    });
    await internals.settleDetachedRegistration(a.deviceId, new Date(), generation + 1);
    expect(a.manager.deploymentSocket(a.deviceId)).toMatchObject({
      generation: generation + 1,
      inventoryComplete: false,
    });
    await a.snapshot();
    expect(a.manager.deploymentSocket(a.deviceId)?.inventoryComplete).toBe(true);
  }, 60_000);
  it("an agent cancelling a pending restart obeys every rank node's command mode", async () => {
    const a = await arrangement();
    const s = await seed(a, { stopped: true });
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { startedBy: "AGENT" },
    });
    const agent = { userId: a.user.id, id: `agent-${randomUUID()}`, kind: "AGENT" as const };
    const human = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const mode = (value: "OFF" | "SUPERVISED") =>
      fixture.cliDevice.update({
        where: { id: a.deviceId },
        data: { mcpCommandMode: value, reportedMcpCommandMode: value },
      });
    await mode("OFF");
    await expect(createDeploymentPlan(agent, { stopInstanceId: s.instance.id })).rejects.toThrow(
      /off on an affected node/,
    );
    await mode("SUPERVISED");
    const plan = await createDeploymentPlan(agent, { stopInstanceId: s.instance.id });
    expect(plan.contents).toMatchObject({
      affectedNodeIds: [],
      effectiveMode: "SUPERVISED",
      requiresConfirmation: true,
    });
    expect(plan.state).toBe("AWAITING_CONFIRMATION");
    expect(await applyDeploymentPlan(agent, plan.id, false)).toMatchObject({
      status: "awaiting_confirmation",
    });
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .desiredState,
    ).toBe("RUNNING");
    await applyDeploymentPlan(human, plan.id, true);
    expect(
      (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
        .desiredState,
    ).toBe("STOPPED");
  }, 60_000);
  it("the owner can cancel a pending restart on a node whose deployment grant was revoked", async () => {
    const a = await arrangement();
    const { pools } = await routers(a);
    const s = await seed(a, { stopped: true });
    // The grant revocation is exactly why the restart cannot proceed.
    await fixture.cliDevice.update({
      where: { id: a.deviceId },
      data: { allowDeployments: false },
    });
    const owner = { userId: a.user.id, id: a.user.id, kind: "USER" as const };
    const plan = await createDeploymentPlan(owner, { stopInstanceId: s.instance.id });
    expect(plan.contents).toMatchObject({ affectedNodeIds: [], requiresConfirmation: true });
    await applyDeploymentPlan(owner, plan.id, true);
    await until(async () => {
      await a.reconciler.runOnce();
      return (
        (await fixture.deploymentInstance.findUniqueOrThrow({ where: { id: s.instance.id } }))
          .observedState === "STOPPED"
      );
    });
    expect(await pools.deleteModelPool({ id: s.pool.id })).toEqual({ deleted: true });
  }, 60_000);

  async function actors(a: Awaited<ReturnType<typeof arrangement>>) {
    const { createRouterClient } = await import("@orpc/server");
    const { appRouter } = await import("@ws-model-proxy/api/routers/index");
    const { createMcpContext, createMcpSyntheticSession } = await import("../mcp/context.js");
    const user = await fixture.user.findUniqueOrThrow({ where: { id: a.user.id } });
    const now = new Date();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const agentContext = createMcpContext({ user: user as never, expiresAt, now, services: {} });
    const humanContext = {
      session: createMcpSyntheticSession({ user: user as never, expiresAt, now }),
      services: {},
    };
    return {
      agentContext,
      humanContext,
      agent: createRouterClient(appRouter, { context: agentContext }),
      human: createRouterClient(appRouter, { context: humanContext }),
    };
  }
  async function errorCode(promise: Promise<unknown>) {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "?";
    }
  }
  async function commandModes(deviceId: string, mode: "OFF" | "SUPERVISED" | "UNSUPERVISED") {
    await fixture.cliDevice.update({
      where: { id: deviceId },
      data: { mcpCommandMode: mode, reportedMcpCommandMode: mode },
    });
  }
  const openAiCaps = {
    version: 1,
    protocol: "openai-compatible",
    chatCompletions: { supported: true, streaming: true },
  };
  function managedEndpoint(s: Awaited<ReturnType<typeof seed>>, model: string) {
    return {
      slug: s.instance.endpointSlug,
      label: s.instance.endpointSlug,
      kind: "openai-compatible",
      status: "online",
      deploymentInstanceId: s.instance.id,
      defaultCapabilities: openAiCaps,
      models: [{ upstreamModelId: model }],
    };
  }
  const plainEndpoint = {
    slug: "plain-ep",
    label: "plain",
    kind: "openai-compatible",
    status: "online",
    defaultCapabilities: openAiCaps,
    models: [{ upstreamModelId: "plain-model" }],
  };

  it("refuses a recipe model id the relay would normalize, and matches a stored padded id in its normalized form", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const { human } = await actors(a);
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Padded", slug: `padded-${randomUUID()}` },
    });
    const padded = recipeSpec(pool.id) as unknown as { variants: Array<{ models: string[] }> };
    padded.variants[0]!.models = ["pad-model "];
    expect(
      await errorCode(
        human.deployments.createConfig({
          slug: "padded",
          name: "Padded",
          poolId: pool.id,
          spec: padded as never,
        }),
      ),
    ).toBe("BAD_REQUEST");

    // A revision stored before the rule still registers under the relay's trimmed id.
    const s = await seed(a, { models: ["pad-model "] });
    await a.frame({
      type: "inventory.update",
      id: "padded",
      endpoints: [managedEndpoint(s, "pad-model "), plainEndpoint],
    });
    await until(() => a.frames.some((f) => f.type === "inventory.ok" && f.id === "padded"));
    const managed = await fixture.endpoint.findFirstOrThrow({
      where: { userId: a.user.id, slug: s.instance.endpointSlug },
    });
    // Registered against its instance (publication waits for the instance to run).
    expect(managed.deploymentInstanceId).toBe(s.instance.id);
  }, 60_000);

  it("leaves out only a managed endpoint whose model identity is wrong, so the device stays connected", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const s = await seed(a);
    await a.frame({
      type: "inventory.update",
      id: "wrong-model",
      endpoints: [managedEndpoint(s, "not-the-recipe-model"), plainEndpoint],
    });
    await until(() =>
      a.frames.some(
        (f) =>
          (f.type === "inventory.ok" || f.type === "inventory.error") && f.id === "wrong-model",
      ),
    );
    expect(a.frames.find((f) => f.id === "wrong-model")?.type).toBe("inventory.ok");
    expect(
      await fixture.endpoint.count({
        where: { userId: a.user.id, slug: "plain-ep", published: true },
      }),
    ).toBe(1);
    expect(
      await fixture.endpoint.count({
        where: { userId: a.user.id, slug: s.instance.endpointSlug, published: true },
      }),
    ).toBe(0);

    // A reconnect whose hello carries the refused managed endpoint is admitted.
    a.client.terminate();
    await until(
      async () =>
        (await fixture.cliDevice.findUniqueOrThrow({ where: { id: a.deviceId } })).status !==
        "CONNECTED",
    );
    const second = await a.connect([managedEndpoint(s, "not-the-recipe-model"), plainEndpoint]);
    expect(second.readyState).toBe(WebSocket.OPEN);
    await until(
      async () =>
        (await fixture.cliDevice.findUniqueOrThrow({ where: { id: a.deviceId } })).status ===
        "CONNECTED",
    );
  }, 60_000);

  it("returns planner refusals and invalid text with their HTTP status, not 500", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const { RPCHandler } = await import("@orpc/server/fetch");
    const { appRouter } = await import("@ws-model-proxy/api/routers/index");
    const { agentContext, humanContext, human } = await actors(a);
    const handler = new RPCHandler(appRouter);
    async function status(path: string, input: unknown, context: unknown) {
      const result = await handler.handle(
        new Request(`http://fixture/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: context as never },
      );
      return result.response?.status;
    }
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Status", slug: `status-${randomUUID()}` },
    });
    await commandModes(a.deviceId, "OFF");
    const config = await human.deployments.createConfig({
      slug: "status",
      name: "Status",
      poolId: pool.id,
      spec: recipeSpec(pool.id) as never,
    });
    const revisionId = config.Revisions[0]?.id ?? "";
    expect(
      await status(
        "deployments/planStart",
        { revisionId, variantKey: "one", nodeIds: ["missing-node"], groupCount: 1 },
        humanContext,
      ),
    ).toBe(400);
    expect(
      await status(
        "deployments/planStart",
        { revisionId, variantKey: "one", groupCount: 1 },
        agentContext,
      ),
    ).toBe(403);
    expect(
      await status(
        "deployments/createConfig",
        { slug: "nul", name: "n\u0000", poolId: pool.id, spec: recipeSpec(pool.id) },
        humanContext,
      ),
    ).toBe(400);
  }, 60_000);

  it("refuses hidden command text from an agent, and a person reviews an agent-edited revision before starting it", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const { agent, human } = await actors(a);
    await commandModes(a.deviceId, "SUPERVISED");
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Review", slug: `review-${randomUUID()}` },
    });
    const config = await human.deployments.createConfig({
      slug: "review",
      name: "Review",
      poolId: pool.id,
      spec: recipeSpec(pool.id) as never,
    });
    const withStart = (start: string) => {
      const spec = recipeSpec(pool.id) as unknown as {
        variants: Array<{ commands: Array<{ start: string }> }>;
      };
      spec.variants[0]!.commands[0]!.start = start;
      return spec as never;
    };
    expect(
      await errorCode(
        agent.deployments.updateConfig({
          id: config.id,
          expectedRevision: 1,
          spec: withStart("serve #‮⁦ ;rm -rf ~/models⁩"),
        }),
      ),
    ).toBe("BAD_REQUEST");
    await agent.deployments.updateConfig({
      id: config.id,
      expectedRevision: 1,
      spec: withStart("serve --port {{port}}"),
    });
    const revision = await fixture.deploymentConfigRevision.findFirstOrThrow({
      where: { configId: config.id, revision: 2 },
    });
    expect(revision.editorKind).toBe("AGENT");
    const plan = await human.deployments.planStart({
      revisionId: revision.id,
      variantKey: "one",
      groupCount: 1,
    });
    expect(plan.state).toBe("AWAITING_CONFIRMATION");
    const status = await human.deployments.planStatus({ id: plan.id });
    expect(status.preview.agentEdited).toBe(true);
  }, 60_000);

  it("returns a job the CLI never received to PENDING without counting an attempt", async () => {
    const a = await arrangement();
    // Inventory is complete, then the real reconciler stops before any step exists.
    await a.snapshot([]);
    await a.reconciler.stop();
    const s = await seed(a);
    const sends: string[] = [];
    const refusing = new DeploymentReconciler(
      {
        current: (id) => a.manager.deploymentSocket(id),
        send: (_, job) => {
          sends.push(job.stepId);
          return false;
        },
      },
      production,
    );
    try {
      for (let k = 0; k < 3; k++) await refusing.runOnce();
      // It was dispatched (and refused); the release below is what matters.
      expect(sends.length).toBeGreaterThanOrEqual(1);
      const start = await fixture.deploymentStep.findFirstOrThrow({
        where: { instanceId: s.instance.id, phase: "start" },
      });
      expect(start).toMatchObject({ state: "PENDING", ownerEpoch: null, attempts: 0 });
      const instance = await fixture.deploymentInstance.findUniqueOrThrow({
        where: { id: s.instance.id },
      });
      expect(instance.restartAttempts).toBe(0);
    } finally {
      await refusing.stop();
    }
  }, 60_000);

  it("refuses revoking a node's deployment grant while an instance holds a claim there", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    await seed(a);
    const { human } = await actors(a);
    expect(
      await errorCode(human.deployments.setNodeGrant({ nodeId: a.deviceId, allow: false })),
    ).toBe("CONFLICT");
    expect(
      (await fixture.cliDevice.findUniqueOrThrow({ where: { id: a.deviceId } })).allowDeployments,
    ).toBe(true);
  }, 60_000);

  it("serves a revision stored before model ids were validated, under the relay's trimmed id", async () => {
    const a = await arrangement();
    const s = await seed(a, { models: ["pad-model "] });
    await a.frame({
      type: "inventory.update",
      id: "legacy-padded",
      endpoints: [managedEndpoint(s, "pad-model ")],
    });
    await startServing(a);
    const state = await servingState(s);
    expect(state.instance.observedState).toBe("RUNNING");
    expect(state.gate).toBe("OPEN");
    expect(state.endpoint.published).toBe(true);
  }, 60_000);

  it("a passing health check does not republish a managed endpoint whose inventory was refused", async () => {
    const a = await arrangement();
    const s = await seed(a, {
      health: { intervalMs: 5000, failureThreshold: 3, successThreshold: 1 },
    });
    await publishManagedEndpoint(a, s);
    await startServing(a);
    expect((await servingState(s)).endpoint.published).toBe(true);

    await a.frame({
      type: "inventory.update",
      id: "refused-later",
      endpoints: [managedEndpoint(s, "not-the-recipe-model")],
    });
    await until(() => a.frames.some((f) => f.type === "inventory.ok" && f.id === "refused-later"));
    await fixture.deploymentInstance.update({
      where: { id: s.instance.id },
      data: { lastHealthAt: new Date(Date.now() - 60_000) },
    });
    await a.tickUntil(() => a.jobs.some((j) => j.action === "health"));
    await a.settle(a.jobs.find((j) => j.action === "health")!);
    const refused = await fixture.endpoint.findFirstOrThrow({
      where: { deploymentInstanceId: s.instance.id },
    });
    expect(refused).toMatchObject({
      published: false,
      failureReasonCode: "managed_identity_refused",
    });

    // Reporting the recipe's identity again clears the mark.
    await publishManagedEndpoint(a, s);
    expect(
      (await fixture.endpoint.findUniqueOrThrow({ where: { id: refused.id } })).failureReasonCode,
    ).toBeNull();
  }, 60_000);

  it("keeps agent-written commands under review after a person re-saves the recipe, even once agent commands are off", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const { agent, human } = await actors(a);
    await commandModes(a.deviceId, "SUPERVISED");
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Resave", slug: `resave-${randomUUID()}` },
    });
    const config = await human.deployments.createConfig({
      slug: "resave",
      name: "Resave",
      poolId: pool.id,
      spec: recipeSpec(pool.id) as never,
    });
    const agentSpec = recipeSpec(pool.id) as unknown as {
      variants: Array<{ commands: Array<{ start: string }> }>;
    };
    agentSpec.variants[0]!.commands[0]!.start = "serve --port {{port}} --agent";
    await agent.deployments.updateConfig({
      id: config.id,
      expectedRevision: 1,
      spec: agentSpec as never,
    });
    // A person renames it, keeping the agent's commands.
    await human.deployments.updateConfig({
      id: config.id,
      expectedRevision: 2,
      name: "Renamed",
      spec: agentSpec as never,
    });
    const revision = await fixture.deploymentConfigRevision.findFirstOrThrow({
      where: { configId: config.id, revision: 3 },
    });
    expect(revision.editorKind).toBe("USER");
    const plan = await human.deployments.planStart({
      revisionId: revision.id,
      variantKey: "one",
      groupCount: 1,
    });
    expect(plan.state).toBe("AWAITING_CONFIRMATION");
    expect((await human.deployments.planStatus({ id: plan.id })).preview.agentEdited).toBe(true);

    // Agent commands turned off later: a person can still start it (after
    // review); MCP command modes govern agents, not the dashboard.
    await commandModes(a.deviceId, "OFF");
    const afterOff = await human.deployments.planStart({
      revisionId: revision.id,
      variantKey: "one",
      groupCount: 1,
    });
    expect(afterOff.state).toBe("AWAITING_CONFIRMATION");
  }, 60_000);

  it("refuses revoking a node's grant while a live instance has a rank there without a claim", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    // Claims released, restart pending: the instance is still live on this node.
    await seed(a, { stopped: true });
    const { human } = await actors(a);
    expect(
      await errorCode(human.deployments.setNodeGrant({ nodeId: a.deviceId, allow: false })),
    ).toBe("CONFLICT");
  }, 60_000);

  it("keeps agent-written commands under review when a person edits a different command field", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const { agent, human } = await actors(a);
    await commandModes(a.deviceId, "SUPERVISED");
    const pool = await fixture.modelPool.create({
      data: { userId: a.user.id, name: "Partial", slug: `partial-${randomUUID()}` },
    });
    const config = await human.deployments.createConfig({
      slug: "partial",
      name: "Partial",
      poolId: pool.id,
      spec: recipeSpec(pool.id) as never,
    });
    type Spec = { variants: Array<{ commands: Array<{ start: string; stop: string }> }> };
    const agentSpec = recipeSpec(pool.id) as unknown as Spec;
    agentSpec.variants[0]!.commands[0]!.stop = "agent-written-stop";
    await agent.deployments.updateConfig({
      id: config.id,
      expectedRevision: 1,
      spec: agentSpec as never,
    });
    // A person changes only `start`; the agent's `stop` text is kept.
    const humanSpec = structuredClone(agentSpec);
    humanSpec.variants[0]!.commands[0]!.start = "serve --port {{port}} --edited";
    await human.deployments.updateConfig({
      id: config.id,
      expectedRevision: 2,
      spec: humanSpec as never,
    });
    const revision = await fixture.deploymentConfigRevision.findFirstOrThrow({
      where: { configId: config.id, revision: 3 },
    });
    const plan = await human.deployments.planStart({
      revisionId: revision.id,
      variantKey: "one",
      groupCount: 1,
    });
    expect(plan.state).toBe("AWAITING_CONFIRMATION");
    expect((await human.deployments.planStatus({ id: plan.id })).preview.agentEdited).toBe(true);
  }, 60_000);

  it("lets a person stop an agent-written deployment from the dashboard once agent commands are off", async () => {
    const a = await arrangement();
    await a.snapshot([]);
    const s = await seed(a, { editorKind: "AGENT" });
    const { agent, human } = await actors(a);
    await commandModes(a.deviceId, "OFF");
    // The agent may not, the person may.
    expect(await errorCode(agent.deployments.planStop({ instanceId: s.instance.id }))).toBe(
      "FORBIDDEN",
    );
    const plan = await human.deployments.planStop({ instanceId: s.instance.id });
    expect((await human.deployments.planStatus({ id: plan.id })).preview.agentEdited).toBe(false);
    const applied = await human.deployments.confirmPlan({ planId: plan.id });
    expect(applied).toBeTruthy();
    const stop = await fixture.deploymentStep.findFirstOrThrow({
      where: { instanceId: s.instance.id, phase: "stop" },
    });
    expect(stop.state).toBe("PENDING");
  }, 60_000);
});

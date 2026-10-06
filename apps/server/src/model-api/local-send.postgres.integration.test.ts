import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { LocalSendBinding } from "./local-send.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL fixture required");
const integration = databaseUrl ? describe : describe.skip;
type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Boundary handshake timed out");
}

integration("local permission acceptance on PostgreSQL and real WebSocket", () => {
  let fixture: Client;
  let strict: Client;
  let writer: Client;
  let send: typeof import("./local-send.js").startAuthorizedLocalRelayAttempt;
  let order: typeof import("@ws-model-proxy/db/capacity-lock-order");
  let Manager: typeof import("../relay/session-manager.js").RelaySessionManager;
  let helloIdentity: typeof import("../relay/hello-identity.js").generateTestHelloIdentity;
  let protocol: typeof import("../relay/protocol.js");
  const users: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "local-send-fixture-secret-not-production";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const factory = await import("@ws-model-proxy/db/client-factory");
    fixture = (await import("@ws-model-proxy/db/test-fixture-client")).createFixturePrismaClient(
      databaseUrl,
    );
    strict = factory.createPrismaClient(databaseUrl);
    writer = factory.createPrismaClient(databaseUrl);
    ({ startAuthorizedLocalRelayAttempt: send } = await import("./local-send.js"));
    order = await import("@ws-model-proxy/db/capacity-lock-order");
    ({ RelaySessionManager: Manager } = await import("../relay/session-manager.js"));
    ({ generateTestHelloIdentity: helloIdentity } = await import("../relay/hello-identity.js"));
    protocol = await import("../relay/protocol.js");
  });
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    // Scoped synthetic fixture cleanup only. No operating-system jobs exist.
    await fixture.capacityLease.updateMany({
      where: { userId: { in: users }, state: "ACTIVE" },
      data: { state: "RELEASED", releasedAt: new Date() },
    });
    await fixture.admissionRequest.updateMany({
      where: { userId: { in: users }, state: "WAITING" },
      data: { state: "CANCELLED" },
    });
    const { purgeDeletedUserHistory } = await import("@ws-model-proxy/db/hot-path-sweeps");
    for (const id of users) {
      await purgeDeletedUserHistory(strict, id);
      await fixture.user.delete({ where: { id } });
    }
    process.stdout.write(JSON.stringify({ independentSiblingCleanup: users }) + "\n");
    await Promise.all([fixture?.$disconnect(), strict?.$disconnect(), writer?.$disconnect()]);
  });
  async function user() {
    const id = randomUUID();
    const row = await fixture.user.create({
      data: { name: "send-boundary", email: `${id}@example.test`, slug: `s-${id}` },
    });
    users.push(row.id);
    return row;
  }
  async function arrangement(
    existingContributor?: Awaited<ReturnType<typeof user>>,
    cliSlug = "node",
  ) {
    const contributor = existingContributor ?? (await user());
    const endpointSlug = `${cliSlug}-inference`;
    const owner = await user();
    const token = await fixture.cliToken.create({
      data: {
        userId: contributor.id,
        name: "test",
        lookupPrefix: randomUUID(),
        secretDigest: randomUUID(),
      },
    });
    const manager = new Manager();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const queued: string[] = [];
    const frames: Record<string, unknown>[] = [];
    const registration = deferred();
    let serverSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      serverSocket = socket;
      const realSend = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const value = JSON.parse(data) as { type: string };
          if (value.type === "relay.request") queued.push("enqueue");
        }
        return realSend(data);
      };
      socket.on("message", (data, binary) => {
        const work = binary
          ? manager.handleBinaryFrame(socket, new Uint8Array(data as Buffer).buffer)
          : manager.handleTextFrame(socket, data.toString());
        void Promise.resolve(work).then(() => {
          if (manager.getActiveCliDeviceIds().length) registration.resolve();
        });
      });
      manager.acceptAuthenticatedSocket({
        socket,
        identity: {
          kind: "cliToken",
          id: token.id,
          userId: contributor.id,
          lookupPrefix: token.lookupPrefix,
          cliDeviceId: null,
        },
      });
    });
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const identity = helloIdentity();
    client.on("message", (data, binary) => {
      if (binary) return;
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "hello.challenge")
        client.send(
          JSON.stringify({
            type: "hello",
            id: "send-hello",
            protocolVersion: protocol.RELAY_PROTOCOL_VERSIONS[0],
            cli: {
              slug: cliSlug,
              hostname: "fixture",
              identityPublicKey: identity.publicKey,
              identitySignature: identity.sign(String(frame.nonce), cliSlug, String(frame.origin)),
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
                },
              },
            },
            endpoints: [
              {
                slug: endpointSlug,
                label: "inference",
                kind: "openai-compatible",
                status: "online",
                defaultCapabilities: {
                  version: 1,
                  protocol: "openai-compatible",
                  chatCompletions: { supported: true, streaming: true },
                  embeddings: { supported: true },
                },
                models: [{ slug: "send-fixture-model", upstreamModelId: "send-fixture-model" }],
              },
            ],
          }),
        );
    });
    cleanups.push(async () => {
      client.terminate();
      serverSocket?.terminate();
      manager.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await Promise.race([
      registration.promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Registration failed: ${JSON.stringify(frames)}`)),
          3_000,
        ),
      ),
    ]);
    const deviceId = manager.getActiveCliDeviceIds()[0]!;
    const endpoint = await fixture.endpoint.findFirstOrThrow({
      where: { cliDeviceId: deviceId, slug: endpointSlug },
    });
    const model = await fixture.discoveredModel.findFirstOrThrow({
      where: { endpointId: endpoint.id },
    });
    await fixture.endpoint.update({ where: { id: endpoint.id }, data: { published: true } });
    await fixture.discoveredModel.update({ where: { id: model.id }, data: { published: true } });
    const target = await fixture.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    const pool = await fixture.modelPool.create({
      data: { userId: owner.id, slug: "pool", name: "pool" },
    });
    const consent = await fixture.inferenceContribution.create({
      data: {
        poolId: pool.id,
        poolOwnerUserId: owner.id,
        contributorUserId: contributor.id,
        discoveredModelId: model.id,
        expiresAt: new Date(Date.now() + 60_000),
        state: "PENDING",
      },
    });
    await fixture.inferenceContribution.update({
      where: { id: consent.id },
      data: { state: "ACTIVE", acceptedAt: new Date() },
    });
    const member = await fixture.poolMember.create({
      data: {
        poolId: pool.id,
        discoveredModelId: model.id,
        executionTargetId: target.id,
        inferenceContributionId: consent.id,
      },
    });
    const binding: LocalSendBinding = {
      requesterUserId: owner.id,
      engineOwnerUserId: contributor.id,
      discoveredModelId: model.id,
      executionTargetId: target.id,
      capacityId: target.inferenceCapacityId,
      endpointId: endpoint.id,
      cliDeviceId: deviceId,
      endpointSlug: endpoint.slug,
      upstreamModelId: model.upstreamModelId,
      pool: {
        id: pool.id,
        ownerUserId: owner.id,
        accessGrantId: null,
        memberId: member.id,
        contributionId: consent.id,
      },
    };
    function args() {
      return {
        manager,
        cliDeviceId: deviceId,
        endpointSlug: endpoint.slug,
        family: "chat.completions" as const,
        method: "POST",
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode("{}"),
        timeoutMs: 5_000,
      };
    }
    async function revoke() {
      await writer.$transaction(async (tx) => {
        await order.fenceOwners(tx, [contributor.id, owner.id]);
        await order.acquireFences(tx, [
          order.fences.capacityPolicy(target.id),
          order.fences.capacity(target.inferenceCapacityId!),
        ]);
        await tx.inferenceContribution.update({
          where: { id: consent.id },
          data: { state: "REVOKED", revokedAt: new Date() },
        });
        await tx.poolMember.delete({ where: { id: member.id } });
      });
      queued.push("revoked");
    }
    function respond(requestId: string) {
      client.send(
        JSON.stringify({
          type: "relay.response.headers",
          requestId,
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      client.send(
        protocol.encodeRelayBinaryFrame(
          { type: "relay.response.body", requestId, chunkId: "0" },
          new TextEncoder().encode(
            JSON.stringify({
              choices: [{ message: { content: "pong" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          ),
        ),
      );
      client.send(
        JSON.stringify({
          type: "relay.complete",
          requestId,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }),
      );
    }
    return {
      contributor,
      owner,
      model,
      target,
      pool,
      member,
      consent,
      manager,
      queued,
      frames,
      binding,
      args,
      revoke,
      respond,
      client,
    };
  }

  it.each(["capacity", "receipt"] as const)(
    "cache lifecycle separate OS: %s failure and observer loss fence remote warmth",
    async (failure) => {
      const a = await arrangement(undefined, "independent-parent");
      await fixture.inferenceCapacity.update({
        where: { id: a.target.inferenceCapacityId! },
        data: {
          runtimeIdentityKey: "core-shared-physical-engine",
          runtimeModel: "send-fixture-model",
          cacheNamespace: "core-shared-prefix-cache",
        },
      });
      const child = fork(
        fileURLToPath(new URL("./cache-affinity-observer-process.test-helper.ts", import.meta.url)),
        [
          JSON.stringify({
            contributorId: a.contributor.id,
            capacityId: a.target.inferenceCapacityId,
          }),
        ],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      child.stdout?.on("data", (data) => process.stdout.write(data));
      child.stderr?.on("data", (data) => process.stderr.write(data));
      const messages: Record<string, unknown>[] = [];
      child.on("message", (msg) => messages.push(msg as Record<string, unknown>));
      const childExit = new Promise<number | null>((resolve) => child.once("exit", resolve));
      try {
        await until(() => messages.some((m) => m.type === "ready"));
        const signal = (counterEpoch: number) =>
          a.client.send(
            JSON.stringify({
              type: "endpoint.load",
              endpointSlug: a.binding.endpointSlug,
              counterEpoch,
              running: 0,
              source: "custom",
              ts: new Date().toISOString(),
            }),
          );
        signal(1);
        await until(
          async () =>
            (await fixture.endpoint.findUniqueOrThrow({ where: { id: a.binding.endpointId } }))
              .loadCounterEpoch === 1,
        );
        const held = deferred(),
          release = deferred();
        const blocker = writer.$transaction(
          async (tx) => {
            if (failure === "capacity")
              await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id=${a.target.inferenceCapacityId} FOR UPDATE`;
            else
              await tx.$queryRaw`SELECT "capacityId" FROM cache_affinity_observer WHERE "cliDeviceId" = ${a.binding.cliDeviceId} FOR UPDATE`;
            held.resolve();
            await release.promise;
          },
          { timeout: 15000 },
        );
        await held.promise;
        try {
          signal(2);
          await until(
            () =>
              (a.manager as unknown as { pendingAffinityResets: Map<string, unknown> })
                .pendingAffinityResets.size === 1,
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
          expect(
            (await fixture.endpoint.findUniqueOrThrow({ where: { id: a.binding.endpointId } }))
              .loadCounterEpoch,
          ).toBe(1);
          a.manager.dispose();
          a.client.terminate();
          release.resolve();
          await blocker;
          await new Promise((resolve) => setTimeout(resolve, failure === "receipt" ? 2600 : 1200));
          expect(
            (await fixture.endpoint.findUniqueOrThrow({ where: { id: a.binding.endpointId } }))
              .loadCounterEpoch,
          ).toBe(1);
          child.send({ type: "probe" });
          await until(() => messages.some((m) => m.type === "result"));
          const result = messages.find((m) => m.type === "result")!;
          process.stdout.write(
            JSON.stringify({
              independentSeparateProcess: {
                parentPid: process.pid,
                observerCli: a.binding.cliDeviceId,
                capacity: a.target.inferenceCapacityId,
                messages,
              },
            }) + "\n",
          );
          expect(result.actualAuthorizedSend).toBe(true);
          expect(result.before).toBeGreaterThan(0);
          expect(result.staleRejected).toBe(true);
          expect(result.fresh).toBeGreaterThan(0);
          expect(result.after, "remote eligible same physical-cache sibling must remain cold").toBe(
            0,
          );
        } finally {
          release.resolve();
          await blocker;
        }
      } finally {
        if (child.connected) child.send({ type: "cleanup" });
        await childExit;
      }
    },
    30000,
  );

  it.each(["a key never seen before", "an existing key"])(
    "a signed reset on %s with 1000 load keys invalidates the shared physical cache",
    async (which) => {
      const a = await arrangement(undefined, "cap-reset-observer");
      // An explicit alias of the same physical runtime/model/cache shares the reset fence.
      await fixture.inferenceCapacity.update({
        where: { id: a.target.inferenceCapacityId! },
        data: {
          runtimeIdentityKey: "cap-reset-shared-physical-engine",
          runtimeModel: "send-fixture-model",
          cacheNamespace: "cap-reset-shared-prefix-cache",
        },
      });
      const child = fork(
        fileURLToPath(new URL("./cache-affinity-observer-process.test-helper.ts", import.meta.url)),
        [
          JSON.stringify({
            contributorId: a.contributor.id,
            capacityId: a.target.inferenceCapacityId,
            quiet: true,
          }),
        ],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      child.stdout?.on("data", (data) => process.stdout.write(data));
      child.stderr?.on("data", (data) => process.stderr.write(data));
      const messages: Record<string, unknown>[] = [];
      child.on("message", (message) => messages.push(message as Record<string, unknown>));
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const signal = (modelSlug: string, counterEpoch: number) =>
        a.client.send(
          JSON.stringify({
            type: "endpoint.load",
            endpointSlug: a.binding.endpointSlug,
            modelSlug,
            counterEpoch,
            running: 0,
            source: "custom",
            ts: new Date().toISOString(),
          }),
        );
      const session = () =>
        (
          a.manager as unknown as {
            sessionsByCliDeviceId: Map<string, { endpointLoad: Map<string, unknown> }>;
          }
        ).sessionsByCliDeviceId.get(a.binding.cliDeviceId)!;
      try {
        await until(() => messages.some((message) => message.type === "ready"));
        signal("first", 1);
        await until(
          async () =>
            (await fixture.endpoint.findUniqueOrThrow({ where: { id: a.binding.endpointId } }))
              .loadCounterEpoch === 1,
        );
        for (let index = 1; index < 1000; index++) signal(`key-${index}`, 1);
        await until(() => session().endpointLoad.size === 1000);
        signal(which === "an existing key" ? "first" : "never-seen-key", 2);
        await new Promise((resolve) => setTimeout(resolve, 2600));
        child.send({ type: "probe" });
        await until(() => messages.some((message) => message.type === "result"));
        const result = messages.find((message) => message.type === "result")!;
        expect(session().endpointLoad.size).toBe(1000);
        expect(
          (await fixture.endpoint.findUniqueOrThrow({ where: { id: a.binding.endpointId } }))
            .loadCounterEpoch,
        ).toBe(2);
        expect(result.actualAuthorizedSend).toBe(true);
        expect(result.before).toBeGreaterThan(0);
        expect(result.after).toBe(0);
        expect(result.staleRejected).toBe(true);
        expect(result.fresh).toBeGreaterThan(0);
      } finally {
        if (child.connected) child.send({ type: "cleanup" });
        await exited;
      }
    },
    30_000,
  );

  function barrierClient(identities: number) {
    const reached = deferred();
    const release = deferred();
    let reads = 0;
    // The real transaction and every query remain PostgreSQL-owned. Delay
    // only the continuation of its final locked account read, before enqueue.
    const db: Pick<Client, "$transaction"> = {
      $transaction: ((work: unknown, options?: unknown) => {
        if (typeof work !== "function") throw new Error("Expected callback transaction");
        return strict.$transaction(
          async (tx) =>
            work(
              new Proxy(tx, {
                get(target, key) {
                  if (key !== "user") return Reflect.get(target, key);
                  return new Proxy(target.user, {
                    get(delegate, method) {
                      if (method !== "findUnique") return Reflect.get(delegate, method);
                      return async (input: Parameters<typeof tx.user.findUnique>[0]) => {
                        const result = await tx.user.findUnique(input);
                        if (++reads === identities) {
                          reached.resolve();
                          await release.promise;
                        }
                        return result;
                      };
                    },
                  });
                },
              }),
            ),
          options as { timeout?: number },
        );
      }) as Client["$transaction"],
    };
    return { db, reached, release };
  }
  it("independent revoke waits at the permission mutex until real CONTROL enqueue", async () => {
    const f = await arrangement();
    const barrier = barrierClient(2);
    const pending = send(f.binding, f.args(), barrier.db);
    await barrier.reached.promise;
    let committed = false;
    const revoked = f.revoke().then(() => {
      committed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const committedBeforeAcceptance = committed;
    const queuedBeforeAcceptance = [...f.queued];
    barrier.release.resolve();
    const attempt = await pending;
    await revoked;
    if (committedBeforeAcceptance) attempt.cancel("cancelled");
    expect(committedBeforeAcceptance, "revoke must wait before CONTROL acceptance").toBe(false);
    expect(queuedBeforeAcceptance).toEqual([]);
    expect(f.queued).toEqual(["enqueue", "revoked"]);
    await until(() => f.frames.some((frame) => frame.type === "relay.request"));
    f.respond(attempt.requestId);
    expect(await (await attempt.started).body.getReader().read()).toMatchObject({ done: false });
    expect((await attempt.terminal).ok).toBe(true);
    await expect(send(f.binding, f.args(), strict)).rejects.toMatchObject({
      denial: "MEMBER_UNAVAILABLE",
    });
    expect(f.queued.filter((entry) => entry === "enqueue")).toHaveLength(1);
  }, 20_000);
  it("unfenced account ban UPDATE contends on user SHARE before real CONTROL", async () => {
    const f = await arrangement();
    const barrier = barrierClient(2);
    const pending = send(f.binding, f.args(), barrier.db);
    await barrier.reached.promise;
    let committed = false;
    const banned = writer.user
      .update({ where: { id: f.contributor.id }, data: { banned: true } })
      .then(() => {
        committed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const committedBeforeAcceptance = committed;
    barrier.release.resolve();
    const attempt = await pending;
    await banned;
    attempt.cancel("cancelled");
    expect(committedBeforeAcceptance, "unfenced ban must wait before CONTROL acceptance").toBe(
      false,
    );
    expect(f.queued).toEqual(["enqueue"]);
    await expect(send(f.binding, f.args(), strict)).rejects.toMatchObject({
      denial: "OWNER_INACTIVE",
    });
    expect(f.queued).toHaveLength(1);
  }, 20_000);
  it("committed revoke denies zero CONTROL and accepted slow body finishes outside DB locks", async () => {
    const revoked = await arrangement();
    await revoked.revoke();
    await expect(send(revoked.binding, revoked.args(), strict)).rejects.toMatchObject({
      denial: "MEMBER_UNAVAILABLE",
    });
    expect(revoked.queued).toEqual(["revoked"]);
    const f = await arrangement();
    const slowBody = deferred();
    const base = f.args();
    const attempt = await send(
      f.binding,
      {
        ...base,
        body: undefined,
        bodySource: {
          kind: "memory",
          size: 2,
          async *open() {
            await slowBody.promise;
            yield new TextEncoder().encode("{}");
          },
          async dispose() {},
        },
      },
      strict,
    );
    await until(() => f.frames.some((frame) => frame.type === "relay.request"));
    await f.revoke(); // Must complete while the accepted body remains parked.
    expect(f.queued).toEqual(["enqueue", "revoked"]);
    slowBody.resolve();
    f.respond(attempt.requestId);
    const response = await attempt.started;
    expect(await new Response(response.body).text()).toContain("pong");
    expect((await attempt.terminal).ok).toBe(true);
  }, 20_000);
  it("diagnostic owners share the original physical slot and revoked queued diagnostics send nothing", async () => {
    const f = await arrangement();
    await fixture.inferenceCapacity.update({
      where: { id: f.target.inferenceCapacityId! },
      data: { hardConcurrencyLimit: 1, hardConcurrencyLimitSource: "USER" },
    });
    const secondOwner = await user();
    const pool2 = await fixture.modelPool.create({
      data: { userId: secondOwner.id, slug: "pool2", name: "pool2" },
    });
    const consent2 = await fixture.inferenceContribution.create({
      data: {
        poolId: pool2.id,
        poolOwnerUserId: secondOwner.id,
        contributorUserId: f.contributor.id,
        discoveredModelId: f.model.id,
        expiresAt: new Date(Date.now() + 60_000),
        state: "PENDING",
      },
    });
    await fixture.inferenceContribution.update({
      where: { id: consent2.id },
      data: { state: "ACTIVE", acceptedAt: new Date() },
    });
    const member2 = await fixture.poolMember.create({
      data: {
        poolId: pool2.id,
        discoveredModelId: f.model.id,
        executionTargetId: f.target.id,
        inferenceContributionId: consent2.id,
      },
    });
    const { StoreCapacityAdmissionRuntime } = await import("./capacity/runtime.js");
    const { PostgresCapacityAdmissionStore } = await import("./capacity/postgres-store.js");
    const { runPoolMemberTest } = await import("./diagnostics.js");
    const runtime = new StoreCapacityAdmissionRuntime(new PostgresCapacityAdmissionStore(strict));
    try {
      const first = runPoolMemberTest({
        userId: f.owner.id,
        memberId: f.member.id,
        manager: f.manager,
        capacityRuntime: runtime,
      });
      await until(() => f.frames.filter((frame) => frame.type === "relay.request").length === 1);
      const second = runPoolMemberTest({
        userId: secondOwner.id,
        memberId: member2.id,
        manager: f.manager,
        capacityRuntime: runtime,
      });
      await until(
        async () =>
          (await fixture.capacityWaiter.count({
            where: { poolMemberId: member2.id, state: "WAITING" },
          })) === 1,
      );
      expect(
        await fixture.capacityLease.count({
          where: { capacityId: f.target.inferenceCapacityId!, state: "ACTIVE" },
        }),
      ).toBe(1);
      expect(f.queued).toEqual(["enqueue"]);
      const original = await fixture.capacityRuntime.findUniqueOrThrow({
        where: { capacityId: f.target.inferenceCapacityId! },
      });
      expect(original.userId).toBe(f.contributor.id);
      await writer.$transaction(async (tx) => {
        await order.fenceOwners(tx, [f.contributor.id, secondOwner.id]);
        await order.acquireFences(tx, [
          order.fences.capacityPolicy(f.target.id),
          order.fences.capacity(f.target.inferenceCapacityId!),
        ]);
        await tx.inferenceContribution.update({
          where: { id: consent2.id },
          data: { state: "REVOKED", revokedAt: new Date() },
        });
        await tx.poolMember.delete({ where: { id: member2.id } });
      });
      f.respond(String(f.frames.find((frame) => frame.type === "relay.request")!.requestId));
      expect((await first).outcome).toBe("ok");
      const usage = await fixture.relayRequest.findFirstOrThrow({
        where: { requestedModelPoolId: f.pool.id },
        orderBy: { createdAt: "desc" },
      });
      expect(usage).toMatchObject({
        status: "SUCCEEDED",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        usageKnown: true,
      });
      expect((await second).outcome).not.toBe("ok");
      expect(f.queued).toEqual(["enqueue"]);
      await until(
        async () =>
          (await fixture.capacityLease.count({
            where: { capacityId: f.target.inferenceCapacityId!, state: "ACTIVE" },
          })) === 0,
      );
      expect(
        await fixture.capacityWaiter.count({
          where: { poolMemberId: member2.id, state: "WAITING" },
        }),
      ).toBe(0);
      const denied = await runPoolMemberTest({
        userId: secondOwner.id,
        memberId: member2.id,
        manager: f.manager,
        capacityRuntime: runtime,
      });
      expect(denied.outcome).toBe("not-found");
      expect(f.queued).toEqual(["enqueue"]);
    } finally {
      await runtime.close();
    }
  }, 20_000);
  it("legitimate owner direct, countFirst and configured transformer use the same CONTROL boundary", async () => {
    const f = await arrangement();
    const direct = { ...f.binding, requesterUserId: f.contributor.id, pool: undefined };
    const attempt = await send(
      direct,
      { ...f.args(), countFirst: true, countCeiling: 100 },
      strict,
    );
    await until(() => f.frames.some((frame) => frame.type === "relay.request"));
    expect(f.frames.find((frame) => frame.type === "relay.request")).toMatchObject({
      countFirst: true,
      countCeiling: 100,
    });
    f.respond(attempt.requestId);
    await new Response((await attempt.started).body).text();
    expect((await attempt.terminal).ok).toBe(true);
    const pool = await fixture.modelPool.create({
      data: {
        userId: f.contributor.id,
        slug: "owned",
        name: "owned",
        transformerDiscoveredModelId: f.model.id,
      },
    });
    const transformer = await send(
      {
        ...direct,
        pool: {
          id: pool.id,
          ownerUserId: f.contributor.id,
          accessGrantId: null,
          memberId: null,
          transformer: true,
        },
      },
      f.args(),
      strict,
    );
    await until(() => f.frames.filter((frame) => frame.type === "relay.request").length === 2);
    f.respond(transformer.requestId);
    await new Response((await transformer.started).body).text();
    expect((await transformer.terminal).ok).toBe(true);
    expect(f.queued).toEqual(["enqueue", "enqueue"]);
    await fixture.modelPool.update({
      where: { id: pool.id },
      data: { transformerDiscoveredModelId: null },
    });
    await expect(
      send(
        {
          ...direct,
          pool: {
            id: pool.id,
            ownerUserId: f.contributor.id,
            accessGrantId: null,
            memberId: null,
            transformer: true,
          },
        },
        f.args(),
        strict,
      ),
    ).rejects.toMatchObject({ denial: "MEMBER_UNAVAILABLE" });
    expect(f.queued).toHaveLength(2);
  }, 20_000);
  it("lock contention is bounded and cancelled permission waits never enqueue", async () => {
    const f = await arrangement();
    const locked = deferred();
    const release = deferred();
    const blocker = writer.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${f.contributor.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 5_000 },
    );
    await locked.promise;
    const abort = new AbortController();
    const start = Date.now();
    const pending = send(f.binding, { ...f.args(), abortSignal: abort.signal }, strict);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ denial: "CHECK_FAILED" });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(f.queued).toEqual([]);
    release.resolve();
    await blocker;
    const next = await send(f.binding, f.args(), strict);
    next.cancel("cancelled");
    expect(f.queued).toEqual(["enqueue"]);
  }, 20_000);
  it("exact destination and contribution snapshots refuse retargeting the same member id", async () => {
    const f = await arrangement();
    await expect(
      send({ ...f.binding, endpointSlug: "changed" }, f.args(), strict),
    ).rejects.toMatchObject({ denial: "MEMBER_UNAVAILABLE" });
    await expect(
      send({ ...f.binding, executionTargetId: randomUUID() }, f.args(), strict),
    ).rejects.toMatchObject({ denial: "MEMBER_UNAVAILABLE" });
    await expect(
      send(
        { ...f.binding, pool: { ...f.binding.pool!, contributionId: randomUUID() } },
        f.args(),
        strict,
      ),
    ).rejects.toMatchObject({ denial: "MEMBER_UNAVAILABLE" });
    await expect(
      send(f.binding, { ...f.args(), endpointSlug: "another-endpoint" }, strict),
    ).rejects.toMatchObject({ denial: "MEMBER_UNAVAILABLE" });
    expect(f.queued).toEqual([]);
  }, 20_000);
  it("embedding-only member diagnostics use native vector inference without chat affinity", async () => {
    const f = await arrangement();
    const model = await fixture.discoveredModel.findUniqueOrThrow({ where: { id: f.model.id } });
    await fixture.endpoint.update({
      where: { id: model.endpointId },
      data: {
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          embeddings: { supported: true },
        },
        defaultCapabilities: ["EMBEDDING"],
      },
    });
    const { StoreCapacityAdmissionRuntime } = await import("./capacity/runtime.js");
    const { PostgresCapacityAdmissionStore } = await import("./capacity/postgres-store.js");
    const { runPoolMemberTest } = await import("./diagnostics.js");
    const runtime = new StoreCapacityAdmissionRuntime(new PostgresCapacityAdmissionStore(strict));
    try {
      const pending = runPoolMemberTest({
        userId: f.owner.id,
        memberId: f.member.id,
        manager: f.manager,
        capacityRuntime: runtime,
      });
      await until(() => f.frames.some((frame) => frame.type === "relay.request"));
      const frame = f.frames.find((entry) => entry.type === "relay.request")!;
      expect(frame).toMatchObject({ family: "embeddings", path: "/v1/embeddings" });
      expect(frame).not.toHaveProperty("countFirst");
      const requestId = String(frame.requestId);
      f.client.send(
        JSON.stringify({
          type: "relay.response.headers",
          requestId,
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      f.client.send(
        protocol.encodeRelayBinaryFrame(
          { type: "relay.response.body", requestId, chunkId: "0" },
          new TextEncoder().encode(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2], index: 0 }],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          ),
        ),
      );
      f.client.send(
        JSON.stringify({
          type: "relay.complete",
          requestId,
          usage: { promptTokens: 1, totalTokens: 1 },
        }),
      );
      expect((await pending).outcome).toBe("ok");
      expect(await fixture.cacheAffinityRecord.count({ where: { poolId: f.pool.id } })).toBe(0);
      expect(
        await fixture.capacityLease.count({
          where: { capacityId: f.target.inferenceCapacityId!, state: "ACTIVE" },
        }),
      ).toBe(0);
    } finally {
      await runtime.close();
    }
  }, 20_000);
  async function realtimeFixture() {
    const f = await arrangement();
    const { withAuthorizedLocalSend } = await import("./local-send.js");
    const { createRealtimeAuthorizer, realtimeLocalSendBinding } = await import(
      "./realtime/authorize.js"
    );
    const token = await fixture.modelApiToken.create({
      data: {
        userId: f.owner.id,
        name: "realtime",
        lookupPrefix: randomUUID(),
        secretDigest: randomUUID(),
        scopeMode: "ALLOWLIST",
      },
    });
    const candidate = {
      cliDeviceId: f.binding.cliDeviceId,
      endpointSlug: f.binding.endpointSlug,
      upstreamModel: f.binding.upstreamModelId,
      capabilities: null,
      deploymentManaged: true,
      memberId: f.member.id,
      route: {
        kind: "pool" as const,
        poolId: f.pool.id,
        poolMemberId: f.member.id,
        discoveredModelId: f.model.id,
        endpointId: f.binding.endpointId,
        executionTargetId: f.target.id,
        capacityId: f.target.inferenceCapacityId,
        ownerUserId: f.owner.id,
        engineOwnerUserId: f.contributor.id,
        accessGrantId: null,
        contributionId: f.consent.id,
      },
    };
    const requester = { tokenId: token.id, userId: f.owner.id };
    const authorize = createRealtimeAuthorizer(requester, (binding, send, options) =>
      withAuthorizedLocalSend(binding, send, { ...options, db: strict }),
    );
    const binding = realtimeLocalSendBinding(requester, candidate);
    if (!binding) throw new Error("no binding");
    return { f, token, candidate, authorize, binding };
  }

  it("live transcription opens take the same claim and allowlist check as HTTP sends", async () => {
    const { checkLocalSendPermission } = await import("./local-send.js");
    const { f, token, candidate, authorize, binding } = await realtimeFixture();
    const sent: string[] = [];
    const open = () => sent.push("open");
    const abort = () => sent.push("abort");
    // An ALLOWLIST token without an entry for this pool: refused, nothing sent.
    expect(await authorize(candidate, open, abort)).toEqual({ ok: false, denial: "access" });
    expect(await checkLocalSendPermission(binding, strict)).toBe("ACCESS_REVOKED");
    expect(sent).toEqual([]);
    await fixture.modelApiTokenAllowlistEntry.create({
      data: { modelApiTokenId: token.id, target: "MODEL_POOL", modelPoolId: f.pool.id },
    });
    expect(await authorize(candidate, open, abort)).toEqual({ ok: true });
    expect(sent).toEqual(["open"]);
    expect(await checkLocalSendPermission(binding, strict)).toBeNull();
    // A revoked token: the recheck and the next open are refused.
    await fixture.modelApiToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });
    expect(await checkLocalSendPermission(binding, strict)).toBe("ACCESS_REVOKED");
    expect(await authorize(candidate, open, abort)).toEqual({ ok: false, denial: "access" });
    expect(sent).toEqual(["open"]);
  }, 20_000);

  it("live transcription opens refuse a revoked member and a disconnected CLI", async () => {
    const { checkLocalSendPermission } = await import("./local-send.js");
    const disconnected = await realtimeFixture();
    await fixture.modelApiTokenAllowlistEntry.create({
      data: {
        modelApiTokenId: disconnected.token.id,
        target: "MODEL_POOL",
        modelPoolId: disconnected.f.pool.id,
      },
    });
    expect(await checkLocalSendPermission(disconnected.binding, strict)).toBeNull();
    await fixture.cliDevice.update({
      where: { id: disconnected.binding.cliDeviceId },
      data: { status: "DISCONNECTED" },
    });
    expect(await checkLocalSendPermission(disconnected.binding, strict)).toBe("MEMBER_UNAVAILABLE");
    const sent: string[] = [];
    expect(
      await disconnected.authorize(
        disconnected.candidate,
        () => sent.push("open"),
        () => sent.push("abort"),
      ),
    ).toEqual({ ok: false, denial: "member" });
    expect(sent).toEqual([]);

    const revoked = await realtimeFixture();
    await fixture.modelApiTokenAllowlistEntry.create({
      data: {
        modelApiTokenId: revoked.token.id,
        target: "MODEL_POOL",
        modelPoolId: revoked.f.pool.id,
      },
    });
    await revoked.f.revoke();
    expect(await checkLocalSendPermission(revoked.binding, strict)).toBe("MEMBER_UNAVAILABLE");
  }, 20_000);
});

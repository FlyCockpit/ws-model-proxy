import { afterAll, describe, expect, it } from "vitest";

/**
 * Real-PostgreSQL proof of the disconnect fence: a stale disconnect (one whose
 * device generation a later hello has superseded) must never re-impose the
 * pool-member circuit-open, including when its member write waits on a row
 * lock across the successor's commit (the statement-snapshot gap).
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("disconnect fence with real PostgreSQL", () => {
  const userIds: string[] = [];

  afterAll(async () => {
    if (!databaseUrl || userIds.length === 0) return;
    const { default: prisma } = await import("@ws-model-proxy/db");
    for (const id of userIds) await prisma.user.deleteMany({ where: { id } });
  });

  async function loadModules() {
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [{ default: prisma }, routing] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./model-pool-routing"),
    ]);
    return { prisma, routing };
  }

  /** One user with `devices` devices, each with one endpoint/model/pool member. */
  async function seed(tag: string, devices = 1) {
    const { prisma, routing } = await loadModules();
    const suffix = `${tag}-${crypto.randomUUID()}`;
    const user = await prisma.user.create({
      data: { name: "fence", email: `fence-${suffix}@example.test`, slug: `fence-${suffix}` },
    });
    userIds.push(user.id);
    const pool = await prisma.modelPool.create({
      data: { userId: user.id, slug: `pool-${suffix}`.slice(0, 60), name: "pool" },
    });
    const rows = [];
    for (let i = 0; i < devices; i++) {
      const device = await prisma.cliDevice.create({
        data: {
          userId: user.id,
          slug: `desk-${i}`,
          status: "CONNECTED",
          connectionGeneration: 1,
          lastHeartbeatAt: new Date(),
        },
      });
      const endpoint = await prisma.endpoint.create({
        data: {
          userId: user.id,
          cliDeviceId: device.id,
          slug: `ep-${i}`,
          label: "ep",
          status: "ONLINE",
        },
      });
      const model = await prisma.discoveredModel.create({
        data: {
          userId: user.id,
          endpointId: endpoint.id,
          upstreamModelId: "m",
          encodedModelId: "m",
        },
      });
      const member = await prisma.poolMember.create({
        data: { poolId: pool.id, discoveredModelId: model.id, healthStatus: "HEALTHY" },
      });
      rows.push({ device, member });
    }
    return { prisma, routing, rows };
  }

  it("applies a genuine disconnect to its own device only", async () => {
    const { prisma, routing, rows } = await seed("genuine", 2);
    const [a, b] = rows;
    const applied = await routing.disconnectCliDeviceAtGeneration({
      cliDeviceId: a?.device.id ?? "",
      generation: 1,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
    });
    expect(applied).toBe(true);
    const deviceA = await prisma.cliDevice.findUniqueOrThrow({ where: { id: a?.device.id } });
    const memberA = await prisma.poolMember.findUniqueOrThrow({ where: { id: a?.member.id } });
    expect(deviceA.status).toBe("DISCONNECTED");
    expect(memberA.healthStatus).toBe("UNHEALTHY");
    expect(memberA.lastFailureClass).toBe("WEBSOCKET_DISCONNECTED");
    // The other device's member stays untouched (cool-down is per device).
    const deviceB = await prisma.cliDevice.findUniqueOrThrow({ where: { id: b?.device.id } });
    const memberB = await prisma.poolMember.findUniqueOrThrow({ where: { id: b?.member.id } });
    expect(deviceB.status).toBe("CONNECTED");
    expect(memberB.healthStatus).toBe("HEALTHY");
  });

  it("refuses a stale disconnect once a successor generation committed", async () => {
    const { prisma, routing, rows } = await seed("sequential");
    const row = rows[0];
    await prisma.cliDevice.update({
      where: { id: row?.device.id },
      data: { connectionGeneration: { increment: 1 } },
    });
    const applied = await routing.disconnectCliDeviceAtGeneration({
      cliDeviceId: row?.device.id ?? "",
      generation: 1,
      cliStatus: "STALE",
      failureClass: "STALE_SESSION",
    });
    expect(applied).toBe(false);
    const device = await prisma.cliDevice.findUniqueOrThrow({ where: { id: row?.device.id } });
    const member = await prisma.poolMember.findUniqueOrThrow({ where: { id: row?.member.id } });
    expect(device.status).toBe("CONNECTED");
    expect(member.healthStatus).toBe("HEALTHY");
  });

  it("orders a successor's due-write after a disconnect whose member write waits on a row lock", async () => {
    const { prisma, routing, rows } = await seed("overlap");
    const row = rows[0];
    if (!row) throw new Error("seed");
    const memberId = row.member.id;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const lockedP = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another writer of the member row (a routing outcome, an admission
    // transaction) holds its row lock.
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe("SELECT id FROM pool_member WHERE id = $1 FOR UPDATE", memberId);
        locked();
        await gate;
        await tx.poolMember.update({ where: { id: memberId }, data: { lastRoutedAt: new Date() } });
      },
      { timeout: 20_000 },
    );
    await lockedP;

    const staleAt = new Date();
    let staleDone = false;
    const stale = routing
      .disconnectCliDeviceAtGeneration({
        cliDeviceId: row.device.id,
        generation: 1,
        cliStatus: "DISCONNECTED",
        failureClass: "WEBSOCKET_DISCONNECTED",
        now: staleAt,
      })
      .then((applied) => {
        staleDone = true;
        return applied;
      });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(staleDone).toBe(false);

    // The successor's registration bumps the generation. It must wait for the
    // stale transaction (device row lock held) instead of committing between
    // the stale device write and the stale member write.
    let successorDone = false;
    const successor = prisma.cliDevice
      .update({
        where: { id: row.device.id },
        data: { connectionGeneration: { increment: 1 }, status: "CONNECTED" },
      })
      .then(() => {
        successorDone = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(successorDone).toBe(false);

    release();
    await blocker;
    await expect(stale).resolves.toBe(true);
    await successor;

    const due = await routing.markPoolMembersDueAfterCliReconnect({
      cliDeviceId: row.device.id,
      now: new Date(),
    });
    const device = await prisma.cliDevice.findUniqueOrThrow({ where: { id: row.device.id } });
    const member = await prisma.poolMember.findUniqueOrThrow({ where: { id: memberId } });
    expect(device.status).toBe("CONNECTED");
    expect(device.connectionGeneration).toBe(2);
    expect(due).toBe(1);
    expect(member.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("preserves a running real-failure cooldown across disconnect and reconnect, and opens the rest", async () => {
    const { prisma, routing, rows } = await seed("provenance", 5);
    const now = new Date();
    const later = new Date(now.getTime() + 120_000);
    const past = new Date(now.getTime() - 5_000);
    // 0: real failure, cooldown running. 1: real failure, cooldown over.
    // 2: disconnect-class already. 3: healthy. 4: UNHEALTHY with no class recorded.
    const states = [
      { healthStatus: "UNHEALTHY", lastFailureClass: "RELAY_TIMEOUT", nextRetryAt: later },
      { healthStatus: "UNHEALTHY", lastFailureClass: "UPSTREAM_5XX", nextRetryAt: past },
      { healthStatus: "UNHEALTHY", lastFailureClass: "STALE_SESSION", nextRetryAt: later },
      { healthStatus: "HEALTHY", lastFailureClass: null, nextRetryAt: null },
      { healthStatus: "UNHEALTHY", lastFailureClass: null, nextRetryAt: later },
    ] as const;
    for (const [i, state] of states.entries())
      await prisma.poolMember.update({
        where: { id: rows[i]?.member.id },
        data: { ...state, consecutiveRetryableFailures: 5 },
      });
    for (const row of rows)
      await routing.disconnectCliDeviceAtGeneration({
        cliDeviceId: row.device.id,
        generation: 1,
        cliStatus: "DISCONNECTED",
        failureClass: "WEBSOCKET_DISCONNECTED",
        now,
      });
    // The reconnect due-write runs for every device.
    for (const row of rows)
      await routing.markPoolMembersDueAfterCliReconnect({ cliDeviceId: row.device.id, now });
    const after = await Promise.all(
      rows.map((row) => prisma.poolMember.findUniqueOrThrow({ where: { id: row.member.id } })),
    );
    // Real failure with a running cooldown: class and cooldown untouched.
    expect(after[0]?.lastFailureClass).toBe("RELAY_TIMEOUT");
    expect(after[0]?.nextRetryAt?.getTime()).toBe(later.getTime());
    // Every other shape was opened by the disconnect and is due at reconnect.
    for (const i of [1, 2, 3, 4]) {
      expect(after[i]?.healthStatus, `member ${i}`).toBe("UNHEALTHY");
      expect(after[i]?.lastFailureClass, `member ${i}`).toBe("WEBSOCKET_DISCONNECTED");
      expect(after[i]?.nextRetryAt?.getTime(), `member ${i}`).toBeLessThanOrEqual(now.getTime());
    }
  });
});

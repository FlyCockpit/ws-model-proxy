import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  encryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import { poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PRIORITY_CLASS_COUNT, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";
import type { AdmissionAttempt, CapacityLeaseHandle } from "./types.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;
const workerPath = fileURLToPath(new URL("./postgres-process-worker.ts", import.meta.url));

type SerializableLease = Omit<CapacityLeaseHandle, "fencingToken" | "expiresAt"> & {
  fencingToken: string;
  expiresAt: string;
};
type WorkerResult =
  | { state: "WAITING" | "CANCELLED" | "EXPIRED"; requestId?: string }
  | { state: "ADMITTED"; lease: SerializableLease }
  | { reclaimed: number }
  | { released: boolean }
  | { heartbeat: boolean }
  | { budgets: number; attempts: number }
  | { winner?: { admissionRequestId: string; priority: number } }
  | { port: number };

function startWorker(command: unknown, requestedApplicationName?: string) {
  const production =
    typeof command === "object" &&
    command !== null &&
    "operation" in command &&
    command.operation === "production-server";
  const applicationName =
    requestedApplicationName ??
    (production ? `wsmp-prod-${crypto.randomUUID()}` : `wsmp-capacity-${crypto.randomUUID()}`);
  const workerDatabaseUrl = databaseUrl
    ? `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}application_name=${encodeURIComponent(applicationName)}`
    : databaseUrl;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, Buffer.from(JSON.stringify(command)).toString("base64url")],
    {
      cwd: fileURLToPath(new URL("../../../../..", import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: workerDatabaseUrl,
        SCHEMA_VALIDATION_DATABASE_URL: workerDatabaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  const result = new Promise<WorkerResult>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line) as WorkerResult);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (stdout.includes("{")) return;
      reject(new Error(`capacity worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, result, applicationName, stderr: () => stderr };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for process integration handshake.");
}

async function quiesceCapacityFixture(
  db: ReturnType<typeof createPrismaClient>,
  userId: string,
): Promise<void> {
  const terminalAt = new Date();
  await db.capacityLease.updateMany({
    where: { userId, state: "ACTIVE" },
    data: { state: "RELEASED", releasedAt: terminalAt, releaseReason: "test_cleanup" },
  });
  await db.capacityWaiter.updateMany({
    where: { userId, state: "WAITING" },
    data: { state: "CANCELLED", stateChangedAt: terminalAt, terminalReason: "test_cleanup" },
  });
  await db.admissionRequest.updateMany({
    where: { userId, state: { in: ["WAITING", "ADMITTED"] } },
    data: { state: "TERMINAL", terminalAt, terminalReason: "test_cleanup" },
  });
  expect(await db.capacityLease.count({ where: { userId, state: "ACTIVE" } })).toBe(0);
  // Immutable lease/target history is retained until the disposable
  // validation database is removed; only live state can affect later tests.
}

async function expectCapacityFixtureQuiescent(
  db: ReturnType<typeof createPrismaClient>,
  userId: string,
): Promise<void> {
  expect(await db.capacityLease.count({ where: { userId, state: "ACTIVE" } })).toBe(0);
  expect(await db.capacityWaiter.count({ where: { userId, state: "WAITING" } })).toBe(0);
  expect(
    await db.admissionRequest.count({
      where: { userId, state: { in: ["WAITING", "ADMITTED"] } },
    }),
  ).toBe(0);
}

integration("capacity admission across operating-system processes", () => {
  const db = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  const children = new Set<ChildProcess>();
  const fixtureUserIds = new Set<string>();
  afterEach(async () => {
    await Promise.all([...children].map(stop));
    children.clear();
    if (!db) return;
    for (const userId of fixtureUserIds) await quiesceCapacityFixture(db, userId);
    fixtureUserIds.clear();
  });
  afterAll(async () => {
    await Promise.all([...children].map(stop));
    await db?.$disconnect();
  });

  it("fences concurrent workers and recovers admitted and streaming work after SIGKILL", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Process capacity proof", email: `process-capacity-${suffix}@example.test` },
    });
    fixtureUserIds.add(owner.id);
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `process-capacity-${suffix}`,
        runtimeIdentityKey: `process-runtime-${suffix}`,
        runtimeModel: "process-proof",
        hardConcurrencyLimit: 1,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: owner.id,
        providerType: "process-proof",
        label: `process-account-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: { userId: owner.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    const target = await db.executionTarget.create({
      data: {
        userId: owner.id,
        kind: "PROVIDER_MODEL",
        providerModelId: model.id,
        inferenceCapacityId: capacity.id,
      },
    });
    const attempt = (
      label: string,
    ): Omit<AdmissionAttempt, "deadlineAt"> & { deadlineAt: string } => ({
      attemptId: `${label}-${suffix}`,
      requestId: `${label}-${suffix}`,
      ownerId: owner.id,
      sourceKind: "DIRECT",
      basePriority: 16,
      connectionOwner: `${label}-process`,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
    });

    for (const phase of ["admitted", "streaming"] as const) {
      const holder = startWorker({
        operation: "acquire",
        attempt: attempt(`${phase}-holder`),
        hold: true,
      });
      children.add(holder.child);
      const holderResult = await holder.result;
      expect(holderResult).toMatchObject({ state: "ADMITTED" });
      if (!("state" in holderResult) || holderResult.state !== "ADMITTED")
        throw new Error("Holder was not admitted.");
      const contender = startWorker({
        operation: "acquire",
        attempt: attempt(`${phase}-contender`),
        hold: false,
      });
      children.add(contender.child);
      const contenderResult = await contender.result;
      expect(contenderResult).toMatchObject({ state: "WAITING" });
      expect(
        await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
      ).toBe(1);

      await stop(holder.child);
      children.delete(holder.child);
      await db.$executeRaw`
        UPDATE capacity_lease SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
         WHERE id = ${holderResult.lease.leaseId}`;
      const sweepers = [
        startWorker({ operation: "reclaim", limit: 10 }),
        startWorker({ operation: "reclaim", limit: 10 }),
      ];
      for (const sweeper of sweepers) children.add(sweeper.child);
      const sweepResults = await Promise.all(sweepers.map((sweeper) => sweeper.result));
      // Reclaim is deliberately global. Another concurrently running
      // integration sweeper may win this lease, so the durable row below—not
      // this worker-local count—is the authoritative ownership proof.
      expect(
        sweepResults.every((result) => "reclaimed" in result && Number.isInteger(result.reclaimed)),
      ).toBe(true);
      await expect(
        db.capacityLease.findUniqueOrThrow({ where: { id: holderResult.lease.leaseId } }),
      ).resolves.toMatchObject({ state: "RECLAIMED" });

      const recovered = startWorker({
        operation: "acquire",
        attempt: { ...attempt(`${phase}-contender`), candidates: [] },
        hold: false,
      });
      children.add(recovered.child);
      const recoveredResult = await recovered.result;
      expect(recoveredResult).toMatchObject({ state: "ADMITTED" });
      if (!("state" in recoveredResult) || recoveredResult.state !== "ADMITTED")
        throw new Error("Contender did not recover.");
      expect(BigInt(recoveredResult.lease.fencingToken)).toBeGreaterThan(
        BigInt(holderResult.lease.fencingToken),
      );
      expect(
        await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
      ).toBe(1);
      const releaser = startWorker({ operation: "release", lease: recoveredResult.lease });
      children.add(releaser.child);
      await expect(releaser.result).resolves.toEqual({ released: true });
    }

    // Persist scheduler state in PostgreSQL, then let different OS processes
    // advance it. The high-weight class receives its remaining turn, the
    // cursor advances to the low class (bounded anti-starvation), and FIFO is
    // stable within that class.
    const deficits = Array(32).fill(0) as number[];
    deficits[31] = 1;
    await db.inferenceCapacity.update({
      where: { id: capacity.id },
      data: { schedulerCursor: 31, schedulerDeficits: deficits },
    });
    const weightedCandidates = [
      {
        admissionRequestId: `high-${suffix}`,
        waiterId: `high-${suffix}`,
        candidateOrder: 0,
        priority: 31,
        enqueueSequence: "2",
        eligible: true,
      },
      {
        admissionRequestId: `low-${suffix}`,
        waiterId: `low-${suffix}`,
        candidateOrder: 0,
        priority: 0,
        enqueueSequence: "1",
        eligible: true,
      },
    ];
    const highRound = startWorker({
      operation: "schedule",
      capacityId: capacity.id,
      candidates: weightedCandidates,
    });
    children.add(highRound.child);
    await expect(highRound.result).resolves.toMatchObject({
      winner: { admissionRequestId: `high-${suffix}`, priority: 31 },
    });
    const lowRound = startWorker({
      operation: "schedule",
      capacityId: capacity.id,
      candidates: weightedCandidates,
    });
    children.add(lowRound.child);
    await expect(lowRound.result).resolves.toMatchObject({
      winner: { admissionRequestId: `low-${suffix}`, priority: 0 },
    });
    const fifoRound = startWorker({
      operation: "schedule",
      capacityId: capacity.id,
      candidates: [
        {
          admissionRequestId: `later-${suffix}`,
          waiterId: `later-${suffix}`,
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: "4",
          eligible: true,
        },
        {
          admissionRequestId: `earlier-${suffix}`,
          waiterId: `earlier-${suffix}`,
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: "3",
          eligible: true,
        },
      ],
    });
    children.add(fifoRound.child);
    await expect(fifoRound.result).resolves.toMatchObject({
      winner: { admissionRequestId: `earlier-${suffix}` },
    });

    await quiesceCapacityFixture(db, owner.id);
  }, 30_000);

  it("drains a deterministic high-contention process queue without retry exhaustion", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const applicationPrefix = `wsmp-capacity-contention-${suffix}`;
    const owner = await db.user.create({
      data: {
        name: "Capacity contention proof",
        email: `capacity-contention-${suffix}@example.test`,
      },
    });
    fixtureUserIds.add(owner.id);
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `capacity-contention-${suffix}`,
        runtimeIdentityKey: `capacity-contention-runtime-${suffix}`,
        runtimeModel: "capacity-contention-proof",
        hardConcurrencyLimit: 3,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: owner.id,
        providerType: "capacity-contention-proof",
        label: `capacity-contention-account-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: { userId: owner.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    const target = await db.executionTarget.create({
      data: {
        userId: owner.id,
        kind: "PROVIDER_MODEL",
        providerModelId: model.id,
        inferenceCapacityId: capacity.id,
      },
    });
    let releaseFence: (() => void) | undefined;
    let reportLocked: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const barrier = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${target.id} FOR UPDATE`;
        reportLocked?.();
        await release;
      },
      { timeout: 30_000 },
    );
    await locked;
    const attempts = Array.from({ length: 12 }, (_value, index) => ({
      attemptId: `contention-${index}-${suffix}`,
      requestId: `contention-${index}-${suffix}`,
      ownerId: owner.id,
      sourceKind: "DIRECT" as const,
      basePriority: index % 32,
      connectionOwner: `contention-process-${index}`,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
    }));
    const workers = attempts.map((attempt, index) =>
      startWorker({ operation: "acquire", attempt, hold: false }, `${applicationPrefix}-${index}`),
    );
    for (const worker of workers) children.add(worker.child);
    const outcomesPromise = Promise.all(workers.map((worker) => worker.result));
    const waiterCount = await waitFor(async () => {
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM pg_stat_activity
        WHERE application_name LIKE ${`${applicationPrefix}-%`}
          AND wait_event_type = 'Lock'
      `;
      const count = Number(rows[0]?.count ?? 0n);
      return count === attempts.length ? count : undefined;
    }, 15_000);
    expect(waiterCount).toBe(attempts.length);
    releaseFence?.();
    await barrier;
    const outcomes = await outcomesPromise;
    expect(
      outcomes.filter((outcome) => "state" in outcome && outcome.state === "ADMITTED"),
    ).toHaveLength(3);
    expect(
      outcomes.filter((outcome) => "state" in outcome && outcome.state === "WAITING"),
    ).toHaveLength(9);
    expect(
      await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
    ).toBe(3);

    const admittedAttempts = new Set<string>();
    while (admittedAttempts.size < attempts.length) {
      const active = await db.capacityLease.findMany({
        where: { capacityId: capacity.id, state: "ACTIVE" },
        orderBy: { fencingToken: "asc" },
      });
      expect(active.length).toBeGreaterThan(0);
      expect(active.length).toBeLessThanOrEqual(3);
      for (const lease of active) admittedAttempts.add(lease.attemptId);
      const releasers = active.map((lease, index) =>
        startWorker(
          {
            operation: "release",
            lease: {
              leaseId: lease.id,
              attemptId: lease.attemptId,
              capacityId: lease.capacityId,
              executionTargetId: lease.executionTargetId,
              poolMemberId: lease.poolMemberId ?? undefined,
              fencingToken: lease.fencingToken.toString(),
              expiresAt: lease.expiresAt.toISOString(),
              reservationClass: lease.reservationClass,
              borrowed: lease.borrowed,
            },
          },
          `${applicationPrefix}-release-${admittedAttempts.size}-${index}`,
        ),
      );
      for (const releaser of releasers) children.add(releaser.child);
      await expect(Promise.all(releasers.map((releaser) => releaser.result))).resolves.toEqual(
        active.map(() => ({ released: true })),
      );
    }
    expect(admittedAttempts).toEqual(new Set(attempts.map((attempt) => attempt.attemptId)));
    expect(
      await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
    ).toBe(0);
    expect(
      await db.admissionRequest.count({
        where: {
          attemptId: { in: attempts.map((attempt) => attempt.attemptId) },
          state: "TERMINAL",
        },
      }),
    ).toBe(attempts.length);
    // Capacity leases intentionally retain immutable execution-target history,
    // so this disposable PostgreSQL proof is cleaned up with its container.
    await quiesceCapacityFixture(db, owner.id);
  }, 60_000);

  it("enforces one pool scope across capacities and admits one sibling on simultaneous release", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Cross-capacity proof", email: `cross-capacity-${suffix}@example.test` },
    });
    fixtureUserIds.add(owner.id);
    const pool = await db.modelPool.create({
      data: {
        userId: owner.id,
        slug: `cross-capacity-${suffix}`,
        name: "Cross-capacity proof",
        capacityConcurrencyLimit: 1,
        publicEgressAcknowledged: true,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: owner.id,
        providerType: "cross-capacity-proof",
        label: `cross-capacity-account-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const capacities = await Promise.all(
      [0, 1].map((index) =>
        db.inferenceCapacity.create({
          data: {
            userId: owner.id,
            label: `cross-capacity-${index}-${suffix}`,
            runtimeIdentityKey: `cross-runtime-${index}-${suffix}`,
            runtimeModel: "cross-capacity-proof",
            hardConcurrencyLimit: 1,
          },
        }),
      ),
    );
    const targets: Array<{ id: string }> = [];
    const members: Array<{ id: string }> = [];
    for (const [index, capacity] of capacities.entries()) {
      const model = await db.providerModel.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          upstreamModelId: `cross-${index}-${suffix}`,
        },
      });
      const target = await db.executionTarget.create({
        data: {
          userId: owner.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: capacity.id,
        },
      });
      const member = await db.poolMember.create({
        data: { poolId: pool.id, executionTargetId: target.id, tier: "PRIMARY" },
      });
      targets.push(target);
      members.push(member);
    }
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const directAttempt = (index: number) => ({
      attemptId: `cross-holder-${index}-${suffix}`,
      requestId: `cross-holder-${index}-${suffix}`,
      ownerId: owner.id,
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: `cross-holder-${index}`,
      deadlineAt,
      candidates: [
        {
          capacityId: capacities[index]!.id,
          executionTargetId: targets[index]!.id,
          candidateOrder: 0,
        },
      ],
    });
    const holders = [0, 1].map((index) =>
      startWorker({ operation: "acquire", attempt: directAttempt(index), hold: false }),
    );
    for (const holder of holders) children.add(holder.child);
    const holderResults = await Promise.all(holders.map((holder) => holder.result));
    expect(holderResults.every((result) => "state" in result && result.state === "ADMITTED")).toBe(
      true,
    );
    const siblingAttempt = {
      attemptId: `cross-sibling-${suffix}`,
      requestId: `cross-sibling-${suffix}`,
      ownerId: owner.id,
      sourceKind: "POOL" as const,
      poolId: pool.id,
      basePriority: 16,
      connectionOwner: "cross-sibling",
      deadlineAt,
      candidates: capacities.map((capacity, index) => ({
        capacityId: capacity.id,
        executionTargetId: targets[index]!.id,
        poolMemberId: members[index]!.id,
        candidateOrder: index,
      })),
    };
    const sibling = startWorker({ operation: "acquire", attempt: siblingAttempt, hold: false });
    children.add(sibling.child);
    await expect(sibling.result).resolves.toMatchObject({ state: "WAITING" });
    const releases = holderResults.map((result) => {
      if (!("state" in result) || result.state !== "ADMITTED")
        throw new Error("Cross-capacity holder was not admitted.");
      return startWorker({ operation: "release", lease: result.lease });
    });
    for (const release of releases) children.add(release.child);
    await expect(Promise.all(releases.map((release) => release.result))).resolves.toEqual([
      { released: true },
      { released: true },
    ]);
    const siblingLeases = await db.capacityLease.findMany({
      where: { attemptId: siblingAttempt.attemptId, state: "ACTIVE" },
    });
    expect(siblingLeases).toHaveLength(1);
    expect(await db.capacityLease.count({ where: { poolId: pool.id, state: "ACTIVE" } })).toBe(1);
    const releaser = startWorker({
      operation: "release",
      lease: {
        leaseId: siblingLeases[0]!.id,
        attemptId: siblingLeases[0]!.attemptId,
        capacityId: siblingLeases[0]!.capacityId,
        executionTargetId: siblingLeases[0]!.executionTargetId,
        fencingToken: siblingLeases[0]!.fencingToken.toString(),
        expiresAt: siblingLeases[0]!.expiresAt.toISOString(),
        poolMemberId: siblingLeases[0]!.poolMemberId ?? undefined,
        reservationClass: siblingLeases[0]!.reservationClass,
        borrowed: siblingLeases[0]!.borrowed,
      },
    });
    children.add(releaser.child);
    await expect(releaser.result).resolves.toEqual({ released: true });
    await quiesceCapacityFixture(db, owner.id);
  }, 60_000);

  it("runs real Hono workers through precommit and committed stream crashes", async () => {
    if (!db) return;
    const pendingUpstreams: ServerResponse[] = [];
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests++;
      pendingUpstreams.push(response);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Upstream did not bind TCP.");
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Hono process proof", email: `hono-process-${suffix}@example.test` },
    });
    fixtureUserIds.add(owner.id);
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `hono-capacity-${suffix}`,
        runtimeIdentityKey: `hono-runtime-${suffix}`,
        runtimeModel: "hono-proof",
        hardConcurrencyLimit: 1,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: owner.id,
        providerType: "hono-proof",
        label: `hono-account-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: { userId: owner.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    const target = await db.executionTarget.create({
      data: {
        userId: owner.id,
        kind: "PROVIDER_MODEL",
        providerModelId: model.id,
        inferenceCapacityId: capacity.id,
      },
    });
    const attempt = (label: string) => ({
      attemptId: `${label}-${suffix}`,
      requestId: `${label}-${suffix}`,
      ownerId: owner.id,
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: `${label}-hono`,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
    });
    const upstreamUrl = `http://127.0.0.1:${address.port}/controlled`;
    const servers = [
      startWorker({ operation: "server", upstreamUrl }),
      startWorker({ operation: "server", upstreamUrl }),
    ];
    for (const server of servers) children.add(server.child);
    const serverResults = await Promise.all(servers.map((server) => server.result));
    const ports = serverResults.map((result) => {
      if (!("port" in result)) throw new Error("Hono worker did not report its port.");
      return result.port;
    });

    try {
      for (const phase of ["precommit", "committed-stream"] as const) {
        const holderAttempt = attempt(`${phase}-holder`);
        const contenderAttempt = attempt(`${phase}-contender`);
        const workOutcome = fetch(`http://127.0.0.1:${ports[0]}/work`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(holderAttempt),
        }).then(
          (response) => ({ response, error: undefined }),
          (error: unknown) => ({ response: undefined, error }),
        );
        const upstreamResponse = await waitFor(() => pendingUpstreams.shift());
        const waiting = await fetch(`http://127.0.0.1:${ports[1]}/admit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(contenderAttempt),
        });
        expect(waiting.status).toBe(202);
        expect(await waiting.json()).toMatchObject({ state: "WAITING" });

        let committedFence: string | null = null;
        if (phase === "committed-stream") {
          upstreamResponse.writeHead(200, { "content-type": "text/event-stream" });
          upstreamResponse.write("data: first\n\n");
          const outcome = await workOutcome;
          if (!outcome.response) throw outcome.error;
          const response = outcome.response;
          expect(response.status).toBe(200);
          committedFence = response.headers.get("x-capacity-fence");
          const first = await response.body?.getReader().read();
          expect(new TextDecoder().decode(first?.value)).toContain("data: first");
        }
        const oldLease = await db.capacityLease.findUniqueOrThrow({
          where: { attemptId: holderAttempt.attemptId },
        });
        await stop(servers[0]!.child);
        children.delete(servers[0]!.child);
        if (phase === "precommit") {
          const outcome = await workOutcome;
          expect(outcome.response).toBeUndefined();
          expect(outcome.error).toBeDefined();
        }
        upstreamResponse.destroy();
        await db.$executeRaw`
          UPDATE capacity_lease SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
           WHERE id = ${oldLease.id}`;
        const reclaim = startWorker({ operation: "reclaim", limit: 10_000 });
        children.add(reclaim.child);
        // Other integration files can have expired work in the same forced-PG
        // run. The global sweeper count is therefore not scoped to this lease;
        // successful recovery below proves this exact lease was reclaimed.
        await expect(reclaim.result).resolves.toMatchObject({
          reclaimed: expect.any(Number),
        });
        const recovery = await fetch(`http://127.0.0.1:${ports[1]}/admit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...contenderAttempt, candidates: [] }),
        });
        expect(recovery.status).toBe(200);
        const replacement = (await recovery.json()) as { state: string; lease: SerializableLease };
        expect(replacement.state).toBe("ADMITTED");
        expect(BigInt(replacement.lease.fencingToken)).toBeGreaterThan(oldLease.fencingToken);
        if (committedFence) expect(BigInt(committedFence)).toBe(oldLease.fencingToken);

        const staleLease: SerializableLease = {
          leaseId: oldLease.id,
          attemptId: oldLease.attemptId,
          capacityId: oldLease.capacityId,
          executionTargetId: oldLease.executionTargetId,
          poolMemberId: oldLease.poolMemberId ?? undefined,
          fencingToken: oldLease.fencingToken.toString(),
          expiresAt: oldLease.expiresAt.toISOString(),
          reservationClass: oldLease.reservationClass,
          borrowed: oldLease.borrowed,
        };
        const staleHeartbeat = startWorker({
          operation: "heartbeat",
          lease: staleLease,
          extensionMs: 30_000,
        });
        const staleRelease = startWorker({ operation: "release", lease: staleLease });
        const duplicateKilledAttempt = startWorker({
          operation: "acquire",
          attempt: { ...holderAttempt, candidates: [] },
          hold: false,
        });
        children.add(staleHeartbeat.child);
        children.add(staleRelease.child);
        children.add(duplicateKilledAttempt.child);
        await expect(staleHeartbeat.result).resolves.toEqual({ heartbeat: false });
        await expect(staleRelease.result).resolves.toEqual({ released: false });
        await expect(duplicateKilledAttempt.result).resolves.toEqual({ state: "CANCELLED" });
        expect(
          await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
        ).toBe(1);
        const released = await fetch(
          `http://127.0.0.1:${ports[1]}/release/${contenderAttempt.attemptId}`,
          { method: "POST" },
        );
        expect(await released.json()).toEqual({ released: true });
        const secondRepair = startWorker({ operation: "reclaim", limit: 10 });
        children.add(secondRepair.child);
        // Reclaim is global, so another test's expired lease may contribute to
        // this worker's count. Idempotency is proven on both leases owned by
        // this scenario instead of assuming an otherwise empty database.
        await expect(secondRepair.result).resolves.toMatchObject({
          reclaimed: expect.any(Number),
        });
        await expect(
          db.capacityLease.findUniqueOrThrow({ where: { id: oldLease.id } }),
        ).resolves.toMatchObject({ state: "RECLAIMED" });
        await expect(
          db.capacityLease.findUniqueOrThrow({ where: { id: replacement.lease.leaseId } }),
        ).resolves.toMatchObject({ state: "RELEASED" });

        const replacementServer = startWorker({ operation: "server", upstreamUrl });
        children.add(replacementServer.child);
        const replacementResult = await replacementServer.result;
        if (!("port" in replacementResult)) throw new Error("Restarted worker has no port.");
        ports[0] = replacementResult.port;
        servers[0] = replacementServer;
      }
      const interruptedAttempt = attempt("network-interrupted");
      const interruptedWork = fetch(`http://127.0.0.1:${ports[0]}/work`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(interruptedAttempt),
      });
      const interruptedUpstream = await waitFor(() => pendingUpstreams.shift());
      interruptedUpstream.destroy(new Error("deterministic upstream disconnect"));
      await expect(interruptedWork).resolves.toMatchObject({ status: 500 });
      await waitFor(() =>
        db.capacityLease
          .findUnique({ where: { attemptId: interruptedAttempt.attemptId } })
          .then((lease) => (lease?.state === "RELEASED" ? lease : undefined)),
      );
      expect(
        await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
      ).toBe(0);
      const interruptedRepair = startWorker({ operation: "reclaim", limit: 10 });
      children.add(interruptedRepair.child);
      await expect(interruptedRepair.result).resolves.toMatchObject({
        reclaimed: expect.any(Number),
      });
      await expect(
        db.capacityLease.findUniqueOrThrow({
          where: { attemptId: interruptedAttempt.attemptId },
        }),
      ).resolves.toMatchObject({ state: "RELEASED" });
      expect(upstreamRequests).toBe(3);

      await db.executionTarget.update({
        where: { id: target.id },
        data: { directPriority: 0 },
      });
      const highModel = await db.providerModel.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          upstreamModelId: `high-${suffix}`,
        },
      });
      const highTarget = await db.executionTarget.create({
        data: {
          userId: owner.id,
          kind: "PROVIDER_MODEL",
          providerModelId: highModel.id,
          inferenceCapacityId: capacity.id,
          directPriority: 31,
        },
      });
      const queueAttempt = (label: string, executionTargetId: string) => ({
        ...attempt(label),
        candidates: [{ capacityId: capacity.id, executionTargetId, candidateOrder: 0 }],
      });
      const blocker = queueAttempt("wdrr-blocker", target.id);
      const blockerResponse = await fetch(`http://127.0.0.1:${ports[0]}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(blocker),
      });
      expect(blockerResponse.status).toBe(200);
      const lowAttempts = [
        queueAttempt("wdrr-low-head", target.id),
        queueAttempt("wdrr-low-second", target.id),
      ];
      const starvationBoundRounds = 33;
      const proofRounds = starvationBoundRounds + 3;
      const highAttempts = Array.from({ length: proofRounds + 4 }, (_value, index) =>
        queueAttempt(`wdrr-high-${index}`, highTarget.id),
      );
      for (const [index, queued] of [...lowAttempts, ...highAttempts].entries()) {
        const response = await fetch(`http://127.0.0.1:${ports[index % 2]}/admit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(queued),
        });
        expect(response.status).toBe(202);
      }
      await db.inferenceCapacity.update({
        where: { id: capacity.id },
        data: { schedulerCursor: 0, schedulerDeficits: Array(32).fill(0) },
      });
      const blockerRelease = await fetch(
        `http://127.0.0.1:${ports[0]}/release/${blocker.attemptId}`,
        { method: "POST" },
      );
      expect(await blockerRelease.json()).toEqual({ released: true });

      const winners: string[] = [];
      let restartFencingToken: bigint | undefined;
      for (let round = 0; round < proofRounds; round++) {
        // Release commits the next admission before its HTTP response, so a
        // direct read is a deterministic barrier rather than a polling sleep.
        const active = await db.capacityLease.findFirstOrThrow({
          where: { capacityId: capacity.id, state: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        });
        expect(
          await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
        ).toBe(1);
        winners.push(active.attemptId);
        const serializable = {
          leaseId: active.id,
          attemptId: active.attemptId,
          capacityId: active.capacityId,
          executionTargetId: active.executionTargetId,
          poolMemberId: active.poolMemberId ?? undefined,
          fencingToken: active.fencingToken.toString(),
          expiresAt: active.expiresAt.toISOString(),
          reservationClass: active.reservationClass,
          borrowed: active.borrowed,
        };
        if (round === 10) {
          const schedulerBeforeRestart = await db.inferenceCapacity.findUniqueOrThrow({
            where: { id: capacity.id },
          });
          restartFencingToken = schedulerBeforeRestart.nextFencingToken;
          await stop(servers[0]!.child);
          children.delete(servers[0]!.child);
          const restarted = startWorker({ operation: "server", upstreamUrl });
          children.add(restarted.child);
          const ready = await restarted.result;
          if (!("port" in ready)) throw new Error("Contended worker restart failed.");
          ports[0] = ready.port;
          servers[0] = restarted;
          const schedulerAfterRestart = await db.inferenceCapacity.findUniqueOrThrow({
            where: { id: capacity.id },
          });
          expect(schedulerAfterRestart.schedulerCursor).toBe(
            schedulerBeforeRestart.schedulerCursor,
          );
          expect(schedulerAfterRestart.schedulerDeficits).toEqual(
            schedulerBeforeRestart.schedulerDeficits,
          );
        }
        const releasePort = round === 10 ? ports[0] : ports[round % 2];
        const response = await fetch(`http://127.0.0.1:${releasePort}/release-lease`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(serializable),
        });
        expect(await response.json()).toEqual({ released: true });
        if (round === 10) {
          const persisted = await db.inferenceCapacity.findUniqueOrThrow({
            where: { id: capacity.id },
          });
          expect(persisted.nextFencingToken).toBeGreaterThan(restartFencingToken!);
        }
      }
      expect(winners[0]).toBe(lowAttempts[0]!.attemptId);
      const secondLowRound = winners.indexOf(lowAttempts[1]!.attemptId);
      expect(secondLowRound).toBeGreaterThan(0);
      expect(secondLowRound).toBeLessThanOrEqual(starvationBoundRounds);
      expect(winners.filter((winner) => winner.includes("wdrr-high-")).length).toBeGreaterThan(
        winners.filter((winner) => winner.includes("wdrr-low-")).length,
      );
      expect(new Set(winners).size).toBe(winners.length);
    } finally {
      for (const server of servers) await stop(server.child);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await quiesceCapacityFixture(db, owner.id);
    }
  }, 90_000);

  it("boots production model routes in two processes and preserves commit semantics", async () => {
    if (!db || !databaseUrl) return;
    process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    process.env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = "true";
    process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = `process-v1:${Buffer.alloc(32, 37).toString("base64")}`;
    process.env.MODEL_API_GLOBAL_CAPACITY_ENABLED = "true";
    process.env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = "true";
    const { credentialLookupPrefix, hmacDigestForForwarderPurpose } = await import(
      "@ws-model-proxy/db/forwarder-security"
    );
    const upstreamResponses: Array<{ path: string; response: ServerResponse; label?: string }> = [];
    const observations: string[] = [];
    const upstream = createServer((request, response) => {
      const path = request.url ?? "";
      observations.push(path);
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        let label: string | undefined;
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
          const content = parsed.messages?.[0]?.content;
          if (typeof content === "string") label = content;
        } catch {
          // Protocol validation is exercised by the production route. The
          // upstream collector only needs labels for the scheduler proof.
        }
        upstreamResponses.push({ path, response, label });
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Production upstream unavailable.");
    const origin = `http://127.0.0.1:${address.port}`;
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: {
        name: "Production process proof",
        email: `production-process-${suffix}@example.test`,
        slug: `production-process-${suffix}`,
      },
    });
    // This scenario proves that production lifecycle handling itself leaves no
    // live capacity state. Its finally block asserts rather than repairing;
    // exclude it from the generic repair-oriented fixture cleanup.
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `production-capacity-${suffix}`,
        runtimeIdentityKey: `production-runtime-${suffix}`,
        runtimeModel: "production-proof",
        hardConcurrencyLimit: 1,
      },
    });
    const pool = await db.modelPool.create({
      data: {
        userId: owner.id,
        slug: `production-pool-${suffix}`,
        name: "Production process pool",
        protocolAdaptationEnabled: true,
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      },
    });
    const keyring = parseProviderCredentialKeyring(
      process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS,
    );
    const createProvider = async (
      label: string,
      publicOrder: number,
      providerPool = pool,
      providerCapacity = capacity,
    ) => {
      const accountId = crypto.randomUUID();
      const credentialId = crypto.randomUUID();
      const account = await db.providerAccount.create({
        data: {
          id: accountId,
          userId: owner.id,
          providerType: "openai",
          label: `${label}-${suffix}`,
          baseUrl: `${origin}/${label}`,
          endpointIdentity: `${origin}/${label}`,
          authType: "BEARER",
          status: "ACTIVE",
          enabled: false,
          healthStatus: "HEALTHY",
        },
      });
      const encrypted = encryptProviderCredential(
        `secret-${label}`,
        {
          userId: owner.id,
          providerAccountId: account.id,
          credentialId,
          credentialType: "BEARER",
          aadVersion: 1,
        },
        keyring,
      );
      await db.$transaction(async (tx) => {
        await tx.providerCredential.create({
          data: {
            id: credentialId,
            userId: owner.id,
            providerAccountId: account.id,
            credentialType: "BEARER",
            ...encrypted,
          },
        });
        await tx.providerAccount.update({
          where: { id: account.id },
          data: { currentCredentialId: credentialId, enabled: true },
        });
      });
      const model = await db.providerModel.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          upstreamModelId: `upstream-${label}`,
          enabled: true,
          healthStatus: "HEALTHY",
          contextWindow: 8_192,
          maxOutputTokens: 256,
          nativeCapabilities: {
            protocols: ["openai"],
            surfaces: ["openai-chat"],
            streaming: true,
            features: [],
          },
        },
      });
      const target = await db.executionTarget.create({
        data: {
          userId: owner.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: providerCapacity.id,
        },
      });
      await db.poolMember.create({
        data: {
          poolId: providerPool.id,
          executionTargetId: target.id,
          tier: "PUBLIC_OVERFLOW",
          publicOrder,
        },
      });
      await db.providerPricingVersion.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          version: "process-v1",
          currency: "USD",
          status: "ACTIVE",
          accountingVersion: "provider-billable-v1",
          confidence: "CALCULATED",
          effectiveAt: new Date(Date.now() - 60_000),
          activatedAt: new Date(Date.now() - 60_000),
          pricing: { ratesPerMillion: { input: "1", output: "2", additional: "2" } },
          chargeRules: {
            inputIncludesCacheRead: false,
            inputIncludesCacheWrite: false,
            outputIncludesReasoning: false,
            outputIncludesTool: false,
            cacheReadAllowanceTokens: 0,
            cacheWriteAllowanceTokens: 0,
            reasoningAllowanceTokens: 0,
            toolAllowanceTokens: 0,
            additionalAllowanceTokens: 0,
            unknownCategories: "FAIL_CLOSED",
          },
        },
      });
      await db.providerBudgetPolicy.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          poolId: providerPool.id,
          scopeType: "POOL_PROVIDER_MODEL",
          active: true,
          activatedAt: new Date(Date.now() - 60_000),
          Rules: {
            create: [
              { metric: "CONCURRENCY", period: "PER_ATTEMPT", mode: "UNLIMITED" },
              { metric: "TOKENS", period: "UTC_DAY", mode: "LIMITED", limitValue: 100_000 },
              {
                metric: "SPEND",
                period: "UTC_DAY",
                mode: "LIMITED",
                limitValue: "10",
                currency: "USD",
              },
            ],
          },
        },
      });
      return { account, model, target };
    };
    const primary = await createProvider("primary", 0);
    await createProvider("secondary", 1);
    const rawToken = `wsmp_model_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.modelApiToken.create({
      data: {
        userId: owner.id,
        name: "Production process token",
        lookupPrefix: credentialLookupPrefix(rawToken),
        secretDigest: hmacDigestForForwarderPurpose({ purpose: "modelApiToken", value: rawToken }),
      },
    });
    const modelId = poolModelId({ userSlug: owner.slug, poolSlug: pool.slug });
    const request = (port: number, requestedModelId = modelId, label = "hi", stream = true) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: requestedModelId,
          stream,
          max_tokens: 16,
          messages: [{ role: "user", content: label }],
        }),
      });
    const workers = [
      startWorker({ operation: "production-server" }),
      startWorker({ operation: "production-server" }),
    ];
    for (const worker of workers) children.add(worker.child);
    const ready = await Promise.all(workers.map((worker) => worker.result));
    const ports = ready.map((result) => {
      if (!("port" in result)) throw new Error("Production worker did not become ready.");
      return result.port;
    });
    let lifecycleCompleted = false;
    try {
      let priorProviderFence = 0n;
      for (const phase of ["before-byte", "after-byte"] as const) {
        const observationStart = observations.length;
        const responsePromise = request(ports[0]!);
        const responseOutcome = responsePromise.then(
          (response) => ({ response, error: undefined }),
          (error: unknown) => ({ response: undefined, error }),
        );
        let upstreamObserved = false;
        const controlled = await Promise.race([
          waitFor(() => upstreamResponses.shift(), 10_000).then((upstreamResponse) => {
            upstreamObserved = true;
            return upstreamResponse;
          }),
          responseOutcome.then(async (outcome) => {
            if (upstreamObserved) return new Promise<never>(() => undefined);
            if (!outcome.response)
              throw outcome.error ?? new Error("Production route failed without an error.");
            const body = await outcome.response.text();
            throw new Error(
              `Production route returned before upstream dispatch: ${outcome.response.status} ${body}; worker stderr: ${workers[0]?.stderr() ?? ""}`,
            );
          }),
        ]);
        expect(controlled.path).toContain("/primary/");
        if (phase === "after-byte") {
          controlled.response.writeHead(200, { "content-type": "text/event-stream" });
          controlled.response.write(
            `data: ${JSON.stringify({
              id: `chunk-${suffix}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "upstream-primary",
              choices: [{ index: 0, delta: { content: "first" }, finish_reason: null }],
            })}\n\n`,
          );
          const outcome = await responseOutcome;
          if (!outcome.response) throw outcome.error;
          const downstream = outcome.response;
          const first = await downstream.body?.getReader().read();
          expect(new TextDecoder().decode(first?.value)).toContain("first");
        }
        const active = await waitFor(() =>
          db.providerAttempt
            .findFirst({
              where: { providerModelId: primary.model.id, state: "ACTIVE" },
              orderBy: { createdAt: "desc" },
            })
            .then((attemptRow) => attemptRow ?? undefined),
        );
        expect(active.fencingToken).toBeGreaterThan(priorProviderFence);
        priorProviderFence = active.fencingToken;
        await stop(workers[0]!.child);
        children.delete(workers[0]!.child);
        if (phase === "before-byte") {
          const outcome = await responseOutcome;
          expect(outcome.error).toBeDefined();
          expect(outcome.response).toBeUndefined();
        }
        controlled.response.destroy();
        expect(
          observations.slice(observationStart).filter((path) => path.includes("/secondary/")),
        ).toHaveLength(0);
        await db.providerAttempt.update({
          where: { id: active.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        const providerRepair = startWorker({
          operation: "repair-provider",
          now: new Date(Date.now() + 10 * 60_000).toISOString(),
          userId: owner.id,
          providerAccountId: primary.account.id,
        });
        children.add(providerRepair.child);
        const providerRepairResult = await providerRepair.result;
        expect(providerRepairResult).toMatchObject({ budgets: 1 });
        const duplicateProviderRepair = startWorker({
          operation: "repair-provider",
          now: new Date(Date.now() + 10 * 60_000).toISOString(),
          userId: owner.id,
          providerAccountId: primary.account.id,
        });
        children.add(duplicateProviderRepair.child);
        await expect(duplicateProviderRepair.result).resolves.toMatchObject({ budgets: 0 });
        await expect(
          db.providerAttempt.findFirstOrThrow({
            where: { providerModelId: primary.model.id },
            orderBy: { createdAt: "desc" },
          }),
        ).resolves.toMatchObject({ state: "EXPIRED", terminalReason: "CRASH_RECOVERY" });
        expect(
          await db.providerAttempt.count({
            where: { providerModelId: primary.model.id, state: "ACTIVE" },
          }),
        ).toBe(0);
        // The provider-attempt repair and the global capacity sweeper are
        // deliberately independent crash-recovery loops. Model a database
        // lease timeout as well before asking the restarted process to admit
        // the next request; otherwise the killed process correctly retains
        // its physical slot until the original 30-second lease expires.
        const crashedCapacityLease = await db.capacityLease.findFirstOrThrow({
          where: { capacityId: capacity.id, state: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        });
        await db.capacityLease.update({
          where: { id: crashedCapacityLease.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        const capacityRepair = startWorker({ operation: "reclaim", limit: 10 });
        children.add(capacityRepair.child);
        await expect(capacityRepair.result).resolves.toMatchObject({
          reclaimed: expect.any(Number),
        });
        await expect(
          db.capacityLease.findUniqueOrThrow({ where: { id: crashedCapacityLease.id } }),
        ).resolves.toMatchObject({ state: "RECLAIMED" });
        const restarted = startWorker({ operation: "production-server" });
        children.add(restarted.child);
        const restartedResult = await restarted.result;
        if (!("port" in restartedResult)) throw new Error("Production restart failed.");
        workers[0] = restarted;
        ports[0] = restartedResult.port;
      }

      const interruptedOutcome = request(ports[0]!).then(
        (response) => ({ response, error: undefined }),
        (error: unknown) => ({ response: undefined, error }),
      );
      const controlled = await waitFor(() => upstreamResponses.shift(), 10_000);
      const selectedApplicationName = workers[0]!.applicationName;
      if (!selectedApplicationName) throw new Error("Production worker application name missing.");
      const backendRows = await waitFor(() =>
        db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
         WHERE application_name = ${selectedApplicationName}
           AND pid <> pg_backend_pid()`.then((rows) => (rows.length > 0 ? rows : undefined)),
      );
      const selectedBackendPids = backendRows.map((row) => row.pid);
      expect(selectedBackendPids.length).toBeGreaterThan(0);
      const terminated = await Promise.all(
        selectedBackendPids.map(
          (pid) =>
            db.$queryRaw<Array<{ terminated: boolean }>>`
            SELECT pg_terminate_backend(${pid}) AS terminated`,
        ),
      );
      expect(terminated).toEqual(selectedBackendPids.map(() => [{ terminated: true }]));
      await waitFor(async () => {
        const presence = await Promise.all(
          selectedBackendPids.map(
            (pid) =>
              db.$queryRaw<Array<{ present: boolean }>>`
              SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}) AS present`,
          ),
        );
        return presence.every((rows) => rows[0]?.present === false) ? true : undefined;
      });
      controlled.response.destroy(new Error("database connectivity interruption"));
      const fallback = await waitFor(
        () => upstreamResponses.find((entry) => entry.path.includes("/secondary/")),
        10_000,
      );
      const recoveredBackendRows = await waitFor(() =>
        db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
           WHERE application_name = ${selectedApplicationName}
             AND pid <> pg_backend_pid()`.then((rows) => {
          const recovered = rows.filter((row) => !selectedBackendPids.includes(row.pid));
          return recovered.length > 0 ? recovered : undefined;
        }),
      );
      expect(recoveredBackendRows.every((row) => !selectedBackendPids.includes(row.pid))).toBe(
        true,
      );
      fallback.response.writeHead(503, { "content-type": "application/json" });
      fallback.response.end(JSON.stringify({ error: { message: "controlled fallback failure" } }));
      const interrupted = await interruptedOutcome;
      if (!interrupted.response) throw interrupted.error;
      expect(interrupted.response.status).toBeGreaterThanOrEqual(400);
      await interrupted.response.text();
      try {
        await waitFor(async () => {
          const [activeLeases, liveWaiters, liveRequests] = await Promise.all([
            db.capacityLease.count({ where: { userId: owner.id, state: "ACTIVE" } }),
            db.capacityWaiter.count({ where: { userId: owner.id, state: "WAITING" } }),
            db.admissionRequest.count({
              where: { userId: owner.id, state: { in: ["WAITING", "ADMITTED"] } },
            }),
          ]);
          return activeLeases === 0 && liveWaiters === 0 && liveRequests === 0 ? true : undefined;
        });
      } catch (error) {
        throw new Error(
          `Interrupted provider lifecycle did not terminalize: ${workers.map((worker) => worker.stderr()).join("\n")}`,
          { cause: error },
        );
      }
      const interruptedLease = await db.providerAttempt.findFirst({
        where: { providerModelId: primary.model.id },
        orderBy: { createdAt: "desc" },
      });
      if (interruptedLease?.state === "ACTIVE") {
        await db.providerAttempt.update({
          where: { id: interruptedLease.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
      }
      const interruptedProviderRepair = startWorker({
        operation: "repair-provider",
        now: new Date(Date.now() + 10 * 60_000).toISOString(),
        userId: owner.id,
        providerAccountId: primary.account.id,
      });
      children.add(interruptedProviderRepair.child);
      await expect(interruptedProviderRepair.result).resolves.toMatchObject({
        budgets: expect.any(Number),
      });
      expect(
        await db.providerAttempt.count({
          where: { providerModelId: primary.model.id, state: "ACTIVE" },
        }),
      ).toBe(0);
      expect(await db.providerAttempt.count({ where: { providerModelId: primary.model.id } })).toBe(
        3,
      );
      expect(await db.capacityLease.count({ where: { userId: owner.id, state: "ACTIVE" } })).toBe(
        0,
      );
      expect(await db.capacityWaiter.count({ where: { userId: owner.id, state: "WAITING" } })).toBe(
        0,
      );
      expect(
        await db.admissionRequest.count({
          where: { userId: owner.id, state: { in: ["WAITING", "ADMITTED"] } },
        }),
      ).toBe(0);

      const lowPool = await db.modelPool.create({
        data: {
          userId: owner.id,
          slug: `production-low-${suffix}`,
          name: "Production low-priority proof",
          capacityPriority: 0,
          protocolAdaptationEnabled: true,
          publicEgressEnabled: true,
          publicEgressAcknowledged: true,
        },
      });
      const highPool = await db.modelPool.create({
        data: {
          userId: owner.id,
          slug: `production-high-${suffix}`,
          name: "Production high-priority proof",
          capacityPriority: 31,
          protocolAdaptationEnabled: true,
          publicEgressEnabled: true,
          publicEgressAcknowledged: true,
        },
      });
      await createProvider("wdrr-low", 0, lowPool);
      await createProvider("wdrr-high", 0, highPool);
      const lowModelId = poolModelId({ userSlug: owner.slug, poolSlug: lowPool.slug });
      const highModelId = poolModelId({ userSlug: owner.slug, poolSlug: highPool.slug });
      upstreamResponses.length = 0;

      const finishUpstream = (entry: { response: ServerResponse }, label: string) => {
        entry.response.writeHead(200, { "content-type": "application/json" });
        entry.response.end(
          JSON.stringify({
            id: `wdrr-${label}`,
            object: "chat.completion",
            created: 1,
            model: "wdrr-proof",
            choices: [{ index: 0, message: { role: "assistant", content: label } }],
          }),
        );
      };
      const pending = new Map<string, Promise<Response>>();
      const owners = new Map<string, number>();
      const enqueueProduction = (label: string, requestedModelId: string, workerIndex: number) => {
        owners.set(label, workerIndex);
        const promise = request(ports[workerIndex]!, requestedModelId, label, false);
        pending.set(label, promise);
        void promise.catch(() => undefined);
      };

      enqueueProduction("wdrr-blocker", lowModelId, 1);
      const blockerUpstream = await waitFor(
        () => upstreamResponses.find((entry) => entry.label === "wdrr-blocker"),
        10_000,
      );
      const lowLabels = ["wdrr-low-head", "wdrr-low-second"];
      for (const [index, label] of lowLabels.entries()) {
        enqueueProduction(label, lowModelId, 1);
        await waitFor(async () => {
          const queued = await db.capacityWaiter.count({
            where: { poolId: lowPool.id, state: "WAITING" },
          });
          return queued === index + 1 ? true : undefined;
        });
      }
      const highLabels = Array.from({ length: 40 }, (_value, index) => `wdrr-high-${index}`);
      // The tenth high-priority request is isolated on worker zero so that
      // killing its admitted owner does not also kill the durable backlog.
      const initialHighBacklog = 4;
      for (const [index, label] of highLabels.slice(0, initialHighBacklog).entries())
        enqueueProduction(label, highModelId, index === 9 ? 0 : 1);
      await waitFor(async () => {
        const queued = await db.capacityWaiter.count({
          where: { capacityId: capacity.id, state: "WAITING" },
        });
        return queued === lowLabels.length + initialHighBacklog ? true : undefined;
      }, 20_000);
      await db.inferenceCapacity.update({
        where: { id: capacity.id },
        data: { schedulerCursor: 0, schedulerDeficits: Array(PRIORITY_CLASS_COUNT).fill(0) },
      });
      finishUpstream(blockerUpstream, "wdrr-blocker");
      await (await pending.get("wdrr-blocker"))?.arrayBuffer();
      pending.delete("wdrr-blocker");

      const winners: string[] = [];
      const consumedLabels = new Set(["wdrr-blocker"]);
      const starvationBoundRounds = 33;
      const totalQueued = lowLabels.length + highLabels.length;
      let nextHighIndex = initialHighBacklog;
      for (let round = 0; round < totalQueued; round++) {
        const admittedUpstream = await waitFor(
          () => upstreamResponses.find((entry) => entry.label && !consumedLabels.has(entry.label)),
          20_000,
        );
        const label = admittedUpstream.label;
        if (!label) throw new Error("Production WDRR upstream label missing.");
        consumedLabels.add(label);
        winners.push(label);
        expect(
          await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
        ).toBe(1);

        if (label.startsWith("wdrr-high-") && nextHighIndex < highLabels.length) {
          const replacementIndex = nextHighIndex++;
          enqueueProduction(
            highLabels[replacementIndex]!,
            highModelId,
            replacementIndex === 9 ? 0 : 1,
          );
          await waitFor(async () => {
            const enqueued = await db.admissionRequest.count({
              where: { poolId: highPool.id },
            });
            return enqueued === nextHighIndex ? true : undefined;
          });
        }

        if (round === 10) {
          expect(label).toBe("wdrr-high-9");
          const ownerIndex = owners.get(label);
          if (ownerIndex === undefined) throw new Error("Production WDRR owner missing.");
          const schedulerBeforeRestart = await db.inferenceCapacity.findUniqueOrThrow({
            where: { id: capacity.id },
          });
          await stop(workers[ownerIndex]!.child);
          children.delete(workers[ownerIndex]!.child);
          admittedUpstream.response.destroy(new Error("deterministic WDRR worker crash"));
          const restarted = startWorker({ operation: "production-server" });
          children.add(restarted.child);
          const ready = await restarted.result;
          if (!("port" in ready)) throw new Error("Production WDRR restart failed.");
          workers[ownerIndex] = restarted;
          ports[ownerIndex] = ready.port;
          await expect(
            db.inferenceCapacity.findUniqueOrThrow({ where: { id: capacity.id } }),
          ).resolves.toMatchObject({
            schedulerCursor: schedulerBeforeRestart.schedulerCursor,
            schedulerDeficits: schedulerBeforeRestart.schedulerDeficits,
          });

          const candidates = await db.capacityWaiter.findMany({
            where: {
              capacityId: capacity.id,
              state: "WAITING",
              AdmissionRequest: { state: "WAITING" },
            },
            include: { AdmissionRequest: true },
          });
          const expected = scheduleWeightedDeficitRoundRobin({
            state: {
              cursor: schedulerBeforeRestart.schedulerCursor,
              deficits: schedulerBeforeRestart.schedulerDeficits as number[],
              version: schedulerBeforeRestart.schedulerVersion,
            },
            candidates: candidates.map((candidate) => ({
              admissionRequestId: candidate.admissionRequestId,
              waiterId: candidate.id,
              candidateOrder: candidate.candidateOrder,
              priority: candidate.effectivePriority,
              enqueueSequence: candidate.AdmissionRequest.enqueueSequence,
              eligible: true,
            })),
          });
          if (!expected.winner) throw new Error("Expected a post-restart WDRR winner.");
          const crashedLease = await db.capacityLease.findFirstOrThrow({
            where: { capacityId: capacity.id, state: "ACTIVE" },
          });
          await db.capacityLease.update({
            where: { id: crashedLease.id },
            data: { expiresAt: new Date(Date.now() - 1) },
          });
          const repair = startWorker({ operation: "reclaim", limit: 10_000 });
          children.add(repair.child);
          await repair.result;
          await expect(
            db.inferenceCapacity.findUniqueOrThrow({ where: { id: capacity.id } }),
          ).resolves.toMatchObject({
            schedulerCursor: expected.state.cursor,
            schedulerDeficits: expected.state.deficits,
          });
          const expectedRequest = candidates.find(
            (candidate) => candidate.admissionRequestId === expected.winner?.admissionRequestId,
          );
          await expect(
            db.capacityLease.findFirstOrThrow({
              where: { capacityId: capacity.id, state: "ACTIVE" },
            }),
          ).resolves.toMatchObject({ attemptId: expectedRequest?.AdmissionRequest.attemptId });
        } else {
          finishUpstream(admittedUpstream, label);
          await (await pending.get(label))?.arrayBuffer();
          pending.delete(label);
        }
      }
      expect(winners[0]).toBe(lowLabels[0]);
      expect(winners.indexOf(lowLabels[1]!)).toBeGreaterThan(0);
      expect(winners.indexOf(lowLabels[1]!)).toBeLessThanOrEqual(starvationBoundRounds);
      expect(winners.filter((label) => label.startsWith("wdrr-high-")).length).toBeGreaterThan(
        winners.filter((label) => label.startsWith("wdrr-low-")).length,
      );
      expect(new Set(winners).size).toBe(winners.length);
      await waitFor(async () => {
        const [activeLeases, liveWaiters, liveRequests] = await Promise.all([
          db.capacityLease.count({ where: { userId: owner.id, state: "ACTIVE" } }),
          db.capacityWaiter.count({ where: { userId: owner.id, state: "WAITING" } }),
          db.admissionRequest.count({
            where: { userId: owner.id, state: { in: ["WAITING", "ADMITTED"] } },
          }),
        ]);
        return activeLeases === 0 && liveWaiters === 0 && liveRequests === 0 ? true : undefined;
      });
      expect(await db.capacityLease.count({ where: { userId: owner.id, state: "ACTIVE" } })).toBe(
        0,
      );
      expect(await db.capacityWaiter.count({ where: { userId: owner.id, state: "WAITING" } })).toBe(
        0,
      );
      expect(
        await db.admissionRequest.count({
          where: { userId: owner.id, state: { in: ["WAITING", "ADMITTED"] } },
        }),
      ).toBe(0);
      lifecycleCompleted = true;
    } finally {
      for (const worker of workers) await stop(worker.child);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (lifecycleCompleted) await expectCapacityFixtureQuiescent(db, owner.id);
      // Provider attempt/audit rows are append-only and deliberately retain
      // their owner. Quiescing capacity state prevents fixture rows from
      // affecting global sweepers while preserving that production invariant.
    }
  }, 120_000);
});

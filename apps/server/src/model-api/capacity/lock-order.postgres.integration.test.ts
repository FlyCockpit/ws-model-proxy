// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.

import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { describe, expect, it, vi } from "vitest";

// DL-1 lock-order regressions on real PostgreSQL. Every scenario pairs a
// production code path with an admitter that holds the capacity locks and
// then takes the implicit FOR KEY SHARE locks of its child inserts. The test
// side sets a short deadlock_timeout, so when a cycle exists PostgreSQL's
// deadlock check runs on the test side first and aborts it: a deadlock can
// never be hidden by the production path's own retry loop.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

// Registration retries 40P01/40001 internally. Record every error its retry
// predicate sees so a deadlock that the retry absorbed still fails the test.
const registrationRetryErrors: unknown[] = [];
vi.mock("@ws-model-proxy/api/lib/discovered-inference-capacity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ws-model-proxy/api/lib/discovered-inference-capacity")>();
  return {
    ...actual,
    isInferenceCapacityWriteRetryable: (error: unknown) => {
      const retryable = actual.isInferenceCapacityWriteRetryable(error);
      if (retryable) registrationRetryErrors.push(error);
      return retryable;
    },
  };
});

type Client = ReturnType<typeof createFixturePrismaClient>;

function namedUrl(name: string): string {
  if (!databaseUrl) throw new Error("PostgreSQL URL unavailable.");
  return `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}application_name=${encodeURIComponent(name)}`;
}

async function backendPid(tx: Pick<Client, "$queryRaw">): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("Backend pid unavailable.");
  return pid;
}

/** Waits until at least `count` other backends are queued behind `pid`. */
async function waitUntilBlockedBy(inspector: Client, pid: number, count = 1): Promise<void> {
  for (let poll = 0; poll < 1_000; poll++) {
    const rows = await inspector.$queryRaw<Array<{ blocked: bigint }>>`
      SELECT count(*) AS blocked FROM pg_stat_activity
       WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if (Number(rows[0]?.blocked ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No backend queued behind ${pid}.`);
}

/** Waits until every named backend is waiting on a heavyweight lock. */
async function waitUntilLockWaiting(inspector: Client, applicationNames: string[]): Promise<void> {
  for (let poll = 0; poll < 1_000; poll++) {
    const rows = await inspector.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_stat_activity
       WHERE application_name = ANY(${applicationNames}::text[]) AND wait_event_type = 'Lock'`;
    if (Number(rows[0]?.waiting ?? 0) >= applicationNames.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backends ${applicationNames.join(", ")} never waited on a lock.`);
}

async function cleanupLiveCapacityState(db: Client, userId: string): Promise<void> {
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
}

function settledLabels(outcomes: PromiseSettledResult<unknown>[]): string[] {
  return outcomes.map((outcome) =>
    outcome.status === "fulfilled" ? "committed" : String(outcome.reason),
  );
}

integration("DL-1 capacity lock order on PostgreSQL", () => {
  it("re-registers an inventory while an admitter inserts a lease on its target (no 40P01)", async () => {
    // DL-1-REG. Relay registration re-reads its existing execution targets and
    // later seeds the capacity's physical context (an inference_capacity row
    // write). The admitter holds that capacity's advisory and row locks, then
    // inserts a capacity_lease whose FK check takes FOR KEY SHARE on the
    // target. Registration must never hold the target in a mode that
    // conflicts with KEY SHARE (the old native upsert SET "userId" took
    // LockTupleExclusive) while it waits on the capacity row.
    if (!databaseUrl) return;
    registrationRetryErrors.length = 0;
    process.env.DATABASE_URL = databaseUrl;
    const suffix = crypto.randomUUID();
    const fixtures = createFixturePrismaClient(databaseUrl);
    const admitter = createFixturePrismaClient(namedUrl(`dl1-reg-admitter-${suffix}`));
    const inspector = createFixturePrismaClient(databaseUrl);
    const user = await fixtures.user.create({
      data: {
        name: "Registration lock order",
        email: `dl1-reg-${suffix}@example.test`,
        slug: `dl1-reg-${suffix}`,
      },
    });
    let admitterSide: Promise<void> | undefined;
    let registrationSide: Promise<unknown> | undefined;
    let release!: () => void;
    const admitterMayInsert = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const token = await fixtures.cliToken.create({
        data: {
          userId: user.id,
          name: "dl1",
          lookupPrefix: `dl1-${suffix}`,
          secretDigest: `dl1-digest-${suffix}`,
        },
      });
      const identity = {
        kind: "cliToken" as const,
        id: token.id,
        userId: user.id,
        lookupPrefix: token.lookupPrefix,
        cliDeviceId: null,
      };
      const endpoints = (maxContextTokens?: number) => [
        {
          slug: "dl1-endpoint",
          label: "DL-1 endpoint",
          kind: "openai-compatible" as const,
          status: "online" as const,
          defaultCapabilities: {
            version: 4 as const,
            protocol: "openai-compatible" as const,
            surfaces: {
              openaiChatCompletions: {
                source: "declared" as const,
                confidence: "exact" as const,
                streaming: true,
                operations: ["create" as const],
                ...(maxContextTokens ? { maxContextTokens } : {}),
              },
            },
          },
          models: [{ upstreamModelId: "dl1/model", capabilityOverrideMode: "inherit" as const }],
        },
      ];
      const { persistRelayRegistration } = await import("../../relay/registration.js");
      await persistRelayRegistration({
        identity,
        cli: { slug: "dl1-cli" },
        endpoints: endpoints(),
        inventoryConfirmed: true,
        endpointTargeting: true,
      });
      const target = await fixtures.executionTarget.findFirstOrThrow({
        where: { userId: user.id, kind: "DISCOVERED_MODEL" },
      });
      const capacityId = target.inferenceCapacityId;
      if (!capacityId) throw new Error("Registration must attach a capacity.");
      expect(
        await fixtures.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      ).toMatchObject({ hardConcurrencyLimit: 1, physicalMaxContext: null });

      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(fixtures, `dl1-reg-${suffix}`);
      const attempt = (name: string) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: name,
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [{ capacityId, executionTargetId: target.id, candidateOrder: 0 }],
      });
      const holder = await store.acquire(attempt("holder"));
      if (holder.state !== "ADMITTED") throw new Error("Expected the holder lease.");
      await expect(store.acquire(attempt("waiter"))).resolves.toMatchObject({ state: "WAITING" });
      const waiting = await fixtures.admissionRequest.findUniqueOrThrow({
        where: { attemptId: `waiter-${suffix}` },
      });

      let admitterReady!: (pid: number) => void;
      const admitterPid = new Promise<number>((resolve) => {
        admitterReady = resolve;
      });
      admitterSide = admitter.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
          const pid = await backendPid(tx);
          await acquireFences(tx, [fences.capacity(capacityId)]);
          await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${capacityId} FOR UPDATE`;
          admitterReady(pid);
          await admitterMayInsert;
          await tx.capacityLease.create({
            data: {
              userId: user.id,
              requestId: waiting.requestId,
              attemptId: waiting.attemptId,
              admissionRequestId: waiting.id,
              capacityId,
              executionTargetId: target.id,
              priority: 16,
              reservationClass: 16,
              fencingToken: 1_000_000n,
              ownerServerInstance: `dl1-reg-${suffix}`,
              heartbeatAt: new Date(),
              expiresAt: new Date(Date.now() + 30_000),
            },
          });
        },
        { timeout: 20_000 },
      );
      const pid = await admitterPid;
      registrationSide = persistRelayRegistration({
        identity,
        cli: { slug: "dl1-cli" },
        endpoints: endpoints(8_192),
        inventoryConfirmed: true,
        endpointTargeting: true,
      });
      // Registration is provably queued behind the admitter's capacity locks
      // before the admitter takes FOR KEY SHARE on the target.
      await waitUntilBlockedBy(inspector, pid);
      release();

      const outcomes = await Promise.allSettled([admitterSide, registrationSide]);
      expect(settledLabels(outcomes)).toEqual(["committed", "committed"]);
      expect(registrationRetryErrors).toEqual([]);
      expect(
        await fixtures.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      ).toMatchObject({ physicalMaxContext: 8_192 });
    } finally {
      release();
      await Promise.allSettled([admitterSide, registrationSide]);
      await cleanupLiveCapacityState(fixtures, user.id);
      await Promise.all([fixtures.$disconnect(), admitter.$disconnect(), inspector.$disconnect()]);
    }
  }, 60_000);

  it("stores engine facts and refreshes only an AUTO limit from engine slots, with a live lease", async () => {
    // S-B (relay 2.7): registration writes engine facts under the
    // capacity-policy / capacity fences it already holds, refreshes an AUTO
    // hard limit from reported slots on every update, and never touches a USER
    // limit.
    if (!databaseUrl) return;
    registrationRetryErrors.length = 0;
    process.env.DATABASE_URL = databaseUrl;
    const suffix = crypto.randomUUID();
    const fixtures = createFixturePrismaClient(databaseUrl);
    const user = await fixtures.user.create({
      data: {
        name: "Engine facts",
        email: `engine-facts-${suffix}@example.test`,
        slug: `engine-facts-${suffix}`,
      },
    });
    try {
      const token = await fixtures.cliToken.create({
        data: {
          userId: user.id,
          name: "engine",
          lookupPrefix: `engine-${suffix}`,
          secretDigest: `engine-digest-${suffix}`,
        },
      });
      const identity = {
        kind: "cliToken" as const,
        id: token.id,
        userId: user.id,
        lookupPrefix: token.lookupPrefix,
        cliDeviceId: null,
      };
      const register = async (slots: number) => {
        const { persistRelayRegistration } = await import("../../relay/registration.js");
        await persistRelayRegistration({
          identity,
          cli: { slug: "engine-cli" },
          endpoints: [
            {
              slug: "engine-endpoint",
              label: "Engine endpoint",
              kind: "openai-compatible" as const,
              status: "online" as const,
              defaultCapabilities: {
                version: 1 as const,
                protocol: "openai-compatible" as const,
                chatCompletions: { supported: true },
              },
              models: [
                { upstreamModelId: "engine/model", capabilityOverrideMode: "inherit" as const },
              ],
              engineFacts: {
                engine: { value: "llama.cpp" as const, source: "probe" as const },
                slots: { value: slots, source: "probe" as const },
                maxModelLen: { value: 32_768, source: "probe" as const },
              },
            },
          ],
          inventoryConfirmed: true,
          endpointTargeting: true,
        });
      };
      await register(3);
      const target = await fixtures.executionTarget.findFirstOrThrow({
        where: { userId: user.id, kind: "DISCOVERED_MODEL" },
      });
      const capacityId = target.inferenceCapacityId;
      if (!capacityId) throw new Error("Registration must attach a capacity.");
      expect(
        await fixtures.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      ).toMatchObject({
        hardConcurrencyLimit: 3,
        hardConcurrencyLimitSource: "AUTO",
        engineKind: "LLAMA_CPP",
        engineSlots: 3,
        maxModelLen: 32_768,
        engineFactsSource: "PROBE",
      });

      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(fixtures, `engine-${suffix}`);
      const holder = await store.acquire({
        requestId: `engine-holder-${suffix}`,
        attemptId: `engine-holder-${suffix}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: "engine-holder",
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [{ capacityId, executionTargetId: target.id, candidateOrder: 0 }],
      });
      expect(holder.state).toBe("ADMITTED");

      // The engine restarted with more slots while a lease is live.
      await register(5);
      expect(
        await fixtures.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      ).toMatchObject({ hardConcurrencyLimit: 5, hardConcurrencyLimitSource: "AUTO" });

      await fixtures.inferenceCapacity.update({
        where: { id: capacityId },
        data: { hardConcurrencyLimit: 2, hardConcurrencyLimitSource: "USER" },
      });
      await register(6);
      expect(
        await fixtures.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      ).toMatchObject({
        hardConcurrencyLimit: 2,
        hardConcurrencyLimitSource: "USER",
        engineSlots: 6,
      });
      expect(registrationRetryErrors).toEqual([]);
    } finally {
      await cleanupLiveCapacityState(fixtures, user.id);
      await fixtures.$disconnect();
    }
  }, 60_000);

  it("expires terminal relay requests while an admitter updates one of them (no 40P01)", async () => {
    // Cross-capacity request and relay row locks. An admitter locks its
    // admission_request row, then updates the relay_request row it references.
    // Retention deletes that terminal relay
    // row, whose ON DELETE SET NULL rewrites the admission row. The delete
    // must never hold the relay row while it waits on the admission row.
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const fixtures = createFixturePrismaClient(databaseUrl);
    const admitter = createFixturePrismaClient(namedUrl(`dl1-relay-admitter-${suffix}`));
    const inspector = createFixturePrismaClient(databaseUrl);
    const user = await fixtures.user.create({
      data: { name: "Relay order", email: `dl1-relay-${suffix}@example.test` },
    });
    let release!: () => void;
    const admitterMayUpdate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitterSide: Promise<void> | undefined;
    try {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const relay = await fixtures.relayRequest.create({
        data: {
          userId: user.id,
          requestedSurface: "OPENAI_CHAT_COMPLETIONS",
          status: "SUCCEEDED",
          createdAt: old,
          startedAt: old,
          completedAt: old,
        },
      });
      const pool = await fixtures.modelPool.create({
        data: {
          userId: user.id,
          slug: `dl1-relay-${suffix}`,
          name: "Relay order",
        },
      });
      const request = await fixtures.admissionRequest.create({
        data: {
          userId: user.id,
          requestId: `dl1-relay-${suffix}`,
          attemptId: `dl1-relay-${suffix}`,
          relayRequestId: relay.id,
          sourceKind: "POOL",
          poolId: pool.id,
          basePriority: 16,
          enqueueSequence: 1n,
          connectionOwner: "dl1",
          heartbeatAt: new Date(),
          state: "ADMITTED",
        },
      });
      let ready!: (pid: number) => void;
      const admitterPid = new Promise<number>((resolve) => {
        ready = resolve;
      });
      admitterSide = admitter.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
          const pid = await backendPid(tx);
          await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ${request.id} FOR UPDATE`;
          await tx.admissionRequest.update({
            where: { id: request.id },
            data: { state: "TERMINAL", terminalAt: new Date() },
          });
          ready(pid);
          await admitterMayUpdate;
          await tx.relayRequest.updateMany({
            where: { id: relay.id },
            data: { admissionTerminalState: "TERMINAL" },
          });
        },
        { timeout: 20_000 },
      );
      const pid = await admitterPid;
      const { deleteExpiredRelayRequests } = await import("../usage-retention.js");
      const retention = deleteExpiredRelayRequests({
        prisma: fixtures,
        now: new Date(),
        retentionDays: 14,
      });
      // Either retention skips the busy row and finishes, or it queues
      // behind the admitter; only then may the admitter touch the relay row.
      await Promise.race([retention.catch(() => undefined), waitUntilBlockedBy(inspector, pid)]);
      release();
      const outcomes = await Promise.allSettled([admitterSide, retention]);
      expect(settledLabels(outcomes)).toEqual(["committed", "committed"]);
      // The busy relay row survives this run and is removed by the next one.
      expect(
        await deleteExpiredRelayRequests({ prisma: fixtures, now: new Date(), retentionDays: 14 }),
      ).toBeGreaterThanOrEqual(0);
      expect(await fixtures.relayRequest.findUnique({ where: { id: relay.id } })).toBeNull();
      expect(
        await fixtures.admissionRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ relayRequestId: null, state: "TERMINAL" });
    } finally {
      release();
      await Promise.allSettled([admitterSide]);
      await Promise.all([fixtures.$disconnect(), admitter.$disconnect(), inspector.$disconnect()]);
    }
  }, 60_000);

  it("admits two overlapping multi-capacity requests from disjoint capacity sets (no 40P01)", async () => {
    // Cross-capacity request locks. Two admitters hold disjoint capacity sets
    // ({c1,c2} and {c3,c4}).
    // Request A waits on c1 and c4, request B on c2 and c3, so each admitter
    // wins one of them on its first capacity and the other on its second.
    // Admission-request row locks must be taken in one global order.
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const fixtures = createFixturePrismaClient(databaseUrl);
    const inspector = createFixturePrismaClient(databaseUrl);
    const gate = createFixturePrismaClient(namedUrl(`dl1-l6-gate-${suffix}`));
    const names = [`dl1-l6-one-${suffix}`, `dl1-l6-two-${suffix}`];
    const attemptCounts = [0, 0];
    const countingClient = (index: number): Client => {
      const client = createFixturePrismaClient(namedUrl(names[index] ?? "dl1-l6"));
      return new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property !== "$transaction" || typeof value !== "function") return value;
          return (...args: unknown[]) => {
            attemptCounts[index] = (attemptCounts[index] ?? 0) + 1;
            return Reflect.apply(value, target, args);
          };
        },
      });
    };
    const clients = [countingClient(0), countingClient(1)];
    const user = await fixtures.user.create({
      data: { name: "cross-capacity order", email: `dl1-cross-${suffix}@example.test` },
    });
    let releaseGate!: () => void;
    const gateMayCommit = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateSide: Promise<void> | undefined;
    let admissions: Promise<unknown>[] = [];
    try {
      const account = await fixtures.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `dl1-l6-${suffix}`,
          baseUrl: "https://example.test",
          endpointIdentity: "https://example.test",
          authType: "BEARER",
        },
      });
      const capacities: string[] = [];
      const targets: string[] = [];
      for (let index = 0; index < 4; index++) {
        const capacity = await fixtures.inferenceCapacity.create({
          data: {
            userId: user.id,
            label: `dl1-l6-${index}-${suffix}`,
            runtimeIdentityKey: `dl1-l6-${index}-${suffix}`,
            runtimeModel: "dl1-l6",
            hardConcurrencyLimit: 1,
          },
        });
        const model = await fixtures.providerModel.create({
          data: {
            userId: user.id,
            providerAccountId: account.id,
            upstreamModelId: `dl1-l6-${index}-${suffix}`,
          },
        });
        const target = await fixtures.executionTarget.create({
          data: {
            userId: user.id,
            kind: "PROVIDER_MODEL",
            providerModelId: model.id,
            inferenceCapacityId: capacity.id,
          },
        });
        capacities.push(capacity.id);
        targets.push(target.id);
      }
      const pool = async (label: string, targetIndexes: number[]) => {
        const created = await fixtures.modelPool.create({
          data: {
            userId: user.id,
            slug: `dl1-l6-${label}-${suffix}`,
            name: label,
            capacityConcurrencyLimit: null,
          },
        });
        const members: Array<{ id: string }> = [];
        // Provider targets are external fallback members (PRIMARY is local-only).
        for (const [order, targetIndex] of targetIndexes.entries())
          members.push(
            await fixtures.poolMember.create({
              data: {
                poolId: created.id,
                executionTargetId: targets[targetIndex] as string,
                tier: "PUBLIC_OVERFLOW",
                publicOrder: order,
                capacityConcurrencyMode: "INHERIT",
              },
            }),
          );
        return {
          id: created.id,
          candidates: targetIndexes.map((targetIndex, order) => ({
            capacityId: capacities[targetIndex] as string,
            executionTargetId: targets[targetIndex] as string,
            poolMemberId: members[order]?.id as string,
            candidateOrder: order,
          })),
        };
      };
      const holders = await Promise.all([0, 1, 2, 3].map((index) => pool(`h${index}`, [index])));
      const poolA = await pool("a", [0, 3]);
      const poolB = await pool("b", [1, 2]);
      const poolC = await pool("c", [0, 1]);
      const poolD = await pool("d", [2, 3]);
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const setupStore = new PostgresCapacityAdmissionStore(fixtures, `dl1-l6-${suffix}`);
      const attempt = (name: string, target: { id: string; candidates: unknown[] }) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL" as const,
        poolId: target.id,
        basePriority: 16,
        connectionOwner: name,
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: target.candidates as never,
      });
      for (const [index, holder] of holders.entries())
        expect(await setupStore.acquire(attempt(`holder-${index}`, holder))).toMatchObject({
          state: "ADMITTED",
        });
      // Enqueue order fixes the FIFO winners: A wins c1/c4, B wins c2/c3.
      for (const [name, target] of [
        ["a", poolA],
        ["b", poolB],
        ["c", poolC],
        ["d", poolD],
      ] as const)
        expect(await setupStore.acquire(attempt(name, target))).toMatchObject({
          state: "WAITING",
        });
      // Free every slot without running the fill, so the next admitters see
      // four available capacities with queued multi-capacity requests.
      await fixtures.capacityLease.updateMany({
        where: { userId: user.id, state: "ACTIVE" },
        data: { state: "RELEASED", releasedAt: new Date(), releaseReason: "test_free" },
      });
      await fixtures.admissionRequest.updateMany({
        where: { userId: user.id, attemptId: { startsWith: "holder-" }, state: "ADMITTED" },
        data: { state: "TERMINAL", terminalAt: new Date() },
      });
      // The gate pauses A's lease insert on c1 and B's on c3 (a disposable
      // trigger waiting on an advisory lock the gate holds), so both
      // admitters pause at their first lease insert, after their first
      // admission-request row lock. (Before DL-1 (d) the lease insert's FK
      // check on pool_member was the pause point; hot-path rows now carry no
      // foreign key into the graph.)
      const gateKey = 16_006_001;
      await fixtures.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION dl1_l6_gate() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          IF (NEW."attemptId" = 'a-${suffix}' AND NEW."capacityId" = '${capacities[0]}')
             OR (NEW."attemptId" = 'b-${suffix}' AND NEW."capacityId" = '${capacities[2]}') THEN
            PERFORM pg_advisory_xact_lock(${gateKey});
          END IF;
          RETURN NEW;
        END $f$`);
      await fixtures.$executeRawUnsafe(
        `CREATE TRIGGER dl1_l6_gate BEFORE INSERT ON capacity_lease FOR EACH ROW EXECUTE FUNCTION dl1_l6_gate()`,
      );
      let gateReady!: () => void;
      const gateLocked = new Promise<void>((resolve) => {
        gateReady = resolve;
      });
      gateSide = gate.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${gateKey})`);
          gateReady();
          await gateMayCommit;
        },
        { timeout: 30_000 },
      );
      await gateLocked;
      const storeOne = new PostgresCapacityAdmissionStore(clients[0], `dl1-l6-one-${suffix}`);
      const storeTwo = new PostgresCapacityAdmissionStore(clients[1], `dl1-l6-two-${suffix}`);
      admissions = [storeOne.acquire(attempt("c", poolC)), storeTwo.acquire(attempt("d", poolD))];
      await waitUntilLockWaiting(inspector, names);
      releaseGate();
      const outcomes = await Promise.allSettled(admissions);
      expect(settledLabels(outcomes)).toEqual(["committed", "committed"]);
      // One transaction attempt each: a deadlock retry would show up here.
      expect(attemptCounts).toEqual([1, 1]);
      const admitted = await fixtures.admissionRequest.findMany({
        where: { userId: user.id, attemptId: { in: [`a-${suffix}`, `b-${suffix}`] } },
        select: { state: true },
      });
      expect(admitted.map((request) => request.state)).toEqual(["ADMITTED", "ADMITTED"]);
    } finally {
      releaseGate();
      await Promise.allSettled([gateSide, ...admissions]);
      await fixtures.$executeRawUnsafe("DROP TRIGGER IF EXISTS dl1_l6_gate ON capacity_lease");
      await fixtures.$executeRawUnsafe("DROP FUNCTION IF EXISTS dl1_l6_gate()");
      await cleanupLiveCapacityState(fixtures, user.id);
      await Promise.all([
        fixtures.$disconnect(),
        inspector.$disconnect(),
        gate.$disconnect(),
        ...clients.map((client) => client.$disconnect()),
      ]);
    }
  }, 60_000);
});

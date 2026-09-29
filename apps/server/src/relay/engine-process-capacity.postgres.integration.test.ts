import { createRouterClient } from "@orpc/server";
import type { Context } from "@ws-model-proxy/api/context";
import type { EngineKindName } from "@ws-model-proxy/api/lib/engine-facts";
import type { Prisma } from "@ws-model-proxy/db";
import { acquireFences, fenceParentDelete, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EndpointInventory } from "./protocol.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL URL required");
const integration = databaseUrl ? describe : describe.skip;
const retries: unknown[] = [];
vi.mock("@ws-model-proxy/api/lib/discovered-inference-capacity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ws-model-proxy/api/lib/discovered-inference-capacity")>();
  return {
    ...actual,
    isInferenceCapacityWriteRetryable: (error: unknown) => {
      if (actual.isInferenceCapacityWriteRetryable(error)) retries.push(error);
      return actual.isInferenceCapacityWriteRetryable(error);
    },
  };
});

// Observe retry predicates so a recovered deadlock cannot hide a broken order.
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...actual,
    isRetryableCapacityTransactionError: (error: unknown) => {
      if (actual.isRetryableCapacityTransactionError(error)) retries.push(error);
      return actual.isRetryableCapacityTransactionError(error);
    },
  };
});

integration("engine process capacity lifecycle", () => {
  let fixture: ReturnType<typeof createFixturePrismaClient>;
  let modules: {
    registration: typeof import("./registration.js");
    lifecycle: typeof import("@ws-model-proxy/api/lib/engine-process-capacity");
    access: typeof import("@ws-model-proxy/api/lib/cli-credential-access");
    router: typeof import("@ws-model-proxy/api/routers/index");
    db: typeof import("@ws-model-proxy/db").default;
    factory: typeof import("@ws-model-proxy/db/client-factory");
    discovered: typeof import("@ws-model-proxy/api/lib/discovered-inference-capacity");
    store: typeof import("../model-api/capacity/postgres-store.js");
  };
  // Fixed input clock; the admission store deliberately owns its database clock.
  const now = new Date("2026-09-29T12:00:00Z");
  const envKeys = ["DATABASE_URL", "NODE_ENV", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] as const;
  const createdUserIds: string[] = [];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("URL required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-thirty-two";
    process.env.BETTER_AUTH_URL = "https://proxy.example.test";
    const [registration, lifecycle, access, router, { default: db }, factory, store, discovered] =
      await Promise.all([
        import("./registration.js"),
        import("@ws-model-proxy/api/lib/engine-process-capacity"),
        import("@ws-model-proxy/api/lib/cli-credential-access"),
        import("@ws-model-proxy/api/routers/index"),
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/client-factory"),
        import("../model-api/capacity/postgres-store.js"),
        import("@ws-model-proxy/api/lib/discovered-inference-capacity"),
      ]);
    modules = { registration, lifecycle, access, router, db, factory, store, discovered };
    fixture = createFixturePrismaClient(databaseUrl);
  });
  afterAll(async () => {
    // Leave no live admission rows for another file sharing this database.
    const where = { userId: { in: createdUserIds } };
    await fixture?.capacityLease.deleteMany({ where });
    await fixture?.capacityWaiter.deleteMany({ where });
    await fixture?.admissionRequest.deleteMany({ where });
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([fixture?.$disconnect(), modules?.db.$disconnect()]);
  });

  async function setup() {
    const suffix = crypto.randomUUID();
    const user = await fixture.user.create({
      data: { name: "capacity lifecycle", email: `${suffix}@example.test`, slug: `u-${suffix}` },
    });
    createdUserIds.push(user.id);
    const token = await fixture.cliToken.create({
      data: {
        userId: user.id,
        name: "test",
        lookupPrefix: suffix,
        secretDigest: `digest-${suffix}`,
      },
    });
    const identity = {
      kind: "cliToken" as const,
      id: token.id,
      userId: user.id,
      cliDeviceId: null,
      lookupPrefix: token.lookupPrefix,
    };
    const register = async (
      engine: EngineKindName = "llama.cpp",
      aliases: string[] | undefined = ["a", "b"],
      ids = ["a", "b"],
      slots: number | null = 1,
      slug = "engine",
    ) => {
      const endpoints: EndpointInventory[] = [
        {
          slug,
          label: "Engine",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true },
          },
          engineFacts: {
            engine: { value: engine, source: "probe" },
            ...(slots === null ? {} : { slots: { value: slots, source: "probe" as const } }),
            ...(aliases
              ? { servedModelAliases: { value: aliases, source: "probe" as const } }
              : {}),
          },
          models: ids.map((upstreamModelId) => ({
            upstreamModelId,
            capabilityOverrideMode: "inherit",
          })),
        },
      ];
      return modules.registration.persistRelayRegistration({
        identity,
        cli: { slug: "desktop" },
        endpoints,
        inventoryConfirmed: true,
        endpointTargeting: true,
        now,
      });
    };
    const targets = () =>
      fixture.executionTarget.findMany({
        where: { userId: user.id },
        include: { InferenceCapacity: true, DiscoveredModel: true },
        orderBy: { DiscoveredModel: { upstreamModelId: "asc" } },
      });
    return { user, register, targets, identity };
  }

  it.each([
    {
      name: "no collision (default endpoint)",
      occupied: [],
      slug: "engine",
      retry: false,
      suffix: "",
    },
    {
      name: "owner uses shared label",
      occupied: ["Engine process engine"],
      slug: "engine",
      retry: false,
      suffix: " (2)",
    },
    {
      name: "first free suffix skips occupied higher suffix",
      occupied: ["Engine process engine", "Engine process engine (3)"],
      slug: "engine",
      retry: false,
      suffix: " (2)",
    },
    {
      name: "owner uses second endpoint label",
      occupied: ["Engine process second"],
      slug: "second",
      retry: false,
      suffix: " (2)",
    },
    {
      name: "many occupied suffixes",
      occupied: [
        "Engine process engine",
        ...Array.from({ length: 31 }, (_, i) => `Engine process engine (${i + 2})`),
      ],
      slug: "engine",
      retry: false,
      suffix: " (33)",
    },
    {
      name: "capacity-key conflict retries whole transaction",
      occupied: ["Engine process engine"],
      slug: "engine",
      retry: true,
      suffix: " (2)",
    },
  ])("allocates durable labels: $name", async ({ occupied, slug, retry, suffix }) => {
    const { user, register } = await setup();
    if (occupied.length === 0) {
      const foreign = (await setup()).user;
      await fixture.inferenceCapacity.create({
        data: {
          userId: foreign.id,
          label: "Engine process engine",
          runtimeIdentityKey: "owner:foreign",
          runtimeModel: "owner",
          hardConcurrencyLimitSource: "USER",
        },
      });
    }
    const owners = [];
    for (const [i, label] of occupied.entries()) {
      owners.push(
        await fixture.inferenceCapacity.create({
          data: {
            userId: user.id,
            label,
            runtimeIdentityKey: `owner:${i}`,
            runtimeModel: "owner",
            hardConcurrencyLimitSource: "USER",
          },
        }),
      );
    }
    if (slug === "second") await register();
    const retryStart = retries.length;
    try {
      if (retry) {
        // nextval survives rollback. Fail the first real process INSERT with
        // 23505, then let the retry succeed: no mocked transaction delegate.
        await fixture.$executeRawUnsafe("CREATE SEQUENCE test_engine_capacity_conflict_seq");
        await fixture.$executeRawUnsafe(`CREATE FUNCTION test_engine_capacity_conflict()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW."runtimeIdentityKey" LIKE 'engine-process:%'
               AND nextval('test_engine_capacity_conflict_seq') = 1 THEN
              RAISE unique_violation USING MESSAGE = 'test capacity-key conflict',
                CONSTRAINT = 'inference_capacity_userId_runtimeIdentityKey_key';
            END IF;
            RETURN NEW;
          END $$`);
        await fixture.$executeRawUnsafe(`CREATE TRIGGER test_engine_capacity_conflict
          BEFORE INSERT ON inference_capacity FOR EACH ROW
          EXECUTE FUNCTION test_engine_capacity_conflict()`);
      }
      if (occupied.length === 0 && slug === "engine") await register();
      else await register("llama.cpp", ["a", "b"], ["a", "b"], 1, slug);
      if (retry) {
        const [sequence] = await fixture.$queryRaw<Array<{ attempts: number }>>`
          SELECT last_value::int AS attempts FROM test_engine_capacity_conflict_seq`;
        expect(sequence?.attempts).toBe(2);
      }
      const endpoint = await fixture.endpoint.findFirstOrThrow({
        where: { userId: user.id, slug },
      });
      const key = `engine-process:${endpoint.id}`;
      const capacity = await fixture.inferenceCapacity.findUniqueOrThrow({
        where: { userId_runtimeIdentityKey: { userId: user.id, runtimeIdentityKey: key } },
      });
      expect(capacity.label).toBe(`Engine process ${slug}${suffix}`);
      expect(capacity.hardConcurrencyLimit).toBe(1);
      expect(
        await fixture.executionTarget.count({ where: { inferenceCapacityId: capacity.id } }),
      ).toBe(2);
      await register("llama.cpp", ["a", "b"], ["a", "b"], 1, slug);
      expect(
        await fixture.inferenceCapacity.findUnique({ where: { id: capacity.id } }),
      ).toMatchObject({
        id: capacity.id,
        label: capacity.label,
        runtimeIdentityKey: key,
        hardConcurrencyLimit: capacity.hardConcurrencyLimit,
      });
      // Repoint/split and sweep still preserve owner labels and remove idle AUTO rows.
      await register("llama.cpp", ["a"], ["a", "b"], 1, slug);
      expect(
        await fixture.executionTarget.count({ where: { inferenceCapacityId: capacity.id } }),
      ).toBe(0);
      await modules.lifecycle.sweepOrphanAutoCapacities();
      expect(await fixture.inferenceCapacity.findUnique({ where: { id: capacity.id } })).toBeNull();
      for (const owner of owners)
        expect(await fixture.inferenceCapacity.findUnique({ where: { id: owner.id } })).toEqual(
          owner,
        );
      if (!retry) expect(retries.slice(retryStart)).toEqual([]);
    } finally {
      if (retry) {
        await fixture.$executeRawUnsafe(
          "DROP TRIGGER IF EXISTS test_engine_capacity_conflict ON inference_capacity",
        );
        await fixture.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_engine_capacity_conflict()");
        await fixture.$executeRawUnsafe(
          "DROP SEQUENCE IF EXISTS test_engine_capacity_conflict_seq",
        );
      }
      retries.splice(retryStart);
    }
  });

  it.each(["discovered-model", "execution-target"] as const)(
    "disambiguates sibling %s creation",
    async (kind) => {
      const { user, register } = await setup();
      await register("generic");
      const endpoint = await fixture.endpoint.findFirstOrThrow({ where: { userId: user.id } });
      const modelId = `label-${crypto.randomUUID()}`;
      const [target] = await fixture.$queryRaw<
        Array<{ targetId: string }>
      >`SELECT 'et_dm_' || md5(${modelId}) AS "targetId"`;
      const targetId = target?.targetId;
      if (!targetId) throw new Error("target id missing");
      const preferred =
        kind === "discovered-model" ? `Discovered model ${modelId}` : `extra (${targetId})`;
      const owner = await fixture.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: preferred,
          runtimeIdentityKey: "owner:collision",
          runtimeModel: "owner",
          hardConcurrencyLimitSource: "USER",
        },
      });
      const id = await modules.db.$transaction(async (tx) => {
        await acquireFences(tx, [fences.owner(user.id)]);
        if (kind === "discovered-model")
          return modules.discovered.ensureDiscoveredInferenceCapacity(tx, {
            userId: user.id,
            discoveredModelId: modelId,
            upstreamModelId: "extra",
          });
        await tx.discoveredModel.create({
          data: {
            id: modelId,
            userId: user.id,
            endpointId: endpoint.id,
            upstreamModelId: "extra",
            encodedModelId: modelId,
          },
        });
        return (await tx.executionTarget.findUniqueOrThrow({ where: { id: targetId } }))
          .inferenceCapacityId;
      });
      if (!id) throw new Error("capacity missing");
      expect((await fixture.inferenceCapacity.findUniqueOrThrow({ where: { id } })).label).toBe(
        `${preferred} (2)`,
      );
      expect(await fixture.inferenceCapacity.findUnique({ where: { id: owner.id } })).toEqual(
        owner,
      );
    },
  );

  it.each([
    {
      name: "long label",
      key: "engine-process:long",
      label: "x".repeat(120),
      source: "AUTO" as const,
      expected: "x".repeat(116) + " (2)",
    },
    {
      name: "owner intent",
      key: "engine-process:owner",
      label: "occupied",
      source: "USER" as const,
      expected: null,
    },
    {
      name: "unknown prefix",
      key: "owner:unknown",
      label: "occupied",
      source: "AUTO" as const,
      expected: null,
    },
    {
      name: "malformed reserved key",
      key: "engine-process:",
      label: "occupied",
      source: "AUTO" as const,
      expected: null,
    },
    {
      name: "empty automatic label",
      key: "engine-process:empty",
      label: "",
      source: "AUTO" as const,
      expected: null,
    },
  ])(
    "bounds allocation and preserves rejection: $name",
    async ({ key, label, source, expected }) => {
      const { user } = await setup();
      const owner = await fixture.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: label || "owner",
          runtimeIdentityKey: "owner:label",
          runtimeModel: "owner",
          hardConcurrencyLimitSource: "USER",
        },
      });
      const insert = () =>
        modules.db.$transaction(async (tx) => {
          await acquireFences(tx, [fences.owner(user.id)]);
          return tx.inferenceCapacity.create({
            data: {
              userId: user.id,
              label,
              runtimeIdentityKey: key,
              runtimeModel: "engine",
              hardConcurrencyLimitSource: source,
            },
          });
        });
      if (expected === null) {
        if (source === "USER" || key.startsWith("owner:"))
          await expect(insert()).rejects.toMatchObject({ code: "P2002" });
        else await expect(insert()).rejects.toThrow("Invalid automatic capacity identity or label");
      } else expect((await insert()).label).toBe(expected);
      expect(await fixture.inferenceCapacity.findUnique({ where: { id: owner.id } })).toEqual(
        owner,
      );
    },
  );

  it("allocates again after cancellation without reserving a label", async () => {
    const { user } = await setup();
    const data = {
      userId: user.id,
      label: "cancelled",
      runtimeIdentityKey: "engine-process:cancelled",
      runtimeModel: "engine",
    };
    // Native INSERT omits provenance, pinning the database AUTO default too
    // (Prisma create supplies its own generated default explicitly).
    const id = crypto.randomUUID();
    const insert = (tx: Prisma.TransactionClient) => tx.$queryRaw<
      Array<{ label: string; hardConcurrencyLimitSource: string }>
    >`INSERT INTO inference_capacity (id, "userId", label, "runtimeIdentityKey", "runtimeModel", "updatedAt")
      VALUES (${id}, ${data.userId}, ${data.label}, ${data.runtimeIdentityKey}, ${data.runtimeModel}, NOW())
      RETURNING label, "hardConcurrencyLimitSource"`;
    await expect(
      modules.db.$transaction(async (tx) => {
        await acquireFences(tx, [fences.owner(user.id)]);
        expect((await insert(tx))[0]?.label).toBe(data.label);
        throw new Error("cancel registration");
      }),
    ).rejects.toThrow("cancel registration");
    expect(await fixture.inferenceCapacity.count({ where: { userId: user.id } })).toBe(0);
    const capacity = await modules.db.$transaction(async (tx) => {
      await acquireFences(tx, [fences.owner(user.id)]);
      return (await insert(tx))[0];
    });
    expect(capacity?.label).toBe(data.label);
    expect(capacity?.hardConcurrencyLimitSource).toBe("AUTO");
  });

  it("merges proven engines, preserves owner choices, splits removed aliases, and repeats idempotently", async () => {
    for (const engine of ["llama.cpp", "vllm", "sglang", "ollama", "lm-studio"] as const) {
      const { user, register, targets } = await setup();
      await register(engine);
      const initial = await targets();
      const dbKind = {
        "llama.cpp": "LLAMA_CPP",
        vllm: "VLLM",
        sglang: "SGLANG",
        ollama: "OLLAMA",
        "lm-studio": "LM_STUDIO",
      }[engine];
      expect(
        initial.every(
          (target) =>
            target.InferenceCapacity?.engineKind === dbKind &&
            target.InferenceCapacity?.engineSlots === 1,
        ),
      ).toBe(true);
      expect(new Set(initial.map((target) => target.inferenceCapacityId)).size).toBe(
        ["ollama", "lm-studio"].includes(engine) ? 2 : 1,
      );
      await register(engine);
      expect((await targets()).map((target) => target.inferenceCapacityId)).toEqual(
        initial.map((target) => target.inferenceCapacityId),
      );
      if (["ollama", "lm-studio"].includes(engine)) continue;
      // A model missing from the next inventory must split too, not remain on S.
      await register(engine, ["a"], ["a"]);
      const split = await targets();
      expect(new Set(split.map((target) => target.inferenceCapacityId)).size).toBe(2);
      expect(
        split.every(
          (target) =>
            target.InferenceCapacity?.runtimeIdentityKey ===
              `discovered-model:${target.discoveredModelId}` ||
            target.InferenceCapacity?.runtimeIdentityKey === `execution-target:${target.id}`,
        ),
      ).toBe(true);
      const first = split[0]!;
      await fixture.inferenceCapacity.update({
        where: { id: first.inferenceCapacityId! },
        data: { hardConcurrencyLimitSource: "USER", hardConcurrencyLimit: null },
      });
      await register(engine);
      expect((await targets())[0]?.inferenceCapacityId).toBe(first.inferenceCapacityId);
      expect(new Set((await targets()).map((target) => target.inferenceCapacityId)).size).toBe(2);
      // An explicit non-auto assignment also survives a valid alias group.
      const ownerCapacity = await fixture.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: "Owner",
          runtimeIdentityKey: "owner",
          runtimeModel: "a",
          hardConcurrencyLimit: 1,
        },
      });
      await fixture.executionTarget.update({
        where: { id: first.id },
        data: { inferenceCapacityId: ownerCapacity.id },
      });
      await register(engine);
      expect((await targets())[0]?.inferenceCapacityId).toBe(ownerCapacity.id);
    }
    expect(retries).toEqual([]);
  });

  it("never joins a target to a shared capacity whose limit the owner took over", async () => {
    const { register, targets } = await setup();
    await register("llama.cpp", ["a", "b", "c", "d"], ["a", "b"]);
    const [a, b] = await targets();
    const sharedId = a?.inferenceCapacityId;
    if (!sharedId || sharedId !== b?.inferenceCapacityId) throw new Error("no shared capacity");
    await fixture.inferenceCapacity.update({
      where: { id: sharedId },
      data: { hardConcurrencyLimitSource: "USER", hardConcurrencyLimit: 4 },
    });
    await register("llama.cpp", ["a", "b", "c", "d"], ["a", "b", "c", "d"]);
    const all = await targets();
    expect(all.map((target) => target.inferenceCapacityId === sharedId)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(all[0]?.InferenceCapacity?.hardConcurrencyLimit).toBe(4);
  });

  it("sizes the shared capacity from engine slots, else from the summed member limits", async () => {
    for (const [slots, expected] of [
      [3, 3],
      [null, 2],
    ] as const) {
      const { register, targets } = await setup();
      await register("vllm", ["a", "b"], ["a", "b"], slots);
      const [first, second] = await targets();
      expect(first?.inferenceCapacityId).toBe(second?.inferenceCapacityId);
      expect(first?.InferenceCapacity?.hardConcurrencyLimit).toBe(expected);
      expect(first?.InferenceCapacity?.label).toBe("Engine process engine");
    }
  });

  it("fails closed when a direct or pool policy cannot fit the destination", async () => {
    for (const policy of ["direct", "pool"]) {
      const { user, register, targets } = await setup();
      await register("generic");
      const [first, second] = await targets();
      if (!first?.inferenceCapacityId) throw new Error("target missing");
      await fixture.inferenceCapacity.update({
        where: { id: first.inferenceCapacityId },
        data: { hardConcurrencyLimit: 5 },
      });
      if (policy === "direct")
        await fixture.executionTarget.update({
          where: { id: first.id },
          data: { directConcurrencyLimit: 5 },
        });
      else {
        const pool = await fixture.modelPool.create({
          data: { userId: user.id, slug: "pool", name: "Pool", capacityConcurrencyLimit: 5 },
        });
        await fixture.poolMember.create({
          data: {
            poolId: pool.id,
            executionTargetId: first.id,
            capacityConcurrencyMode: "INHERIT",
          },
        });
      }
      await register();
      expect((await targets())[0]?.inferenceCapacityId).toBe(first.inferenceCapacityId);
      expect((await targets())[1]?.inferenceCapacityId).not.toBe(second?.inferenceCapacityId);
    }
  });

  it("re-points with live leases/waiters and concurrent admissions without stranding runtime state", async () => {
    for (let round = 0; round < 3; round++) {
      const { user, register, targets } = await setup();
      await register("generic");
      const [a, b] = await targets();
      if (!a?.inferenceCapacityId || !b?.inferenceCapacityId || !a.DiscoveredModel)
        throw new Error("targets missing");
      const old = a.inferenceCapacityId;
      const shared = await fixture.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: "Shared",
          runtimeIdentityKey: `engine-process:${a.DiscoveredModel.endpointId}`,
          runtimeModel: "process",
          hardConcurrencyLimit: 1,
        },
      });
      const store = new modules.store.PostgresCapacityAdmissionStore(modules.db, "lifecycle");
      const attempt = (id: string, capacityId: string, targetId: string) => ({
        requestId: `${user.id}-${id}`,
        attemptId: `${user.id}-${id}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: "test",
        deadlineAt: new Date("2030-01-01T00:00:00Z"),
        candidates: [{ capacityId, executionTargetId: targetId, candidateOrder: 0 }],
      });
      const holder = await store.acquire(attempt("holder", old, a.id));
      expect(holder.state).toBe("ADMITTED");
      expect((await store.acquire(attempt("waiter", old, a.id))).state).toBe("WAITING");
      const gate = modules.factory.createPrismaClient(databaseUrl!);
      let release!: () => void;
      let ready!: (pid: number) => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const gateSide = gate.$transaction(
        async (tx) => {
          await acquireFences(tx, [
            fences.capacityPolicy(a.id),
            fences.capacityPolicy(b.id),
            ...[old, b.inferenceCapacityId!, shared.id].map((id) => fences.capacity(id)),
          ]);
          const [{ pid } = { pid: 0 }] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          ready(pid);
          await released;
        },
        { timeout: 20_000 },
      );
      const pending: Promise<unknown>[] = [];
      try {
        const pid = await locked;
        pending.push(
          register(),
          store.acquire(attempt("old-admit", old, a.id)),
          store.acquire(attempt("new-admit", shared.id, b.id)),
        );
        // Query the actual wait graph. No sleeps establish transaction ordering.
        const deadline = performance.now() + 10_000;
        for (;;) {
          const [{ n } = { n: 0n }] = await fixture.$queryRaw<
            Array<{ n: bigint }>
          >`SELECT count(*) AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
          if (Number(n) >= 3) break;
          if (performance.now() > deadline)
            throw new Error("Concurrent fence waits were not observed");
        }
        release();
        const outcomes = await Promise.allSettled(pending);
        expect(outcomes[0]?.status).toBe("fulfilled");
        // Admission planned against a pre-move FK fails closed; that is the
        // store's existing public contract, not a deadlock or a stranded request.
        for (const outcome of outcomes.slice(1))
          if (outcome.status === "rejected") {
            expect(outcome.reason).toBeInstanceOf(Error);
            expect(outcome.reason.message).toBe(
              "Admission candidate does not belong to the requested owner and capacity.",
            );
          }
        expect(new Set((await targets()).map((target) => target.inferenceCapacityId))).toEqual(
          new Set([shared.id]),
        );
        expect(await fixture.inferenceCapacity.findUnique({ where: { id: old } })).not.toBeNull();
        expect(
          await fixture.capacityLease.findFirst({
            where: { userId: user.id, capacityId: old, state: "ACTIVE" },
          }),
        ).not.toBeNull();
        await store.sweepOrphans({ limit: 200 });
        expect(
          await fixture.capacityWaiter.count({
            where: { userId: user.id, capacityId: old, state: "WAITING" },
          }),
        ).toBe(0);
        const waiter = await fixture.admissionRequest.findUniqueOrThrow({
          where: { attemptId: `${user.id}-waiter` },
        });
        expect(waiter.state).toBe("CANCELLED");
        if (holder.state !== "ADMITTED") throw new Error("lease missing");
        expect(await store.release(holder.lease)).toBe(true);
        expect(
          await fixture.capacityLease.count({
            where: { userId: user.id, capacityId: old, state: "ACTIVE" },
          }),
        ).toBe(0);
        await register();
        expect(await fixture.inferenceCapacity.findUnique({ where: { id: old } })).toBeNull();
      } finally {
        release();
        await Promise.allSettled([gateSide, ...pending]);
        // Release every other acquired lease using its original durable handle.
        await fixture.capacityLease.updateMany({
          where: { userId: user.id, state: "ACTIVE" },
          data: { state: "RELEASED", releasedAt: now, releaseReason: "test_cleanup" },
        });
        await gate.$disconnect();
      }
    }
    expect(retries).toEqual([]);
  }, 60_000);

  it("cleans auto orphans in every parent-delete transaction and preserves shared/owner rows", async () => {
    for (const kind of ["endpoint", "model", "device"] as const) {
      const { user, register, targets, identity } = await setup();
      await register();
      const [a, b] = await targets();
      if (!a?.DiscoveredModel || !b) throw new Error("model missing");
      const capacityId = a.inferenceCapacityId!;
      const store = new modules.store.PostgresCapacityAdmissionStore(modules.db, "parent-delete");
      for (const id of ["holder", "waiter"])
        await store.acquire({
          requestId: `${user.id}-${id}`,
          attemptId: `${user.id}-${id}`,
          ownerId: user.id,
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "parent-delete",
          deadlineAt: new Date("2030-01-01T00:00:00Z"),
          candidates: [{ capacityId, executionTargetId: a.id, candidateOrder: 0 }],
        });

      const owner = await fixture.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: "Owner empty",
          runtimeIdentityKey: "owner:empty",
          runtimeModel: "owner",
        },
      });
      const saved = await fixture.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: "Saved empty",
          runtimeIdentityKey: "discovered-model:saved",
          runtimeModel: "saved",
          hardConcurrencyLimitSource: "USER",
        },
      });
      const endpoint = await fixture.endpoint.findUniqueOrThrow({
        where: { id: a.DiscoveredModel.endpointId },
      });
      await modules.db.$transaction(async (tx) => {
        const capacityIds = await fenceParentDelete(
          tx,
          kind === "endpoint"
            ? { userId: user.id, endpointIds: [endpoint.id] }
            : kind === "device"
              ? { userId: user.id, cliDeviceIds: [endpoint.cliDeviceId] }
              : { userId: user.id, discoveredModelIds: [a.discoveredModelId!] },
        );
        expect(capacityIds).toContain(capacityId);
        const [row] = await tx.$queryRaw<
          Array<{ held: string }>
        >`SELECT current_setting('wsmp.fences', true) AS held`;
        expect(row?.held).toContain(`00:owner:${user.id}`);
        expect(row?.held).toContain(`08:capacity:${capacityId}`);
      });
      const context: Context = {
        services: undefined,
        session: {
          user: { ...user, role: user.role },
          session: {
            id: "test",
            token: "test",
            userId: user.id,
            expiresAt: new Date("2030-01-01T00:00:00Z"),
            createdAt: now,
            updatedAt: now,
          },
        },
      };
      const router = createRouterClient(modules.router.appRouter, { context });
      if (kind === "endpoint")
        await router.forwarderManagement.removeEndpointMetadata({ id: endpoint.id });
      else if (kind === "device")
        await modules.access.deleteCliDeviceAndCredentials({
          userId: user.id,
          cliDeviceId: endpoint.cliDeviceId,
          now,
        });
      else {
        await router.forwarderManagement.removeDiscoveredModelMetadata({
          id: a.discoveredModelId!,
        });
        expect(
          await fixture.inferenceCapacity.findUnique({ where: { id: capacityId } }),
        ).not.toBeNull();
        await router.forwarderManagement.removeDiscoveredModelMetadata({
          id: b.discoveredModelId!,
        });
      }
      expect(await fixture.inferenceCapacity.findUnique({ where: { id: capacityId } })).toBeNull();
      expect(
        await fixture.inferenceCapacity.findUnique({ where: { id: owner.id } }),
      ).not.toBeNull();
      expect(
        await fixture.inferenceCapacity.findUnique({ where: { id: saved.id } }),
      ).not.toBeNull();
      if (kind === "device") {
        const suffix = crypto.randomUUID();
        const fresh = await fixture.cliToken.create({
          data: {
            userId: user.id,
            name: "Re-register",
            lookupPrefix: suffix,
            secretDigest: `digest-${suffix}`,
          },
        });
        identity.id = fresh.id;
        identity.lookupPrefix = fresh.lookupPrefix;
      }
      await register();
      expect(
        await fixture.inferenceCapacity.count({
          where: {
            userId: user.id,
            ExecutionTargets: { none: {} },
            hardConcurrencyLimitSource: "AUTO",
            runtimeIdentityKey: { startsWith: "engine-process:" },
          },
        }),
      ).toBe(0);
    }
  });

  it("guards cleanup by owner, provenance, targets and idle state; sweeps keyset batches idempotently", async () => {
    const { user, register, targets } = await setup();
    const other = (await setup()).user;
    await register("generic");
    const [a] = await targets();
    if (!a?.inferenceCapacityId) throw new Error("target missing");
    const create = (
      id: string,
      userId = user.id,
      source: "AUTO" | "USER" = "AUTO",
      key = `discovered-model:${id}`,
    ) =>
      fixture.inferenceCapacity.create({
        data: {
          userId,
          label: id,
          runtimeIdentityKey: key,
          runtimeModel: id,
          hardConcurrencyLimitSource: source,
          hardConcurrencyLimit: 1,
        },
      });
    const empty = await create("empty");
    const foreign = await create("foreign", other.id);
    const owner = await create("owner", user.id, "AUTO", "owner:key");
    const saved = await create("saved", user.id, "USER");
    const store = new modules.store.PostgresCapacityAdmissionStore(modules.db, "cleanup");
    const result = await store.acquire({
      requestId: user.id,
      attemptId: user.id,
      ownerId: user.id,
      sourceKind: "DIRECT",
      basePriority: 16,
      connectionOwner: "cleanup",
      deadlineAt: new Date("2030-01-01T00:00:00Z"),
      candidates: [
        { capacityId: a.inferenceCapacityId, executionTargetId: a.id, candidateOrder: 0 },
      ],
    });
    expect(result.state).toBe("ADMITTED");
    // Move the fixture only: its old capacity has no target but a live lease.
    const moved = await create("moved");
    await fixture.executionTarget.update({
      where: { id: a.id },
      data: { inferenceCapacityId: moved.id },
    });
    const waiting = await create("waiting");
    const request = await fixture.admissionRequest.create({
      data: {
        userId: user.id,
        requestId: `${user.id}-orphan`,
        attemptId: `${user.id}-orphan`,
        sourceKind: "DIRECT",
        directExecutionTargetId: "gone",
        basePriority: 16,
        enqueueSequence: 1n,
        connectionOwner: "cleanup",
        heartbeatAt: now,
        state: "WAITING",
      },
    });
    await fixture.capacityWaiter.create({
      data: {
        userId: user.id,
        admissionRequestId: request.id,
        requestId: request.requestId,
        attemptId: request.attemptId,
        capacityId: waiting.id,
        executionTargetId: "gone",
        candidateOrder: 0,
        effectiveConcurrencyScope: "DIRECT_TARGET",
        effectiveConcurrencyScopeId: "gone",
        state: "WAITING",
      },
    });
    const ids = [
      empty.id,
      foreign.id,
      owner.id,
      saved.id,
      a.inferenceCapacityId,
      moved.id,
      waiting.id,
    ];
    const remove = (idleOnly?: boolean) =>
      modules.db.$transaction(async (tx) => {
        await acquireFences(tx, [fences.owner(user.id), ...ids.map((id) => fences.capacity(id))]);
        return modules.lifecycle.deleteOrphanAutoCapacities(
          tx,
          user.id,
          ids,
          idleOnly === undefined ? undefined : { idleOnly },
        );
      });
    expect(await remove()).toBe(1);
    for (const id of [foreign.id, owner.id, saved.id, a.inferenceCapacityId, moved.id, waiting.id])
      expect(await fixture.inferenceCapacity.findUnique({ where: { id } })).not.toBeNull();
    for (let i = 0; i < 5; i++) await create(`batch-${i}`);
    await modules.lifecycle.sweepOrphanAutoCapacities({ batchSize: 2 });
    expect(
      await fixture.inferenceCapacity.count({
        where: { userId: user.id, label: { startsWith: "batch-" } },
      }),
    ).toBe(0);
    expect(
      await fixture.inferenceCapacity.findUnique({ where: { id: a.inferenceCapacityId } }),
    ).not.toBeNull();
    expect(await modules.lifecycle.sweepOrphanAutoCapacities({ batchSize: 2 })).toBe(0);
    if (result.state !== "ADMITTED") throw new Error("lease missing");
    await store.release(result.lease);
    expect(await remove(false)).toBe(2);
    // Leave no orphan admission rows behind for other files sharing this database.
    await fixture.capacityWaiter.deleteMany({ where: { userId: user.id } });
    await fixture.admissionRequest.deleteMany({ where: { userId: user.id } });
  });
});

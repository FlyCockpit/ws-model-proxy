import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryAnswers } from "../integration/retry-answers";
import type { RuntimeSpec } from "../lib/runtime-spec";
import { CALLERS, contextFor } from "./lane-c-test-helpers";

// Reservations (`launch.reservations`, table instance_reservation) on real PostgreSQL: a start
// writes them in its fenced transaction and placement counts them (another start cannot take
// the memory); the node views' batched held-claim query counts them; the hardening triggers
// refuse a reservation on another owner's node, a write without the owner fence and a second
// current row per entry; a restart that moves a reservation keeps the old row (superseded) held
// until the new run starts; deleting a reservation node stops the instance (node_delete_release)
// and nulls the row (SET NULL); deleting the instance deletes its rows (CASCADE). Concurrent
// starts on separate sessions never double-book a reservation node, and the node list's held
// claims load in a fixed number of SQL statements whatever the number of nodes.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const RUN = `rv${Date.now().toString(36)}`;
const USER = `${RUN}-user`;
const OTHER = `${RUN}-other`;

/** A single-node runtime on the head label, reserving `memoryGb` on a node with `labels`. */
function spec(name: string, memoryGb: number, reservation: string[] | null): RuntimeSpec {
  return {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: `m-${name}` }],
    launch: {
      management: "process",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb }],
      labels: ["r-head"],
      ...(reservation
        ? { reservations: [{ labels: reservation, resources: { kind: "unified", memoryGb } }] }
        : {}),
      commands: [{ start: "vllm serve m --host 127.0.0.1 --port {{port}}", stop: "true" }],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
    },
  };
}

/** A runtime that runs on the worker nodes themselves (to try to take their memory). */
function onWorker(name: string, memoryGb: number): RuntimeSpec {
  const base = spec(name, memoryGb, null);
  if (!base.launch) throw new Error("no launch");
  return { ...base, launch: { ...base.launch, labels: [] } };
}

integration("reservations on PostgreSQL", () => {
  let modules: {
    prisma: typeof import("@ws-model-proxy/db").default;
    graph: typeof import("../lib/graph-write");
    runtimes: typeof import("./runtimes");
    views: typeof import("../nodes/views");
    reservations: typeof import("../lib/reservations");
  };
  const node: Record<string, string> = {};
  let otherNode = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [db, graph, runtimes, views, reservations] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("../lib/graph-write"),
      import("./runtimes"),
      import("../nodes/views"),
      import("../lib/reservations"),
    ]);
    modules = { prisma: db.default, graph, runtimes, views, reservations };
    for (const id of [USER, OTHER])
      await modules.prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, emailVerified: true },
      });
    // 66 GiB unified nodes (64 usable after the unified headroom).
    await graph.graphWrite([USER], async (tx) => {
      for (const [slug, labels] of [
        ["head", ["r-head"]],
        ["w1", ["r-w1"]],
        ["w2", ["r-w2"]],
        ["wdel", ["r-del"]],
        ["wrace", ["r-race"]],
      ] as const) {
        const created = await tx.node.create({
          data: {
            userId: USER,
            slug: `${RUN}-${slug}`,
            connection: "ONLINE",
            trust: "FULL",
            labels: [...labels],
            declaredResources: { kind: "unified", memoryGb: 66 },
            portStart: 31000,
            portEnd: 31010,
          },
          select: { id: true },
        });
        node[slug] = created.id;
      }
    });
    await graph.graphWrite([OTHER], async (tx) => {
      const created = await tx.node.create({
        data: {
          userId: OTHER,
          slug: `${RUN}-theirs`,
          connection: "ONLINE",
          trust: "FULL",
          labels: ["r-w1"],
          declaredResources: { kind: "unified", memoryGb: 66 },
          portStart: 31000,
          portEnd: 31010,
        },
        select: { id: true },
      });
      otherNode = created.id;
    });
  });

  afterAll(async () => {
    // Remove every row this run seeded, children first, each delete scoped to this run's users.
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    const fixture = createFixturePrismaClient(databaseUrl ?? "");
    try {
      await fixture.runtimeOperation.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
      await fixture.runtimeInstance.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
      await fixture.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
      expect(await fixture.node.count({ where: { userId: { in: [USER, OTHER] } } })).toBe(0);
    } finally {
      await fixture.$disconnect();
      await modules?.prisma.$disconnect();
    }
  });

  const client = (auth = CALLERS.fullAgent(USER)) =>
    createRouterClient(modules.runtimes.runtimesRouter, {
      context: contextFor(auth),
      interceptors: [retryAnswers],
    });

  async function createRuntime(slug: string, body: RuntimeSpec) {
    const created = await client(CALLERS.person(USER)).create({
      slug,
      name: slug,
      kind: "STARTABLE",
      spec: body,
    });
    return created.runtime.id;
  }

  async function reservationRows(instanceId: string) {
    return modules.prisma.instanceReservation.findMany({
      where: { instanceId },
      orderBy: [{ supersededGeneration: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      select: { nodeId: true, index: true, labels: true, supersededGeneration: true },
    });
  }

  /**
   * Whether a 40 GiB rank of `runtimeId` fits on `nodeId` now without stopping anything (a
   * person's preview may stop others to make room; that it would have to says it is held).
   */
  async function fitsOn(runtimeId: string, nodeId: string): Promise<boolean> {
    const preview = await client(CALLERS.person(USER)).start({
      runtimeId,
      nodeIds: [nodeId],
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    return preview.preview.refusals.length === 0 && preview.preview.stops.length === 0;
  }

  async function reservedNowGb(nodeId: string): Promise<number> {
    const [row] = await modules.prisma.node.findMany({
      where: { id: nodeId },
      select: modules.views.nodeSummarySelect,
    });
    if (!row) throw new Error("no node");
    return modules.views.toNodeSummary(row, new Date()).reservedNowMemoryGb ?? 0;
  }

  let reserving = "";
  let reservingInstance = "";
  let taker = "";

  it("a start writes its reservation in its transaction; placement and node views count it", async () => {
    reserving = await createRuntime(`${RUN}-ds`, spec("ds", 40, ["r-w1"]));
    taker = await createRuntime(`${RUN}-taker`, onWorker("taker", 40));
    // Control: before the reservation, the taker fits on w1.
    expect(await fitsOn(taker, node.w1 ?? "")).toBe(true);

    const started = await client().start({ runtimeId: reserving });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    reservingInstance = started.operation.instances[0]?.id ?? "";
    expect(started.operation.instances[0]?.reservations).toEqual([
      expect.objectContaining({ index: 0, nodeId: node.w1, labels: ["r-w1"], reserved: "HELD" }),
    ]);
    expect(await reservationRows(reservingInstance)).toEqual([
      { nodeId: node.w1, index: 0, labels: ["r-w1"], supersededGeneration: null },
    ]);
    // 64 - 40 = 24 GiB left on w1: the taker's 40 GiB no longer fits there.
    expect(await fitsOn(taker, node.w1 ?? "")).toBe(false);
    // Only by stopping the reserving instance (a preview's preemption; not applied here).
    const preview = await client(CALLERS.person(USER)).start({
      runtimeId: taker,
      nodeIds: [node.w1 ?? ""],
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.stops.map((stop) => stop.instanceId)).toEqual([reservingInstance]);
    // The node views' one query (held claims as nested selects) counts the reservation.
    expect(await reservedNowGb(node.w1 ?? "")).toBe(40);
    expect(await reservedNowGb(node.w2 ?? "")).toBe(0);
  });

  it("the hardening triggers refuse a foreign node, a write without the fence and a second current row", async () => {
    const row = {
      instanceId: reservingInstance,
      index: 1,
      labels: ["r-w1"],
      resources: { kind: "unified", memoryGb: 1 },
    };
    // Another owner's node (enforce_instance_node_owner).
    await expect(
      modules.graph.graphWrite([USER], (tx) =>
        tx.instanceReservation.create({ data: { ...row, nodeId: otherNode } }),
      ),
    ).rejects.toThrow(/only on nodes of its owner/);
    // No owner fence (z_graph_write_fence).
    await expect(
      modules.prisma.instanceReservation.create({ data: { ...row, nodeId: node.w2 ?? "" } }),
    ).rejects.toThrow(/instance_reservation requires fence/);
    // A second current row for entry 0 (instance_reservation_current_index).
    await expect(
      modules.graph.graphWrite([USER], (tx) =>
        tx.instanceReservation.create({ data: { ...row, index: 0, nodeId: node.w2 ?? "" } }),
      ),
    ).rejects.toThrow(/Unique constraint|instance_reservation_current_index|23505/);
    // Control: the same row at a free index, on the owner's node, under the fence, is accepted.
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceReservation.create({ data: { ...row, index: 7, nodeId: node.w2 ?? "" } }),
    );
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceReservation.deleteMany({ where: { instanceId: reservingInstance, index: 7 } }),
    );
    expect(await reservationRows(reservingInstance)).toHaveLength(1);
  });

  it("a restart that moves the reservation keeps the old row held until the new run starts", async () => {
    await client(CALLERS.person(USER)).update({
      runtimeId: reserving,
      spec: spec("ds", 40, ["r-w2"]),
    });
    // Generation 1 ran: its START was sent to the head (the old run may still use w1).
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceStep.create({
        data: {
          instanceId: reservingInstance,
          nodeId: node.head ?? "",
          rank: 0,
          phase: "START",
          sequence: 120,
          generation: 1,
          state: "SUCCEEDED",
          attempts: 1,
          intent: {},
          intentHash: "0".repeat(64),
        },
      }),
    );
    // And a gang stop of run 1 that will answer late (after the restart below).
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceStep.create({
        data: {
          instanceId: reservingInstance,
          nodeId: node.head ?? "",
          rank: 0,
          phase: "STOP",
          sequence: 150,
          generation: 1,
          state: "SUCCEEDED",
          attempts: 1,
          intent: {},
          intentHash: "0".repeat(64),
        },
      }),
    );
    const restarted = await client().start({ runtimeId: reserving, instanceId: reservingInstance });
    expect(restarted.mode).toBe("applied");
    // Old (superseded at the run's generation 1) and new, both held.
    expect(await reservationRows(reservingInstance)).toEqual([
      { nodeId: node.w1, index: 0, labels: ["r-w1"], supersededGeneration: 1 },
      { nodeId: node.w2, index: 0, labels: ["r-w2"], supersededGeneration: null },
    ]);
    expect(await fitsOn(taker, node.w1 ?? "")).toBe(false);
    expect(await reservedNowGb(node.w1 ?? "")).toBe(40);
    expect(await reservedNowGb(node.w2 ?? "")).toBe(40);
    // The new run's START is claimed (its leading stop proved the old run stopped).
    await modules.graph.graphWrite([USER], (tx) =>
      modules.reservations.dropSupersededHolds(tx, reservingInstance, 2),
    );
    expect(await reservationRows(reservingInstance)).toEqual([
      { nodeId: node.w2, index: 0, labels: ["r-w2"], supersededGeneration: null },
    ]);
    expect(await fitsOn(taker, node.w1 ?? "")).toBe(true);
    expect(await reservedNowGb(node.w1 ?? "")).toBe(0);
  });

  it("a proof of the run before the restart releases nothing; the current run's does", async () => {
    const [rank] = await modules.prisma.instanceRank.findMany({
      where: { instanceId: reservingInstance },
      select: { id: true, claim: true },
    });
    if (!rank) throw new Error("no rank");
    // Started as run 1, restarted above as run 2.
    expect(rank).toMatchObject({ claim: "HELD" });
    expect(
      (
        await modules.prisma.runtimeInstance.findUniqueOrThrow({
          where: { id: reservingInstance },
          select: { runGeneration: true },
        })
      ).runGeneration,
    ).toBe(2);
    const oldStop = await modules.prisma.instanceStep.findFirstOrThrow({
      where: { instanceId: reservingInstance, phase: "STOP", generation: 1 },
      select: { id: true },
    });
    const release = await import("../lib/claim-release");
    type Tx = import("@ws-model-proxy/db").Prisma.TransactionClient;
    const fenced = <T>(work: (tx: Tx) => Promise<T>) =>
      modules.graph.graphWrite([USER], work, async () =>
        modules.graph.instanceCapacityFences([reservingInstance]),
      );
    // A late stop proof of the run before the restart.
    expect(
      await fenced((tx) =>
        release.releaseClaim(tx, rank.id, new Date(), { result: { stepId: oldStop.id } }),
      ),
    ).toBe(false);
    expect(
      await modules.prisma.instanceRank.findUniqueOrThrow({
        where: { id: rank.id },
        select: { claim: true, stoppedAt: true },
      }),
    ).toEqual({ claim: "HELD", stoppedAt: null });
    // The reservation still holds w2.
    expect(await reservedNowGb(node.w2 ?? "")).toBe(40);
    expect(await fitsOn(taker, node.w2 ?? "")).toBe(false);
    // Control: a gang stop of run 2 that proved the stop releases it (rolled back: later tests
    // use the claim).
    const rolledBack = new Error("roll back");
    await expect(
      fenced(async (tx) => {
        const current = await tx.instanceStep.create({
          data: {
            instanceId: reservingInstance,
            nodeId: node.head ?? "",
            rank: 0,
            phase: "STOP",
            sequence: 250,
            generation: 2,
            state: "SUCCEEDED",
            attempts: 1,
            intent: {},
            intentHash: "0".repeat(64),
          },
        });
        expect(
          await release.releaseClaim(tx, rank.id, new Date(), { result: { stepId: current.id } }),
        ).toBe(true);
        expect(
          await tx.instanceRank.findUniqueOrThrow({
            where: { id: rank.id },
            select: { claim: true },
          }),
        ).toEqual({ claim: "RELEASED" });
        throw rolledBack;
      }),
    ).rejects.toBe(rolledBack);
    expect(
      (await modules.prisma.instanceRank.findUniqueOrThrow({ where: { id: rank.id } })).claim,
    ).toBe("HELD");
    // The run is fenced like the claim: no write of it without the owner and capacity fences.
    await expect(
      modules.prisma.runtimeInstance.update({
        where: { id: reservingInstance },
        data: { runGeneration: 3 },
      }),
    ).rejects.toThrow(/requires fence/);
    await expect(
      modules.graph.graphWrite([USER], (tx) =>
        tx.runtimeInstance.update({
          where: { id: reservingInstance },
          data: { runGeneration: 3 },
        }),
      ),
    ).rejects.toThrow(/requires fence/);
    // A step of an earlier run can no longer be written (instance_step_run_order), nor a run
    // set back (instance_run_order).
    await expect(
      fenced((tx) =>
        tx.instanceStep.create({
          data: {
            instanceId: reservingInstance,
            nodeId: node.head ?? "",
            rank: 0,
            phase: "START",
            sequence: 121,
            generation: 1,
            intent: {},
            intentHash: "0".repeat(64),
          },
        }),
      ),
    ).rejects.toThrow(/current run/);
    await expect(
      fenced((tx) =>
        tx.runtimeInstance.update({
          where: { id: reservingInstance },
          data: { runGeneration: 1 },
        }),
      ),
    ).rejects.toThrow(/never goes back/);
    // A step's generation never changes (instance_step_run_order on UPDATE OF generation; PG3).
    const anyStep = await modules.prisma.instanceStep.findFirstOrThrow({
      where: { instanceId: reservingInstance },
      select: { id: true, generation: true },
    });
    await expect(
      fenced((tx) =>
        tx.instanceStep.update({
          where: { id: anyStep.id },
          data: { generation: anyStep.generation + 1 },
        }),
      ),
    ).rejects.toThrow(/keeps its generation|identity/);
  });

  it("deleting a reservation node stops the instance and nulls the row; deleting the instance deletes its rows", async () => {
    const doomed = await createRuntime(`${RUN}-del`, spec("del", 10, ["r-del"]));
    const started = await client().start({ runtimeId: doomed });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = started.operation.instances[0]?.id ?? "";
    expect((await reservationRows(instanceId)).map((row) => row.nodeId)).toEqual([node.wdel]);

    await modules.graph.graphWrite([USER], (tx) =>
      tx.node.delete({ where: { id: node.wdel ?? "" } }),
    );
    const stopped = await modules.prisma.runtimeInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { desiredState: true, phase: true, phaseReason: true },
    });
    expect(stopped).toEqual({
      desiredState: "STOPPED",
      phase: "STOPPING",
      phaseReason: "node_deleted",
    });
    expect((await reservationRows(instanceId)).map((row) => row.nodeId)).toEqual([null]);
    // The head's claim is untouched by the trigger (its node was not deleted): it is released
    // by the head's stop proof, not here.
    const rank = await modules.prisma.instanceRank.findFirstOrThrow({
      where: { instanceId },
      select: { claim: true },
    });
    expect(rank.claim).toBe("HELD");

    // Instance deletion cascades to its reservations.
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    const fixture = createFixturePrismaClient(databaseUrl ?? "");
    try {
      await fixture.runtimeInstance.deleteMany({ where: { id: instanceId, userId: USER } });
    } finally {
      await fixture.$disconnect();
    }
    expect(await modules.prisma.instanceReservation.count({ where: { instanceId } })).toBe(0);
  });

  it("concurrent starts on separate sessions never double-book a reservation node", async () => {
    // Four runtimes each reserve 40 GiB on wrace (64 GiB usable: room for one), started at
    // once: each start is its own request transaction on its own pooled connection.
    const racers: string[] = [];
    for (const name of ["ra", "rb", "rc", "rd"])
      racers.push(await createRuntime(`${RUN}-${name}`, spec(name, 40, ["r-race"])));
    const outcomes = await Promise.allSettled(
      racers.map((runtimeId) => client().start({ runtimeId })),
    );
    const applied = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(applied.length).toBeGreaterThanOrEqual(1);
    // Every start that did not apply was refused for the memory (never a crash or a deadlock).
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(JSON.stringify(Reflect.get(Object(outcome.reason), "data"))).toMatch(
          /not_enough_memory|resources_held/,
        );
    const holders = await modules.prisma.instanceReservation.findMany({
      where: {
        nodeId: node.wrace,
        Instance: { Ranks: { some: { claim: { not: "RELEASED" } } } },
      },
      select: {
        Instance: { select: { id: true, phase: true, Ranks: { select: { blockedBy: true } } } },
      },
    });
    // At most one run may use the node: any other applied start was placed only by stopping
    // the one before (preempted: STOPPING, its claim held until the stop is proven), and the
    // start that is not stopping waits for every stopping holder (blockedBy) before it runs.
    const live = holders.filter((row) => row.Instance.phase !== "STOPPING");
    const stopping = holders.filter((row) => row.Instance.phase === "STOPPING");
    expect(live).toHaveLength(1);
    expect(holders).toHaveLength(applied.length);
    const waitsFor = new Set(live[0]?.Instance.Ranks.flatMap((rank) => rank.blockedBy) ?? []);
    for (const row of stopping) expect(waitsFor.has(row.Instance.id)).toBe(true);
    // Control: a fifth start sees the node full.
    const after = await createRuntime(`${RUN}-re`, spec("re", 40, ["r-race"]));
    const preview = await client(CALLERS.person(USER)).start({ runtimeId: after, preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals.length > 0 || preview.preview.stops.length > 0).toBe(true);
  });

  it("G1: overlapping starts with their own heads never double-book a shared reservation node", async () => {
    // Each racer has a head of its own (ample room), so the shared reservation node is the only
    // bottleneck: 4 × 40 GiB reservations on 64 usable GiB.
    const heads: string[] = [];
    let shared = "";
    await modules.graph.graphWrite([USER], async (tx) => {
      for (let index = 0; index < 4; index++) {
        const created = await tx.node.create({
          data: {
            userId: USER,
            slug: `${RUN}-gh${index}`,
            connection: "ONLINE",
            trust: "FULL",
            labels: [`r-gh${index}`],
            declaredResources: { kind: "unified", memoryGb: 256 },
            portStart: 31000,
            portEnd: 31010,
          },
          select: { id: true },
        });
        heads.push(created.id);
      }
      shared = (
        await tx.node.create({
          data: {
            userId: USER,
            slug: `${RUN}-gshared`,
            connection: "ONLINE",
            trust: "FULL",
            labels: ["r-gshared"],
            declaredResources: { kind: "unified", memoryGb: 66 },
            portStart: 31000,
            portEnd: 31010,
          },
          select: { id: true },
        })
      ).id;
    });
    const racers: string[] = [];
    for (let index = 0; index < 4; index++) {
      const body = spec(`g${index}`, 40, ["r-gshared"]);
      if (!body.launch) throw new Error("no launch");
      racers.push(
        await createRuntime(`${RUN}-g${index}`, {
          ...body,
          launch: { ...body.launch, labels: [`r-gh${index}`] },
        }),
      );
    }
    // Overlap barrier: the owner fence is held while every start is sent, and each start is
    // seen waiting on a lock before any of them may be admitted.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = modules.graph.graphWrite([USER], async () => {
      entered();
      await gate;
    });
    await holding;
    const starts = racers.map((runtimeId) =>
      client()
        .start({ runtimeId })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
    );
    let waiting = 0;
    for (let poll = 0; poll < 400 && waiting < racers.length; poll++) {
      const [row] = await modules.prisma.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      waiting = Number(row?.waiting ?? 0);
      if (waiting < racers.length) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBeGreaterThanOrEqual(racers.length);
    release();
    await holder;
    const outcomes = await Promise.all(starts);
    const applied = outcomes.filter((outcome) => outcome.ok);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes)
      if (!outcome.ok)
        expect(JSON.stringify(Reflect.get(Object(outcome.error), "data"))).toMatch(
          /not_enough_memory|resources_held/,
        );
    const holders = await modules.prisma.instanceReservation.findMany({
      where: { nodeId: shared, Instance: { Ranks: { some: { claim: { not: "RELEASED" } } } } },
      select: {
        Instance: {
          select: {
            id: true,
            phase: true,
            Ranks: { select: { nodeId: true, blockedBy: true } },
          },
        },
      },
    });
    // Every head is distinct: nothing but the shared reservation decided the outcome.
    const usedHeads = holders.flatMap((row) => row.Instance.Ranks.map((rank) => rank.nodeId));
    expect(new Set(usedHeads).size).toBe(usedHeads.length);
    expect(usedHeads.every((head) => head !== null && heads.includes(head))).toBe(true);
    // One run may use the shared node; another applied start only by stopping it first.
    const live = holders.filter((row) => row.Instance.phase !== "STOPPING");
    expect(live).toHaveLength(1);
    expect(holders).toHaveLength(applied.length);
    const waitsFor = new Set(live[0]?.Instance.Ranks.flatMap((rank) => rank.blockedBy) ?? []);
    for (const row of holders.filter((entry) => entry.Instance.phase === "STOPPING"))
      expect(waitsFor.has(row.Instance.id)).toBe(true);
  });

  it("G1: deleting a node only a superseded reservation is on leaves the instance running", async () => {
    let oldNode = "";
    let newNode = "";
    await modules.graph.graphWrite([USER], async (tx) => {
      for (const [slug, labels] of [
        ["sx-old", ["r-sx-old"]],
        ["sx-new", ["r-sx-new"]],
      ] as const) {
        const created = await tx.node.create({
          data: {
            userId: USER,
            slug: `${RUN}-${slug}`,
            connection: "ONLINE",
            trust: "FULL",
            labels: [...labels],
            declaredResources: { kind: "unified", memoryGb: 66 },
            portStart: 31000,
            portEnd: 31010,
          },
          select: { id: true },
        });
        if (slug === "sx-old") oldNode = created.id;
        else newNode = created.id;
      }
    });
    const runtimeId = await createRuntime(`${RUN}-sx`, spec("sx", 10, ["r-sx-old"]));
    const started = await client().start({ runtimeId });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = started.operation.instances[0]?.id ?? "";
    // Run 1 was dispatched (it may use the old node), then the reservation moves.
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceStep.create({
        data: {
          instanceId,
          nodeId: node.head ?? "",
          rank: 0,
          phase: "START",
          sequence: 120,
          generation: 1,
          state: "SUCCEEDED",
          attempts: 1,
          intent: {},
          intentHash: "0".repeat(64),
        },
      }),
    );
    await client(CALLERS.person(USER)).update({
      runtimeId,
      spec: spec("sx", 10, ["r-sx-new"]),
    });
    const restarted = await client().start({ runtimeId, instanceId });
    expect(restarted.mode).toBe("applied");
    expect(await reservationRows(instanceId)).toEqual([
      { nodeId: oldNode, index: 0, labels: ["r-sx-old"], supersededGeneration: 1 },
      { nodeId: newNode, index: 0, labels: ["r-sx-new"], supersededGeneration: null },
    ]);
    await modules.graph.graphWrite([USER], (tx) => tx.node.delete({ where: { id: oldNode } }));
    // The current plan does not use the deleted node: the restart goes on.
    expect(
      await modules.prisma.runtimeInstance.findUniqueOrThrow({
        where: { id: instanceId },
        select: { desiredState: true, phase: true },
      }),
    ).toEqual({ desiredState: "RUNNING", phase: "STARTING" });
    expect(await reservationRows(instanceId)).toEqual([
      { nodeId: null, index: 0, labels: ["r-sx-old"], supersededGeneration: 1 },
      { nodeId: newNode, index: 0, labels: ["r-sx-new"], supersededGeneration: null },
    ]);
    expect(
      (await modules.prisma.instanceRank.findFirstOrThrow({ where: { instanceId } })).claim,
    ).toBe("HELD");
    // Its run's START (after the leading stop) drops the old row.
    await modules.graph.graphWrite([USER], (tx) =>
      modules.reservations.dropSupersededHolds(tx, instanceId, 2),
    );
    expect((await reservationRows(instanceId)).map((row) => row.nodeId)).toEqual([newNode]);
    // Control: deleting the current plan's node stops it.
    await modules.graph.graphWrite([USER], (tx) => tx.node.delete({ where: { id: newNode } }));
    expect(
      await modules.prisma.runtimeInstance.findUniqueOrThrow({
        where: { id: instanceId },
        select: { desiredState: true, phase: true },
      }),
    ).toEqual({ desiredState: "STOPPED", phase: "STOPPING" });
  });

  it("a restart keeps the running rank's claim (prev*) until the new run starts; the CHECKs hold", async () => {
    const runtimeId = await createRuntime(`${RUN}-prev`, spec("prev", 10, null));
    const started = await client().start({ runtimeId });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = started.operation.instances[0]?.id ?? "";
    const rankOf = () =>
      modules.prisma.instanceRank.findFirstOrThrow({
        where: { instanceId },
        select: {
          id: true,
          resources: true,
          port: true,
          plannedGeneration: true,
          prevResources: true,
          prevPort: true,
          prevGeneration: true,
        },
      });
    const before = await rankOf();
    // Run 1 was dispatched (it may be running), then the runtime grows and restarts.
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceStep.create({
        data: {
          instanceId,
          nodeId: node.head ?? "",
          rank: 0,
          phase: "START",
          sequence: 120,
          generation: 1,
          state: "SUCCEEDED",
          attempts: 1,
          intent: {},
          intentHash: "0".repeat(64),
        },
      }),
    );
    await client(CALLERS.person(USER)).update({ runtimeId, spec: spec("prev", 20, null) });
    const headBefore = await reservedNowGb(node.head ?? "");
    const restarted = await client().start({ runtimeId, instanceId });
    expect(restarted.mode).toBe("applied");
    expect(await rankOf()).toMatchObject({
      resources: { kind: "unified", memoryGb: 20 },
      plannedGeneration: 1,
      prevResources: { kind: "unified", memoryGb: 10 },
      prevPort: before.port,
      prevGeneration: 1,
    });
    // The old run's claim overlaps the new one: the head counts max(10, 20), not 30.
    expect(await reservedNowGb(node.head ?? "")).toBeCloseTo(headBefore + 10);
    // A replaced run's claim is all or nothing, and a released claim holds none.
    await expect(
      modules.graph.graphWrite([USER], (tx) =>
        tx.instanceRank.update({ where: { id: before.id }, data: { prevGeneration: null } }),
      ),
    ).rejects.toThrow(/instance_rank_bounds/);
    await expect(
      modules.graph.graphWrite([USER], (tx) =>
        tx.instanceRank.update({
          where: { id: before.id },
          data: { claim: "RELEASED", stoppedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/instance_rank_claim_shape/);
    // Run 2's START (after its leading stop proved run 1 stopped) drops it.
    await modules.graph.graphWrite([USER], (tx) =>
      modules.reservations.dropSupersededHolds(tx, instanceId, 2),
    );
    expect(await rankOf()).toMatchObject({
      prevResources: null,
      prevPort: null,
      prevGeneration: null,
    });
  });

  it("deleting the runtime's own node keeps its claim while it holds reservations on other nodes", async () => {
    const created: Record<string, string> = {};
    await modules.graph.graphWrite([USER], async (tx) => {
      for (const [slug, labels] of [
        ["hd-head", ["r-hd-head"]],
        ["hd-worker", ["r-hd-worker"]],
      ] as const) {
        const row = await tx.node.create({
          data: {
            userId: USER,
            slug: `${RUN}-${slug}`,
            connection: "ONLINE",
            trust: "FULL",
            labels: [...labels],
            declaredResources: { kind: "unified", memoryGb: 66 },
            portStart: 31000,
            portEnd: 31010,
          },
          select: { id: true },
        });
        created[slug] = row.id;
      }
    });
    const base = spec("hd", 10, ["r-hd-worker"]);
    if (!base.launch) throw new Error("no launch");
    const runtimeId = await createRuntime(`${RUN}-hd`, {
      ...base,
      launch: { ...base.launch, labels: ["r-hd-head"] },
    });
    const started = await client().start({ runtimeId });
    if (started.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = started.operation.instances[0]?.id ?? "";
    const worker = created["hd-worker"] ?? "";
    expect(await reservedNowGb(worker)).toBe(10);
    await modules.graph.graphWrite([USER], (tx) =>
      tx.node.delete({ where: { id: created["hd-head"] ?? "" } }),
    );
    // Nothing can prove the head's process (and what it started on the worker) stopped: the
    // claim stays held with no node, so the worker's reserved memory stays counted.
    expect(
      await modules.prisma.instanceRank.findFirstOrThrow({
        where: { instanceId },
        select: { claim: true, nodeId: true },
      }),
    ).toEqual({ claim: "HELD", nodeId: null });
    expect(
      await modules.prisma.runtimeInstance.findUniqueOrThrow({
        where: { id: instanceId },
        select: { desiredState: true, phase: true, phaseReason: true },
      }),
    ).toEqual({ desiredState: "STOPPED", phase: "STOPPING", phaseReason: "node_deleted" });
    expect(await reservedNowGb(worker)).toBe(10);
    // Control: a runtime without reservations elsewhere is released with its node.
    const solo = await createRuntime(`${RUN}-hd-solo`, {
      ...base,
      launch: { ...base.launch, labels: ["r-hd-worker"], reservations: [] },
    });
    const soloStarted = await client().start({ runtimeId: solo });
    if (soloStarted.mode !== "applied") throw new Error("expected an applied start");
    const soloInstance = soloStarted.operation.instances[0]?.id ?? "";
    await modules.graph.graphWrite([USER], (tx) => tx.node.delete({ where: { id: worker } }));
    expect(
      await modules.prisma.instanceRank.findFirstOrThrow({
        where: { instanceId: soloInstance },
        select: { claim: true, nodeId: true },
      }),
    ).toEqual({ claim: "RELEASED", nodeId: null });
  });

  it("the node list loads every node's held claims in a fixed number of statements", async () => {
    const { createStatementCountingPrismaClient } = await import(
      "@ws-model-proxy/db/test-fixture-client"
    );
    const { client: counting, counter } = createStatementCountingPrismaClient(databaseUrl ?? "");
    try {
      const statementsFor = async (ids: string[]) => {
        await counting.$queryRaw`SELECT 1`;
        const before = counter.statements;
        const rows = await counting.node.findMany({
          where: { userId: USER, id: { in: ids } },
          select: modules.views.nodeListSelect,
          orderBy: { slug: "asc" },
        });
        expect(rows).toHaveLength(ids.length);
        return {
          statements: counter.statements - before,
          reservedGb: rows.map(
            (row) => modules.views.toNodeListRow(row, new Date()).reservedNowMemoryGb,
          ),
        };
      };
      // Every node of this run but the one an earlier case deleted.
      const all = Object.entries(node)
        .filter(([slug]) => slug !== "wdel")
        .map(([, id]) => id);
      expect(all.length).toBeGreaterThanOrEqual(4);
      const one = await statementsFor([node.w2 ?? ""]);
      const many = await statementsFor(all);
      // Batched: one statement per relation level, not one per node.
      expect(many.statements).toBe(one.statements);
      expect(one.statements).toBeGreaterThan(0);
      // And the held claims are there: w2's moved reservation, wrace's race winner.
      expect(one.reservedGb).toEqual([40]);
      expect(many.reservedGb.some((gb) => (gb ?? 0) >= 40)).toBe(true);
    } finally {
      await counting.$disconnect();
    }
  });
});

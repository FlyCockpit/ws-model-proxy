import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryAnswers } from "../integration/retry-answers";
import { CALLERS, contextFor } from "../routers/lane-c-test-helpers";
import type { RuntimeSpec } from "./runtime-spec";

// `physicalLaunchIntents` (one $queryRaw with DISTINCT ON) on real PostgreSQL: per (instance,
// rank) the latest physical launch (a start-phase step dispatched at least once and not refused
// before the node admitted it), newest run first; ranks whose claim was RELEASED, and other
// owners' instances, are left out.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const RUN = `pl${Date.now().toString(36)}`;
const USER = `${RUN}-user`;
const OTHER = `${RUN}-other`;

function spec(name: string, label: string): RuntimeSpec {
  return {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: `m-${name}` }],
    launch: {
      management: "process",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 8 }],
      labels: [label],
      commands: [{ start: "vllm serve m --host 127.0.0.1 --port {{port}}", stop: "true" }],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
    },
  };
}

integration("physicalLaunchIntents on PostgreSQL", () => {
  let modules: {
    prisma: typeof import("@ws-model-proxy/db").default;
    graph: typeof import("./graph-write");
    runtimes: typeof import("../routers/runtimes");
    run: typeof import("./instance-run");
  };
  const node: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [db, graph, runtimes, run] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./graph-write"),
      import("../routers/runtimes"),
      import("./instance-run"),
    ]);
    modules = { prisma: db.default, graph, runtimes, run };
    for (const id of [USER, OTHER])
      await modules.prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, emailVerified: true },
      });
    for (const [owner, slug, label] of [
      [USER, "a", "pl-a"],
      [USER, "b", "pl-b"],
      [OTHER, "theirs", "pl-theirs"],
    ] as const)
      await graph.graphWrite([owner], async (tx) => {
        const created = await tx.node.create({
          data: {
            userId: owner,
            slug: `${RUN}-${slug}`,
            connection: "ONLINE",
            trust: "FULL",
            labels: [label],
            declaredResources: { kind: "unified", memoryGb: 66 },
            portStart: 31000,
            portEnd: 31010,
          },
          select: { id: true },
        });
        node[slug] = created.id;
      });
  });

  afterAll(async () => {
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

  const client = (owner: string, auth = CALLERS.person(owner)) =>
    createRouterClient(modules.runtimes.runtimesRouter, {
      context: contextFor(auth),
      interceptors: [retryAnswers],
    });

  /** A started single-node instance of `owner` on the node labelled `label`. */
  async function started(owner: string, name: string, label: string): Promise<string> {
    const created = await client(owner).create({
      slug: `${RUN}-${name}`,
      name,
      kind: "STARTABLE",
      spec: spec(name, label),
    });
    const start = await client(owner, CALLERS.fullAgent(owner)).start({
      runtimeId: created.runtime.id,
    });
    if (start.mode !== "applied") throw new Error("expected an applied start");
    const instanceId = start.operation.instances[0]?.id;
    if (!instanceId) throw new Error("no instance");
    return instanceId;
  }

  /** A start-phase step of the instance's current run, as dispatch leaves it. */
  async function step(
    owner: string,
    instanceId: string,
    nodeId: string,
    input: {
      phase: "PREPARE" | "START" | "AFTER_JOIN" | "READINESS";
      generation: number;
      sequence: number;
      attempts: number;
      errorCode?: string;
      /** An earlier dispatch of it may have run (`InstanceStep.mayHaveRun`). */
      mayHaveRun?: boolean;
      marker: string;
    },
  ) {
    await modules.graph.graphWrite([owner], (tx) =>
      tx.instanceStep.create({
        data: {
          instanceId,
          nodeId,
          rank: 0,
          phase: input.phase,
          sequence: input.sequence,
          generation: input.generation,
          state: input.errorCode ? "FAILED" : input.attempts > 0 ? "SUCCEEDED" : "CANCELLED",
          attempts: input.attempts,
          errorCode: input.errorCode ?? null,
          mayHaveRun: input.mayHaveRun ?? false,
          intent: { marker: input.marker },
          intentHash: "0".repeat(64),
        },
      }),
    );
  }

  const markers = async (nodeIds: string[]) =>
    (await modules.run.physicalLaunchIntents(modules.prisma, { userId: USER, nodeIds })).map(
      (row) => [row.instanceId, row.rank, row.nodeId, (row.intent as { marker: string }).marker],
    );

  it("returns the latest launch per rank, skipping pre-admission refusals, undispatched steps, released claims and other owners", async () => {
    const live = await started(USER, "live", "pl-a");
    const released = await started(USER, "released", "pl-b");
    const theirs = await started(OTHER, "theirs", "pl-theirs");
    const a = node.a ?? "";
    const b = node.b ?? "";
    const other = node.theirs ?? "";

    // Run 1 of `live`: START then AFTER_JOIN (the latest of run 1).
    await step(USER, live, a, {
      phase: "START",
      generation: 1,
      sequence: 120,
      attempts: 1,
      marker: "g1-start",
    });
    await step(USER, live, a, {
      phase: "AFTER_JOIN",
      generation: 1,
      sequence: 130,
      attempts: 1,
      marker: "g1-join",
    });
    expect(await markers([a])).toEqual([[live, 0, a, "g1-join"]]);

    // Run 2 begins (a restart in place).
    const restart = await client(USER, CALLERS.fullAgent(USER)).start({
      runtimeId: (
        await modules.prisma.runtimeInstance.findUniqueOrThrow({
          where: { id: live },
          select: { runtimeId: true },
        })
      ).runtimeId,
      instanceId: live,
    });
    expect(restart.mode).toBe("applied");
    const { runGeneration } = await modules.prisma.runtimeInstance.findUniqueOrThrow({
      where: { id: live },
      select: { runGeneration: true },
    });
    expect(runGeneration).toBe(2);
    // Refused before the node admitted it (pre-admission), or never dispatched: not launches.
    await step(USER, live, a, {
      phase: "PREPARE",
      generation: 2,
      sequence: 210,
      attempts: 1,
      errorCode: "definition_missing",
      marker: "g2-refused",
    });
    await step(USER, live, a, {
      phase: "START",
      generation: 2,
      sequence: 220,
      attempts: 0,
      marker: "g2-undispatched",
    });
    expect(await markers([a])).toEqual([[live, 0, a, "g1-join"]]);
    // A run-2 launch that ran (it failed after the node admitted it) is now the latest.
    await step(USER, live, a, {
      phase: "READINESS",
      generation: 2,
      sequence: 240,
      attempts: 1,
      errorCode: "readiness_failed",
      marker: "g2-readiness",
    });
    expect(await markers([a])).toEqual([[live, 0, a, "g2-readiness"]]);
    // A replay refused before admission whose earlier dispatch may have run (its session was
    // lost): the refusal proves only the replay never ran, so it is still a launch, the latest.
    await step(USER, live, a, {
      phase: "READINESS",
      generation: 2,
      sequence: 245,
      attempts: 2,
      errorCode: "bad_job",
      mayHaveRun: true,
      marker: "g2-replayed",
    });
    expect(await markers([a])).toEqual([[live, 0, a, "g2-replayed"]]);
    expect(await modules.run.physicalLaunch(modules.prisma, live, 0)).toMatchObject({
      intent: { marker: "g2-replayed" },
    });

    // `released`: launched, then its claim RELEASED: nothing of it.
    await step(USER, released, b, {
      phase: "START",
      generation: 1,
      sequence: 120,
      attempts: 1,
      marker: "rel-start",
    });
    expect(await markers([a, b])).toEqual(
      [
        [live, 0, a, "g2-replayed"],
        [released, 0, b, "rel-start"],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    await modules.graph.graphWrite([USER], (tx) =>
      tx.instanceRank.updateMany({
        where: { instanceId: released },
        data: { claim: "RELEASED", claimChangedAt: new Date(), stoppedAt: new Date() },
      }),
    );
    expect(await markers([a, b])).toEqual([[live, 0, a, "g2-replayed"]]);

    // Another owner's launch is never returned for this owner, whatever nodes are asked for.
    await step(OTHER, theirs, other, {
      phase: "START",
      generation: 1,
      sequence: 120,
      attempts: 1,
      marker: "theirs",
    });
    expect(await markers([a, b, other])).toEqual([[live, 0, a, "g2-replayed"]]);
    expect(
      (
        await modules.run.physicalLaunchIntents(modules.prisma, {
          userId: OTHER,
          nodeIds: [other],
        })
      ).map((row) => row.instanceId),
    ).toEqual([theirs]);
    // No nodes asked: nothing (and no query).
    expect(
      await modules.run.physicalLaunchIntents(modules.prisma, { userId: USER, nodeIds: [] }),
    ).toEqual([]);
  });
});

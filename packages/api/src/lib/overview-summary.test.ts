import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", async () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: await import("../../../db/prisma/generated/internal/prismaNamespace"),
}));

import { emptyLatencyHistogram, latencyBucketIndex } from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { overviewSummary } from "./overview-summary";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const NOW = new Date("2026-10-07T12:20:00.000Z");

function histogram(prefix: string, ...samples: number[]) {
  const counts = emptyLatencyHistogram();
  for (const sample of samples) counts[latencyBucketIndex(sample)]! += 1;
  return Object.fromEntries(counts.map((count, index) => [`${prefix}${index + 1}`, count]));
}

let queries: Prisma.Sql[] = [];

beforeEach(() => {
  mockReset(db);
  queries = [];
  db.user.findUnique.mockResolvedValue({ slug: "alex", onboardingDoneAt: null } as never);
  db.node.findMany.mockResolvedValue([
    {
      id: "n1",
      slug: "desk",
      connection: "ONLINE",
      trust: "FULL",
      trustLowerRequestedAt: new Date(),
      trustChangedAt: null,
    },
  ] as never);
  db.pool.findMany.mockResolvedValue([{ id: "p1", slug: "chat" }] as never);
  db.node.count.mockImplementation((async (args?: { where?: { connection?: string } }) =>
    args?.where?.connection === "ONLINE" ? 0 : 3) as never);
  db.runtime.count.mockResolvedValue(1);
  db.pool.count.mockResolvedValue(1);
  db.mcpGrant.count.mockResolvedValue(0);
  db.apiKey.count.mockResolvedValue(2);
  db.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...parts: unknown[]) => {
    const query = Prisma.sql(strings, ...parts);
    queries.push(query);
    if (query.sql.includes('"poolId" AS pool'))
      return [
        { pool: "p1", t: new Date("2026-10-07T12:00:00.000Z"), requests: 4, errors: 1 },
        { pool: "p1", t: new Date("2026-10-06T13:00:00.000Z"), requests: 2, errors: 0 },
        { pool: "other", t: new Date("2026-10-07T12:00:00.000Z"), requests: 99, errors: 0 },
      ];
    return [
      {
        requests: 8,
        errors: 1,
        cloudRequests: 2,
        ...histogram("l", 900, 1_100),
        ...histogram("t", 150),
      },
    ];
  }) as never);
});

describe("overview summary", () => {
  it("answers KPIs, nodes, pool sparklines and the getting-started state", async () => {
    const summary = await overviewSummary("u1", "24h", NOW);
    expect(summary.kpis).toMatchObject({
      requests: 8,
      errors: 1,
      cloudShare: 0.25,
      p95QueueWaitMs: null,
    });
    expect(summary.kpis.p95LatencyMs).toBeGreaterThan(1_000);
    // A person's pending lower makes the node Relay at once.
    expect(summary.nodes).toEqual([{ id: "n1", slug: "desk", online: true, trust: "RELAY" }]);
    expect(summary).toMatchObject({ nodesTotal: 3, nodesOnline: 0 });
    const [pool] = summary.pools;
    expect(pool).toMatchObject({ id: "p1", callableId: "alex/chat", requests: 6, errors: 1 });
    expect(pool?.sparkline).toHaveLength(24);
    expect(pool?.sparkline[0]).toBe(2);
    expect(pool?.sparkline[23]).toBe(4);
    expect(summary.onboarding).toEqual({
      done: false,
      steps: { node: true, runtime: true, pool: true, agent: false, apiKey: true },
    });
  });

  it("scopes every read to the caller and leaves out tests (Test page and agent)", async () => {
    await overviewSummary("u1", "7d", NOW);
    for (const query of queries) {
      expect(query.sql).toContain(
        `source NOT IN ('TEST'::"RequestSource", 'AGENT_TEST'::"RequestSource")`,
      );
      expect(query.values).toContain("u1");
    }
    expect(queries[0]?.sql).toMatch(/\("ownerUserId" = \S+ OR "requesterUserId" = \S+\)/);
    expect(queries[1]?.sql).toMatch(/WHERE "ownerUserId" = \S+ AND "poolId" = ANY/);
    for (const call of [db.node.findMany, db.pool.findMany])
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
    expect(db.mcpGrant.count).toHaveBeenCalledWith({ where: { userId: "u1", revokedAt: null } });
  });

  it("is done when dismissed, and answers zeros with no traffic and no pools", async () => {
    db.user.findUnique.mockResolvedValue({ slug: "alex", onboardingDoneAt: new Date() } as never);
    db.pool.findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([
      { requests: null, errors: null, cloudRequests: null },
    ] as never);
    const summary = await overviewSummary("u1", "7d", NOW);
    expect(summary.onboarding.done).toBe(true);
    expect(summary.kpis).toEqual({
      requests: 0,
      errors: 0,
      p95LatencyMs: null,
      p95TtftMs: null,
      p95QueueWaitMs: null,
      cloudShare: null,
    });
    expect(summary.pools).toEqual([]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

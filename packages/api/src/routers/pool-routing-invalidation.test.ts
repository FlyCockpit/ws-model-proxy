import { createRouterClient } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidatePoolRouting } from "../lib/pool-routing-invalidation";
import {
  buildContext,
  db,
  fenceParentDelete,
  forwarderManagementRouter,
  prisma,
} from "./forwarder-test-helpers";

const { inferenceContributionsRouter } = await import("./inference-contributions");

// The mutation/commit boundary is mocked; the real router and advisory helper
// run. These assertions concern response/hook semantics, not DB locking/authz.
const extra = prisma as unknown as {
  inferenceContribution: { findUnique: MockInstance; update: MockInstance; findMany: MockInstance };
  discoveredModel: { findFirst: MockInstance };
  poolRoutingRule: { deleteMany: MockInstance; createMany: MockInstance };
  poolMember: { deleteMany: MockInstance };
};

beforeEach(() => {
  vi.resetAllMocks();
  fenceParentDelete.mockResolvedValue([]);
  db.inferenceCapacity.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (work: (tx: typeof db) => unknown) => work(db));
  db.$queryRaw.mockResolvedValue([]);
  db.poolMember.findMany.mockResolvedValue([{ poolId: "pool-id" }]);
  db.poolMember.findUnique.mockResolvedValue({
    id: "member-id",
    poolId: "pool-id",
    tier: "PUBLIC_OVERFLOW",
    ModelPool: {
      userId: "user-id",
      recommendedSurfaceOverride: null,
      protocolAdaptationEnabled: false,
    },
  });
  db.poolMember.delete.mockResolvedValue({ id: "member-id" });
  db.poolMember.updateMany.mockResolvedValue({ count: 1 });
  db.poolMember.findFirst.mockResolvedValue({
    id: "member-id",
    poolId: "pool-id",
    engineLoadMode: "OFF",
  });
  db.modelPool.findFirst.mockResolvedValue({ id: "pool-id", PoolMembers: [] });
  db.modelPool.findMany.mockResolvedValue([]);
  db.modelPool.findUnique.mockResolvedValue({
    recommendedSurfaceOverride: null,
    protocolAdaptationEnabled: false,
    capacityContextCeiling: null,
    capacityContextMargin: 0,
  });
  extra.discoveredModel.findFirst.mockResolvedValue({
    published: true,
    capabilityOverrideMode: "INHERIT",
    capabilityOverrides: [],
    capabilityOverrideMetadata: null,
    Endpoint: {
      published: true,
      status: "ONLINE",
      CliDevice: { status: "CONNECTED" },
      capabilityMetadata: null,
      defaultCapabilities: ["TEXT_GENERATION"],
    },
    ExecutionTarget: { InferenceCapacity: { physicalMaxContext: 32768 } },
  });
  db.poolMember.create.mockResolvedValue({ id: "accepted-member" });
  db.cliDevice.findFirst.mockResolvedValue({ lastHeartbeatAt: null });
  db.cliDevice.updateMany.mockResolvedValue({ count: 1 });
  db.cliDeviceCredential.findMany.mockResolvedValue([]);
  db.cliToken.findMany.mockResolvedValue([]);
  db.cliDevice.delete.mockResolvedValue({ id: "cli-id" });
  db.endpoint.findUnique.mockResolvedValue({
    id: "endpoint-id",
    userId: "user-id",
    lastSeenAt: null,
  });
  db.discoveredModel.findUnique.mockResolvedValue({
    id: "model-id",
    userId: "user-id",
    lastSeenAt: null,
  });
  db.executionTarget.findUnique.mockResolvedValue({
    id: "target-id",
    inferenceCapacityId: "capacity-id",
  });
  extra.inferenceContribution.findMany.mockResolvedValue([{ poolId: "pool-id" }]);
  extra.inferenceContribution.findUnique.mockResolvedValue({
    id: "offer-id",
    poolId: "pool-id",
    discoveredModelId: "model-id",
    contributorUserId: "contributor",
    poolOwnerUserId: "user-id",
    state: "PENDING",
    expiresAt: new Date(Date.now() + 60000),
  });
  db.user.findUnique.mockResolvedValue({
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  });
});

function clients(hook: (id: string) => Promise<void>) {
  const context = { ...buildContext(), services: { onPoolRoutingRulesChanged: hook } };
  return {
    management: createRouterClient(forwarderManagementRouter, { context }),
    contributions: createRouterClient(inferenceContributionsRouter, { context }),
  };
}
const cases = [
  {
    name: "explicit member removal",
    run: (c: ReturnType<typeof clients>) => c.management.removePoolMember({ id: "member-id" }),
    transactional: true,
  },
  {
    name: "rule replacement",
    run: (c: ReturnType<typeof clients>) =>
      c.management.setPoolRoutingRules({ poolId: "pool-id", rules: [] }),
    transactional: true,
  },
  {
    name: "engine load override",
    run: (c: ReturnType<typeof clients>) =>
      c.management.setPoolMemberEngineLoad({ poolMemberId: "member-id", mode: "off" }),
    transactional: false,
  },
  {
    name: "device metadata cascade",
    run: (c: ReturnType<typeof clients>) => c.management.removeCliDeviceMetadata({ id: "cli-id" }),
    transactional: true,
  },
  {
    name: "endpoint metadata cascade",
    run: (c: ReturnType<typeof clients>) =>
      c.management.removeEndpointMetadata({ id: "endpoint-id" }),
    transactional: true,
  },
  {
    name: "model metadata cascade",
    run: (c: ReturnType<typeof clients>) =>
      c.management.removeDiscoveredModelMetadata({ id: "model-id" }),
    transactional: true,
  },
  {
    name: "contribution accept",
    run: (c: ReturnType<typeof clients>) => {
      db.poolMember.findMany.mockResolvedValue([]);
      return c.contributions.accept({ id: "offer-id" });
    },
    transactional: true,
  },
  {
    name: "contribution revoke",
    run: (c: ReturnType<typeof clients>) => c.contributions.revoke({ id: "offer-id" }),
    transactional: true,
  },
];

describe("postcommit routing invalidation callers", () => {
  it.each(cases)("$name succeeds when the postcommit hook rejects", async ({ run }) => {
    let committed = false;
    db.$transaction.mockImplementation(async (work: (tx: typeof db) => unknown) => {
      const result = await work(db);
      committed = true;
      return result;
    });
    db.poolMember.updateMany.mockImplementation(async () => {
      committed = true;
      return { count: 1 };
    });
    const observedCommitStates: boolean[] = [];
    const hook = vi.fn(async () => {
      observedCommitStates.push(committed);
      throw new Error("advisory unavailable");
    });
    await expect(run(clients(hook))).resolves.toBeDefined();
    expect(observedCommitStates).toEqual([true]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith("pool-id");
  });
  it.each(cases)("$name never nudges on a failed mutation", async ({ run, transactional }) => {
    if (transactional) {
      // Reject AFTER executing the callback, emulating commit failure/rollback.
      db.$transaction.mockImplementation(async (work: (tx: typeof db) => unknown) => {
        await work(db);
        throw new Error("commit failed");
      });
    } else db.poolMember.updateMany.mockRejectedValue(new Error("write failed"));
    const hook = vi.fn(async () => {});
    await expect(run(clients(hook))).rejects.toThrow(
      transactional ? "commit failed" : "write failed",
    );
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("central advisory boundary", () => {
  it("deduplicates pools and continues after sync and asynchronous hook failures", async () => {
    const visited: string[] = [];
    await invalidatePoolRouting(
      {
        onPoolRoutingRulesChanged: (id) => {
          visited.push(id);
          if (id === "sync") throw new Error("sync failed");
          if (id === "async") return Promise.reject(new Error("async failed"));
          return Promise.resolve();
        },
      },
      ["sync", "async", "sync", "ok"],
    );
    expect(visited).toEqual(["sync", "async", "ok"]);
  });
  it("succeeds with no relay services", async () => {
    await expect(invalidatePoolRouting(undefined, ["pool-id"])).resolves.toBeUndefined();
  });
});

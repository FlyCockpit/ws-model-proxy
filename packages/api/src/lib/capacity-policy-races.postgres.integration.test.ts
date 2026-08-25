import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
  lockExecutionTargetIdentities,
  lockExecutionTargetPolicies,
} from "./capacity-policy-safety";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("capacity policy two-connection races", () => {
  const first = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  const second = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  let userId = "";
  let capacityId = "";
  let targetIds: string[] = [];
  let poolId = "";
  let memberId = "";

  beforeAll(async () => {
    if (!first) return;
    const suffix = crypto.randomUUID();
    const user = await first.user.create({
      data: {
        name: "Capacity race",
        email: `capacity-race-${suffix}@example.test`,
        slug: `capacity-race-${suffix}`,
      },
    });
    userId = user.id;
    const capacity = await first.inferenceCapacity.create({
      data: {
        userId,
        label: `race-${suffix}`,
        runtimeIdentityKey: `race-${suffix}`,
        runtimeModel: "race-model",
        hardConcurrencyLimit: 8,
        physicalMaxContext: 16_384,
      },
    });
    capacityId = capacity.id;
    const targets = await Promise.all(
      ["a", "b"].map(async (name) => {
        const account = await first.providerAccount.create({
          data: {
            userId,
            providerType: "openai",
            label: `race-${name}-${suffix}`,
            baseUrl: `https://${name}.example.test/v1`,
            endpointIdentity: `https://${name}.example.test/v1`,
            authType: "BEARER",
          },
        });
        const provider = await first.providerModel.create({
          data: {
            userId,
            providerAccountId: account.id,
            upstreamModelId: `race-${name}`,
          },
        });
        return first.executionTarget.create({
          data: {
            userId,
            kind: "PROVIDER_MODEL",
            providerModelId: provider.id,
            inferenceCapacityId: capacity.id,
            directConcurrencyLimit: 4,
            directReservedSlots: 1,
            directContextCeiling: 8_192,
            directContextMargin: 512,
          },
        });
      }),
    );
    targetIds = targets.map((target) => target.id);
    const pool = await first.modelPool.create({
      data: {
        userId,
        slug: `race-${suffix}`,
        name: "Race pool",
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 1,
        capacityContextCeiling: 8_192,
        capacityContextMargin: 512,
      },
    });
    poolId = pool.id;
    const member = await first.poolMember.create({
      data: { poolId, executionTargetId: targetIds[0], tier: "PRIMARY", weight: 1 },
    });
    memberId = member.id;
  });

  afterAll(async () => {
    if (first && userId) await first.user.delete({ where: { id: userId } });
    await Promise.all([first?.$disconnect(), second?.$disconnect()]);
  });

  it("serializes provider physical updates with standard attachment", async () => {
    if (!first || !second) return;
    const identity = "provider-model:race-a";
    const outcomes = await Promise.allSettled([
      first.$transaction(async (tx) => {
        await lockExecutionTargetIdentities(tx, [identity]);
        await lockExecutionTargetPolicies(tx, [targetIds[0]!]);
        await tx.inferenceCapacity.update({
          where: { id: capacityId },
          data: { hardConcurrencyLimit: 6 },
        });
      }),
      second.$transaction(async (tx) => {
        await lockExecutionTargetIdentities(tx, [identity]);
        await lockExecutionTargetPolicies(tx, [targetIds[0]!]);
        const capacity = await tx.inferenceCapacity.findUniqueOrThrow({
          where: { id: capacityId },
        });
        assertEffectiveConcurrencyPolicy({
          hardLimit: capacity.hardConcurrencyLimit,
          poolLimit: 4,
          poolReserved: 1,
        });
      }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
  });

  it("sorts guarded multi-attachment target locks across connections", async () => {
    if (!first || !second) return;
    const outcomes = await Promise.allSettled([
      first.$transaction((tx) => lockExecutionTargetPolicies(tx, targetIds)),
      second.$transaction((tx) => lockExecutionTargetPolicies(tx, [...targetIds].reverse())),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
  });

  it("preserves pool, member, and direct-policy invariants under concurrent writes", async () => {
    if (!first || !second) return;
    const outcomes = await Promise.allSettled([
      first.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${poolId} FOR UPDATE`;
        await lockExecutionTargetPolicies(tx, [targetIds[0]!]);
        await tx.poolMember.update({
          where: { id: memberId },
          data: { capacityReservedSlots: 2 },
        });
      }),
      second.$transaction(async (tx) => {
        await lockExecutionTargetPolicies(tx, [targetIds[0]!]);
        await tx.executionTarget.update({
          where: { id: targetIds[0]! },
          data: { directReservedSlots: 2 },
        });
      }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const [capacity, target, member] = await Promise.all([
      first.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      first.executionTarget.findUniqueOrThrow({ where: { id: targetIds[0]! } }),
      first.poolMember.findUniqueOrThrow({
        where: { id: memberId },
        include: { ModelPool: true },
      }),
    ]);
    assertDirectCapacityPolicy({
      hardLimit: capacity.hardConcurrencyLimit,
      concurrencyLimit: target.directConcurrencyLimit,
      reservedSlots: target.directReservedSlots,
      physicalMaxContext: capacity.physicalMaxContext,
      contextCeiling: target.directContextCeiling,
      contextMargin: target.directContextMargin,
    });
    assertEffectiveConcurrencyPolicy({
      hardLimit: capacity.hardConcurrencyLimit,
      poolLimit: member.ModelPool.capacityConcurrencyLimit,
      poolReserved: member.ModelPool.capacityReservedSlots,
      memberMode: member.capacityConcurrencyMode,
      memberLimit: member.capacityConcurrencyLimit,
      memberReserved: member.capacityReservedSlots,
    });
    assertEffectiveContextPolicy({
      physicalMaxContext: capacity.physicalMaxContext,
      poolCeiling: member.ModelPool.capacityContextCeiling,
      poolMargin: member.ModelPool.capacityContextMargin,
      memberMode: member.capacityContextCeilingMode,
      memberCeiling: member.capacityContextCeiling,
      memberMargin: member.capacityContextMargin,
    });
  });
});

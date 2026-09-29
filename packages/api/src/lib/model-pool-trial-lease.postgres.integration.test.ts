import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

// Every clock below is an explicit `now`: no wall-clock reads, no sleeps.
const T0 = new Date("2026-03-01T00:00:00.000Z");

integration("pool member half-open trial lease (PostgreSQL)", () => {
  let prisma: typeof import("@ws-model-proxy/db").default;
  let routing: typeof import("./model-pool-routing");
  const memberIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    prisma = (await import("@ws-model-proxy/db")).default;
    routing = await import("./model-pool-routing");
    const suffix = crypto.randomUUID();
    const user = await prisma.user.create({
      data: {
        name: "Trial lease",
        email: `trial-lease-${suffix}@example.test`,
        slug: `trial-lease-${suffix}`,
      },
    });
    const capacity = await prisma.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `trial-lease-${suffix}`,
        runtimeIdentityKey: `trial-lease-${suffix}`,
        runtimeModel: "trial-lease",
        hardConcurrencyLimit: 4,
      },
    });
    const account = await prisma.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `trial-lease-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await prisma.providerModel.create({
      data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    const target = await prisma.executionTarget.create({
      data: {
        userId: user.id,
        kind: "PROVIDER_MODEL",
        providerModelId: model.id,
        inferenceCapacityId: capacity.id,
      },
    });
    // One pool and member per case: cases never share a row. Provider targets
    // are external fallback members, which is enough for the claim under test.
    for (let index = 0; index < 8; index += 1) {
      const pool = await prisma.modelPool.create({
        data: {
          userId: user.id,
          slug: `trial-lease-${index}-${suffix}`,
          name: `Trial lease ${index}`,
        },
      });
      const member = await prisma.poolMember.create({
        data: {
          poolId: pool.id,
          executionTargetId: target.id,
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 0,
        },
      });
      memberIds.push(member.id);
    }
  });

  afterAll(async () => {
    // Fixture rows carry unique identities; nothing here is shared or global.
    await prisma?.$disconnect();
  });

  function memberFor(index: number): string {
    return memberIds[index]!;
  }

  async function seed(index: number, startedAt: Date | null) {
    await prisma.poolMember.update({
      where: { id: memberFor(index) },
      data: { healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: startedAt, nextRetryAt: null },
    });
  }

  async function row(index: number) {
    return prisma.poolMember.findUniqueOrThrow({
      where: { id: memberFor(index) },
      select: { healthStatus: true, halfOpenTrialStartedAt: true },
    });
  }

  const lease = () => routing.POOL_MEMBER_HALF_OPEN_LEASE_MS;

  // startedAt offset from `now` (ms, negative = in the past) -> claim count.
  it.each([
    ["never claimed", null, 1],
    ["just claimed", 0, 0],
    ["one ms before the lease elapses", () => -(lease() - 1), 0],
    ["exactly at the lease cutoff", () => -lease(), 1],
    ["one ms past the lease", () => -(lease() + 1), 1],
    ["long stranded", () => -10 * lease(), 1],
  ] as const)("claim when the trial is %s", async (_name, offset, expected) => {
    const startedAt =
      offset === null
        ? null
        : new Date(T0.getTime() + (typeof offset === "function" ? offset() : offset));
    await seed(0, startedAt);
    const count = await routing.markPoolMemberHalfOpenTrial({
      poolMemberId: memberFor(0),
      now: T0,
    });
    expect(count).toBe(expected);
    expect((await row(0)).halfOpenTrialStartedAt).toEqual(expected === 1 ? T0 : startedAt);
  });

  it("agrees with the routing predicate for every offset", () => {
    for (const offset of [0, -(lease() - 1), -lease(), -(lease() + 1)])
      expect(routing.poolMemberTrialLive(new Date(T0.getTime() + offset), T0)).toBe(
        offset > -lease(),
      );
  });

  it("an abandoned claim is reclaimed after the lease and the old holder is fenced out", async () => {
    await seed(1, null);
    // Holder A claims, then never settles (client abort, crash).
    expect(await routing.markPoolMemberHalfOpenTrial({ poolMemberId: memberFor(1), now: T0 })).toBe(
      1,
    );
    const later = new Date(T0.getTime() + lease());
    expect(
      await routing.markPoolMemberHalfOpenTrial({ poolMemberId: memberFor(1), now: later }),
    ).toBe(1);
    // A's late release and late settlement match nothing: B's trial stands.
    expect(
      await routing.releasePoolMemberHalfOpenTrial({
        poolMemberId: memberFor(1),
        trialStartedAt: T0,
      }),
    ).toBe(false);
    expect(
      await routing.settlePoolMemberRecoveryTrial({
        poolMemberId: memberFor(1),
        trialStartedAt: T0,
        healthy: true,
        now: later,
      }),
    ).toBe(false);
    expect(await row(1)).toEqual({ healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: later });
    // B's own release still works and reopens the member.
    expect(
      await routing.releasePoolMemberHalfOpenTrial({
        poolMemberId: memberFor(1),
        trialStartedAt: later,
      }),
    ).toBe(true);
    expect((await row(1)).halfOpenTrialStartedAt).toBeNull();
  });

  it("the release fence still admits exactly one live trial (sequential)", async () => {
    await seed(2, null);
    const first = await routing.markPoolMemberHalfOpenTrial({
      poolMemberId: memberFor(2),
      now: T0,
    });
    const second = await routing.markPoolMemberHalfOpenTrial({
      poolMemberId: memberFor(2),
      now: new Date(T0.getTime() + lease() - 1),
    });
    expect([first, second]).toEqual([1, 0]);
    // The loser's release (it holds no claim) cannot clear the winner's.
    expect(
      await routing.releasePoolMemberHalfOpenTrial({
        poolMemberId: memberFor(2),
        trialStartedAt: new Date(T0.getTime() + lease() - 1),
      }),
    ).toBe(false);
    expect((await row(2)).halfOpenTrialStartedAt).toEqual(T0);
  });

  it.each([
    ["never claimed", null],
    ["expired", () => new Date(T0.getTime() - lease())],
  ] as const)("concurrent claimants on a %s trial: exactly one wins", async (_name, startedAt) => {
    await seed(3, typeof startedAt === "function" ? startedAt() : startedAt);
    const claimants = 8;
    const counts = await Promise.all(
      Array.from({ length: claimants }, (_, index) =>
        routing.markPoolMemberHalfOpenTrial({
          poolMemberId: memberFor(3),
          // Distinct instants inside one lease window: only the timestamp
          // differs, so a second winner would overwrite the first's fence.
          now: new Date(T0.getTime() + index),
        }),
      ),
    );
    expect(counts.filter((count) => count === 1)).toHaveLength(1);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(1);
  });

  it("a released trial is claimable again immediately", async () => {
    await seed(4, null);
    expect(await routing.markPoolMemberHalfOpenTrial({ poolMemberId: memberFor(4), now: T0 })).toBe(
      1,
    );
    expect(
      await routing.releasePoolMemberHalfOpenTrial({
        poolMemberId: memberFor(4),
        trialStartedAt: T0,
      }),
    ).toBe(true);
    expect(
      await routing.markPoolMemberHalfOpenTrial({
        poolMemberId: memberFor(4),
        now: new Date(T0.getTime() + 1),
      }),
    ).toBe(1);
  });
});

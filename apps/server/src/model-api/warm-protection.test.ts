import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: {} }));

const { assessWarmProtection, memberProtectionVerdict, protectedWarmSessions, protectionRouting } =
  await import("./warm-protection.js");
type WarmSession = import("./warm-protection.js").WarmSession;
type WarmProtectionPolicy = import("./warm-protection.js").WarmProtectionPolicy;
type ProtectionVerdict = import("./warm-protection.js").ProtectionVerdict;
type MemberProtectionState = import("./warm-protection.js").MemberProtectionState;

const policy = (overrides: Partial<WarmProtectionPolicy> = {}): WarmProtectionPolicy => ({
  enabled: true,
  windowSeconds: 300,
  minTokens: 8192,
  share: "EQUAL_SHARE",
  fixedPercent: null,
  ...overrides,
});
const session = (
  userId: string,
  ageSeconds: number,
  tokens = 10_000,
  overridePercent: number | null = null,
): WarmSession => ({ userId, ageMs: ageSeconds * 1000, tokens, overridePercent });
const slots = (slotCount: number, active = 0) => ({
  slots: slotCount,
  active,
  kvBudgetTokens: null,
});
const ages = (sessions: readonly WarmSession[]) =>
  sessions.map(({ userId, ageMs }) => `${userId}@${ageMs / 1000}`).sort();

describe("S-C warm-session equity", () => {
  it("EQUAL_SHARE caps each of two active users at half of the member's slots", () => {
    const protectedSessions = protectedWarmSessions(
      [
        session("alice", 10),
        session("alice", 20),
        session("alice", 30),
        session("bob", 5),
        session("bob", 15),
        session("bob", 25),
      ],
      slots(4),
      policy(),
    );
    // Two active users, four slots: two sessions each, newest first.
    expect(ages(protectedSessions)).toEqual(["alice@10", "alice@20", "bob@15", "bob@5"]);
  });

  it("an over-share user's oldest sessions lose protection first", () => {
    const protectedSessions = protectedWarmSessions(
      [session("alice", 200), session("alice", 50), session("alice", 120), session("bob", 1)],
      slots(4),
      policy(),
    );
    // Alice's share is 2 of 4 slots: her 200 s old session is not shielded.
    expect(ages(protectedSessions)).toEqual(["alice@120", "alice@50", "bob@1"]);
  });

  it("every active user keeps at least one protected session", () => {
    const protectedSessions = protectedWarmSessions(
      [session("a", 1), session("b", 2), session("c", 3), session("a", 4)],
      slots(2),
      policy(),
    );
    // floor(2 / 3) = 0 would starve everyone: max(1, ...) keeps one each.
    expect(ages(protectedSessions)).toEqual(["a@1", "b@2", "c@3"]);
  });

  it("an UNPROTECTED grant is never shielded and does not dilute the others", () => {
    const protectedSessions = protectedWarmSessions(
      [
        session("unprotected", 1, 50_000, 0),
        session("alice", 10),
        session("alice", 20),
        session("alice", 30),
      ],
      slots(3),
      policy(),
    );
    expect(protectedSessions.map(({ userId }) => userId)).not.toContain("unprotected");
    // Alice is the only active user: all three slots are hers.
    expect(ages(protectedSessions)).toEqual(["alice@10", "alice@20", "alice@30"]);
  });

  it("small and idle sessions do not count as active users", () => {
    const protectedSessions = protectedWarmSessions(
      [
        session("alice", 10),
        session("alice", 20),
        // Too small, and outside the 5-minute window: neither makes an active user.
        session("small", 1, 4_000),
        session("idle", 301),
      ],
      slots(2),
      policy(),
    );
    expect(ages(protectedSessions)).toEqual(["alice@10", "alice@20"]);
  });

  it("a percent override replaces the pool share for that user", () => {
    const protectedSessions = protectedWarmSessions(
      [
        session("owner", 1, 10_000, 100),
        session("owner", 2, 10_000, 100),
        session("owner", 3, 10_000, 100),
        session("owner", 4, 10_000, 100),
        session("bob", 5),
        session("bob", 6),
      ],
      slots(4),
      policy(),
    );
    // The owner gave themselves 100 %; Bob keeps his equal share (4 / 2 = 2).
    expect(protectedSessions.filter(({ userId }) => userId === "owner")).toHaveLength(4);
    expect(protectedSessions.filter(({ userId }) => userId === "bob")).toHaveLength(2);
  });

  it("FIRST_COME has no per-user cap; FIXED_PERCENT gives each user N %", () => {
    const sessions = [session("alice", 1), session("alice", 2), session("alice", 3)];
    expect(protectedWarmSessions(sessions, slots(4), policy({ share: "FIRST_COME" }))).toHaveLength(
      3,
    );
    expect(
      protectedWarmSessions(
        sessions,
        slots(4),
        policy({ share: "FIXED_PERCENT", fixedPercent: 50 }),
      ),
    ).toHaveLength(2);
  });

  it("token mode caps each user's protected tokens at their share of the KV budget", () => {
    const protectedSessions = protectedWarmSessions(
      [
        session("alice", 1, 30_000),
        session("alice", 2, 30_000),
        session("alice", 3, 30_000),
        session("bob", 4, 90_000),
      ],
      { slots: 8, active: 0, kvBudgetTokens: 100_000 },
      policy(),
    );
    // Share = 50k tokens each: Alice keeps one 30k session, Bob keeps his
    // single (oversized) newest session: never less than one.
    expect(ages(protectedSessions)).toEqual(["alice@1", "bob@4"]);
  });

  it("protects nothing when the pool turned protection off", () => {
    expect(
      protectedWarmSessions([session("alice", 1)], slots(1), policy({ enabled: false })),
    ).toEqual([]);
  });
});

describe("S-C member state", () => {
  const warm = [session("alice", 10)];

  it("slot mode: PROTECTED only when every idle slot holds a protected session", () => {
    const verdict = (active: number, protectedSessions: readonly WarmSession[], limit = 2) =>
      memberProtectionVerdict({
        load: slots(limit, active),
        protectedSessions,
        requestTokens: 1_000,
        affine: false,
      }).state;
    expect(verdict(0, warm)).toBe("FREE"); // two idle slots, one protected
    expect(verdict(1, warm)).toBe("PROTECTED"); // one idle slot, one protected
    expect(verdict(0, [...warm, session("bob", 5)])).toBe("PROTECTED");
    expect(verdict(2, warm)).toBe("FULL");
    expect(verdict(0, [])).toBe("FREE");
  });

  it("a continuation (affinity hit) is never PROTECTED", () => {
    expect(
      memberProtectionVerdict({
        load: slots(1, 0),
        protectedSessions: warm,
        requestTokens: 50_000,
        affine: true,
      }).state,
    ).toBe("FREE");
  });

  it("token mode: W_protected + r against the KV budget minus headroom", () => {
    const verdict = (requestTokens: number) =>
      memberProtectionVerdict({
        load: { slots: 8, active: 1, kvBudgetTokens: 100_000 },
        protectedSessions: [session("alice", 1, 60_000)],
        requestTokens,
        affine: false,
      }).state;
    expect(verdict(30_000)).toBe("FREE"); // 90k <= 90k
    expect(verdict(30_001)).toBe("PROTECTED");
  });

  it("an unknown concurrency cap and KV budget is FREE (nothing to reason about)", () => {
    expect(
      memberProtectionVerdict({
        load: { slots: null, active: 3, kvBudgetTokens: null },
        protectedSessions: warm,
        requestTokens: 1,
        affine: false,
      }).state,
    ).toBe("FREE");
  });
});

describe("S-C decision procedure", () => {
  const verdict = (
    state: MemberProtectionState,
    newestProtectedAgeMs: number | null = null,
    protectedTokens = 0,
  ): ProtectionVerdict => ({
    state,
    protectedSessions: state === "PROTECTED" ? 1 : 0,
    protectedTokens,
    newestProtectedAgeMs,
  });

  it("a new session avoids a PROTECTED member when another member is FREE", () => {
    const candidates = [
      { poolMemberId: "a", affine: false },
      { poolMemberId: "b", affine: false },
    ];
    const verdicts = new Map([
      ["a", verdict("PROTECTED", 10_000)],
      ["b", verdict("FREE")],
    ]);
    expect(protectionRouting({ candidates, verdicts, externalPlan: false })).toEqual({
      order: ["b", "a"],
      initial: ["b", "a"],
      externalFirst: false,
    });
    // With an external plan the PROTECTED member sits out the first admission.
    expect(protectionRouting({ candidates, verdicts, externalPlan: true })).toEqual({
      order: ["b", "a"],
      initial: ["b"],
      externalFirst: false,
    });
  });

  it("never treats the cache holder as PROTECTED, even from a stale verdict", () => {
    const routing = protectionRouting({
      candidates: [
        { poolMemberId: "holder", affine: true },
        { poolMemberId: "b", affine: false },
      ],
      verdicts: new Map([
        ["holder", verdict("PROTECTED", 1_000)],
        ["b", verdict("FULL")],
      ]),
      externalPlan: true,
    });
    expect(routing).toEqual({
      order: ["holder", "b"],
      initial: ["holder", "b"],
      externalFirst: false,
    });
  });

  it("orders PROTECTED members oldest, then cheapest, first", () => {
    const candidates = ["young", "old-big", "old-small"].map((poolMemberId) => ({
      poolMemberId,
      affine: false,
    }));
    const verdicts = new Map([
      ["young", verdict("PROTECTED", 5_000, 10_000)],
      ["old-big", verdict("PROTECTED", 90_000, 80_000)],
      ["old-small", verdict("PROTECTED", 90_000, 20_000)],
    ]);
    expect(protectionRouting({ candidates, verdicts, externalPlan: false }).order).toEqual([
      "old-small",
      "old-big",
      "young",
    ]);
  });

  // Review-loop invariant: every combination of member states on two members,
  // with and without an external plan and an affinity hit, ends in dispatch,
  // queue or external. Never a stuck wait, and never an empty admission.
  const states = ["FREE", "FULL", "PROTECTED", "UNAVAILABLE"] as const;
  const combinations = states.flatMap((first) =>
    states.flatMap((second) =>
      [false, true].flatMap((externalPlan) =>
        [null, "a", "b"].map((affineMember) => ({ first, second, externalPlan, affineMember })),
      ),
    ),
  );
  it.each(combinations)(
    "two members $first/$second (external plan: $externalPlan, affine: $affineMember)",
    ({ first, second, externalPlan, affineMember }) => {
      // UNAVAILABLE members never reach protection (compatibility filter).
      const members = (
        [
          ["a", first],
          ["b", second],
        ] as const
      ).filter(([, state]) => state !== "UNAVAILABLE");
      // An affine member is never PROTECTED (memberProtectionVerdict).
      const effective = (id: string, state: (typeof states)[number]) =>
        id === affineMember && state === "PROTECTED" ? "FREE" : state;
      const candidates = members.map(([poolMemberId]) => ({
        poolMemberId,
        affine: poolMemberId === affineMember,
      }));
      const verdicts = new Map<string, ProtectionVerdict>(
        members.map(([id, state]) => [
          id,
          verdict(effective(id, state) as MemberProtectionState, 1_000),
        ]),
      );
      const routing = protectionRouting({ candidates, verdicts, externalPlan });
      // Every candidate stays routable for the rounds after the first one.
      expect([...routing.order].sort()).toEqual(candidates.map(({ poolMemberId }) => poolMemberId));
      if (candidates.length === 0) return; // no local member: handled before protection
      const anyProtected = members.some(([id, state]) => effective(id, state) === "PROTECTED");
      const canServe = members.some(
        ([id, state]) => id === affineMember || effective(id, state) === "FREE",
      );
      if (routing.externalFirst) {
        // Step 4: only with a plan, only when nothing FREE or affine exists.
        expect(externalPlan && anyProtected && !canServe).toBe(true);
        // If the external attempt does not dispatch, every member is admitted.
        expect(routing.initial).toEqual(routing.order);
        return;
      }
      expect(routing.initial.length).toBeGreaterThan(0);
      if (!externalPlan) expect(routing.initial).toEqual(routing.order);
      // A PROTECTED member is left out only while something else can serve.
      if (routing.initial.length < routing.order.length) expect(canServe).toBe(true);
      // Without a plan, a PROTECTED member always ranks after FREE and FULL ones.
      const lastProtected = routing.order.findIndex(
        (id) => verdicts.get(id)?.state === "PROTECTED",
      );
      if (lastProtected >= 0)
        expect(
          routing.order.slice(lastProtected).every((id) => verdicts.get(id)?.state === "PROTECTED"),
        ).toBe(true);
    },
  );
});

describe("S-C assessment", () => {
  it("combines active leases and the warm set per member KV pool", async () => {
    const load = vi.fn(async () => ({
      activeByCapacity: new Map([["cap-a", 0]]),
      sessionsByCapacity: new Map([["cap-a", [session("alice", 10)]]]),
    }));
    const verdicts = await assessWarmProtection({
      ownerId: "owner",
      policy: policy(),
      members: [
        {
          poolMemberId: "a",
          capacityId: "cap-a",
          slots: 1,
          kvBudgetTokens: null,
          affine: false,
          requestTokens: 100,
        },
        {
          poolMemberId: "a-continuation",
          capacityId: "cap-a",
          slots: 1,
          kvBudgetTokens: null,
          affine: true,
          requestTokens: 100,
        },
        {
          poolMemberId: "b",
          capacityId: "cap-b",
          slots: 1,
          kvBudgetTokens: null,
          affine: false,
          requestTokens: 100,
        },
      ],
      source: { load },
    });
    expect(load).toHaveBeenCalledWith({
      ownerId: "owner",
      capacityIds: ["cap-a", "cap-b"],
      policy: policy(),
    });
    expect(verdicts.get("a")?.state).toBe("PROTECTED");
    expect(verdicts.get("a-continuation")?.state).toBe("FREE");
    expect(verdicts.get("b")?.state).toBe("FREE");
  });

  it("reads nothing when protection is off", async () => {
    const load = vi.fn();
    const verdicts = await assessWarmProtection({
      ownerId: "owner",
      policy: policy({ enabled: false }),
      members: [
        {
          poolMemberId: "a",
          capacityId: "cap-a",
          slots: 1,
          kvBudgetTokens: null,
          affine: false,
          requestTokens: 1,
        },
      ],
      source: { load },
    });
    expect(verdicts.size).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
});

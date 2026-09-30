import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: {} }));

const {
  LLAMA_CPP_WINDOW_FACTOR,
  assessWarmProtection,
  memberProtectionVerdict,
  protectedWarmSessions,
  protectionKvBudgetTokens,
  protectionRouting,
  protectionWindowSecondsFor,
} = await import("./warm-protection.js");
type ProtectionEngineKind = import("./warm-protection.js").ProtectionEngineKind;
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
  inFlight = false,
): WarmSession => ({ userId, ageMs: ageSeconds * 1000, tokens, overridePercent, inFlight });
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

  it("a user's override does not depend on which pool served the newest session", () => {
    // Same user, two pools of one KV pool: the newest session inherits, an older one
    // carries 100%. The explicit override applies whatever the order.
    const sessions = [
      session("alice", 10, 10_000, null),
      session("alice", 20, 10_000, 100),
      session("alice", 30, 10_000, null),
      session("bob", 5),
    ];
    const protectedSessions = protectedWarmSessions(sessions, slots(4), policy());
    expect(ages(protectedSessions)).toEqual(["alice@10", "alice@20", "alice@30", "bob@5"]);
    expect(ages(protectedWarmSessions([...sessions].reverse(), slots(4), policy()))).toEqual(
      ages(protectedSessions),
    );
  });

  it.each([
    // [label, overrides newest-first, share, slots, expected protected count]
    ["100% pool A does not widen 25% pool B", [100, 25, 25, 25], "EQUAL_SHARE", 4, 2],
    [
      "explicit 25% does not suppress inherited FIRST_COME",
      [25, null, null, null],
      "FIRST_COME",
      4,
      4,
    ],
    [
      "two explicit values: the user total stays within the larger share",
      [25, 75, 75, 75, 25],
      "EQUAL_SHARE",
      4,
      3,
    ],
    ["the largest bucket bounds the user total", [50, 50, 100, 100], "EQUAL_SHARE", 4, 4],
    ["a bucket always keeps its first session", [10, 10, 10], "EQUAL_SHARE", 4, 1],
    ["inherit shares the pool with an explicit bucket", [null, null, 25, 25], "EQUAL_SHARE", 4, 3],
  ] as const)("cross-pool overrides: %s", (_label, overrides, share, slotCount, expected) => {
    const sessions = overrides.map((override, index) =>
      session("alice", 10 + index, 10_000, override),
    );
    expect(protectedWarmSessions(sessions, slots(slotCount), policy({ share }))).toHaveLength(
      expected,
    );
    expect(
      protectedWarmSessions([...sessions].reverse(), slots(slotCount), policy({ share })),
    ).toHaveLength(expected);
  });

  it("token mode applies each override bucket and the user total to the KV budget", () => {
    const load = { slots: null, active: 0, kvBudgetTokens: 100_000 };
    const sessions = [
      session("alice", 10, 30_000, 100),
      session("alice", 20, 30_000, 25),
      session("alice", 30, 30_000, 25),
      session("alice", 40, 30_000, 100),
    ];
    // Bucket 25% of 100k holds one 30k session (the second would be 60k > 25k);
    // bucket 100% holds both of its own; the user total 100k holds three.
    expect(ages(protectedWarmSessions(sessions, load, policy()))).toEqual([
      "alice@10",
      "alice@20",
      "alice@40",
    ]);
  });

  it("token mode: over the share the user's OLDER sessions lose protection first (closure is sticky)", () => {
    const load = { slots: null, active: 0, kvBudgetTokens: 100_000 };
    // Two active users: alice's share is 50k. 30k fits, the second 30k overflows,
    // so the older 10k (which would fit on its own) must not be protected.
    const user = [
      session("alice", 10, 30_000),
      session("alice", 20, 30_000),
      session("alice", 30, 10_000),
      session("bob", 5, 10_000),
    ];
    expect(ages(protectedWarmSessions(user, load, policy()))).toEqual(["alice@10", "bob@5"]);
    // The same per override bucket: bucket 25% (25k) keeps the 20k, not the older 4k.
    const buckets = [
      session("alice", 5, 10_000, 100),
      session("alice", 10, 20_000, 25),
      session("alice", 20, 20_000, 25),
      session("alice", 30, 4_000, 25),
    ];
    expect(ages(protectedWarmSessions(buckets, load, policy({ minTokens: 0 })))).toEqual([
      "alice@10",
      "alice@5",
    ]);
  });

  it("a bucket that only fits its first session does not stop the user's other buckets", () => {
    const load = { slots: 4, active: 0, kvBudgetTokens: null };
    const sessions = [
      session("alice", 10, 10_000, 25),
      session("alice", 20, 10_000, 25),
      session("alice", 30, 10_000, 100),
    ];
    expect(ages(protectedWarmSessions(sessions, load, policy()))).toEqual(["alice@10", "alice@30"]);
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

  // Slot mode compares the IDLE slots (C - a) with the protected sessions no
  // active lease is serving. Literal rows, C = 4: [protected sessions idle,
  // protected sessions in flight] -> the verdict for a = 0..4 active leases.
  // An in-flight session is served by one of the `a` leases, so it never
  // fills an idle slot; `p >= C` (or the old `min(p, C) >= idle`) gets the
  // in-flight rows wrong in opposite directions.
  const slotTable: {
    idle: number;
    inFlight: number;
    byActive: [
      MemberProtectionState,
      MemberProtectionState,
      MemberProtectionState,
      MemberProtectionState,
      MemberProtectionState,
    ];
  }[] = [
    { idle: 0, inFlight: 0, byActive: ["FREE", "FREE", "FREE", "FREE", "FULL"] },
    { idle: 1, inFlight: 0, byActive: ["FREE", "FREE", "FREE", "PROTECTED", "FULL"] },
    { idle: 2, inFlight: 0, byActive: ["FREE", "FREE", "PROTECTED", "PROTECTED", "FULL"] },
    {
      idle: 4,
      inFlight: 0,
      byActive: ["PROTECTED", "PROTECTED", "PROTECTED", "PROTECTED", "FULL"],
    },
    // Only in-flight sessions: every idle slot is empty, whatever `a` is.
    { idle: 0, inFlight: 2, byActive: ["FREE", "FREE", "FREE", "FREE", "FULL"] },
    { idle: 0, inFlight: 4, byActive: ["FREE", "FREE", "FREE", "FREE", "FULL"] },
    { idle: 2, inFlight: 2, byActive: ["FREE", "FREE", "PROTECTED", "PROTECTED", "FULL"] },
    { idle: 3, inFlight: 1, byActive: ["FREE", "PROTECTED", "PROTECTED", "PROTECTED", "FULL"] },
    { idle: 1, inFlight: 3, byActive: ["FREE", "FREE", "FREE", "PROTECTED", "FULL"] },
  ];
  it.each(
    slotTable.flatMap(({ idle, inFlight, byActive }) =>
      byActive.map((expected, active) => ({ idle, inFlight, active, expected })),
    ),
  )(
    "slot mode C=4 a=$active with $idle idle and $inFlight in-flight protected: $expected",
    ({ idle, inFlight, active, expected }) => {
      const sessions = [
        ...Array.from({ length: idle }, (_, index) => session(`idle${index}`, 10 + index)),
        ...Array.from({ length: inFlight }, (_, index) =>
          session(`busy${index}`, 5 + index, 10_000, null, true),
        ),
      ];
      const result = memberProtectionVerdict({
        load: slots(4, active),
        protectedSessions: sessions,
        requestTokens: 1_000,
        affine: false,
      });
      expect(result.state).toBe(expected);
      // The count the verdict compared is reported too.
      expect(result.idleProtectedSessions).toBe(idle);
      expect(result.protectedSessions).toBe(idle + inFlight);
    },
  );

  it("C1b-1: two conversations mid-turn do not make a half-busy member PROTECTED", () => {
    // C=4, a=2: alice's and bob's warm conversations are running right now.
    // Both idle slots are empty, so a new :external session is admitted there
    // instead of going external.
    const load = slots(4, 2);
    const busy = [session("alice", 10, 10_000, null, true), session("bob", 12, 10_000, null, true)];
    const verdict = memberProtectionVerdict({
      load,
      protectedSessions: protectedWarmSessions(busy, load, policy()),
      requestTokens: 1_000,
      affine: false,
    });
    expect(verdict.state).toBe("FREE");
    expect(
      protectionRouting({
        candidates: [{ poolMemberId: "only", affine: false }],
        verdicts: new Map([["only", verdict]]),
        externalPlan: true,
      }),
    ).toEqual({ order: ["only"], initial: ["only"], externalFirst: false });
  });

  it("token mode counts in-flight sessions: their KV is still in the pool", () => {
    expect(
      memberProtectionVerdict({
        load: { slots: 8, active: 1, kvBudgetTokens: 100_000 },
        protectedSessions: [session("alice", 1, 85_000, null, true)],
        requestTokens: 10_000,
        affine: false,
      }).state,
    ).toBe("PROTECTED");
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
    idleProtectedSessions: state === "PROTECTED" ? 1 : 0,
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
  it.each([
    {
      name: "only the matched session",
      matched: "own",
      target: "target-a",
      extra: false,
      otherTarget: false,
      state: "FREE",
    },
    {
      name: "other own conversation remains protected",
      matched: "own",
      target: "target-a",
      extra: true,
      otherTarget: false,
      state: "PROTECTED",
    },
    {
      name: "same id on another target stays protected",
      matched: "own",
      target: "target-a",
      extra: false,
      otherTarget: true,
      state: "PROTECTED",
    },
    {
      name: "missing identity defaults to protection",
      matched: undefined,
      target: "target-a",
      extra: false,
      otherTarget: false,
      state: "PROTECTED",
    },
    {
      name: "missing target defaults to protection",
      matched: "own",
      target: undefined,
      extra: false,
      otherTarget: false,
      state: "PROTECTED",
    },
  ])("session-only continuation: $name", async ({ matched, target, extra, otherTarget, state }) => {
    const own = {
      ...session("requester", 10),
      sessionId: "own",
      executionTargetId: otherTarget ? "target-b" : "target-a",
    };
    const other = {
      ...session("requester", 20),
      sessionId: "other",
      executionTargetId: "target-a",
    };
    const verdicts = await assessWarmProtection({
      ownerId: "owner",
      policy: policy({ share: "FIRST_COME" }),
      members: [
        {
          poolMemberId: "a",
          capacityId: "cap",
          slots: 1,
          kvBudgetTokens: null,
          executionTargetId: target,
          matchedSessionId: matched,
          affine: false,
          requestTokens: 100,
        },
      ],
      source: {
        load: async () => ({
          activeByCapacity: new Map(),
          sessionsByCapacity: new Map([["cap", extra ? [own, other] : [own]]]),
        }),
      },
    });
    expect(verdicts.get("a")?.state).toBe(state);
    expect(verdicts.get("a")?.protectedSessions).toBe(state === "FREE" ? 0 : 1);
  });

  it.each([
    {
      name: "share caps precede exclusion",
      slots: 1,
      budget: null,
      tokens: 100,
      state: "FREE",
      count: 0,
    },
    {
      name: "other KV still counts without an affinity exemption",
      slots: 4,
      budget: 30_000,
      tokens: 20_000,
      state: "PROTECTED",
      count: 1,
    },
    {
      name: "full capacity stays full",
      slots: 0,
      budget: null,
      tokens: 100,
      state: "FULL",
      count: 1,
    },
  ])("session-only verdict: $name", async ({ slots, budget, tokens, state, count }) => {
    const verdicts = await assessWarmProtection({
      ownerId: "owner",
      policy: policy(),
      members: [
        {
          poolMemberId: "a",
          capacityId: "cap",
          slots,
          kvBudgetTokens: budget,
          executionTargetId: "target",
          matchedSessionId: "own",
          affine: false,
          requestTokens: tokens,
        },
      ],
      source: {
        load: async () => ({
          activeByCapacity: new Map(),
          sessionsByCapacity: new Map([
            [
              "cap",
              [
                { ...session("requester", 10), sessionId: "own", executionTargetId: "target" },
                { ...session("requester", 20), sessionId: "other", executionTargetId: "target" },
              ],
            ],
          ]),
        }),
      },
    });
    expect(verdicts.get("a")?.state).toBe(state);
    expect(verdicts.get("a")?.protectedSessions).toBe(count);
  });

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

describe("S-C engine facts (token mode and the llama.cpp window)", () => {
  it.each([
    ["VLLM", 100_000, 100_000],
    ["SGLANG", 100_000, 100_000],
    ["GENERIC", 100_000, 100_000],
    [null, 100_000, 100_000],
    [undefined, 100_000, 100_000],
    ["LLAMA_CPP", 100_000, null],
    ["VLLM", null, null],
    ["VLLM", 0, null],
    ["VLLM", -5, null],
  ] as const)("%s with K=%s uses K=%s", (engineKind, reported, used) => {
    expect(protectionKvBudgetTokens(engineKind, reported)).toBe(used);
  });

  it.each([
    ["LLAMA_CPP", 300, 150],
    ["LLAMA_CPP", 1, 1],
    ["LLAMA_CPP", 3, 1],
    ["VLLM", 300, 300],
    ["OLLAMA", 300, 300],
    ["GENERIC", 300, 300],
    [null, 300, 300],
  ] as const)("%s window %s s is %s s", (engineKind, windowSeconds, expected) => {
    expect(protectionWindowSecondsFor(windowSeconds, engineKind)).toBe(expected);
  });

  it("pins the llama.cpp factor", () => {
    expect(LLAMA_CPP_WINDOW_FACTOR).toBe(0.5);
  });

  const assess = async ({
    engineKind,
    kvBudgetTokens,
    ageSeconds = 30,
    tokens = 20_000,
    requestTokens = 100,
  }: {
    engineKind?: ProtectionEngineKind | null;
    kvBudgetTokens: number | null;
    ageSeconds?: number;
    tokens?: number;
    requestTokens?: number;
  }) => {
    const verdicts = await assessWarmProtection({
      ownerId: "owner",
      policy: policy(),
      members: [
        {
          poolMemberId: "a",
          capacityId: "cap-a",
          slots: 4,
          kvBudgetTokens,
          ...(engineKind === undefined ? {} : { engineKind }),
          affine: false,
          requestTokens,
        },
      ],
      // Three active leases: the one idle slot holds the warm session (slot mode: PROTECTED).
      source: {
        load: async () => ({
          activeByCapacity: new Map([["cap-a", 3]]),
          sessionsByCapacity: new Map([["cap-a", [session("alice", ageSeconds, tokens)]]]),
        }),
      },
    });
    return verdicts.get("a")!.state;
  };

  it("slot mode when no KV budget is reported", async () => {
    expect(await assess({ engineKind: "VLLM", kvBudgetTokens: null })).toBe("PROTECTED");
  });

  it("token mode: a reported budget with room left is FREE, one without room is PROTECTED", async () => {
    // 20k warm + 100 < 90% of 100k: room; slot mode would say PROTECTED.
    expect(await assess({ engineKind: "VLLM", kvBudgetTokens: 100_000 })).toBe("FREE");
    // 20k warm + 100 > 90% of 20k: no room.
    expect(await assess({ engineKind: "SGLANG", kvBudgetTokens: 20_000 })).toBe("PROTECTED");
    // The request's own size counts: 20k + 80k > 90% of 100k.
    expect(
      await assess({ engineKind: "VLLM", kvBudgetTokens: 100_000, requestTokens: 80_000 }),
    ).toBe("PROTECTED");
  });

  it("llama.cpp ignores a reported KV budget and stays slot-based", async () => {
    expect(await assess({ engineKind: "LLAMA_CPP", kvBudgetTokens: 100_000 })).toBe("PROTECTED");
  });

  it("llama.cpp protects sessions for a shorter window than other engines", async () => {
    // 200 s old: inside the 300 s pool window, outside llama.cpp's 150 s.
    expect(await assess({ engineKind: "LLAMA_CPP", kvBudgetTokens: null, ageSeconds: 200 })).toBe(
      "FREE",
    );
    expect(await assess({ engineKind: "VLLM", kvBudgetTokens: null, ageSeconds: 200 })).toBe(
      "PROTECTED",
    );
    expect(await assess({ engineKind: null, kvBudgetTokens: null, ageSeconds: 200 })).toBe(
      "PROTECTED",
    );
    // Inside llama.cpp's window it is protected like any other engine.
    expect(await assess({ engineKind: "LLAMA_CPP", kvBudgetTokens: null, ageSeconds: 100 })).toBe(
      "PROTECTED",
    );
  });

  it("asks the source for the pool's full window, not the shortened one", async () => {
    const load = vi.fn(async () => ({
      activeByCapacity: new Map<string, number>(),
      sessionsByCapacity: new Map<string, readonly WarmSession[]>(),
    }));
    await assessWarmProtection({
      ownerId: "owner",
      policy: policy(),
      members: [
        {
          poolMemberId: "a",
          capacityId: "cap-a",
          slots: 4,
          kvBudgetTokens: null,
          engineKind: "LLAMA_CPP",
          affine: false,
          requestTokens: 1,
        },
        {
          poolMemberId: "b",
          capacityId: "cap-b",
          slots: 4,
          kvBudgetTokens: null,
          engineKind: "VLLM",
          affine: false,
          requestTokens: 1,
        },
      ],
      source: { load },
    });
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining({ windowSeconds: 300 }) }),
    );
  });
});

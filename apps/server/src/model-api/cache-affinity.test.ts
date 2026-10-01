import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalKeys,
  canonicalLocations,
  canonicalPayloadWire,
  canonicalShapes,
  depthPayloadWire,
  depthRows,
  instructionPlacementRows,
  numericOverflowPayload,
  numericOverflowRows,
  orderedHistoryPayload,
} from "./cache-affinity-canonical.test-fixtures.js";
import {
  extractAffinityLayers,
  type JsonValue,
  MAX_CANONICAL_DEPTH,
} from "./cache-affinity-layers.js";

const db = vi.hoisted(() => ({
  cacheAffinityNode: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  },
  cacheAffinityRecord: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  capacityLease: { groupBy: vi.fn() },
  capacityWaiter: { groupBy: vi.fn() },
  modelPool: { findFirst: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));

vi.mock("@ws-model-proxy/db", async () => ({
  Prisma: (await import("../../../../packages/db/prisma/generated/client")).Prisma,
  default: db,
}));
const contextEstimator = vi.hoisted(() => vi.fn());
vi.mock("./capacity/context.js", () => ({ countSerializedRequestContext: contextEstimator }));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-bytes" },
}));

import {
  AFFINITY_EXPIRY_BATCH,
  AFFINITY_TRANSACTION_LIMITS,
  type AffinityTarget,
  affinityPrefixDigests,
  buildAffinityTargetIdentity,
  buildCanonicalRequest,
  extractClientConversationId,
  FREE_SAMPLING_PARAMS,
  rankAffinityTargets,
  rememberAffinity,
  resolveAffinitySession,
  sweepExpiredAffinity,
} from "./cache-affinity.js";

const policy = {
  enabled: true,
  ttlSeconds: 600,
  maxRecords: 100,
  prefixWeight: 100,
  conversationWeight: 150,
  confirmedCacheWeight: 250,
  loadPenaltyWeight: 100,
};

const target = (
  executionTargetId: string,
  targetIdentity: string,
  capacityId = executionTargetId,
) => ({
  poolMemberId: `member-${executionTargetId}`,
  executionTargetId,
  targetIdentity,
  capacityId,
  hardConcurrencyLimit: 1,
  healthPenalty: 0,
  publicEgressPenalty: 0,
  costPenalty: 0,
});

const payload = {
  model: "alias",
  messages: [
    { role: "system", content: "secret instructions" },
    { role: "user", content: "secret prompt" },
  ],
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  temperature: 0.2,
};

const digestArgs = (
  runtimeIdentity: string,
  requestPayload: Record<string, unknown>,
  surface = "openai-chat",
) => ({
  ownerId: "owner",
  resourceOwnerId: "owner",
  poolId: "pool",
  securityScope: "token",
  surface,
  payload: requestPayload,
  runtimeIdentity,
});

const affinityRow = ({
  target: affinityTarget,
  material,
  prefixDigest = null as string | null,
  prefixDepth = 0,
  conversationDigest = null as string | null,
  digestVersion = 5,
  engineCacheConfirmed = false,
  sessionId = "test-session",
  lastUsedAt = new Date("2026-08-25T11:59:00.000Z"),
}: {
  target: ReturnType<typeof target>;
  material: ReturnType<typeof affinityPrefixDigests>;
  prefixDigest?: string | null;
  prefixDepth?: number;
  conversationDigest?: string | null;
  digestVersion?: number;
  engineCacheConfirmed?: boolean;
  sessionId?: string;
  lastUsedAt?: Date;
}) => ({
  id: `record-${prefixDigest ?? conversationDigest}`,
  sessionId,
  lastUsedAt,
  executionTargetId: affinityTarget.executionTargetId,
  targetIdentity: affinityTarget.targetIdentity,
  bindingDigest: material.bindingDigest,
  prefixDigest,
  conversationDigest,
  prefixDepth,
  digestVersion,
  engineCacheConfirmed,
});

// Decode only the SQL write seam; PostgreSQL tests verify actual conflict updates.
function conversationWrites() {
  return db.$executeRaw.mock.calls.flatMap(([query, ...values]) => {
    const sql = (query.strings ?? query).join("");
    if (!sql.includes('WHERE "conversationDigest" IS NOT NULL AND "prefixDigest" IS NULL'))
      return [];
    return [
      {
        sql,
        data: {
          userId: values[1],
          tenantUserId: values[2],
          poolId: values[3],
          executionTargetId: values[4],
          targetIdentity: values[5],
          bindingDigest: values[6],
          prefixDigest: null,
          conversationDigest: values[7],
          sessionId: values[8],
          prefixDepth: 0,
          digestVersion: values[9],
          estimatedTokens: values[10],
          reportedTokens: values[11],
          engineCacheConfirmed: values[12],
          lastUsedAt: values[13] as Date,
          expiresAt: values[14] as Date,
        },
        engineEvidence: values[15],
      },
    ];
  });
}

function mockRetentionRows(
  rows: { id: string; sessionId: string; prefixDigest: string | null; expiresAt: Date }[],
) {
  db.$queryRaw.mockImplementation((query) =>
    Promise.resolve(
      (query.strings ?? query).join("").includes("FROM cache_affinity_record")
        ? rows
        : (query.strings ?? query).join("").includes("cache_affinity_node")
          ? []
          : [{ acquired: true }],
    ),
  );
}

const cap8 = (affinityTarget: ReturnType<typeof target>) => ({
  ...affinityTarget,
  hardConcurrencyLimit: 8,
});

describe("cache affinity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback) => callback(db));
    db.$queryRaw.mockImplementation((query) =>
      Promise.resolve(
        (query.strings ?? query).join("").includes("cache_affinity_node")
          ? []
          : [{ acquired: true }],
      ),
    );
    db.cacheAffinityNode.findMany.mockResolvedValue([]);
    db.cacheAffinityNode.findFirst.mockResolvedValue(null);
    db.cacheAffinityNode.deleteMany.mockResolvedValue({ count: 0 });
    db.cacheAffinityNode.updateMany.mockResolvedValue({ count: 0 });
    db.modelPool.findFirst.mockResolvedValue({ id: "pool" });
    db.cacheAffinityRecord.findMany.mockResolvedValue([]);
    db.cacheAffinityRecord.findFirst.mockResolvedValue(null);
    db.cacheAffinityRecord.deleteMany.mockResolvedValue({ count: 0 });
    db.cacheAffinityRecord.upsert.mockResolvedValue({});
    db.capacityLease.groupBy.mockResolvedValue([]);
    db.capacityWaiter.groupBy.mockResolvedValue([]);
  });

  it.each([
    { name: "default off", expected: 0 },
    { name: "explicit off", collect: false, expected: 0 },
    { name: "enabled", collect: true, expected: 2 },
    { name: "no resolved session", collect: true, expected: 0, noSession: true },
    { name: "one resolved target", collect: true, expected: 1, oneTarget: true },
    { name: "statement error", collect: true, expected: 2, error: true },
    { name: "no proof row", collect: true, expected: 2, noRow: true },
  ])("prefix evidence collection: $name", async (row) => {
    const requestPayload = {
      ...payload,
      messages: [
        ...payload.messages,
        { role: "assistant", content: "reply" },
        { role: "user", content: "next" },
      ],
    };
    const now = new Date("2026-08-25T12:00:00Z");
    const evidence = { tokens: 12_000, lastUsedAt: now, engineCacheConfirmed: false };
    db.$queryRaw.mockImplementation(async (query) => {
      if (query.sql.includes('n."estimatedTokens"')) {
        if ("error" in row) throw new Error("evidence unavailable");
        return "noRow" in row ? [] : [evidence];
      }
      return "noSession" in row || ("oneTarget" in row && query.values.includes("target-b"))
        ? []
        : [{ sessionId: "test-session" }];
    });
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: requestPayload,
      targets: [target("target-a", "runtime-a"), target("target-b", "runtime-b")],
      now,
    };
    const result = await rankAffinityTargets({
      ...args,
      collectPrefixEvidence: "collect" in row ? row.collect : undefined,
    });
    const proofQueries = db.$queryRaw.mock.calls.filter(([query]) =>
      query.sql.includes('n."estimatedTokens"'),
    );
    expect(proofQueries).toHaveLength(row.expected);
    if (!("collect" in row) || !row.collect) expect(result.prefixEvidence).toBeUndefined();
    else
      expect(result.prefixEvidence).toEqual(
        row.expected && !("error" in row) && !("noRow" in row)
          ? Object.fromEntries(
              args.targets
                .filter((t) => result.matchedSessionIds?.[t.executionTargetId])
                .map((t) => [
                  t.executionTargetId,
                  { tokens: 12_000, lastUsedAt: now.getTime(), confirmed: false },
                ]),
            )
          : {},
      );
    // Read failures and absent evidence leave ranking and resolved identity intact.
    const withoutEvidence = await rankAffinityTargets(args);
    const { prefixEvidence: _evidence, ...ranking } = result;
    expect(ranking).toEqual(withoutEvidence);
  });

  it.each(["body", "header"] as const)(
    "client %s identity needs no query when evidence is off",
    async (carrier) => {
      const requestPayload = {
        ...payload,
        ...(carrier === "body" ? { conversation_id: "client" } : {}),
      };
      const headers = carrier === "header" ? new Headers({ "x-session-id": "client" }) : undefined;
      const result = await rankAffinityTargets({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        policy,
        surface: "openai-chat",
        payload: requestPayload,
        headers,
        targets: [target("target-a", "runtime-a")],
        scoreSingleTarget: true,
      });
      expect(result.prefixEvidence).toBeUndefined();
      expect(result.matchedSessionIds?.["target-a"]).toBeTruthy();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    },
  );

  const clientUuid = "11111111-2222-4333-8444-555555555555";
  const carriers: { body: Record<string, unknown>; header?: string; surface?: string }[] = [
    { body: { conversation: "session" } },
    { body: { conversation: { id: "session" } } },
    { body: { conversation_id: "session" } },
    { body: { conversation_id: { id: "session" } } },
    { body: { prompt_cache_key: "session" } },
    ...[
      "x-conversation-id",
      "session_id",
      "session-id",
      "x-session-id",
      "x-claude-code-session-id",
    ].map((header) => ({ body: {}, header })),
  ];
  it.each(carriers)(
    "client carrier %# is normalized to one identity",
    ({ body, header, surface }) => {
      const headers = header ? new Headers({ [header]: "  session  " }) : undefined;
      expect(extractClientConversationId(headers, body, surface ?? "OPENAI_RESPONSES")).toBe(
        "session",
      );
      const args = digestArgs("runtime", { input: "same", ...body }, "OPENAI_RESPONSES");
      expect(affinityPrefixDigests({ ...args, headers }).clientSessionId).toBe(
        affinityPrefixDigests({ ...args, payload: { input: "same", conversation: "session" } })
          .clientSessionId,
      );
      expect(affinityPrefixDigests({ ...args, headers }).rootDigest).toBe(
        affinityPrefixDigests({ ...args, payload: { input: "same" } }).rootDigest,
      );
    },
  );

  it.each(["", "   ", "x".repeat(257), "bad space", "bad#id", 17, null, [], {}, { nope: "x" }])(
    "ignores malformed client id %# and falls through to the next valid carrier",
    (conversation) => {
      expect(
        extractClientConversationId(undefined, { conversation }, "openai-chat"),
      ).toBeUndefined();
      expect(
        extractClientConversationId(
          new Headers({ "session-id": "valid" }),
          { conversation },
          "openai-chat",
        ),
      ).toBe("valid");
      const base = digestArgs("runtime", { messages: [{ role: "user", content: "hello" }] });
      const material = affinityPrefixDigests({
        ...base,
        payload: { ...base.payload, conversation },
      });
      expect(material.clientSessionId).toBeUndefined();
      expect(material.rootDigest).not.toBe(affinityPrefixDigests(base).rootDigest);
      expect(material.nodes).not.toEqual(affinityPrefixDigests(base).nodes);
    },
  );

  it("accepts the charset and 256-character bound after trimming", () => {
    expect(
      extractClientConversationId(undefined, { conversation: "  AZaz09._:/@=+-  " }, "openai-chat"),
    ).toBe("AZaz09._:/@=+-");
    expect(
      extractClientConversationId(undefined, { conversation: "x".repeat(256) }, "openai-chat"),
    ).toHaveLength(256);
  });

  const precedence = [
    "conversation",
    "conversation_id",
    "prompt_cache_key",
    "x-conversation-id",
    "session_id",
    "session-id",
    "x-session-id",
    "x-claude-code-session-id",
  ];
  it.each(precedence.map((name, i) => [name, i] as const))(
    "first valid carrier wins: %s",
    (_, i) => {
      const body = Object.fromEntries(
        precedence.slice(0, 3).map((name, j) => [name, j < i ? "bad id" : name]),
      );
      const headers = new Headers(
        Object.fromEntries(
          precedence.slice(3).map((name, j) => [name, j + 3 < i ? "bad id" : name]),
        ),
      );
      expect(extractClientConversationId(headers, body, "openai-chat")).toBe(precedence[i]);
    },
  );

  it("Anthropic metadata accepts only an embedded session UUID, after all other carriers", () => {
    const metadata = { user_id: `user_account_session_${clientUuid}` };
    expect(extractClientConversationId(undefined, { metadata }, "ANTHROPIC_MESSAGES")).toBe(
      clientUuid,
    );
    expect(
      extractClientConversationId(
        new Headers({ "x-session-id": "header" }),
        { metadata },
        "anthropic-messages",
      ),
    ).toBe("header");
    for (const user_id of [
      "account",
      clientUuid,
      `user_session_${clientUuid}suffix`,
      "user_session_not-a-uuid",
      { id: clientUuid },
    ]) {
      expect(
        extractClientConversationId(undefined, { metadata: { user_id } }, "anthropic-messages"),
      ).toBeUndefined();
    }
    expect(
      extractClientConversationId(undefined, { metadata }, "openai-responses"),
    ).toBeUndefined();
    expect(
      extractClientConversationId(undefined, { prompt_cache_key: "key" }, "anthropic-messages"),
    ).toBeUndefined();
  });

  it("client id overrides native lineage and never probes nodes; transaction waits are bounded", async () => {
    const servedTarget = target("native", "runtime");
    const args = {
      ...digestArgs("runtime", { input: "start", conversation: "client" }, "openai-responses"),
      policy,
      target: servedTarget,
      estimatedTokens: 20000,
    };
    const parent = await rememberAffinity(args);
    const continued = await rememberAffinity({
      ...args,
      payload: { input: "delta", previous_response_id: "response", conversation: "other-client" },
      sessionBinding: parent!,
      estimatedTokens: undefined,
      estimatedDeltaTokens: 100,
    });
    expect(continued?.sessionId).not.toBe(parent?.sessionId);
    expect(continued?.estimatedTokens).toBe(20100);
    expect(db.cacheAffinityNode.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      AFFINITY_TRANSACTION_LIMITS,
    );
    expect(JSON.stringify(db.$executeRaw.mock.calls)).toContain("lock_timeout");
  });

  it("15.4 pins the transaction options actually passed to the writer", async () => {
    await rememberAffinity({
      ...digestArgs("runtime", payload),
      policy,
      target: target("target", "runtime"),
    });
    expect(AFFINITY_TRANSACTION_LIMITS).toEqual({ maxWait: 2000, timeout: 2500 });
    expect(db.$transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 2000, timeout: 2500 });
  });

  it.each(["openai-chat", "anthropic-messages", "openai-responses"])(
    "14.5 %s starter matching a stored tip scores zero conversation prefix depth",
    async (surface) => {
      const request =
        surface === "openai-responses"
          ? { input: "starter" }
          : { messages: [{ role: "user", content: "starter" }] };
      const material = affinityPrefixDigests(digestArgs("runtime", request, surface));
      const served = target("target", "runtime");
      db.cacheAffinityRecord.findMany.mockResolvedValue([
        affinityRow({
          target: served,
          material,
          prefixDigest: material.digests[0]!,
          prefixDepth: 1,
        }),
      ]);
      const rank = await rankAffinityTargets({
        ...digestArgs("runtime", request, surface),
        policy,
        targets: [served],
        scoreSingleTarget: true,
      });
      expect(material.isContinuation).toBe(false);
      expect(rank.prefixDepths.target).toBe(0);
      expect(rank.matchedSessionIds).toEqual({});
    },
  );

  it.each([undefined, null, 42, { id: "parent" }])(
    "13.6 non-string previous_response_id %j never honors a server binding",
    (previous_response_id) => {
      const first = affinityPrefixDigests(
        digestArgs("runtime", { input: "create" }, "openai-responses"),
      );
      const binding = {
        sessionId: "server-session",
        bindingDigest: first.bindingDigest,
        rootDigest: first.rootDigest,
        tipDigest: first.nodes[0]!.digest,
        tipDepth: 1,
        canonicalBytes: first.canonicalBytes,
      };
      const next = affinityPrefixDigests({
        ...digestArgs("runtime", { input: "delta", previous_response_id }, "openai-responses"),
        sessionBinding: binding,
      });
      expect(next.boundSessionId).toBeUndefined();
      expect(next.parentTipDigest).toBeUndefined();
      expect(next.nodes[0]!.depth).toBe(1);
    },
  );

  it.each(["root", "unit"].flatMap((kind) => [0, 1].map((extra) => ({ kind, extra }))))(
    "12.2/12.4 $kind canonical bytes cap + $extra is exact",
    ({ kind, extra }) => {
      const base = kind === "root" ? { instructions: "x", input: [] } : { input: "x" };
      const first = affinityPrefixDigests(digestArgs("runtime", base, "openai-responses"));
      const text = "x".repeat(2 * 1024 * 1024 - first.canonicalBytes + 1 + extra);
      const request = kind === "root" ? { instructions: text, input: [] } : { input: text };
      const material = affinityPrefixDigests(digestArgs("runtime", request, "openai-responses"));
      expect(material.canonicalBytes).toBe(2 * 1024 * 1024 + extra);
      expect(material.identifiable).toBe(extra === 0);
      expect(material.nodes.length).toBe(extra || kind === "root" ? 0 : 1);
    },
  );

  it.each([2, 8192, 100000])(
    "R5 identity with %i small object keys is identifiable at cap and refused at cap+1",
    (count) => {
      const cap = 2 * 1024 * 1024;
      const extension = {
        ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 0])),
        padding: "",
      };
      const payload = { extension, input: "U" };
      const initial = affinityPrefixDigests(digestArgs("runtime", payload, "openai-responses"));
      const bytes =
        Buffer.byteLength(
          JSON.stringify({
            bindingDigest: "x".repeat(43),
            instructions: [],
            parameters: { extension },
            tools: null,
          }),
        ) + Buffer.byteLength(JSON.stringify(payload.input));
      expect(initial.canonicalBytes).toBe(bytes);
      extension.padding = "x".repeat(cap - bytes);
      const atCap = affinityPrefixDigests(digestArgs("runtime", payload, "openai-responses"));
      expect(atCap.canonicalBytes).toBe(cap);
      expect(atCap.identifiable).toBe(true);
      expect(atCap.nodes).toHaveLength(1);
      const overCap = affinityPrefixDigests(
        digestArgs(
          "runtime",
          { extension: { ...extension, padding: `${extension.padding}x` }, input: "U" },
          "openai-responses",
        ),
      );
      expect(overCap.canonicalBytes).toBe(cap + 1);
      expect(overCap.identifiable).toBe(false);
      expect(overCap.nodes).toEqual([]);
      expect(overCap.parentTipDigest).toBeUndefined();
    },
  );

  it.each([true, false])(
    "15.11 evicting the current footprint suppresses binding: client=%s",
    async (client) => {
      const request = { input: "starter", ...(client ? { conversation: "client" } : {}) };
      db.$queryRaw.mockImplementation((query) => {
        const sql = (query.strings ?? query).join("");
        if (sql.includes("FROM cache_affinity_record")) {
          const footprint = conversationWrites()[0]!.data;
          return Promise.resolve([
            {
              id: "evicted-current",
              sessionId: footprint.sessionId,
              prefixDigest: null,
              expiresAt: new Date("2100-01-01"),
            },
          ]);
        }
        return Promise.resolve([{ acquired: true }]);
      });
      expect(
        await rememberAffinity({
          ...digestArgs("runtime", request, "openai-responses"),
          policy: { ...policy, maxRecords: 1 },
          target: target("target", "runtime"),
        }),
      ).toBeNull();
    },
  );

  it.each([
    { estimate: undefined, expected: null },
    { estimate: -3.9, expected: 0 },
    { estimate: 12_000.9, expected: 12_000 },
    { estimate: 3_000_000_000, expected: 2_147_483_647 },
  ])(
    "tip node estimate clamps $estimate to $expected and leaves ancestors NULL",
    async ({ estimate, expected }) => {
      await rememberAffinity({
        ...digestArgs("runtime", {
          ...payload,
          messages: [
            ...payload.messages,
            { role: "assistant", content: "reply" },
            { role: "user", content: "next" },
          ],
        }),
        policy,
        target: target("target", "runtime"),
        estimatedTokens: estimate,
      });
      const writes = db.$executeRaw.mock.calls.filter(([query]) =>
        query.sql?.includes("INSERT INTO cache_affinity_node"),
      );
      expect(writes).toHaveLength(1);
      const values = writes[0]![0].values;
      const rows = Array.from({ length: values.length / 13 }, (_, i) =>
        values.slice(i * 13, (i + 1) * 13),
      );
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.filter((row) => row[9] === true)).toHaveLength(1);
      for (const row of rows) {
        expect(row[10]).toBe(row[9] ? expected : null);
        expect(row[11]).toBeNull();
      }
    },
  );

  it("tip node reported tokens COALESCE on conflict and clamp on insert", async () => {
    await rememberAffinity({
      ...digestArgs("runtime", payload),
      policy,
      target: target("target", "runtime"),
      estimatedTokens: 18_000,
      reportedTokens: 12_000.9,
    });
    const writes = db.$executeRaw.mock.calls.filter(([query]) =>
      query.sql?.includes("INSERT INTO cache_affinity_node"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]![0].sql).toContain(
      'COALESCE(EXCLUDED."reportedTokens", cache_affinity_node."reportedTokens")',
    );
    const values = writes[0]![0].values;
    const rows = Array.from({ length: values.length / 13 }, (_, i) =>
      values.slice(i * 13, (i + 1) * 13),
    );
    const tip = rows.find((row) => row[9] === true);
    expect(tip?.[10]).toBe(18_000);
    expect(tip?.[11]).toBe(12_000);
  });

  it("bound native delta uses the caller estimate and carries the parent size for empty input", async () => {
    const args = {
      ...digestArgs("runtime", { input: "start", conversation: "client" }, "openai-responses"),
      policy,
      target: target("native", "runtime"),
    };
    const parent = await rememberAffinity({
      ...args,
      estimatedTokens: 20000,
      reportedTokens: 15000,
    });
    const next = await rememberAffinity({
      ...args,
      payload: { input: "delta", previous_response_id: "response", conversation: "client" },
      sessionBinding: parent!,
      estimatedDeltaTokens: 10,
    });
    expect(next!.estimatedTokens).toBe(20010);
    expect(next!.reportedTokens).toBe(15010);
    const empty = await rememberAffinity({
      ...args,
      payload: { previous_response_id: "next-response", conversation: "client" },
      sessionBinding: next!,
    });
    expect(empty!.estimatedTokens).toBe(next!.estimatedTokens);
    expect(empty!.tipDigest).toBe(next!.tipDigest);
  });

  it.each([128 * 1024, 512 * 1024])(
    "C2-6 completion never tokenizes a %i-byte bound delta",
    async (size) => {
      const args = {
        ...digestArgs("runtime", { input: "create", conversation: "client" }, "openai-responses"),
        policy,
        target: target("native", "runtime"),
      };
      const parent = await rememberAffinity({ ...args, estimatedTokens: 20000 });
      contextEstimator.mockImplementation(() => {
        throw new Error("EOF estimator must not run");
      });
      const start = performance.now();
      const next = await rememberAffinity({
        ...args,
        payload: {
          input: "d".repeat(size),
          conversation: "client",
          previous_response_id: "parent",
        },
        sessionBinding: parent!,
      });
      expect(next?.estimatedTokens).toBe(20000);
      expect(contextEstimator).not.toHaveBeenCalled();
      expect(performance.now() - start).toBeLessThan(AFFINITY_TRANSACTION_LIMITS.timeout);
    },
  );

  it.each(["missing", "expired", "wrong scope", "changed root"])(
    "AC-75 client id with %s Responses parent publishes no delta nodes",
    async (state) => {
      const args = {
        ...digestArgs("runtime", { input: "create", conversation: "client" }, "openai-responses"),
        policy,
        target: target("native", "runtime"),
      };
      const parent = await rememberAffinity(args);
      vi.clearAllMocks();
      const request = {
        ...args,
        payload: {
          input: "delta",
          conversation: "client",
          previous_response_id: "parent",
          ...(state === "changed root" ? { instructions: "new" } : {}),
        },
        sessionBinding:
          state === "wrong scope"
            ? { ...parent!, bindingDigest: "other" }
            : state === "changed root"
              ? parent!
              : undefined,
      };
      const material = affinityPrefixDigests({
        ...request,
        runtimeIdentity: args.target.targetIdentity,
      });
      expect(material.missingParent).toBe(true);
      expect(material.identifiable).toBe(false);
      expect(material.nodes).toEqual([]);
      expect(
        await resolveAffinitySession(
          db,
          {
            userId: "owner",
            tenantUserId: "owner",
            poolId: "pool",
            executionTargetId: "native",
          },
          material,
          new Date(),
        ),
      ).toBe(parent!.sessionId);
      expect(await rememberAffinity(request)).toBeNull();
      expect(
        db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create.prefixDigest),
      ).toEqual(material.instructionDigests);
      const nodeInserts = db.$executeRaw.mock.calls.filter(([query]) =>
        (query.strings ?? query).join("").includes("INSERT INTO cache_affinity_node"),
      );
      expect(nodeInserts).toEqual([]);
      expect(db.cacheAffinityNode.deleteMany).not.toHaveBeenCalled();
      expect(db.cacheAffinityNode.updateMany).not.toHaveBeenCalled();
      expect(conversationWrites()).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ sessionId: parent!.sessionId }),
        }),
      );
    },
  );

  it.each(["cache_affinity_record", "cache_affinity_node"])(
    "completion expiry cleanup for %s is an indexed batch",
    async (table) => {
      await rememberAffinity({
        ...digestArgs("runtime", payload),
        policy,
        target: target("target", "runtime"),
      });
      const calls = db.$executeRaw.mock.calls.filter(([query]) =>
        (query.strings ?? query).join("").includes(`DELETE FROM ${table} WHERE id = ANY(ARRAY(`),
      );
      expect(calls).toHaveLength(1);
      const [query, ...values] = calls[0]!;
      expect(query.join("")).toContain(
        'ORDER BY "userId", "tenantUserId", "poolId", "expiresAt" LIMIT',
      );
      expect(values.at(-1)).toBe(AFFINITY_EXPIRY_BATCH);
      expect(AFFINITY_EXPIRY_BATCH).toBe(200);
    },
  );

  it.each(["bound", "mismatched", "default", "forged", "disabled", "deleted pool"] as const)(
    "C1a-2 writer binding: %s",
    async (state) => {
      const servedTarget = target("native", "native-runtime");
      const args = {
        ...digestArgs(
          servedTarget.targetIdentity,
          { input: "next only", previous_response_id: "parent" },
          "OPENAI_RESPONSES",
        ),
        policy: { ...policy, enabled: state !== "disabled" },
        target: servedTarget,
      };
      const bindingDigest = affinityPrefixDigests(args).bindingDigest;
      db.cacheAffinityNode.findFirst.mockResolvedValue({ sessionId: "durable-session" });
      const sessionBinding =
        state === "bound" || state === "mismatched"
          ? {
              rootDigest: affinityPrefixDigests(args).rootDigest,
              tipDigest: "p".repeat(43),
              tipDepth: 1,
              canonicalBytes: 100,
              sessionId: "durable-session",
              bindingDigest: state === "bound" ? bindingDigest : "wrong-scope",
            }
          : undefined;
      if (state === "deleted pool") db.modelPool.findFirst.mockResolvedValue(null);
      const binding = await rememberAffinity({
        ...args,
        sessionBinding,
        payload: {
          ...args.payload,
          ...(state === "forged"
            ? {
                sessionBinding: { sessionId: "forged-session", bindingDigest },
                warmSessionId: "forged-session",
                warmBindingDigest: bindingDigest,
              }
            : {}),
        },
      });
      if (state === "disabled" || state === "deleted pool") {
        expect(binding).toBeNull();
        expect(db.cacheAffinityRecord.upsert).not.toHaveBeenCalled();
        return;
      }
      if (state !== "bound") {
        expect(binding).toBeNull();
        expect(db.cacheAffinityRecord.upsert).not.toHaveBeenCalled();
        return;
      }
      expect(binding).toMatchObject({ sessionId: expect.any(String), bindingDigest });
      if (state === "bound") expect(binding?.sessionId).toBe("durable-session");
      else {
        expect(binding?.sessionId).not.toBe("durable-session");
        expect(binding?.sessionId).not.toBe("forged-session");
      }
      if (state === "bound")
        expect(db.cacheAffinityRecord.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ sessionId: binding?.sessionId }),
            update: expect.objectContaining({ sessionId: binding?.sessionId }),
          }),
        );
      else {
        expect(db.cacheAffinityRecord.upsert).not.toHaveBeenCalled();
        expect(binding!.tipDigest).toBe("");
        expect(conversationWrites()).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ sessionId: binding!.sessionId }),
          }),
        );
      }
    },
  );

  it("separates tenants, runtimes, surfaces, ordered content, tools, and parameters", () => {
    const digest = (overrides: Partial<Parameters<typeof affinityPrefixDigests>[0]> = {}) =>
      affinityPrefixDigests({
        ownerId: "owner-a",
        resourceOwnerId: "resource-owner",
        poolId: "pool",
        securityScope: "token-a",
        accessGrantId: "grant-a",
        surface: "OPENAI_CHAT_COMPLETIONS",
        payload,
        runtimeIdentity: "runtime-a",
        ...overrides,
      }).digests.at(-1);

    const baseline = digest();
    expect(digest()).toBe(baseline);
    expect(digest({ ownerId: "owner-b" })).not.toBe(baseline);
    expect(digest({ securityScope: "token-b" })).not.toBe(baseline);
    expect(digest({ accessGrantId: "grant-b" })).not.toBe(baseline);
    expect(digest({ runtimeIdentity: "runtime-b" })).not.toBe(baseline);
    expect(digest({ surface: "ANTHROPIC_MESSAGES" })).not.toBe(baseline);
    const turns = {
      ...payload,
      messages: [
        { role: "user", content: "U1" },
        { role: "assistant", content: "A1" },
      ],
    };
    expect(digest({ payload: { ...turns, messages: [...turns.messages].reverse() } })).not.toBe(
      digest({ payload: turns }),
    );
    expect(digest({ payload: { ...payload, tools: [] } })).not.toBe(baseline);
    expect(digest({ payload: { ...payload, temperature: 0.3 } })).toBe(baseline);
    expect(digest({ payload: { ...payload, vendor_extension: { mode: "different" } } })).not.toBe(
      baseline,
    );
  });

  it("supports scalar Responses input without storing or truncating it", () => {
    const first = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_RESPONSES",
      payload: { input: "first private input" },
      runtimeIdentity: "runtime",
    });
    const second = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_RESPONSES",
      payload: { input: "different private input" },
      runtimeIdentity: "runtime",
    });
    expect(first.digests).toHaveLength(1);
    expect(first.digests[0]).not.toBe(second.digests[0]);
    expect(first.digests[0]).not.toContain("private input");
  });

  it("binds explicit conversation routing hints to the root", () => {
    const digest = (requestPayload: Record<string, unknown>) =>
      affinityPrefixDigests({
        ownerId: "tenant",
        resourceOwnerId: "pool-owner",
        poolId: "pool",
        securityScope: "token-a",
        accessGrantId: "grant-a",
        surface: "OPENAI_RESPONSES",
        payload: requestPayload,
        runtimeIdentity: "target-runtime",
      });
    const first = digest({
      conversation: "conversation-secret",
      input: "turn one",
      instructions: "first instructions",
      tools: [{ name: "first-tool" }],
      temperature: 0.1,
    });
    const second = digest({
      conversation: "conversation-secret",
      input: "turn two",
      instructions: "changed instructions",
      tools: [{ name: "second-tool" }],
      temperature: 0.9,
    });
    expect(second.conversationDigest).not.toBe(first.conversationDigest);
    expect(second.bindingDigest).toBe(first.bindingDigest);
    expect(second.digests).not.toEqual(first.digests);
    expect(first.conversationDigest).not.toContain("conversation-secret");

    for (const isolation of [
      { ownerId: "other-tenant" },
      { resourceOwnerId: "other-owner" },
      { poolId: "other-pool" },
      { securityScope: "token-b" },
      { accessGrantId: "grant-b" },
    ]) {
      expect(
        affinityPrefixDigests({
          ownerId: "tenant",
          resourceOwnerId: "pool-owner",
          poolId: "pool",
          securityScope: "token-a",
          accessGrantId: "grant-a",
          surface: "OPENAI_RESPONSES",
          payload: { conversation: "conversation-secret", input: "turn one" },
          runtimeIdentity: "target-runtime",
          ...isolation,
        }).conversationDigest,
      ).not.toBe(first.conversationDigest);
    }
  });

  it("persists an explicit conversation even when there are no content prefixes", async () => {
    await rememberAffinity({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "grant-and-token",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "conversation-only" },
      target: target("target", "runtime"),
    });
    expect(db.cacheAffinityRecord.upsert).not.toHaveBeenCalled();
    expect(conversationWrites()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          prefixDigest: null,
          prefixDepth: 0,
          digestVersion: 5,
          conversationDigest: expect.any(String),
        }),
      }),
    );
  });

  it("does not rank explicit conversation hints across changed instructions/tools", async () => {
    const selected = target("target-a", "runtime-a");
    const prior = affinityPrefixDigests({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "conversation", input: "first", temperature: 0.1 },
      runtimeIdentity: selected.targetIdentity,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      {
        executionTargetId: selected.executionTargetId,
        targetIdentity: selected.targetIdentity,
        bindingDigest: prior.bindingDigest,
        prefixDigest: null,
        conversationDigest: prior.conversationDigest,
        prefixDepth: 0,
        digestVersion: 5,
        engineCacheConfirmed: false,
      },
    ]);
    const ranked = await rankAffinityTargets({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: {
        conversation: "conversation",
        input: "second",
        instructions: "changed",
        tools: [{ name: "changed" }],
        temperature: 0.9,
      },
      targets: [target("target-b", "runtime-b"), selected],
    });
    expect(ranked.orderedTargetIds[0]).toBe("target-b");
    expect(ranked.conversationMatches[selected.executionTargetId]).toBe(false);
    expect(ranked.prefixDepths[selected.executionTargetId]).toBe(0);
  });

  it("invalidates identity across native surface, adapter, endpoint, and every runtime projection", () => {
    const base = {
      executionTargetId: "target",
      endpointIdentity: "endpoint",
      upstreamModelId: "model",
      runtimeIdentityKey: "runtime-key",
      runtimeModel: "runtime-model",
      runtimeRevision: "revision",
      tokenizer: "tokenizer",
      tokenizerVersion: "tokenizer-version",
      template: "template",
      templateVersion: "template-version",
      engine: "engine",
      cacheNamespace: "namespace",
      requestedSurface: "OPENAI_RESPONSES",
      nativeSurface: "OPENAI_RESPONSES",
      mode: "native",
      adapterVersion: "native",
    };
    const baseline = buildAffinityTargetIdentity(base);
    for (const [key, value] of Object.entries({
      endpointIdentity: "other-endpoint",
      runtimeModel: "other-runtime",
      runtimeRevision: "other-revision",
      tokenizer: "other-tokenizer",
      tokenizerVersion: "other-tokenizer-version",
      template: "other-template",
      templateVersion: "other-template-version",
      engine: "other-engine",
      cacheNamespace: "other-namespace",
      nativeSurface: "ANTHROPIC_MESSAGES",
      mode: "adapted",
      adapterVersion: "2.0.0",
    })) {
      expect(buildAffinityTargetIdentity({ ...base, [key]: value })).not.toBe(baseline);
    }
    expect(baseline).toHaveLength(43);
    expect(
      buildAffinityTargetIdentity({ ...base, runtimeIdentityKey: "a\u001fb", runtimeModel: "c" }),
    ).not.toBe(
      buildAffinityTargetIdentity({ ...base, runtimeIdentityKey: "a", runtimeModel: "b\u001fc" }),
    );
    expect(
      buildAffinityTargetIdentity({
        ...base,
        runtimeIdentityKey: "x".repeat(500),
        runtimeModel: "y".repeat(500),
        tokenizer: "z".repeat(500),
        template: "t".repeat(500),
      }),
    ).toHaveLength(43);
  });

  it("never treats the missing-conversation sentinel as conversation affinity", async () => {
    const affinityTarget = target("target-a", "runtime-a");
    await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: { messages: [{ role: "user", content: "unrelated" }] },
      targets: [affinityTarget, target("target-b", "runtime-b")],
    });
    const query = db.cacheAffinityRecord.findMany.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(query?.where.OR)).not.toContain("conversationDigest");
  });

  it("selects the longest compatible prefix but lets load override a weak match", async () => {
    const targetA = target("target-a", "runtime-a", "capacity-a");
    const targetB = target("target-b", "runtime-b", "capacity-b");
    const continuationPayload = {
      ...payload,
      messages: [...payload.messages, { role: "assistant", content: "secret answer" }],
    };
    const a = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      runtimeIdentity: targetA.targetIdentity,
    });
    const b = affinityPrefixDigests({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      runtimeIdentity: targetB.targetIdentity,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      {
        executionTargetId: "target-a",
        targetIdentity: "runtime-a",
        bindingDigest: a.bindingDigest,
        prefixDigest: a.digests[0],
        conversationDigest: null,
        prefixDepth: 1,
        digestVersion: 5,
        engineCacheConfirmed: false,
      },
      {
        executionTargetId: "target-b",
        targetIdentity: "runtime-b",
        bindingDigest: b.bindingDigest,
        prefixDigest: b.digests[1],
        conversationDigest: null,
        prefixDepth: 2,
        digestVersion: 5,
        engineCacheConfirmed: false,
      },
    ]);
    db.capacityLease.groupBy.mockResolvedValue([{ capacityId: "capacity-b", _count: { _all: 2 } }]);

    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      targets: [targetA, targetB],
    });

    expect(result.matchedPrefixDepth).toBe(2);
    expect(result.orderedTargetIds).toEqual(["target-a", "target-b"]);
    expect(result.scores).toEqual({ "target-a": 100, "target-b": 0 });
  });

  it("reports the matched prefix size from the deepest matching record", async () => {
    const targetA = target("target-a", "runtime-a", "capacity-a");
    const targetB = target("target-b", "runtime-b", "capacity-b");
    const continuationPayload = {
      ...payload,
      messages: [...payload.messages, { role: "assistant", content: "secret answer" }],
    };
    const digests = (runtimeIdentity: string) =>
      affinityPrefixDigests({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        surface: "OPENAI_CHAT_COMPLETIONS",
        payload: continuationPayload,
        runtimeIdentity,
      });
    const a = digests(targetA.targetIdentity);
    const b = digests(targetB.targetIdentity);
    const record = (
      executionTargetId: string,
      targetIdentity: string,
      bindingDigest: string,
      prefixDigest: string | undefined,
      prefixDepth: number,
      estimatedTokens: number | null,
    ) => ({
      executionTargetId,
      targetIdentity,
      bindingDigest,
      prefixDigest,
      conversationDigest: null,
      prefixDepth,
      digestVersion: 5,
      engineCacheConfirmed: false,
      estimatedTokens,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      record("target-a", "runtime-a", a.bindingDigest, a.digests[0], 1, 3_000),
      record("target-b", "runtime-b", b.bindingDigest, b.digests[0], 1, 1_000),
      record("target-b", "runtime-b", b.bindingDigest, b.digests[1], 2, 5_000),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      targets: [targetA, targetB],
    });
    expect(result.prefixTokens).toEqual({ "target-a": 3_000, "target-b": 5_000 });

    // Unknown sizes are omitted, never guessed.
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      record("target-a", "runtime-a", a.bindingDigest, a.digests[0], 1, null),
    ]);
    const unknown = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuationPayload,
      targets: [targetA, targetB],
    });
    expect(unknown.prefixTokens).toEqual({});
  });

  it("queries only unexpired owner-scoped records with target identities", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    await rankAffinityTargets({
      ownerId: "grantee",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      targets: [target("target-a", "runtime-a"), target("target-b", "runtime-b")],
      now,
    });
    expect(db.cacheAffinityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "pool-owner",
          tenantUserId: "grantee",
          poolId: "pool",
          expiresAt: { gt: now },
        }),
      }),
    );
  });

  it("stamps every record of one call with the same lastUsedAt (S-C session grouping)", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    await rememberAffinity({
      ownerId: "grantee",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "c", input: [{ role: "user", content: "hi" }] },
      target: target("target", "runtime"),
      estimatedTokens: 12_000,
      now,
    });
    const stamps = [
      ...db.cacheAffinityRecord.upsert.mock.calls.flatMap(([input]) => [
        input.create.lastUsedAt,
        input.update.lastUsedAt,
      ]),
      ...conversationWrites().map(({ data }) => data.lastUsedAt),
    ];
    expect(stamps.length).toBeGreaterThan(2);
    expect(new Set(stamps.map((stamp: Date | undefined) => stamp?.getTime()))).toEqual(
      new Set([now.getTime()]),
    );
  });

  it("refreshes existing records with the call's lastUsedAt (S-C session grouping)", async () => {
    // The common continuation refreshes records instead of creating them, so
    // the per-material `update` path must stamp `lastUsedAt` like the create
    // paths do; otherwise the session ages out of the protection window while
    // it is still in use (warm-protection.ts groups by `lastUsedAt`).
    const now = new Date("2026-08-25T12:00:00.000Z");
    db.cacheAffinityRecord.findFirst.mockResolvedValue({ id: "existing-conversation-record" });
    await rememberAffinity({
      ownerId: "grantee",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "c", input: [{ role: "user", content: "hi" }] },
      target: target("target", "runtime"),
      estimatedTokens: 12_000,
      now,
    });
    expect(db.cacheAffinityRecord.findFirst).not.toHaveBeenCalled();
    for (const { sql } of conversationWrites())
      expect(sql).toContain('DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt"');
    const stamps = [
      ...db.cacheAffinityRecord.upsert.mock.calls.flatMap(([input]) => [
        input.create.lastUsedAt,
        input.update.lastUsedAt,
      ]),
      ...conversationWrites().map(({ data }) => data.lastUsedAt),
    ];
    expect(stamps.length).toBeGreaterThan(0);
    expect(new Set(stamps.map((stamp: Date | undefined) => stamp?.getTime()))).toEqual(
      new Set([now.getTime()]),
    );
  });

  describe("warm-session identity (#160)", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const scope = {
      userId: "owner",
      tenantUserId: "owner",
      poolId: "pool",
      executionTargetId: "target",
    };
    const material = affinityPrefixDigests(
      digestArgs("runtime", {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
    );
    it.each([
      { name: "none", replies: [[]], expected: null },
      { name: "tip", replies: [[{ sessionId: "tip" }]], expected: "tip" },
      { name: "sole ancestor", replies: [[{ sessionId: "sole" }]], expected: "sole" },
      {
        name: "ambiguous deepest ancestor never falls back",
        replies: [[{ sessionId: null }]],
        expected: null,
      },
    ])("$name", async ({ replies, expected }) => {
      db.$queryRaw.mockReset();
      for (const reply of replies) db.$queryRaw.mockResolvedValueOnce(reply);
      expect(await resolveAffinitySession(db, scope, material, now)).toBe(expected);
      for (const [query, ...values] of db.$queryRaw.mock.calls) {
        expect((query.strings ?? query).join("")).toContain('"expiresAt", "sessionId"\n    LIMIT');
        expect(query.values ?? values).toContain(2);
        expect((query.values ?? values).length).toBeGreaterThan(0);
      }
    });
    it.each(["root-only", "over cap", "missing parent"])("%s never probes", async (state) => {
      const input = {
        ...material,
        ...(state === "root-only"
          ? { nodes: [] }
          : state === "over cap"
            ? { identifiable: false }
            : { missingParent: true }),
      };
      expect(await resolveAffinitySession(db, scope, input, now)).toBeNull();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });
    it("rank and writer use the same resolver, writer after its fence", async () => {
      db.$queryRaw.mockImplementation((query) =>
        Promise.resolve(
          (query.strings ?? query).join("").includes("cache_affinity_node")
            ? [{ sessionId: "kept" }]
            : [{ acquired: true }],
        ),
      );
      const selected = target("target", "runtime");
      const args = {
        ...digestArgs("runtime", {
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
        }),
        policy,
      };
      expect(
        (await rankAffinityTargets({ ...args, targets: [selected], scoreSingleTarget: true }))
          .matchedSessionIds,
      ).toEqual({ target: "kept" });
      db.$queryRaw.mockClear();
      const binding = await rememberAffinity({ ...args, target: selected });
      expect(binding!.sessionId).toBe("kept");
      const firstQuery = db.$queryRaw.mock.calls[0]![0];
      expect((firstQuery.strings ?? firstQuery).join("")).toContain("wsmp_acquire_fences");
      expect(
        new Set(db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create.sessionId)),
      ).toEqual(new Set(["kept"]));
    });
  });

  it("scores a single target so protection can tell a continuation from a new session", async () => {
    const only = target("target-a", "runtime-a");
    const continuation = {
      ...payload,
      messages: [...payload.messages, { role: "assistant", content: "secret answer" }],
    };
    const material = affinityPrefixDigests({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "token",
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuation,
      runtimeIdentity: only.targetIdentity,
    });
    db.cacheAffinityRecord.findMany.mockResolvedValue(
      material.digests.map((prefixDigest, index) => ({
        executionTargetId: only.executionTargetId,
        targetIdentity: only.targetIdentity,
        bindingDigest: material.bindingDigest,
        prefixDigest,
        conversationDigest: null,
        prefixDepth: index + 1,
        digestVersion: 5,
        engineCacheConfirmed: false,
        estimatedTokens: 9_000,
      })),
    );
    const ranked = await rankAffinityTargets({
      ownerId: "tenant",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload: continuation,
      targets: [only],
      scoreSingleTarget: true,
    });
    expect(material.isContinuation).toBe(true);
    expect(ranked.prefixDepths["target-a"]).toBeGreaterThan(0);
  });

  it.each([1000, 10000])(
    "retention reads a fixed batch after cap %i and leaves expired candidates to the sweeper",
    async (maxRecords) => {
      const now = new Date("2030-01-01T00:00:00Z");
      mockRetentionRows([
        {
          id: "expired",
          sessionId: "expired",
          prefixDigest: null,
          expiresAt: new Date(now.getTime() - 1),
        },
        {
          id: "live",
          sessionId: "live",
          prefixDigest: null,
          expiresAt: new Date(now.getTime() + 1),
        },
      ]);
      await rememberAffinity({
        ...digestArgs("runtime", payload),
        target: target("target", "runtime"),
        policy: { ...policy, maxRecords },
        now,
      });
      const [query] = db.$queryRaw.mock.calls.find(([sql]) =>
        (sql.strings ?? sql).join("").includes("FROM cache_affinity_record"),
      )!;
      expect(query.values.slice(-2)).toEqual([200, maxRecords]);
      expect(query.strings.join("")).toContain('"lastUsedAt" DESC, id DESC');
      const deletes = db.$executeRaw.mock.calls.filter(([sql]) => {
        const text = (sql.strings ?? sql).join("");
        return (
          text.includes(["DELETE FROM", "cache_affinity_record"].join(" ")) &&
          text.includes("SELECT unnest")
        );
      });
      expect(deletes.map(([, ids]) => ids)).toEqual([["live"]]);
    },
  );

  it("persists digests only, refreshes TTL, and enforces the row bound", async () => {
    mockRetentionRows([
      { id: "old", sessionId: "old", prefixDigest: null, expiresAt: new Date("2030-01-01") },
    ]);
    const now = new Date("2026-08-25T12:00:00.000Z");
    await rememberAffinity({
      ownerId: "grantee",
      resourceOwnerId: "pool-owner",
      poolId: "pool",
      policy: { ...policy, maxRecords: 1 },
      surface: "OPENAI_CHAT_COMPLETIONS",
      payload,
      target: target("target", "runtime"),
      now,
    });
    const serializedWrites = JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls);
    expect(serializedWrites).not.toContain("secret prompt");
    expect(serializedWrites).not.toContain("secret instructions");
    expect(serializedWrites).not.toContain("lookup");
    expect(serializedWrites).toContain("grantee");
    expect(serializedWrites).toContain("pool-owner");
    const deletes = db.$executeRaw.mock.calls.filter(([sql]) => {
      const text = (sql.strings ?? sql).join("");
      return (
        text.includes(["DELETE FROM", "cache_affinity_record"].join(" ")) &&
        text.includes("SELECT unnest")
      );
    });
    expect(deletes.map(([, ids]) => ids)).toEqual([["old"]]);
  });

  it("persists instruction prefixes for system-only Chat and writes digestVersion 5 on create only", async () => {
    await rememberAffinity({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-chat",
      payload: { messages: [{ role: "system", content: "secret instructions" }] },
      target: target("target", "runtime"),
    });
    expect(db.cacheAffinityRecord.upsert).toHaveBeenCalled();
    const creates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create);
    const updates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.update);
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) {
      expect(create.digestVersion).toBe(5);
      expect(create.prefixDigest).toEqual(expect.any(String));
      expect(create.conversationDigest).toBeNull();
      expect(create.prefixDepth).toBeGreaterThan(0);
    }
    for (const update of updates) {
      expect(update).not.toHaveProperty("digestVersion");
    }
    expect(JSON.stringify(creates)).not.toContain("secret instructions");
    expect(JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls)).not.toContain(
      "secret instructions",
    );
  });

  it("writes digestVersion 5 on conversation-prefix and session creates and omits it on updates", async () => {
    const requestPayload = {
      conversation: "conversation-secret",
      input: "turn one",
      instructions: "secret instructions",
    };
    await rememberAffinity({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-responses",
      payload: requestPayload,
      target: target("target", "runtime"),
    });
    const prefixCreates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create);
    const prefixUpdates = db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.update);
    expect(prefixCreates.length).toBeGreaterThan(1);
    for (const create of prefixCreates) {
      expect(create.digestVersion).toBe(5);
    }
    for (const update of prefixUpdates) {
      expect(update).not.toHaveProperty("digestVersion");
    }
    expect(conversationWrites()[0]?.data.digestVersion).toBe(5);
    expect(JSON.stringify(db.cacheAffinityRecord.upsert.mock.calls)).not.toContain(
      "secret instructions",
    );
    expect(JSON.stringify(conversationWrites())).not.toContain("conversation-secret");

    db.$executeRaw.mockClear();
    await rememberAffinity({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-responses",
      payload: requestPayload,
      target: target("target", "runtime"),
    });
    expect(conversationWrites()).toHaveLength(2);
    for (const { sql } of conversationWrites()) {
      expect(sql.split("DO UPDATE SET")[1]).not.toContain('"digestVersion"');
      expect(sql).toContain('"digestVersion"');
    }
  });

  it("deduplicates the exact prefix while storing distinct conversation identities", async () => {
    for (const conversation of ["conversation-a", "conversation-b"]) {
      await rememberAffinity({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: "shared prefix", conversation },
        target: target("target", "runtime"),
      });
    }
    const uniqueInputs = db.cacheAffinityRecord.upsert.mock.calls.map(
      ([input]) =>
        input.where.tenantUserId_poolId_executionTargetId_targetIdentity_bindingDigest_prefixDigest
          .prefixDigest,
    );
    expect(new Set(uniqueInputs).size).toBe(1);
    expect(conversationWrites()).toHaveLength(4);
    const conversations = conversationWrites().map(({ data }) => data.conversationDigest);
    expect(new Set(conversations).size).toBe(4);
  });

  it.each(["openai-chat", "anthropic-messages", "openai-responses"])(
    "R1 over-cap routing unit %s",
    async (surface) => {
      const content = Array.from({ length: 80 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `turn ${i}`,
      }));
      const huge = {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}` },
          },
        ],
      };
      const request =
        surface === "openai-responses"
          ? { instructions: "rules", input: [...content, huge] }
          : surface === "anthropic-messages"
            ? { system: "rules", messages: [...content, huge] }
            : { messages: [{ role: "system", content: "rules" }, ...content, huge] };
      const material = affinityPrefixDigests(digestArgs("runtime", request, surface));
      expect(material.identifiable).toBe(false);
      expect(material.nodes).toEqual([]);
      expect(material.routingNodes).toHaveLength(64);
      expect(material.routingNodes.at(-1)?.depth).toBe(80);
      expect(material.instructionDigests).toHaveLength(1);
      db.$queryRaw.mockClear();
      expect(
        await resolveAffinitySession(
          db,
          { userId: "owner", tenantUserId: "owner", poolId: "pool", executionTargetId: "target" },
          material,
          new Date(),
        ),
      ).toBeNull();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(
        await rememberAffinity({
          ...digestArgs("runtime", request, surface),
          target: target("target", "runtime"),
          policy,
          estimatedTokens: 20000,
        }),
      ).toBeNull();
      expect(conversationWrites()).toEqual([]);
    },
  );

  it.each([
    ...["openai-chat", "anthropic-messages", "openai-responses"].flatMap((surface) =>
      ["parameter", "tools", "instructions"].map((layer) => ({ surface, layer })),
    ),
    { surface: "openai-chat", layer: "functions" },
  ])(
    "R3 oversized root $layer degrades only bounded hints on $surface",
    async ({ surface, layer }) => {
      const huge = "x".repeat(2 * 1024 * 1024 + 1);
      const units = [
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ];
      const instructions = layer === "instructions" ? huge : "safe rules";
      const request = {
        ...(surface === "openai-responses"
          ? { instructions, input: units }
          : surface === "anthropic-messages"
            ? { system: instructions, messages: units }
            : { messages: [{ role: "system", content: instructions }, ...units] }),
        ...(layer === "parameter" ? { extension: { [huge]: 0 } } : {}),
        ...(layer === "tools" ? { tools: [{ schema: huge }] } : {}),
        ...(layer === "functions"
          ? { functions: [{ name: "legacy", parameters: { schema: huge } }] }
          : {}),
      };
      const args = {
        ...digestArgs("runtime", request, surface),
        headers: new Headers({ "session-id": "client" }),
      };
      const material = affinityPrefixDigests(args);
      expect(material.identifiable).toBe(false);
      expect(material.nodes).toEqual([]);
      expect(material.routingNodes).toEqual([]);
      expect(material.instructionDigests).toHaveLength(layer === "instructions" ? 0 : 1);
      expect(material.clientSessionId).toBeDefined();
      expect(material.boundSessionId).toBeUndefined();
      expect(material.rootDigest).toBe("");
      db.$executeRaw.mockClear();
      expect(
        await rememberAffinity({ ...args, policy, target: target("target", "runtime") }),
      ).toBeNull();
      expect(conversationWrites()).toHaveLength(1);
      expect(conversationWrites()[0]!.data.sessionId).toBe(material.clientSessionId);
    },
  );

  it.each([false, true])("R1 missing-parent delta routing unit client=%s", async (client) => {
    const request = {
      instructions: "rules",
      input: [
        { role: "user", content: "delta" },
        { role: "assistant", content: "output" },
      ],
      previous_response_id: "missing",
      ...(client ? { conversation: "client" } : {}),
    };
    const material = affinityPrefixDigests(digestArgs("runtime", request, "openai-responses"));
    expect(material.missingParent).toBe(true);
    expect(material.nodes).toEqual([]);
    expect(material.routingNodes).toEqual([]);
    expect(material.digests).toEqual([]);
    expect(material.instructionDigests).toHaveLength(1);
    await rememberAffinity({
      ...digestArgs("runtime", request, "openai-responses"),
      target: target("target", "runtime"),
      policy,
    });
    expect(
      db.cacheAffinityRecord.upsert.mock.calls.map(([input]) => input.create.prefixDigest),
    ).toEqual(material.instructionDigests);
    expect(conversationWrites()).toHaveLength(client ? 1 : 0);
  });

  it.each([
    { name: "ownerId", change: { ownerId: "different-owner" } },
    { name: "resourceOwnerId", change: { resourceOwnerId: "different-resource-owner" } },
    { name: "securityScope", change: { securityScope: "different-token" } },
    { name: "accessGrantId", change: { accessGrantId: "different-grant" } },
    { name: "poolId", change: { poolId: "different-pool" } },
    { name: "runtimeIdentity", change: { runtimeIdentity: "different-runtime" } },
    { name: "surface", change: { surface: "anthropic-messages" } },
  ])("R1 client identity scope $name", ({ change }) => {
    const args = {
      ...digestArgs("runtime", {
        conversation: "same-id",
        messages: [{ role: "user", content: "starter" }],
      }),
      securityScope: "token",
      accessGrantId: "grant",
    };
    const original = affinityPrefixDigests(args);
    const changed = affinityPrefixDigests({ ...args, ...change });
    expect(original.clientSessionId).toBeDefined();
    expect(changed.clientSessionId).toBeDefined();
    expect(changed.clientSessionId).not.toBe(original.clientSessionId);
  });

  const forkHistory = [
    { role: "user", content: "shared starter" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "next" },
  ];

  it("a client-id fork is its own session and shares prefix digests with the original", async () => {
    const original = affinityPrefixDigests(
      digestArgs("runtime", { conversation_id: "orig", messages: forkHistory }),
    );
    const fork = affinityPrefixDigests(
      digestArgs("runtime", { conversation_id: "fork", messages: forkHistory }),
    );
    expect(original.clientSessionId).toBeDefined();
    expect(fork.clientSessionId).toBeDefined();
    expect(fork.clientSessionId).not.toBe(original.clientSessionId);
    expect(fork.rootDigest).toBe(original.rootDigest);
    expect(fork.digests).toEqual(original.digests);
    expect(fork.nodes).toEqual(original.nodes);
    expect(fork.isContinuation).toBe(true);
    expect(
      await resolveAffinitySession(
        db,
        { userId: "owner", tenantUserId: "owner", poolId: "pool", executionTargetId: "target" },
        fork,
        new Date(),
      ),
    ).toBe(fork.clientSessionId);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("a fork without an id stays one session across branch switches", async () => {
    const original = affinityPrefixDigests(digestArgs("runtime", { messages: forkHistory }));
    const left = affinityPrefixDigests(
      digestArgs("runtime", {
        messages: [...forkHistory.slice(0, 2), { role: "user", content: "left" }],
      }),
    );
    const right = affinityPrefixDigests(
      digestArgs("runtime", {
        messages: [...forkHistory.slice(0, 2), { role: "user", content: "right" }],
      }),
    );
    expect(original.clientSessionId).toBeUndefined();
    expect(left.clientSessionId).toBeUndefined();
    expect(right.clientSessionId).toBeUndefined();
    expect(left.rootDigest).toBe(original.rootDigest);
    expect(right.rootDigest).toBe(original.rootDigest);
    expect(left.digests[0]).toBe(original.digests[0]);
    expect(right.digests[0]).toBe(original.digests[0]);
    expect(left.digests.at(-1)).not.toBe(right.digests.at(-1));
    expect(left.isContinuation).toBe(true);
    expect(right.isContinuation).toBe(true);
  });

  it("routes a client-id fork to the member holding the shared history", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const forkPayload = { conversation_id: "fork", messages: forkHistory };
    const material = affinityPrefixDigests(digestArgs(warm.targetIdentity, forkPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue(
      material.routingNodes.map(({ digest, depth }) =>
        affinityRow({
          target: warm,
          material,
          prefixDigest: digest,
          prefixDepth: depth,
          sessionId: "original-session",
        }),
      ),
    );
    const ranked = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: forkPayload,
      targets: [idle, warm],
    });
    expect(ranked.orderedTargetIds[0]).toBe("target-a");
    expect(ranked.prefixDepths["target-a"]).toBeGreaterThan(0);
    expect(ranked.matchedSessionIds?.["target-a"]).toBe(material.clientSessionId);
    expect(ranked.matchedSessionIds?.["target-a"]).not.toBe("original-session");
  });

  it("parallel client-id forks stay distinct; anonymous branches share prefix identity", () => {
    const original = affinityPrefixDigests(digestArgs("runtime", { messages: forkHistory }));
    const forkA = affinityPrefixDigests(
      digestArgs("runtime", { conversation_id: "fork-a", messages: forkHistory }),
    );
    const forkB = affinityPrefixDigests(
      digestArgs("runtime", { conversation_id: "fork-b", messages: forkHistory }),
    );
    const anonymous = affinityPrefixDigests(
      digestArgs("runtime", {
        messages: [...forkHistory.slice(0, 2), { role: "user", content: "anon-edit" }],
      }),
    );
    expect(original.clientSessionId).toBeUndefined();
    expect(forkA.clientSessionId).toBeDefined();
    expect(forkB.clientSessionId).toBeDefined();
    expect(forkA.clientSessionId).not.toBe(forkB.clientSessionId);
    expect(anonymous.clientSessionId).toBeUndefined();
    expect(forkA.digests).toEqual(original.digests);
    expect(forkB.digests).toEqual(original.digests);
    expect(anonymous.digests[0]).toBe(original.digests[0]);
  });

  const r1HeaderCases = ["openai-chat", "anthropic-messages", "openai-responses"].flatMap(
    (surface) =>
      [
        "x-conversation-id",
        "session_id",
        "session-id",
        "x-session-id",
        "x-claude-code-session-id",
      ].map((header) => ({ surface, header })),
  );
  it.each(r1HeaderCases)("R1 header carrier unit $surface $header", async ({ surface, header }) => {
    const content = [
      { role: "user", content: "start" },
      { role: "assistant", content: "reply" },
    ];
    const payload = surface === "openai-responses" ? { input: content } : { messages: content };
    const args = {
      ...digestArgs("runtime", payload, surface),
      headers: new Headers({ [header.toUpperCase()]: " stable-client " }),
    };
    const one = affinityPrefixDigests({
      ...args,
      payload: {
        ...payload,
        metadata: { user_id: "user-A_session_11111111-2222-4333-8444-555555555555" },
      },
    });
    const two = affinityPrefixDigests({
      ...args,
      payload: {
        ...payload,
        metadata: { user_id: "user-B_session_11111111-2222-4333-8444-555555555555" },
      },
    });
    expect(extractClientConversationId(args.headers, payload, surface)).toBe("stable-client");
    expect(two.rootDigest).not.toBe(one.rootDigest);
    expect(two.clientSessionId).toBe(one.clientSessionId);
    expect(
      await resolveAffinitySession(
        db,
        { userId: "owner", tenantUserId: "owner", poolId: "pool", executionTargetId: "target" },
        two,
        new Date(),
      ),
    ).toBe(one.clientSessionId);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  const r1CarrierCases = ["openai-chat", "anthropic-messages", "openai-responses"].flatMap(
    (surface) => [
      ...["conversation", "conversation_id"].flatMap((key) => [
        {
          surface,
          name: `${key} valid`,
          before: { [key]: "client" },
          after: { [key]: " client " },
          free: true,
          client: true,
        },
        {
          surface,
          name: `${key} object`,
          before: { [key]: { id: "client", note: "A" } },
          after: { [key]: { id: "client", note: "B" } },
          free: true,
          client: true,
        },
        {
          surface,
          name: `${key} invalid`,
          before: { [key]: "bad key A" },
          after: { [key]: "bad key B" },
          free: false,
          client: false,
        },
      ]),
      {
        surface,
        name: "prompt_cache_key valid or inactive",
        before: { prompt_cache_key: "client" },
        after: { prompt_cache_key: " client " },
        free: surface !== "anthropic-messages",
        client: surface !== "anthropic-messages",
      },
      {
        surface,
        name: "prompt_cache_key invalid",
        before: { prompt_cache_key: "bad key A" },
        after: { prompt_cache_key: "bad key B" },
        free: false,
        client: false,
      },
      {
        surface,
        name: "ordinary metadata.user_id",
        before: { metadata: { user_id: "user-A" } },
        after: { metadata: { user_id: "user-B" } },
        free: false,
        client: false,
      },
      {
        surface,
        name: "metadata session token valid or inactive",
        before: { metadata: { user_id: "user-A_session_11111111-2222-4333-8444-555555555555" } },
        after: { metadata: { user_id: "user-B_session_11111111-2222-4333-8444-555555555555" } },
        free: surface === "anthropic-messages",
        client: surface === "anthropic-messages",
      },
      {
        surface,
        name: "other metadata fields",
        before: {
          metadata: { user_id: "user_session_11111111-2222-4333-8444-555555555555", extra: "A" },
        },
        after: {
          metadata: { user_id: "user_session_11111111-2222-4333-8444-555555555555", extra: "B" },
        },
        free: false,
        client: surface === "anthropic-messages",
      },
      ...["conversation_id", "prompt_cache_key", "metadata"].map((key) => ({
        surface,
        name: `${key} losing carrier`,
        before: {
          conversation: "winner",
          [key]:
            key === "metadata"
              ? { user_id: "user-A_session_11111111-2222-4333-8444-555555555555" }
              : "A",
        },
        after: {
          conversation: "winner",
          [key]:
            key === "metadata"
              ? { user_id: "user-B_session_11111111-2222-4333-8444-555555555555" }
              : "B",
        },
        free: false,
        client: true,
      })),
    ],
  );
  it.each(r1CarrierCases)(
    "R1 carrier unit $surface $name",
    async ({ surface, before, after, free, client }) => {
      const content = [
        { role: "user", content: "start" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "next" },
      ];
      const request = surface === "openai-responses" ? { input: content } : { messages: content };
      const one = affinityPrefixDigests(digestArgs("runtime", { ...request, ...before }, surface));
      const two = affinityPrefixDigests(digestArgs("runtime", { ...request, ...after }, surface));
      expect(two.rootDigest === one.rootDigest).toBe(free);
      expect(one.clientSessionId !== undefined).toBe(client);
      if (client) {
        expect(two.clientSessionId).toBe(one.clientSessionId);
        const changedRoot = affinityPrefixDigests(
          digestArgs("runtime", { ...request, ...after, unknown_extension: "changed" }, surface),
        );
        expect(changedRoot.rootDigest).not.toBe(one.rootDigest);
        expect(
          await resolveAffinitySession(
            db,
            { userId: "owner", tenantUserId: "owner", poolId: "pool", executionTargetId: "target" },
            changedRoot,
            new Date(),
          ),
        ).toBe(one.clientSessionId);
        expect(db.$queryRaw).not.toHaveBeenCalled();
      }
    },
  );

  // Owner decision AC-21/49: deliberately independent of the production list.
  const approvedSamplingParams = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "typical_p",
    "seed",
    "frequency_penalty",
    "presence_penalty",
    "repetition_penalty",
    "logit_bias",
    "stop",
    "stop_sequences",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "n",
    "best_of",
  ];
  it("AC-21/49 pins the exact owner-approved free sampling list", () => {
    expect([...FREE_SAMPLING_PARAMS].sort()).toEqual([...approvedSamplingParams].sort());
  });
  it.each(
    ["openai-chat", "anthropic-messages", "openai-responses"].flatMap((surface) => [
      ...approvedSamplingParams.map((key) => ({ surface, key, value: 0.9, free: true })),
      { surface, key: "response_format", value: { type: "json_object" }, free: false },
      { surface, key: "tool_choice", value: "required", free: false },
      { surface, key: "unknown_extension", value: 1, free: false },
    ]),
  )("AC-21/49 $surface $key free=$free", ({ surface, key, value, free }) => {
    const content = [
      { role: "user", content: "start" },
      { role: "assistant", content: "reply" },
    ];
    const request = surface === "openai-responses" ? { input: content } : { messages: content };
    const base = affinityPrefixDigests(digestArgs("runtime", request, surface));
    const changed = affinityPrefixDigests(
      digestArgs("runtime", { ...request, [key]: value }, surface),
    );
    expect(changed.rootDigest === base.rootDigest).toBe(free);
    expect(changed.digests).toEqual(free ? base.digests : expect.not.arrayContaining(base.digests));
  });

  it.each(["openai-chat", "anthropic-messages", "openai-responses"])(
    "%s: approved sampling and full root semantics",
    (surface) => {
      const content = [
        { role: "user", content: "start" },
        { role: "assistant", content: "reply" },
      ];
      const request =
        surface === "openai-chat"
          ? { messages: [{ role: "system", content: "rules" }, ...content], tools: [] }
          : surface === "anthropic-messages"
            ? { system: "rules", messages: content, tools: [] }
            : { instructions: "rules", input: content, tools: [] };
      const base = affinityPrefixDigests(digestArgs("runtime", request, surface));
      for (const key of approvedSamplingParams) {
        const changed = affinityPrefixDigests(
          digestArgs("runtime", { ...request, [key]: 0.9 }, surface),
        );
        expect(changed.rootDigest, key).toBe(base.rootDigest);
        expect(changed.digests, key).toEqual(base.digests);
      }
      for (const change of [
        { tools: [{ name: "new" }] },
        { response_format: { type: "json_object" } },
        { text: { format: { type: "json_object" } } },
        { tool_choice: "required" },
        { parallel_tool_calls: false },
        { reasoning: { effort: "high" } },
        { thinking: { type: "enabled" } },
        { extension: 1 },
      ]) {
        const changed = affinityPrefixDigests(
          digestArgs("runtime", { ...request, ...change }, surface),
        );
        expect(changed.rootDigest).not.toBe(base.rootDigest);
        expect(changed.digests).not.toEqual(base.digests);
      }
    },
  );

  it("hashes beyond the first 64 units and retains the true tip", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: String(i),
    }));
    const full = affinityPrefixDigests(digestArgs("runtime", { messages }));
    const altered = affinityPrefixDigests(
      digestArgs("runtime", {
        messages: [...messages.slice(0, 99), { role: "assistant", content: "different" }],
      }),
    );
    expect(full.nodes).toHaveLength(64);
    expect(full.nodes[0]!.depth).toBe(37);
    expect(full.nodes.at(-1)!.depth).toBe(100);
    expect(full.nodes.at(-1)!.digest).not.toBe(altered.nodes.at(-1)!.digest);
  });

  it("canonicalizes telemetry surfaces onto production ProtocolSurface HMACs", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      payload,
      runtimeIdentity: "runtime",
    } as const;
    const chat = affinityPrefixDigests({ ...args, surface: "openai-chat" });
    const chatAlias = affinityPrefixDigests({ ...args, surface: "OPENAI_CHAT_COMPLETIONS" });
    expect(chatAlias.bindingDigest).toBe(chat.bindingDigest);
    expect(chatAlias.instructionDigests).toEqual(chat.instructionDigests);
    expect(chatAlias.digests).toEqual(chat.digests);

    const responsesPayload = { instructions: "S", input: "U", temperature: 0.2 };
    const responses = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: responsesPayload,
    });
    const responsesAlias = affinityPrefixDigests({
      ...args,
      surface: "OPENAI_RESPONSES",
      payload: responsesPayload,
    });
    expect(responsesAlias.bindingDigest).toBe(responses.bindingDigest);
    expect(responsesAlias.instructionDigests).toEqual(responses.instructionDigests);
    expect(responsesAlias.digests).toEqual(responses.digests);

    const anthropicPayload = { system: "S", messages: [{ role: "user", content: "U" }] };
    const anthropic = affinityPrefixDigests({
      ...args,
      surface: "anthropic-messages",
      payload: anthropicPayload,
    });
    const anthropicAlias = affinityPrefixDigests({
      ...args,
      surface: "ANTHROPIC_MESSAGES",
      payload: anthropicPayload,
    });
    expect(anthropicAlias.bindingDigest).toBe(anthropic.bindingDigest);
    expect(anthropicAlias.instructionDigests).toEqual(anthropic.instructionDigests);
    expect(anthropicAlias.digests).toEqual(anthropic.digests);
  });

  it("splits Chat system into instruction HMACs and user turns into conversation prefixes", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "openai-chat",
      runtimeIdentity: "runtime",
    };
    const noTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
      },
    });
    expect(noTools.instructionDigests).toHaveLength(1);
    expect(noTools.digests).toHaveLength(1);
    expect(noTools.isContinuation).toBe(false);

    const withTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
    expect(withTools.instructionDigests).toHaveLength(2);
    expect(withTools.instructionDigests[0]).toBe(noTools.instructionDigests[0]);
    expect(withTools.digests).not.toEqual(noTools.digests);

    const otherTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        tools: [{ type: "function", function: { name: "other" } }],
      },
    });
    expect(otherTools.instructionDigests[0]).toBe(noTools.instructionDigests[0]);
    expect(otherTools.instructionDigests[1]).not.toBe(withTools.instructionDigests[1]);
  });

  it("caps instruction HMAC units at 8 and keeps tools as the last unit", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      surface: "openai-chat",
      runtimeIdentity: "runtime",
    };
    const nine = Array.from({ length: 9 }, (_, index) => ({
      role: "system",
      content: `S${index}`,
    }));
    const nineText = affinityPrefixDigests({
      ...args,
      payload: { messages: [...nine, { role: "user", content: "U" }] },
    });
    expect(nineText.instructionDigests).toHaveLength(8);

    const tools = [{ type: "function", function: { name: "lookup" } }];
    const eightPlusTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [...nine.slice(0, 8), { role: "user", content: "U" }],
        tools,
      },
    });
    const sevenPlusTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [...nine.slice(0, 7), { role: "user", content: "U" }],
        tools,
      },
    });
    expect(eightPlusTools.instructionDigests).toHaveLength(8);
    expect(eightPlusTools.instructionDigests).toEqual(sevenPlusTools.instructionDigests);
    expect(eightPlusTools.instructionDigests[0]).toBe(
      affinityPrefixDigests({
        ...args,
        payload: {
          messages: [
            { role: "system", content: "S0" },
            { role: "user", content: "U" },
          ],
        },
      }).instructionDigests[0],
    );
    const otherTools = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [...nine.slice(0, 8), { role: "user", content: "U" }],
        tools: [{ type: "function", function: { name: "other" } }],
      },
    });
    expect(otherTools.instructionDigests[7]).not.toBe(eightPlusTools.instructionDigests[7]);
    expect(otherTools.instructionDigests.slice(0, 7)).toEqual(
      eightPlusTools.instructionDigests.slice(0, 7),
    );

    const ninthDiffers = affinityPrefixDigests({
      ...args,
      payload: {
        messages: [
          ...nine.slice(0, 8),
          { role: "system", content: "S8-other" },
          { role: "user", content: "U" },
        ],
      },
    });
    expect(ninthDiffers.instructionDigests).toEqual(nineText.instructionDigests);
    expect(ninthDiffers.digests).not.toEqual(nineText.digests);
  });

  it("omits remaining instruction HMACs when a unit exceeds the canonical byte cap", () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 64);
    let result: ReturnType<typeof affinityPrefixDigests> | undefined;
    expect(() => {
      result = affinityPrefixDigests({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        surface: "openai-chat",
        runtimeIdentity: "runtime",
        payload: {
          messages: [
            { role: "system", content: huge },
            { role: "system", content: "after" },
            { role: "user", content: "U" },
          ],
        },
      });
    }).not.toThrow();
    expect(result?.instructionDigests).toEqual([]);
    expect(result?.digests).toHaveLength(0);
    expect(result?.identifiable).toBe(false);
  });

  it("keeps stray unconsumed fields in parameters so conversation prefixes do not collide", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      runtimeIdentity: "runtime",
    };
    const chatPromptNone = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }] },
    });
    const chatPromptA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [{ role: "user", content: "U" }],
        prompt: "abc",
      },
    });
    const chatPromptB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [{ role: "user", content: "U" }],
        prompt: "xyz",
      },
    });
    expect(chatPromptA.digests).toHaveLength(1);
    expect(chatPromptB.digests).toHaveLength(1);
    expect(chatPromptNone.digests).toHaveLength(1);
    expect(chatPromptA.instructionDigests).toEqual([]);
    expect(chatPromptB.instructionDigests).toEqual([]);
    expect(chatPromptA.instructionDigests).toEqual(chatPromptNone.instructionDigests);
    expect(chatPromptA.digests).not.toEqual(chatPromptB.digests);
    expect(chatPromptA.digests).not.toEqual(chatPromptNone.digests);

    const malformedA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: "abc", temperature: 0.1 },
    });
    const malformedB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: "xyz", temperature: 0.1 },
    });
    expect(malformedA.digests).toEqual([]);
    expect(malformedB.digests).toEqual([]);
    expect(malformedA.instructionDigests).toEqual([]);
    // Binding is identical; the stray `messages` string lives in parameters and
    // only changes prefixBinding, which is observable once a conversation unit
    // exists. Pair with a Responses scalar input that also carries the stray.
    const responsesWithStrayMessagesA = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", messages: "abc" },
    });
    const responsesWithStrayMessagesB = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", messages: "xyz" },
    });
    expect(responsesWithStrayMessagesA.digests).not.toEqual(responsesWithStrayMessagesB.digests);

    const responsesSystemA = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", system: "A" },
    });
    const responsesSystemB = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: "U", system: "B" },
    });
    expect(responsesSystemA.digests).not.toEqual(responsesSystemB.digests);

    const anthropicInstructionsA = affinityPrefixDigests({
      ...args,
      surface: "anthropic-messages",
      payload: { messages: [{ role: "user", content: "U" }], instructions: "A" },
    });
    const anthropicInstructionsB = affinityPrefixDigests({
      ...args,
      surface: "anthropic-messages",
      payload: { messages: [{ role: "user", content: "U" }], instructions: "B" },
    });
    expect(anthropicInstructionsA.digests).not.toEqual(anthropicInstructionsB.digests);

    const chatSystemA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }], system: "A" },
    });
    const chatSystemB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }], system: "B" },
    });
    expect(chatSystemA.instructionDigests).toEqual([]);
    expect(chatSystemB.instructionDigests).toEqual([]);
    expect(chatSystemA.digests).toHaveLength(1);
    expect(chatSystemA.digests).not.toEqual(chatSystemB.digests);
  });

  it("does not leak consumed messages, input, or tools into prefix-binding parameters", () => {
    const args = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      runtimeIdentity: "runtime",
    };
    const chatUser = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: { messages: [{ role: "user", content: "U" }] },
    });
    const chatContinued = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
      },
    });
    expect(chatContinued.digests[0]).toBe(chatUser.digests[0]);

    const responsesOne = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: { input: [{ role: "user", content: "U" }] },
    });
    const responsesTwo = affinityPrefixDigests({
      ...args,
      surface: "openai-responses",
      payload: {
        input: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
      },
    });
    expect(responsesTwo.digests[0]).toBe(responsesOne.digests[0]);

    const toolsA = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [{ role: "user", content: "U" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
    const toolsB = affinityPrefixDigests({
      ...args,
      surface: "openai-chat",
      payload: {
        messages: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
    });
    expect(toolsB.digests[0]).toBe(toolsA.digests[0]);
    expect(toolsA.digests[0]).not.toBe(chatUser.digests[0]);
  });

  it("routes fresh Chat by availability and uses instruction depth only as a tie-break", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "A" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
    };
    const seeded = affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload));
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(seeded.instructionDigests[0]).toBe(ranked.instructionDigests[0]);
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const busy = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(busy.orderedTargetIds).toEqual(["target-b", "target-a"]);
    expect(busy.instructionDepths?.["target-a"]).toBe(1);
    expect(busy.prefixDepths["target-a"]).toBe(0);
    expect(busy.prefixDepths["target-b"]).toBe(0);

    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const tied = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(tied.orderedTargetIds[0]).toBe("target-a");
    expect(tied.instructionDepths?.["target-a"]).toBeGreaterThanOrEqual(1);
    expect(tied.prefixDepths["target-a"]).toBe(0);
    expect(tied.reasons["target-a"]).toContain("instruction:");
    expect(tied.reasons["target-a"]).toContain("continuation:false");
  });

  it("does not pin continuations that share only the instruction layer", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "A" },
        { role: "assistant", content: "first" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
        { role: "assistant", content: "other" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds).toEqual(["target-b", "target-a"]);
    expect(result.prefixDepths["target-a"]).toBe(0);
    expect(result.instructionDepths?.["target-a"]).toBe(1);
    expect(affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload)).digests).not.toEqual(
      ranked.digests,
    );
  });

  it("keeps a real continuation stuck under 1/8 load at scored prefix depth 2", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
        { role: "user", content: "next" },
      ],
    };
    const seeded = affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload));
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(ranked.digests.slice(0, 2)).toEqual(seeded.digests);
    db.cacheAffinityRecord.findMany.mockResolvedValue(
      seeded.digests.map((prefixDigest, index) =>
        affinityRow({
          target: warm,
          material: ranked,
          prefixDigest,
          prefixDepth: index + 1,
        }),
      ),
    );
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds[0]).toBe("target-a");
    expect(result.prefixDepths["target-a"]).toBe(2);
  });

  it("ignores v3 rows even when the Prisma mock returns a matching instruction digest", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    const query = db.cacheAffinityRecord.findMany.mock.calls.at(-1)?.[0];
    expect(query?.where.digestVersion).toBe(5);
    expect(query?.select.digestVersion).toBe(true);

    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
        digestVersion: 3,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(result.instructionDepths?.["target-a"]).toBe(0);
    expect(result.orderedTargetIds[0]).toBe("target-b");
  });

  it("queries instruction prefix HMACs even when the conversation digest list is empty", async () => {
    const warm = target("target-a", "runtime-a");
    const idle = target("target-b", "runtime-b");
    const rankPayload = { messages: [{ role: "system", content: "S" }] };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(ranked.digests).toEqual([]);
    expect(ranked.instructionDigests.length).toBeGreaterThan(0);
    await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [warm, idle],
    });
    const query = db.cacheAffinityRecord.findMany.mock.calls.at(-1)?.[0];
    const prefixIn = query?.where.OR.find(
      (clause: { prefixDigest?: { in: string[] } }) => clause.prefixDigest?.in,
    )?.prefixDigest.in;
    expect(prefixIn).toEqual(expect.arrayContaining(ranked.instructionDigests));
  });

  it("returns original Completions order without querying records or load", async () => {
    const busy = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "OPENAI_COMPLETIONS",
      payload: { prompt: "complete this" },
      targets: [{ ...busy, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds).toEqual(["target-a", "target-b"]);
    expect(db.cacheAffinityRecord.findMany).not.toHaveBeenCalled();
    expect(db.capacityLease.groupBy).not.toHaveBeenCalled();
    expect(db.capacityWaiter.groupBy).not.toHaveBeenCalled();
  });

  it("does not fire the confirmed-cache bonus on instruction-only matches", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: ranked.instructionDigests[0],
        prefixDepth: 1,
        engineCacheConfirmed: true,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds[0]).toBe("target-b");
    expect(result.scores["target-a"]).toBe(-13);
    expect(result.reasons["target-a"]).toContain("confirmed:false");
  });

  it("spills or keeps continuations using the worked-example load and health arithmetic", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const continuation = (depth: number) => {
      const messages: Record<string, string>[] = [{ role: "system", content: "S" }];
      for (let index = 0; index < depth; index += 1) {
        messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: `t${index}` });
      }
      return { messages };
    };
    const rankAt = async (
      depth: number,
      warmOverrides: Partial<AffinityTarget>,
      seedInstruction: boolean,
    ) => {
      const rankPayload = continuation(depth);
      const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
      const rows = ranked.digests.map((prefixDigest, index) =>
        affinityRow({
          target: warm,
          material: ranked,
          prefixDigest,
          prefixDepth: index + 1,
        }),
      );
      if (seedInstruction && ranked.instructionDigests[0]) {
        rows.push(
          affinityRow({
            target: warm,
            material: ranked,
            prefixDigest: ranked.instructionDigests[0],
            prefixDepth: 1,
          }),
        );
      }
      db.cacheAffinityRecord.findMany.mockResolvedValue(rows);
      db.capacityLease.groupBy.mockResolvedValue([]);
      db.capacityWaiter.groupBy.mockResolvedValue([]);
      return rankAffinityTargets({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        policy,
        surface: "openai-chat",
        payload: rankPayload,
        targets: [idle, { ...warm, ...warmOverrides }],
      });
    };

    const halfOpenIdle = await rankAt(2, { healthPenalty: 200 }, true);
    expect(halfOpenIdle.scores["target-a"]).toBe(0);
    expect(halfOpenIdle.scores["target-b"]).toBe(0);
    expect(halfOpenIdle.orderedTargetIds[0]).toBe("target-a");

    const halfOpenLoaded = await rankAt(2, { healthPenalty: 200, activeLoad: 1 }, true);
    expect(halfOpenLoaded.orderedTargetIds[0]).toBe("target-b");

    const depth3 = await rankAt(3, { healthPenalty: 200 }, true);
    expect(depth3.orderedTargetIds[0]).toBe("target-a");
    expect(depth3.scores["target-a"]).toBe(100);

    const waiters = await rankAt(2, { waitingLoad: 3 }, true);
    expect(waiters.orderedTargetIds[0]).toBe("target-b");

    const deep = await rankAt(20, { waitingLoad: 5, activeLoad: 1 }, true);
    expect(deep.orderedTargetIds[0]).toBe("target-a");
    expect(deep.scores["target-a"]).toBe(1487);
  });

  it("does not pin fresh Responses instructions, input system items, or Anthropic system", async () => {
    const cases = [
      {
        surface: "openai-responses",
        seed: { instructions: "S", input: "user" },
        rank: { instructions: "S", input: "other" },
      },
      {
        surface: "openai-responses",
        seed: {
          input: [
            { role: "system", content: "S" },
            { role: "user", content: "user" },
          ],
        },
        rank: {
          input: [
            { role: "system", content: "S" },
            { role: "user", content: "other" },
          ],
        },
      },
      {
        surface: "anthropic-messages",
        seed: { system: "S", messages: [{ role: "user", content: "user" }] },
        rank: { system: "S", messages: [{ role: "user", content: "other" }] },
      },
    ] as const;
    for (const testCase of cases) {
      const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
      const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
      const ranked = affinityPrefixDigests(
        digestArgs(warm.targetIdentity, testCase.rank, testCase.surface),
      );
      db.cacheAffinityRecord.findMany.mockResolvedValue(
        ranked.instructionDigests.map((prefixDigest, index) =>
          affinityRow({
            target: warm,
            material: ranked,
            prefixDigest,
            prefixDepth: index + 1,
          }),
        ),
      );
      const result = await rankAffinityTargets({
        ownerId: "owner",
        resourceOwnerId: "owner",
        poolId: "pool",
        securityScope: "token",
        policy,
        surface: testCase.surface,
        payload: testCase.rank,
        targets: [{ ...warm, activeLoad: 1 }, idle],
      });
      expect(result.orderedTargetIds, testCase.surface).toEqual(["target-b", "target-a"]);
      expect(result.prefixDepths["target-a"], testCase.surface).toBe(0);
    }
  });

  it("still warmth-matches the same system when tools differ, without using prefixWeight", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const seedPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "A" },
      ],
    };
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "B" },
      ],
      tools: [{ type: "function", function: { name: "other" } }],
    };
    const seeded = affinityPrefixDigests(digestArgs(warm.targetIdentity, seedPayload));
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    expect(ranked.instructionDigests[0]).toBe(seeded.instructionDigests[0]);
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: ranked,
        prefixDigest: seeded.instructionDigests[0],
        prefixDepth: 1,
      }),
    ]);
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(result.scores["target-a"]).toBe(result.scores["target-b"]);
    expect(result.instructionDepths?.["target-a"]).toBe(1);
    expect(result.prefixDepths["target-a"]).toBe(0);
    expect(result.orderedTargetIds[0]).toBe("target-a");
  });

  it("documents that a shared kickoff plus assistant prefill still pins", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "user", content: "shared kickoff" },
        { role: "assistant", content: "prefill" },
      ],
    };
    const ranked = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue(
      ranked.digests.map((prefixDigest, index) =>
        affinityRow({
          target: warm,
          material: ranked,
          prefixDigest,
          prefixDepth: index + 1,
        }),
      ),
    );
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [{ ...warm, activeLoad: 1 }, idle],
    });
    expect(result.orderedTargetIds[0]).toBe("target-a");
    expect(result.prefixDepths["target-a"]).toBeGreaterThanOrEqual(1);
  });

  it("sweeps expired rows in bounded batches", async () => {
    // Writer class S: one DELETE that takes its rows with SKIP LOCKED.
    db.$executeRaw.mockResolvedValue(2);
    const now = new Date("2026-08-25T12:00:00.000Z");
    await expect(sweepExpiredAffinity({ now, limit: 2 })).resolves.toBe(4);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    const [strings, ...values] = db.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain("DELETE FROM cache_affinity_record");
    expect(sql).toContain('"expiresAt" <= ?');
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(values).toEqual([now, 2]);
    expect(db.cacheAffinityRecord.deleteMany).not.toHaveBeenCalled();

    db.$executeRaw.mockClear();
    await sweepExpiredAffinity({ now, limit: 1_000_000 });
    expect((db.$executeRaw.mock.calls[0] as unknown[]).at(-1)).toBe(10_000);
  });

  it("fences the owner's pool before reading it and writes nothing for a missing pool", async () => {
    const rememberArgs = {
      ownerId: "owner",
      resourceOwnerId: "resource-owner",
      poolId: "pool",
      policy,
      surface: "openai-chat",
      payload,
      target: target("target", "runtime"),
    };
    await rememberAffinity(rememberArgs);
    // After setting lock_timeout, the cache-affinity fence precedes every data statement; the pool
    // is read afterwards without a row lock.
    const [strings, fenceNames] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, string[]];
    expect(strings.join("?")).toContain("wsmp_acquire_fences");
    expect(fenceNames).toEqual(["09:cache-affinity:resource-owner:pool"]);
    for (const call of db.$queryRaw.mock.calls) {
      expect((call[0].strings ?? call[0]).join("?")).not.toMatch(/FOR (NO KEY )?UPDATE/);
    }
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.modelPool.findFirst.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(db.modelPool.findFirst).toHaveBeenCalledWith({
      where: { id: "pool", userId: "resource-owner" },
      select: { id: true },
    });
    expect(db.cacheAffinityRecord.upsert).toHaveBeenCalled();

    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback) => callback(db));
    db.$queryRaw.mockImplementation((query) =>
      Promise.resolve(
        (query.strings ?? query).join("").includes("cache_affinity_node")
          ? []
          : [{ acquired: true }],
      ),
    );
    db.cacheAffinityNode.findMany.mockResolvedValue([]);
    db.cacheAffinityNode.findFirst.mockResolvedValue(null);
    db.cacheAffinityNode.deleteMany.mockResolvedValue({ count: 0 });
    db.cacheAffinityNode.updateMany.mockResolvedValue({ count: 0 });
    db.modelPool.findFirst.mockResolvedValue(null);
    await rememberAffinity(rememberArgs);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.cacheAffinityRecord.deleteMany).not.toHaveBeenCalled();
    expect(db.cacheAffinityRecord.upsert).not.toHaveBeenCalled();
    expect(db.cacheAffinityRecord.create).not.toHaveBeenCalled();
    expect(db.cacheAffinityRecord.update).not.toHaveBeenCalled();
  });

  it("merges engine cache confirmation with latest-evidence semantics", async () => {
    const rememberArgs = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-chat",
      payload,
      target: target("target", "runtime"),
    };

    // Hit: cached prompt tokens reported -> flag recorded true everywhere.
    await rememberAffinity({ ...rememberArgs, engineCacheConfirmed: true });
    expect(db.cacheAffinityRecord.upsert.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of db.cacheAffinityRecord.upsert.mock.calls) {
      expect(input.create.engineCacheConfirmed).toBe(true);
      expect(input.update.engineCacheConfirmed).toBe(true);
    }

    // Reported-zero: a later miss resets the stored confirmation to false.
    db.cacheAffinityRecord.upsert.mockClear();
    await rememberAffinity({ ...rememberArgs, engineCacheConfirmed: false });
    for (const [input] of db.cacheAffinityRecord.upsert.mock.calls) {
      expect(input.update.engineCacheConfirmed).toBe(false);
    }

    // Unreported: no cache evidence must leave the stored flag untouched.
    db.cacheAffinityRecord.upsert.mockClear();
    await rememberAffinity(rememberArgs);
    for (const [input] of db.cacheAffinityRecord.upsert.mock.calls) {
      expect(input.create.engineCacheConfirmed).toBe(false);
      expect(input.update).not.toHaveProperty("engineCacheConfirmed");
    }
  });

  it("writes reported tokens with COALESCE and leaves them on a later estimate-only refresh", async () => {
    const rememberArgs = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-chat",
      payload,
      target: target("target", "runtime"),
    };
    await rememberAffinity({ ...rememberArgs, reportedTokens: 12_000, estimatedTokens: 18_000 });
    for (const [input] of db.cacheAffinityRecord.upsert.mock.calls) {
      expect(input.create.reportedTokens).toBe(12_000);
      expect(input.update.reportedTokens).toBe(12_000);
    }
    db.cacheAffinityRecord.upsert.mockClear();
    await rememberAffinity({ ...rememberArgs, estimatedTokens: 18_000 });
    for (const [input] of db.cacheAffinityRecord.upsert.mock.calls) {
      expect(input.create.reportedTokens).toBeNull();
      expect(input.update).not.toHaveProperty("reportedTokens");
    }
  });

  it("applies latest-evidence merge semantics to explicit conversation records", async () => {
    const conversationArgs = {
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      policy,
      surface: "openai-responses",
      payload: { conversation: "conversation", input: "turn" },
      target: target("target", "runtime"),
    };

    await rememberAffinity(conversationArgs);
    expect(conversationWrites()[0]?.data.engineCacheConfirmed).toBe(false);
    expect(conversationWrites()[0]?.engineEvidence).toBeNull();
    for (const evidence of [undefined, true, false]) {
      db.$executeRaw.mockClear();
      await rememberAffinity({ ...conversationArgs, engineCacheConfirmed: evidence });
      expect(conversationWrites()[0]?.engineEvidence).toBe(evidence ?? null);
      expect(conversationWrites()[0]?.sql).toContain('"engineCacheConfirmed" = COALESCE(');
    }
  });

  it("prefers an engine-confirmed continuation over an equal-depth unconfirmed one", async () => {
    const warm = cap8(target("target-a", "runtime-a", "capacity-a"));
    const idle = cap8(target("target-b", "runtime-b", "capacity-b"));
    const rankPayload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
        { role: "user", content: "next" },
      ],
    };
    const warmMaterial = affinityPrefixDigests(digestArgs(warm.targetIdentity, rankPayload));
    const idleMaterial = affinityPrefixDigests(digestArgs(idle.targetIdentity, rankPayload));
    db.cacheAffinityRecord.findMany.mockResolvedValue([
      affinityRow({
        target: warm,
        material: warmMaterial,
        prefixDigest: warmMaterial.digests[1],
        prefixDepth: 2,
        engineCacheConfirmed: true,
      }),
      affinityRow({
        target: idle,
        material: idleMaterial,
        prefixDigest: idleMaterial.digests[1],
        prefixDepth: 2,
        engineCacheConfirmed: false,
      }),
    ]);
    // Both continuations score identically at depth 2; without the confirmed
    // bonus the original-order tie-break would keep idle first. Only the
    // engineCacheConfirmed flag differentiates the two records.
    const result = await rankAffinityTargets({
      ownerId: "owner",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      policy,
      surface: "openai-chat",
      payload: rankPayload,
      targets: [idle, warm],
    });
    expect(result.orderedTargetIds[0]).toBe("target-a");
    expect(result.scores["target-a"]).toBe(450);
    expect(result.scores["target-b"]).toBe(200);
    expect(result.reasons["target-a"]).toContain("confirmed:true");
    expect(result.reasons["target-b"]).toContain("confirmed:false");
  });
});

describe("R2 adversarial identity material", () => {
  it.each(
    ["openai-chat", "anthropic-messages", "openai-responses"].flatMap((surface) =>
      canonicalLocations.flatMap((location) =>
        canonicalShapes.flatMap((shape) =>
          canonicalKeys.map((key) => ({ surface, location, shape, key })),
        ),
      ),
    ),
  )(
    "wire $surface $key changes $location $shape identity without losing any key",
    ({ surface, location, shape, key }) => {
      const request = (value: string) => {
        const leaf = `{${JSON.stringify(key)}:{"const":${JSON.stringify(value)}},"__proto__":{"const":${JSON.stringify(value)}}}`;
        const wire =
          shape === "array" ? `[${leaf}]` : shape === "mixed" ? `{"nested":[${leaf}]}` : leaf;
        return JSON.parse(canonicalPayloadWire(location, wire, surface));
      };
      const one = affinityPrefixDigests(digestArgs("runtime", request("one"), surface));
      const two = affinityPrefixDigests(digestArgs("runtime", request("two"), surface));
      expect(one.identifiable).toBe(true);
      expect(two.identifiable).toBe(true);
      if (location === "messages") expect(two.nodes).not.toEqual(one.nodes);
      else {
        expect(two.rootDigest).not.toBe(one.rootDigest);
        expect(two.nodes).not.toEqual(one.nodes);
      }
      const protoOnly = (value: string) => {
        const leaf = `{${JSON.stringify(key)}:{"const":"one"},"__proto__":{"const":${JSON.stringify(value)}}}`;
        const wire =
          shape === "array" ? `[${leaf}]` : shape === "mixed" ? `{"nested":[${leaf}]}` : leaf;
        return affinityPrefixDigests(
          digestArgs("runtime", JSON.parse(canonicalPayloadWire(location, wire, surface)), surface),
        );
      };
      expect(protoOnly("one").nodes).not.toEqual(protoOnly("two").nodes);
      // Independently change the selected key while holding __proto__ constant.
      const selectedOnly = JSON.parse(
        canonicalPayloadWire(
          location,
          `{${JSON.stringify(key)}:{"const":"two"}${key === "__proto__" ? "" : ',"__proto__":{"const":"one"}'}}`,
          surface,
        ),
      );
      const selectedBefore = JSON.parse(
        canonicalPayloadWire(
          location,
          `{${JSON.stringify(key)}:{"const":"one"}${key === "__proto__" ? "" : ',"__proto__":{"const":"one"}'}}`,
          surface,
        ),
      );
      expect(affinityPrefixDigests(digestArgs("runtime", selectedOnly, surface)).nodes).not.toEqual(
        affinityPrefixDigests(digestArgs("runtime", selectedBefore, surface)).nodes,
      );
    },
  );

  it.each(depthRows)(
    "$location $shape depth $depth is atomic across rank, resolver and writer",
    async ({ location, shape, depth }) => {
      const request = JSON.parse(depthPayloadWire(location, depth, shape));
      const args = digestArgs("runtime", request, "openai-responses");
      const material = affinityPrefixDigests(args);
      expect(material.identifiable).toBe(depth === MAX_CANONICAL_DEPTH);
      if (depth === MAX_CANONICAL_DEPTH) {
        expect(material.nodes.length).toBeGreaterThan(0);
        return;
      }
      const withCarrier = { ...args, payload: { ...request, conversation: "must-not-link" } };
      const unsafe = affinityPrefixDigests(withCarrier);
      expect(unsafe).toMatchObject({
        nodes: [],
        routingNodes: [],
        digests: [],
        instructionDigests: [],
        conversationDigest: null,
        identifiable: false,
      });
      expect(unsafe.clientSessionId).toBeUndefined();
      expect(unsafe.boundSessionId).toBeUndefined();
      expect(unsafe.parentTipDigest).toBeUndefined();
      expect(unsafe.parentTipDepth).toBeUndefined();
      db.$transaction.mockClear();
      expect(
        await rememberAffinity({ ...withCarrier, target: target("target", "runtime"), policy }),
      ).toBeNull();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(
        await resolveAffinitySession(
          db,
          { userId: "owner", tenantUserId: "owner", poolId: "pool", executionTargetId: "target" },
          unsafe,
          new Date(),
        ),
      ).toBeNull();
      const ranked = await rankAffinityTargets({
        ...withCarrier,
        policy,
        targets: [target("target", "runtime")],
        scoreSingleTarget: true,
      });
      expect(ranked.matchedSessionIds).toEqual({});
      expect(ranked.prefixDepths.target ?? 0).toBe(0);
      expect(ranked.instructionDepths?.target ?? 0).toBe(0);
    },
  );

  it("realistic depth-20 schema preserves odd keys, key order and duplicate last-wins", () => {
    const schema =
      '{"type":"object","properties":{"__proto__":{"const":1},"constructor":{"type":"string"}},"additionalProperties":false}';
    let deep = schema;
    for (let level = 0; level < 7; level++)
      deep = `{"type":"object","properties":{"child":${deep}},"required":["child"],"additionalProperties":false}`;
    const first = affinityPrefixDigests(
      digestArgs("runtime", JSON.parse(canonicalPayloadWire("tools", deep)), "openai-responses"),
    );
    const reordered = deep.replace(
      '"type":"object","properties"',
      '"additionalProperties":false,"type":"object","properties"',
    );
    const second = affinityPrefixDigests(
      digestArgs(
        "runtime",
        JSON.parse(canonicalPayloadWire("tools", reordered)),
        "openai-responses",
      ),
    );
    expect(first.identifiable).toBe(true);
    expect(second.rootDigest).toBe(first.rootDigest);
    const changed = deep.replace('"const":1', '"const":1,"const":2');
    expect(
      affinityPrefixDigests(
        digestArgs(
          "runtime",
          JSON.parse(canonicalPayloadWire("tools", changed)),
          "openai-responses",
        ),
      ).rootDigest,
    ).not.toBe(first.rootDigest);
  });

  it("canonicalization failures cannot escape affinityPrefixDigests or leave partial identity", () => {
    const throwing = {
      messages: [{ role: "user", content: "U" }],
      get tools(): unknown {
        throw new Error("getter failure");
      },
    };
    expect(() => affinityPrefixDigests(digestArgs("runtime", throwing))).not.toThrow();
    expect(affinityPrefixDigests(digestArgs("runtime", throwing))).toMatchObject({
      identifiable: false,
      nodes: [],
      instructionDigests: [],
      routingNodes: [],
    });
  });
});

it.each([false, true])(
  "R3 bound cumulative 2 MiB cap retains routing/client footprint without lineage client=%s",
  async (client) => {
    const args = digestArgs("runtime", { input: "parent" }, "openai-responses");
    const first = affinityPrefixDigests(args);
    const sessionBinding = {
      sessionId: "parent",
      bindingDigest: first.bindingDigest,
      rootDigest: first.rootDigest,
      tipDigest: first.nodes.at(-1)!.digest,
      tipDepth: 1,
      canonicalBytes: 2 * 1024 * 1024,
    };
    const request = {
      ...args,
      sessionBinding,
      payload: {
        previous_response_id: "parent",
        input: "delta",
        ...(client ? { conversation: "client" } : {}),
      },
    };
    const material = affinityPrefixDigests(request);
    expect(material).toMatchObject({
      identifiable: false,
      nodes: [],
      instructionDigests: [],
      conversationDigest: null,
    });
    expect(material.routingNodes).toEqual([{ digest: sessionBinding.tipDigest, depth: 1 }]);
    expect(Boolean(material.clientSessionId)).toBe(client);
    expect(material.boundSessionId).toBeUndefined();
    expect(material.parentTipDigest).toBeUndefined();
    expect(material.parentTipDepth).toBeUndefined();
    db.$transaction.mockClear();
    expect(
      await rememberAffinity({ ...request, policy, target: target("target", "runtime") }),
    ).toBeNull();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(conversationWrites()).toHaveLength(client ? 1 : 0);
  },
);

it("R6 oversized new instructions refuse a bound Responses continuation", () => {
  const args = digestArgs("runtime", { input: "parent" }, "openai-responses");
  const parent = affinityPrefixDigests(args);
  const sessionBinding = {
    sessionId: "parent-session",
    bindingDigest: parent.bindingDigest,
    rootDigest: parent.rootDigest,
    tipDigest: parent.nodes.at(-1)!.digest,
    tipDepth: 1,
    canonicalBytes: parent.canonicalBytes,
  };
  const followup = {
    ...args,
    sessionBinding,
    payload: { previous_response_id: "parent", input: "delta" },
  };
  expect(affinityPrefixDigests(followup).boundSessionId).toBe("parent-session");
  const changed = {
    ...followup,
    payload: { ...followup.payload, instructions: "x".repeat(2 * 1024 * 1024 + 1) },
  };
  expect(buildCanonicalRequest(changed)?.hasRootFields).toBe(true);
  const material = affinityPrefixDigests(changed);
  expect(material.rootDigest).toBe("");
  expect(material.routingNodes).toEqual([]);
  expect(material.isContinuation).toBe(false);
  expect(material.missingParent).toBe(true);
  expect(material.boundSessionId).toBeUndefined();
  expect(material.parentTipDigest).toBeUndefined();
  expect(material.identifiable).toBe(false);
  expect(material.nodes).toEqual([]);
});

it("R2 wire __proto__ in legacy Chat function schemas binds the root", () => {
  const request = (value: number) =>
    JSON.parse(
      `{"messages":[{"role":"user","content":"U"},{"role":"assistant","content":"A"}],"functions":[{"name":"lookup","parameters":{"properties":{"__proto__":{"const":${value}}}}}]}`,
    );
  const one = affinityPrefixDigests(digestArgs("runtime", request(1)));
  const two = affinityPrefixDigests(digestArgs("runtime", request(2)));
  expect(one.identifiable).toBe(true);
  expect(two.rootDigest).not.toBe(one.rootDigest);
  expect(two.nodes).not.toEqual(one.nodes);
});

it("R3 affinityPrefixDigests catches HMAC failures after successful conversion", async () => {
  const security = await import("@ws-model-proxy/db/forwarder-security");
  const hmac = vi.spyOn(security, "hmacDigestForForwarderPurpose").mockImplementation(() => {
    throw new Error("HMAC unavailable");
  });
  try {
    expect(() => affinityPrefixDigests(digestArgs("runtime", payload))).not.toThrow();
    expect(affinityPrefixDigests(digestArgs("runtime", payload))).toMatchObject({
      identifiable: false,
      nodes: [],
      routingNodes: [],
      instructionDigests: [],
      bindingDigest: "",
    });
    expect(hmac).toHaveBeenCalled();
  } finally {
    hmac.mockRestore();
  }
});

it.each(numericOverflowRows)(
  "R4 numeric overflow $surface $shape binds forwarded null",
  ({ surface, shape }) => {
    const absent = affinityPrefixDigests(
      digestArgs("runtime", numericOverflowPayload(surface, shape, undefined), surface),
    );
    const nil = affinityPrefixDigests(
      digestArgs("runtime", numericOverflowPayload(surface, shape, "null"), surface),
    );
    const finite = affinityPrefixDigests(
      digestArgs("runtime", numericOverflowPayload(surface, shape, "1e300"), surface),
    );
    expect(nil.rootDigest).not.toBe(absent.rootDigest);
    expect(finite.rootDigest).not.toBe(nil.rootDigest);
    for (const value of ["1e400", "-1e400"]) {
      const wireParsed = numericOverflowPayload(surface, shape, value);
      const original = affinityPrefixDigests(digestArgs("runtime", wireParsed, surface));
      const forwarded = affinityPrefixDigests(
        digestArgs("runtime", JSON.parse(JSON.stringify(wireParsed)), surface),
      );
      expect(original.identifiable).toBe(true);
      expect(original.rootDigest).toBe(nil.rootDigest);
      expect(original.nodes).toEqual(nil.nodes);
      expect(forwarded).toEqual(original);
    }
  },
);

it("R4 bounds wide/deep canonical work and ranks 3 targets within 2 seconds", async () => {
  db.cacheAffinityRecord.findMany.mockResolvedValue([]);
  db.capacityLease.groupBy.mockResolvedValue([]);
  db.capacityWaiter.groupBy.mockResolvedValue([]);
  const wide = {
    conversation: "client",
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
      { role: "user", content: new Array(4_000_000).fill(0) },
    ],
  };
  const work = { steps: 0 };
  const ownKeys = Object.keys;
  const keys = vi.spyOn(Object, "keys").mockImplementation((entry) => {
    if (Array.isArray(entry) && entry.length >= 4_000_000)
      throw new Error("wide arrays must be indexed");
    return ownKeys(entry);
  });
  let canonical: ReturnType<typeof buildCanonicalRequest>;
  try {
    canonical = buildCanonicalRequest(digestArgs("runtime", wide), work);
  } finally {
    keys.mockRestore();
  }
  expect(canonical).not.toBeNull();
  expect(canonical!.conversationUnits).toHaveLength(2);
  expect(canonical!.conversationOverflow).toBe(true);
  expect(work.steps).toBeLessThanOrEqual(8 * 2 * 1024 * 1024);
  expect(work.steps).toBeGreaterThan(4_000_000);
  const material = affinityPrefixDigests(digestArgs("runtime", wide));
  expect(material).toMatchObject({ identifiable: false, nodes: [] });
  expect(material.routingNodes).toHaveLength(2);
  expect(material.instructionDigests).toHaveLength(1);
  expect(material.clientSessionId).toBeDefined();
  const deepWork = { steps: 0 };
  expect(
    buildCanonicalRequest(
      digestArgs(
        "runtime",
        JSON.parse(depthPayloadWire("tools", 128, "mixed")),
        "openai-responses",
      ),
      deepWork,
    ),
  ).not.toBeNull();
  expect(deepWork.steps).toBeLessThanOrEqual(8 * 2 * 1024 * 1024);
  const rootWork = { steps: 0 };
  const root = buildCanonicalRequest(
    digestArgs("runtime", {
      messages: wide.messages.slice(0, 3),
      conversation: "client",
      vendor_extension: wide.messages[3]!.content,
    }),
    rootWork,
  );
  expect(root).not.toBeNull();
  expect(root!.rootBytes).toBe(2 * 1024 * 1024 + 1);
  expect(root!.conversationUnits).toEqual([]);
  expect(rootWork.steps).toBeLessThanOrEqual(8 * 2 * 1024 * 1024);
  let reads = 0;
  Object.defineProperty(wide, "vendor_extension", {
    enumerable: true,
    get() {
      reads++;
      return "bind";
    },
  });
  const start = performance.now();
  await rankAffinityTargets({
    ...digestArgs("runtime", wide),
    policy,
    targets: [target("a", "a"), target("b", "b"), target("c", "c")],
  });
  const elapsed = performance.now() - start;
  console.info(
    `R4 canonical smoke: ${work.steps} steps; rank(4M,3) ${Math.round(elapsed)} ms; payload reads ${reads}`,
  );
  expect(reads).toBe(2); // validation and root capture, independent of target count
  expect(elapsed).toBeLessThan(2000);
}, 10_000);

it("R4 unit-count work refusal retains the safe prefix without identifying a truncated chain", () => {
  const request = {
    conversation: "client",
    messages: Array.from({ length: 4097 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "x",
    })),
  };
  const refused = affinityPrefixDigests(digestArgs("runtime", request));
  expect(refused.identifiable).toBe(false);
  expect(refused.nodes).toEqual([]);
  expect(refused.routingNodes).toHaveLength(64);
  expect(refused.routingNodes.at(-1)?.depth).toBe(4096);
  expect(refused.clientSessionId).toBeDefined();
  expect(
    affinityPrefixDigests(
      digestArgs("runtime", { ...request, messages: request.messages.slice(0, 4096) }),
    ).identifiable,
  ).toBe(true);
});

it("R4 ordinary request roots and nodes retain the previous v5 digest bytes", async () => {
  const { hmacDigestForForwarderPurpose } = await import("@ws-model-proxy/db/forwarder-security");
  const previous = (value: JsonValue): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(previous).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${previous(value[key]!)}`)
      .join(",")}}`;
  };
  const hash = (value: string) =>
    hmacDigestForForwarderPurpose({ purpose: "cacheAffinity", value });
  for (const surface of ["openai-chat", "anthropic-messages", "openai-responses"]) {
    for (let seed = 0; seed < 40; seed++) {
      const extension: JsonValue = {
        "01": [seed, true, null, "☃😀"],
        nested: { [canonicalKeys[seed % canonicalKeys.length]!]: seed / 7 },
      };
      const units = [
        { role: "user", content: "U" },
        { role: "assistant", content: `A${seed}` },
      ];
      const request = {
        ...(surface === "openai-responses"
          ? { input: units, instructions: "rules" }
          : surface === "anthropic-messages"
            ? { messages: units, system: "rules" }
            : { messages: [{ role: "system", content: "rules" }, ...units] }),
        tools: [{ name: "lookup", parameters: extension }],
        vendor_extension: extension,
      };
      const args = digestArgs("runtime", request, surface);
      const material = affinityPrefixDigests(args);
      const layers = extractAffinityLayers(surface, request);
      const bindingDigest = hash(
        `affinity-binding-v5:${previous({ v: 5, ownerId: "owner", resourceOwnerId: "owner", poolId: "pool", securityScope: "token", accessGrantId: null, surface, runtimeIdentity: "runtime" })}`,
      );
      expect(material.bindingDigest).toBe(bindingDigest);
      const root = hash(
        `affinity-root-v5:${previous({ bindingDigest, instructions: layers.instructionUnits, tools: layers.tools ?? null, parameters: { vendor_extension: extension } })}`,
      );
      expect(material.rootDigest).toBe(root);
      let tip = root;
      const nodes = layers.conversationUnits.map((unit, index) => {
        tip = hash(`affinity-node-v5:${tip}:${previous(unit)}`);
        return { digest: tip, depth: index + 1 };
      });
      expect(material.nodes).toEqual(nodes);
    }
  }
});

it.each(["parameter", "tools", "instructions", "messages"] as const)(
  "R4 wire non-finite %s never drops root fields or conversation units",
  (location) => {
    for (const surface of ["openai-chat", "anthropic-messages", "openai-responses"]) {
      for (const value of ["1e400", "-1e400", '{"field":1e400}', "[1e400]"]) {
        const request = JSON.parse(canonicalPayloadWire(location, value, surface));
        const material = affinityPrefixDigests(digestArgs("runtime", request, surface));
        expect(material.identifiable).toBe(true);
        expect(material).toEqual(
          affinityPrefixDigests(
            digestArgs("runtime", JSON.parse(JSON.stringify(request)), surface),
          ),
        );
        expect(material.nodes).toHaveLength(2);
      }
    }
  },
);

it("R4 work exhaustion is atomic and the injected counter never exceeds its literal cap", () => {
  const work = { steps: 8 * 2 * 1024 * 1024 - 1 };
  expect(
    buildCanonicalRequest(
      digestArgs("runtime", { messages: [{ role: "user", content: "U" }], conversation: "client" }),
      work,
    ),
  ).toBeNull();
  expect(work.steps).toBe(8 * 2 * 1024 * 1024);
  expect(
    buildCanonicalRequest(digestArgs("runtime", { messages: [{ role: "user", content: "U" }] }), {
      steps: 0,
    }),
  ).not.toBeNull();
});

it.each(instructionPlacementRows)(
  "R7 production placement $surface $role separates leading and relocated histories",
  ({ surface, role }) => {
    const instruction = { role, content: "S" };
    const user = { role: "user", content: "U" };
    const suffix = [
      { role: "assistant", content: "A" },
      { role: "user", content: "V" },
    ];
    const material = (units: unknown[]) =>
      affinityPrefixDigests(digestArgs("runtime", orderedHistoryPayload(surface, units), surface));
    const a1 = material([instruction, user]);
    const b1 = material([user, instruction]);
    const a2 = material([instruction, user, ...suffix]);
    const b2 = material([user, instruction, ...suffix]);
    expect(a1.identifiable && b1.identifiable && a2.identifiable && b2.identifiable).toBe(true);
    expect(a1.rootDigest).not.toBe(b1.rootDigest);
    expect(a2.rootDigest).toBe(a1.rootDigest);
    expect(b2.rootDigest).toBe(b1.rootDigest);
    expect(a2.nodes.at(-1)?.digest).not.toBe(b2.nodes.at(-1)?.digest);
    expect(a1.nodes).toHaveLength(1);
    expect(b1.nodes).toHaveLength(2);
    expect(a2.nodes.slice(0, 1)).toEqual(a1.nodes);
    expect(b2.nodes.slice(0, 2)).toEqual(b1.nodes);
    expect(a1.isContinuation).toBe(false);
    expect(b1.isContinuation).toBe(false);
    expect(a2.isContinuation).toBe(true);
    expect(b2.isContinuation).toBe(true);
    expect(a2.instructionDigests).toHaveLength(1);
    expect(a2.instructionDigests).toEqual(a1.instructionDigests);
    expect(b1.instructionDigests).toEqual([]);
    expect(b2.instructionDigests).toEqual([]);
    expect(b2.rootDigest).toBe(material([user, ...suffix]).rootDigest);
  },
);

it.each(instructionPlacementRows)(
  "R7 production late edit $surface $role preserves root hints and prefix before the edit",
  ({ surface, role }) => {
    const prefix = [
      { role, content: "leading" },
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
    ];
    const material = (text: string) =>
      affinityPrefixDigests(
        digestArgs(
          "runtime",
          orderedHistoryPayload(surface, [
            ...prefix,
            { role, content: text },
            { role: "user", content: "V" },
          ]),
          surface,
        ),
      );
    const first = material("late");
    const edit = material("edited late");
    expect(first.rootDigest).toBe(edit.rootDigest);
    expect(first.instructionDigests).toEqual(edit.instructionDigests);
    expect(first.nodes).toHaveLength(4);
    expect(first.nodes.slice(0, 2)).toEqual(edit.nodes.slice(0, 2));
    expect(first.nodes.slice(2)).not.toEqual(edit.nodes.slice(2));
    const leadingEdit = affinityPrefixDigests(
      digestArgs(
        "runtime",
        orderedHistoryPayload(surface, [
          { role, content: "edited leading" },
          ...prefix.slice(1),
          { role, content: "late" },
          { role: "user", content: "V" },
        ]),
        surface,
      ),
    );
    expect(leadingEdit.rootDigest).not.toBe(first.rootDigest);
    expect(leadingEdit.instructionDigests).not.toEqual(first.instructionDigests);
    expect(leadingEdit.nodes[0]).not.toEqual(first.nodes[0]);
  },
);

it.each(instructionPlacementRows)(
  "R7 continuation split $surface $role keeps late output evidence after the first user",
  ({ surface, role }) => {
    for (const type of ["tool_use", "tool_result"]) {
      const instruction = { role, content: [{ type, id: "call" }] };
      for (const units of [
        [instruction, { role: "user", content: "U" }],
        [{ role: "assistant", content: "greeting" }, instruction, { role: "user", content: "U" }],
        [{ role: "user", content: "U" }, instruction],
      ]) {
        const request = orderedHistoryPayload(surface, units);
        const expected = units[0]?.role === "user";
        expect(buildCanonicalRequest({ surface, payload: request })?.isContinuation).toBe(expected);
        expect(extractAffinityLayers(surface, request).isContinuation).toBe(expected);
      }
    }
  },
);

it.each([
  {
    surface: "openai-chat",
    request: {
      model: "alias",
      stream: false,
      temperature: 0.2,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: {
              type: "object",
            },
          },
        },
      ],
      vendor_extension: {
        stable: true,
      },
      messages: [
        {
          role: "system",
          content: "S",
        },
        {
          role: "developer",
          content: "D",
        },
        {
          role: "user",
          content: "U",
        },
        {
          role: "assistant",
          content: "A",
        },
        {
          role: "user",
          content: "V",
        },
      ],
    },
    rootDigest: "g3AgU67fsnUp02hkzf5U4zHC2BN034RLlW9299aij_w",
    nodes: [
      {
        digest: "WlvFWf2vi9FySNq5H6HqvIWF13oUXLFApp5b8Op0GyA",
        depth: 1,
      },
      {
        digest: "6jp7Fef4p_URXkegSigsd-wTjiGp6jqTePKpZRD0LyE",
        depth: 2,
      },
      {
        digest: "Wr3sYG2GmjZLE33Ye5PYfCzPy_Y8b2RBKGOk4JMPEyo",
        depth: 3,
      },
    ],
    instructionDigests: [
      "instruction-v5:BRsSf2Cp53X44mAmqlyFn9IcUzWWsnTDp9_hXq5dweA",
      "instruction-v5:Oq7UsVtdg2V0aCEzIJ7xBdkxFOoi9ny4jgyObhSWfns",
      "instruction-v5:-dtT_Nz_DpeKXWEP5J4ohtJwiC3SxVFsIDqAkcGjRHE",
    ],
  },
  {
    surface: "openai-responses",
    request: {
      model: "alias",
      stream: false,
      temperature: 0.2,
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: {
            type: "object",
          },
        },
      ],
      vendor_extension: {
        stable: true,
      },
      instructions: "top",
      input: [
        {
          role: "system",
          content: "S",
        },
        {
          role: "developer",
          content: "D",
        },
        {
          role: "user",
          content: "U",
        },
        {
          role: "assistant",
          content: "A",
        },
        {
          role: "user",
          content: "V",
        },
      ],
    },
    rootDigest: "QgvvQRR1ZmNDQmTNdKClM-UDIztvXNCcW7wjUBAyR1A",
    nodes: [
      {
        digest: "nZc_pk25cKhGsC5bVZnwVz4ktqbIci1Ygbi097PYDg0",
        depth: 1,
      },
      {
        digest: "q1IR1Ai2laay5ii6otXoybq5YXXrfoLeVurJ-6z5jZA",
        depth: 2,
      },
      {
        digest: "cc1zCNVHFXuvtNUELEgLn4yGRhrHLSJr1Z8r6FKdkeo",
        depth: 3,
      },
    ],
    instructionDigests: [
      "instruction-v5:k1g1kEmr2B6nLsvI47rKLcjpx7MAus1yKEf5ch6MznQ",
      "instruction-v5:vl2HH12OiYEjhLZSi5ynajEy-9ygEgpZ4AtAtHPlA0o",
      "instruction-v5:ol7uQpz-WTKxrAH6ws8tfAL_YRmI4-ZCrGoZfCWzq5o",
      "instruction-v5:qjmSUfNQO_jfdefvgutLy9IqSjgLO1iVAxpN7gHbOLw",
    ],
  },
  {
    surface: "anthropic-messages",
    request: {
      model: "alias",
      stream: false,
      temperature: 0.2,
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
          },
        },
      ],
      vendor_extension: {
        stable: true,
      },
      system: [
        {
          type: "text",
          text: "S",
        },
      ],
      messages: [
        {
          role: "user",
          content: "U",
        },
        {
          role: "assistant",
          content: "A",
        },
        {
          role: "user",
          content: "V",
        },
      ],
    },
    rootDigest: "qPrVvbCK40E-RRskLw1IJw6wRQ0BN8JMA9m5UZwNIDs",
    nodes: [
      {
        digest: "VVuMYkSXcPomPOXy7sNM4nn8l0WbuoM9z3n72yiSOmw",
        depth: 1,
      },
      {
        digest: "KoeRFAneXhf5aNPPjOaS0PVB-Ph121ZeypLLlu56MR8",
        depth: 2,
      },
      {
        digest: "NrYJLEB7AxvepojaYDIFY20jvPOOe5kd0AnqlQ_0QKo",
        depth: 3,
      },
    ],
    instructionDigests: [
      "instruction-v5:FL987faZpOp3sx4KrjuOm6f8NptSOli13w0XQpkha-k",
      "instruction-v5:hFMNZxu436AXEXzUQP4_WCJW0-wfl6O30fIsrgk5Pa0",
    ],
  },
])(
  "R7 golden leading instructions $surface retain HEAD root nodes and routing hints",
  ({ surface, request, rootDigest, nodes, instructionDigests }) => {
    const material = affinityPrefixDigests(digestArgs("runtime", request, surface));
    expect(material.rootDigest).toBe(rootDigest);
    expect(material.nodes).toEqual(nodes);
    expect(material.instructionDigests).toEqual(instructionDigests);
  },
);

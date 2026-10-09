import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  },
}));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: vi.fn(() => false),
  sendEmail: vi.fn(async () => undefined),
  renderShareInvite: vi.fn(() => ({ subject: "s", html: "h" })),
}));
const fenceLog = vi.hoisted(() => ({ held: [] as string[] }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async (_tx: unknown, requested: Iterable<string>) => {
      fenceLog.held.push(...requested);
      return true;
    }),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { CallerAuth } from "../contracts/auth-context";
import { releaseClaim } from "../lib/claim-release";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";
import { shownAgentText } from "./runtime-release";
import { runtimesRouter } from "./runtimes";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const API_KEY: CallerAuth = { kind: "api_key", userId: OWNER, apiKeyId: "key-1" };
const READ_AGENT: CallerAuth = {
  kind: "agent_token",
  userId: OWNER,
  agentTokenId: "tok-1",
  level: "READ",
};

function client(auth: CallerAuth = CALLERS.person()) {
  return createRouterClient(runtimesRouter, { context: contextFor(auth) });
}

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError)
      return (error.data as { reason?: string } | undefined)?.reason ?? error.code;
    throw error;
  }
  return undefined;
}

const NOW = Date.now();

/** The instance with one rank as `ownedRank` reads it. */
function instanceWith(
  claim: "HELD" | "HELD_UNKNOWN" | "RELEASED",
  connection: "ONLINE" | "OFFLINE" = "ONLINE",
) {
  return {
    id: "inst-1",
    phase: "STOPPED",
    phaseChangedAt: new Date(NOW - 3_600_000),
    Ranks: [
      {
        id: "rank-0",
        rank: 0,
        claim,
        markedStoppedAt: new Date(NOW - 1_800_000),
        Node: {
          id: "node-1",
          trust: "FULL",
          trustLowerRequestedAt: null,
          connection,
          lastConnectedAt: new Date(NOW - 7_200_000),
          lastDisconnectedAt: connection === "OFFLINE" ? new Date(NOW - 600_000) : null,
          lastHeartbeatAt: new Date(NOW - 10_000),
        },
      },
    ],
  };
}

/** The last status probe of the rank: the node answered "still running". */
function lastCheck(errorCode = "status_running") {
  db.instanceStep.findFirst.mockResolvedValue({
    instanceId: "inst-1",
    rank: 0,
    state: "FAILED",
    errorCode,
    updatedAt: new Date(NOW - 60_000),
  } as never);
}

beforeEach(() => {
  mockReset(db);
  fenceLog.held.length = 0;
  db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) => work(db)) as never);
});

describe("who may release, ask, withdraw, approve and decline", () => {
  const releaseCalls = {
    releaseUnproven: (c: ReturnType<typeof client>) =>
      c.instances.releaseUnproven({ instanceId: "inst-1", nodeNumber: 1 }),
    approve: (c: ReturnType<typeof client>) => c.releaseRequests.approve({ requestId: "req-1" }),
    decline: (c: ReturnType<typeof client>) => c.releaseRequests.decline({ requestId: "req-1" }),
  };

  it("refuses every agent, API key and cookie without CSRF the person-only actions", async () => {
    for (const [name, call] of Object.entries(releaseCalls))
      for (const auth of [
        CALLERS.fullAgent(),
        CALLERS.oauthAgent(),
        READ_AGENT,
        API_KEY,
        CALLERS.cookieWithoutCsrf(),
      ])
        expect(await reasonOf(call(client(auth))), `${name} by ${auth.kind}`).toBe("FORBIDDEN");
    expect(db.runtimeInstance.findFirst).not.toHaveBeenCalled();
    expect(db.claimReleaseRequest.findFirst).not.toHaveBeenCalled();
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    expect(db.claimReleaseRequest.updateMany).not.toHaveBeenCalled();
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("lets only an agent ask or withdraw: never a person, a Read-only agent, an API key or a cookie without CSRF", async () => {
    const ask = (c: ReturnType<typeof client>) =>
      c.releaseRequests.create({ instanceId: "inst-1", findings: "checked" });
    const withdraw = (c: ReturnType<typeof client>) =>
      c.releaseRequests.withdraw({ instanceId: "inst-1" });
    for (const call of [ask, withdraw])
      for (const auth of [CALLERS.person(), READ_AGENT, API_KEY, CALLERS.cookieWithoutCsrf()])
        expect(await reasonOf(call(client(auth))), auth.kind).toBe("FORBIDDEN");
    expect(db.runtimeInstance.findFirst).not.toHaveBeenCalled();
    expect(db.claimReleaseRequest.create).not.toHaveBeenCalled();
  });

  it("finds nothing of another user's: every read is scoped to the caller", async () => {
    db.runtimeInstance.findFirst.mockResolvedValue(null);
    db.claimReleaseRequest.findFirst.mockResolvedValue(null);
    const other = "other-user";
    expect(
      await reasonOf(
        client(CALLERS.person(other)).instances.releaseUnproven({
          instanceId: "inst-1",
          nodeNumber: 1,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await reasonOf(
        client(CALLERS.fullAgent(other)).releaseRequests.create({
          instanceId: "inst-1",
          findings: "checked",
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await reasonOf(client(CALLERS.person(other)).releaseRequests.approve({ requestId: "req-1" })),
    ).toBe("NOT_FOUND");
    expect(
      await reasonOf(client(CALLERS.person(other)).releaseRequests.decline({ requestId: "req-1" })),
    ).toBe("NOT_FOUND");
    for (const call of db.runtimeInstance.findFirst.mock.calls)
      expect(call[0]?.where).toMatchObject({ id: "inst-1", userId: other });
    for (const call of db.claimReleaseRequest.findFirst.mock.calls)
      expect(call[0]?.where).toMatchObject({ id: "req-1", userId: other });
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    expect(db.claimReleaseRequest.create).not.toHaveBeenCalled();
  });
});

describe("runtimes.instances.releaseUnproven", () => {
  it("releases a part marked stopped under the fences, recording who, when and why", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    lastCheck("status_running");
    db.instanceRank.updateMany.mockResolvedValue({ count: 1 });
    db.runtimeInstance.findFirst.mockResolvedValueOnce(null);
    // The view read after the commit: gone meanwhile is NOT_FOUND, never a 500.
    expect(
      await reasonOf(
        client().instances.releaseUnproven({
          instanceId: "inst-1",
          nodeNumber: 1,
          note: "nothing on the port",
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(fenceLog.held).toEqual(
      expect.arrayContaining([expect.stringContaining(OWNER), expect.stringContaining("inst-1")]),
    );
    expect(db.runtimeInstance.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "inst-1",
      userId: OWNER,
    });
    // Only a claim still marked stopped changes (the proven-stop release, plus the record).
    expect(db.instanceRank.updateMany).toHaveBeenCalledWith({
      where: { id: "rank-0", claim: "HELD_UNKNOWN" },
      data: expect.objectContaining({
        claim: "RELEASED",
        releasedUnprovenBy: OWNER,
        releasedUnprovenReason: "status_running",
        releasedUnprovenAt: expect.any(Date),
      }),
    });
    // Pending agent requests for the claim are cleared with it.
    expect(db.claimReleaseRequest.updateMany).toHaveBeenCalledWith({
      where: { pendingRankId: { in: ["rank-0"] }, state: "PENDING" },
      data: expect.objectContaining({ state: "CLEARED", pendingRankId: null }),
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      nodeId: "node-1",
      actor: "USER",
      agentTokenId: null,
      mcpGrantId: null,
      kind: "claim_released",
      subject: "instance:inst-1 rank:0",
      outcome: "completed",
      reason: "status_running: nothing on the port",
    });
  });

  it("records a node that is offline as the reason", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(
      instanceWith("HELD_UNKNOWN", "OFFLINE") as never,
    );
    lastCheck("port_in_use");
    db.instanceRank.updateMany.mockResolvedValue({ count: 1 });
    db.runtimeInstance.findFirst.mockResolvedValueOnce(null);
    await reasonOf(client().instances.releaseUnproven({ instanceId: "inst-1", nodeNumber: 1 }));
    expect(db.instanceRank.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      releasedUnprovenReason: "node_offline",
    });
  });

  it("refuses a part still waiting for its stop, one already released, and a node number it lacks", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD") as never);
    expect(
      await reasonOf(client().instances.releaseUnproven({ instanceId: "inst-1", nodeNumber: 1 })),
    ).toBe("not_marked_stopped");
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("RELEASED") as never);
    expect(
      await reasonOf(client().instances.releaseUnproven({ instanceId: "inst-1", nodeNumber: 1 })),
    ).toBe("already_released");
    db.runtimeInstance.findFirst.mockResolvedValueOnce({
      ...instanceWith("HELD_UNKNOWN"),
      Ranks: [],
    } as never);
    expect(
      await reasonOf(client().instances.releaseUnproven({ instanceId: "inst-1", nodeNumber: 2 })),
    ).toBe("NOT_FOUND");
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("answers already released when a proof released the claim first (no audit, no record)", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    lastCheck();
    db.instanceRank.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await reasonOf(client().instances.releaseUnproven({ instanceId: "inst-1", nodeNumber: 1 })),
    ).toBe("already_released");
    expect(db.claimReleaseRequest.updateMany).not.toHaveBeenCalled();
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });
});

describe("releaseClaim: a late proof after a person released the claim", () => {
  it("changes nothing: the release only takes a claim still held or marked stopped", async () => {
    db.instanceRank.updateMany.mockResolvedValue({ count: 0 });
    expect(await releaseClaim(db as never, "rank-0", new Date())).toBe(false);
    expect(db.instanceRank.updateMany).toHaveBeenCalledWith({
      where: { id: "rank-0", claim: { in: ["HELD", "HELD_UNKNOWN"] } },
      data: expect.not.objectContaining({ releasedUnprovenAt: expect.anything() }),
    });
    // Nothing else is touched: no request is cleared, the person's record stays.
    expect(db.claimReleaseRequest.updateMany).not.toHaveBeenCalled();
  });

  it("a person's release takes only a claim marked stopped", async () => {
    db.instanceRank.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await releaseClaim(db as never, "rank-0", new Date(), { by: OWNER, reason: "no_check" }),
    ).toBe(false);
    expect(db.instanceRank.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "rank-0",
      claim: "HELD_UNKNOWN",
    });
  });
});

describe("runtimes.releaseRequests.create / withdraw (agents)", () => {
  it("records a pending request with cleaned findings and evidence, audited with the agent", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    const expiresAt = new Date(NOW + 86_400_000);
    db.claimReleaseRequest.create.mockResolvedValue({
      id: "req-1",
      state: "PENDING",
      expiresAt,
    } as never);
    const result = await client(CALLERS.oauthAgent()).releaseRequests.create({
      instanceId: "inst-1",
      findings:
        "\u001b[31mport 30001 is free\u001b[0m; token wsmp_agent_abcdefghijklmnopqrstuvwxyz0123",
      evidence: [{ command: "ss -ltnp 'sport = :30001'", output: "State\r\n\u202Eevil" }],
    });
    expect(result).toEqual({
      requestId: "req-1",
      state: "PENDING",
      expiresAt: expiresAt.toISOString(),
    });
    const data = db.claimReleaseRequest.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      userId: OWNER,
      rankId: "rank-0",
      pendingRankId: "rank-0",
      agentTokenId: null,
      mcpGrantId: "grant-1",
      findings: "port 30001 is free; token [redacted]",
      evidence: [{ command: "ss -ltnp 'sport = :30001'", output: "State\n\uFFFDevil" }],
    });
    const ttl = (data?.expiresAt as Date | undefined)?.getTime() ?? 0;
    expect(ttl - Date.now()).toBeGreaterThan(86_400_000 - 60_000);
    expect(ttl - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "AGENT",
      mcpGrantId: "grant-1",
      kind: "claim_release_request",
      outcome: "opened",
      subject: "instance:inst-1 rank:0 request:req-1",
    });
  });

  it("allows one pending request per part, and only for a part marked stopped", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    db.claimReleaseRequest.create.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).releaseRequests.create({
          instanceId: "inst-1",
          findings: "checked",
        }),
      ),
    ).toBe("release_request_pending");
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD") as never);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).releaseRequests.create({
          instanceId: "inst-1",
          findings: "checked",
        }),
      ),
    ).toBe("not_marked_stopped");
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("RELEASED") as never);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).releaseRequests.create({
          instanceId: "inst-1",
          findings: "checked",
        }),
      ),
    ).toBe("already_released");
    expect(db.claimReleaseRequest.create).toHaveBeenCalledTimes(1);
  });

  it("lets an agent take back only its own request", async () => {
    db.runtimeInstance.findFirst.mockResolvedValue(instanceWith("HELD_UNKNOWN") as never);
    db.claimReleaseRequest.findFirst.mockResolvedValueOnce(null);
    expect(
      await reasonOf(
        client(CALLERS.oauthAgent()).releaseRequests.withdraw({ instanceId: "inst-1" }),
      ),
    ).toBe("NOT_FOUND");
    expect(db.claimReleaseRequest.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      userId: OWNER,
      pendingRankId: "rank-0",
      state: "PENDING",
      agentTokenId: null,
      mcpGrantId: "grant-1",
    });
    db.claimReleaseRequest.findFirst.mockResolvedValueOnce({
      id: "req-1",
      expiresAt: new Date(NOW + 1_000),
    } as never);
    db.claimReleaseRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      client(CALLERS.fullAgent()).releaseRequests.withdraw({ instanceId: "inst-1" }),
    ).resolves.toMatchObject({ requestId: "req-1", state: "WITHDRAWN" });
    // Conditional on still pending and still this credential's.
    expect(db.claimReleaseRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "req-1",
        userId: OWNER,
        state: "PENDING",
        agentTokenId: "tok-1",
        mcpGrantId: null,
      },
      data: expect.objectContaining({ state: "WITHDRAWN", pendingRankId: null }),
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "AGENT",
      agentTokenId: "tok-1",
      kind: "claim_release_request",
      outcome: "cancelled",
    });
  });
});

describe("runtimes.releaseRequests: what an agent's text and node may be", () => {
  it("answers a conflict when the sweep or a revocation settled the request before the withdrawal", async () => {
    db.runtimeInstance.findFirst.mockResolvedValue(instanceWith("HELD_UNKNOWN") as never);
    db.claimReleaseRequest.findFirst.mockResolvedValueOnce({
      id: "req-1",
      expiresAt: new Date(NOW + 1_000),
    } as never);
    db.claimReleaseRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).releaseRequests.withdraw({ instanceId: "inst-1" }),
      ),
    ).toBe("CONFLICT");
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("refuses an agent on a Relay-only node, as marking it stopped does", async () => {
    const relay = instanceWith("HELD_UNKNOWN");
    const [part] = relay.Ranks;
    if (part) part.Node.trust = "RELAY";
    db.runtimeInstance.findFirst.mockResolvedValueOnce(relay as never);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).releaseRequests.create({
          instanceId: "inst-1",
          findings: "checked",
        }),
      ),
    ).toBe("trust_relay");
    expect(db.claimReleaseRequest.create).not.toHaveBeenCalled();
  });

  it("refuses evidence whose command is empty once cleaned", async () => {
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).releaseRequests.create({
          instanceId: "inst-1",
          findings: "checked",
          evidence: [{ command: "\u001b[31m", output: "" }],
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(db.claimReleaseRequest.create).not.toHaveBeenCalled();
  });

  it("stores the largest evidence within the stored bounds, even when cleaning lengthens it", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    db.claimReleaseRequest.create.mockResolvedValue({
      id: "req-1",
      state: "PENDING",
      expiresAt: new Date(NOW + 86_400_000),
    } as never);
    // A leading credential prefix grows by one character when redacted; quotes and
    // non-ASCII text grow as JSON bytes.
    const findings = `wsmp_key_${"x".repeat(3_991)}`;
    const entry = { command: `wsmp_key_${'"'.repeat(1_991)}`, output: '\u00e9"'.repeat(2_000) };
    await client(CALLERS.fullAgent()).releaseRequests.create({
      instanceId: "inst-1",
      findings,
      evidence: Array(8).fill(entry),
    });
    const data = db.claimReleaseRequest.create.mock.calls[0]?.[0]?.data;
    expect([...(data?.findings ?? "")].length).toBeLessThanOrEqual(4_000);
    const evidence = data?.evidence as Array<{ command: string; output: string }>;
    expect(evidence).toHaveLength(8);
    for (const stored of evidence) {
      expect(stored.command.length).toBeLessThanOrEqual(2_000);
      expect(stored.output.length).toBeLessThanOrEqual(4_000);
    }
    // Well inside claim_release_request_shape's 256 KiB.
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(262_144);
  });
});

describe("runtimes.releaseRequests.approve / decline (people)", () => {
  const request = { id: "req-1", Rank: { rank: 0, nodeId: "node-1", instanceId: "inst-1" } };

  it("approves through the same release, marking the request approved first", async () => {
    db.claimReleaseRequest.findFirst.mockResolvedValue(request as never);
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    db.claimReleaseRequest.updateMany.mockResolvedValue({ count: 1 });
    lastCheck("status_running");
    db.instanceRank.updateMany.mockResolvedValue({ count: 1 });
    db.runtimeInstance.findFirst.mockResolvedValueOnce(null);
    await reasonOf(client().releaseRequests.approve({ requestId: "req-1" }));
    expect(db.claimReleaseRequest.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "req-1", userId: OWNER, rankId: "rank-0", state: "PENDING" },
      data: { state: "APPROVED", pendingRankId: null, decidedBy: OWNER },
    });
    expect(db.instanceRank.updateMany).toHaveBeenCalledWith({
      where: { id: "rank-0", claim: "HELD_UNKNOWN" },
      data: expect.objectContaining({ claim: "RELEASED", releasedUnprovenBy: OWNER }),
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "USER",
      kind: "claim_released",
      subject: "instance:inst-1 rank:0 request:req-1",
    });
  });

  it("refuses a request already decided, withdrawn or expired, and releases nothing", async () => {
    db.claimReleaseRequest.findFirst.mockResolvedValue(request as never);
    db.runtimeInstance.findFirst.mockResolvedValueOnce(instanceWith("HELD_UNKNOWN") as never);
    db.claimReleaseRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await reasonOf(client().releaseRequests.approve({ requestId: "req-1" }))).toBe(
      "CONFLICT",
    );
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    expect(await reasonOf(client().releaseRequests.decline({ requestId: "req-1" }))).toBe(
      "CONFLICT",
    );
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("declines a pending request; the claim stays held", async () => {
    db.claimReleaseRequest.findFirst.mockResolvedValue(request as never);
    db.claimReleaseRequest.updateMany.mockResolvedValue({ count: 1 });
    db.claimReleaseRequest.findUniqueOrThrow.mockResolvedValue({
      id: "req-1",
      state: "DECLINED",
      agentTokenId: "tok-1",
      mcpGrantId: null,
      findings: "checked",
      evidence: null,
      createdAt: new Date(NOW - 1_000),
      expiresAt: new Date(NOW + 1_000),
      decidedAt: new Date(NOW),
      Rank: {
        rank: 0,
        nodeId: "node-1",
        Node: { slug: "box" },
        Instance: { id: "inst-1", runtimeId: "rt-1", Runtime: { name: "Qwen" } },
      },
    } as never);
    db.agentToken.findMany.mockResolvedValue([{ id: "tok-1", name: "codex" }] as never);
    await expect(client().releaseRequests.decline({ requestId: "req-1" })).resolves.toMatchObject({
      id: "req-1",
      state: "DECLINED",
      agentName: "codex",
      nodeSlug: "box",
      evidence: [],
    });
    expect(db.claimReleaseRequest.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "req-1", userId: OWNER, state: "PENDING" },
      data: { state: "DECLINED", pendingRankId: null, decidedBy: OWNER },
    });
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "USER",
      kind: "claim_release_request",
      outcome: "declined",
    });
  });
});

describe("shownAgentText", () => {
  it("keeps tabs and newlines, drops terminal sequences, redacts credentials, marks hidden characters", () => {
    expect(shownAgentText("a\tb\r\nc\u001b[2Jd\u200Be wsmp_key_0123456789abcdefghijklmnop")).toBe(
      "a\tb\ncd\uFFFDe [redacted]",
    );
  });
});

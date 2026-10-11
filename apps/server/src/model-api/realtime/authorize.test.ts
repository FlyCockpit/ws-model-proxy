import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { LocalSendRefused } = await import("../local-send.js");
const { createRealtimeAuthorizer, realtimeLocalSendBinding, recheckRealtimePermission } =
  await import("./authorize.js");
type Candidate = Parameters<typeof realtimeLocalSendBinding>[1];

const requester = { tokenId: "token-1", userId: "grantee" };

function candidate(route: Partial<NonNullable<Candidate["route"]>> = {}): Candidate {
  return {
    nodeId: "node-1",
    handle: "i-aaaaaaaaaaaa",
    upstreamModel: "whisper-large",
    capabilities: null,
    memberId: "m1",
    route: {
      kind: "pool",
      poolId: "pool-1",
      poolMemberId: "m1",
      runtimeModelId: "rm-1",
      executionTargetId: "et-1",
      instanceId: "inst-1",
      ownerUserId: "owner",
      engineOwnerUserId: "contributor",
      shareId: "share-1",
      contributedShareId: "share-c",
      ...route,
    },
  };
}

describe("realtime send binding", () => {
  it("binds the exact pool destination as the HTTP send does", () => {
    expect(realtimeLocalSendBinding(requester, candidate())).toEqual({
      requesterUserId: "grantee",
      apiKeyId: "token-1",
      engineOwnerUserId: "contributor",
      runtimeModelId: "rm-1",
      executionTargetId: "et-1",
      capacityId: "inst-1",
      nodeId: "node-1",
      handle: "i-aaaaaaaaaaaa",
      upstreamModelId: "whisper-large",
      pool: {
        id: "pool-1",
        ownerUserId: "owner",
        shareId: "share-1",
        memberId: "m1",
        contributedShareId: "share-c",
      },
    });
  });

  it("binds a test target without a pool, and refuses a target without capacity identity", () => {
    const test = realtimeLocalSendBinding(
      requester,
      candidate({ kind: "test", poolId: null, poolMemberId: null, shareId: null }),
    );
    expect(test).not.toHaveProperty("pool");
    expect(realtimeLocalSendBinding(requester, candidate({ instanceId: "" }))).toBeNull();
    expect(realtimeLocalSendBinding(requester, { ...candidate(), route: undefined })).toBeNull();
  });
});

describe("realtime send claim", () => {
  it("opens inside the claim and maps each denial", async () => {
    const open = vi.fn();
    const abort = vi.fn();
    const passing = createRealtimeAuthorizer(requester, async (_binding, send) => send());
    expect(await passing(candidate(), open, abort)).toEqual({ ok: true });
    expect(open).toHaveBeenCalledTimes(1);
    for (const [denial, mapped] of [
      ["REQUESTER_BLOCKED", "requester"],
      ["ACCESS_REVOKED", "access"],
      ["OWNER_INACTIVE", "member"],
      ["MEMBER_UNAVAILABLE", "member"],
      ["CHECK_FAILED", "check_failed"],
    ] as const) {
      const refusing = createRealtimeAuthorizer(requester, async () => {
        throw new LocalSendRefused(denial);
      });
      expect(await refusing(candidate(), open, abort)).toEqual({ ok: false, denial: mapped });
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("withdraws a sent open whose claim did not commit", async () => {
    const open = vi.fn();
    const abort = vi.fn();
    const failingCommit = createRealtimeAuthorizer(requester, async (_binding, send, options) => {
      const sent = send();
      options?.onCommitFailure?.(sent);
      throw new LocalSendRefused("CHECK_FAILED");
    });
    expect(await failingCommit(candidate(), open, abort)).toEqual({
      ok: false,
      denial: "check_failed",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("refuses a candidate it cannot bind, without opening", async () => {
    const open = vi.fn();
    const claim = vi.fn();
    const authorize = createRealtimeAuthorizer(requester, claim);
    expect(await authorize(candidate({ executionTargetId: "" }), open, vi.fn())).toEqual({
      ok: false,
      denial: "member",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("the recheck maps denials and throws on a failed check", async () => {
    expect(await recheckRealtimePermission(requester, candidate(), async () => null)).toBeNull();
    expect(
      await recheckRealtimePermission(requester, candidate(), async () => "ACCESS_REVOKED"),
    ).toBe("access");
    expect(
      await recheckRealtimePermission(requester, candidate(), async () => "OWNER_INACTIVE"),
    ).toBe("member");
    await expect(
      recheckRealtimePermission(requester, candidate(), async () => "CHECK_FAILED"),
    ).rejects.toThrow();
  });
});

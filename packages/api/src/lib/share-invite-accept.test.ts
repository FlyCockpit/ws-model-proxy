import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    BETTER_AUTH_URL: "https://proxy.example.com",
  },
}));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderShareInvite: vi.fn(),
}));
const db = vi.hoisted(() => ({
  shareInvite: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  share: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));
const lockOrder = vi.hoisted(() => ({
  fenceOwners: vi.fn(async () => undefined),
  runCapacityOrderedTransaction: vi.fn(
    async (client: unknown, work: (tx: unknown) => Promise<unknown>) => work(client),
  ),
}));
vi.mock("@ws-model-proxy/db/capacity-lock-order", () => lockOrder);
const registry = vi.hoisted(() => ({
  registerShareInviteAcceptor: vi.fn(),
  registerShareInviteLinkAcceptor: vi.fn(),
}));
vi.mock("@ws-model-proxy/auth/share-invite-acceptance", () => registry);

import { credentialDigest } from "@ws-model-proxy/db/node-security";
import {
  acceptClaimedShareInvite,
  acceptShareInviteByLink,
  acceptShareInvitesForProvenEmail,
  claimShareInviteForSignup,
  isPendingShareInvite,
} from "./share-invite-accept";
import {
  pendingInviteWhere as pending,
  SHARE_INVITE_SIGNUP_CLAIM_MS,
  unclaimedInviteWhere as unclaimed,
} from "./share-invites";

const TOKEN = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const later = new Date(Date.now() + 86_400_000);
const invite = {
  id: "inv1",
  email: "friend@example.test",
  expiresAt: later,
  acceptedAt: null,
  revokedAt: null,
  poolId: "pool1",
  ownerUserId: "owner",
  canUse: true,
  canContribute: true,
  priorityClass: null,
};
const user = { id: "friend", email: "Friend@Example.test" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("share invite acceptance", () => {
  it("registers itself with the Better Auth hooks", async () => {
    vi.resetModules();
    await import("./share-invite-accept");
    expect(registry.registerShareInviteAcceptor).toHaveBeenCalledTimes(1);
    expect(registry.registerShareInviteLinkAcceptor).toHaveBeenCalledTimes(1);
  });

  it("finds a pending invite by its token's digest only", async () => {
    const token = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const now = new Date();
    db.shareInvite.findFirst.mockResolvedValueOnce({ id: "inv1" }).mockResolvedValueOnce(null);
    await expect(isPendingShareInvite(token, now)).resolves.toBe(true);
    await expect(isPendingShareInvite(token, now)).resolves.toBe(false);
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      tokenDigest: credentialDigest("shareInvite", token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    });
    await expect(isPendingShareInvite("wsmp_inv_short", now)).resolves.toBe(false);
    expect(db.shareInvite.findFirst).toHaveBeenCalledTimes(2);
  });

  it("does not accept by e-mail match for an unproven address (needs the link)", async () => {
    db.shareInvite.findMany.mockResolvedValue([invite]);
    await expect(acceptShareInvitesForProvenEmail({ ...user, emailVerified: false })).resolves.toBe(
      0,
    );
    expect(db.share.create).not.toHaveBeenCalled();
    expect(lockOrder.fenceOwners).not.toHaveBeenCalled();
  });

  it("creates the share for a proven e-mail under both owners' fences", async () => {
    db.shareInvite.findMany.mockResolvedValueOnce([invite]).mockResolvedValueOnce([invite]);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    await expect(acceptShareInvitesForProvenEmail({ ...user, emailVerified: true })).resolves.toBe(
      1,
    );
    expect(lockOrder.fenceOwners).toHaveBeenCalledWith(db, ["friend", "owner"]);
    expect(db.share.create.mock.calls[0]?.[0].data).toMatchObject({
      poolId: "pool1",
      ownerUserId: "owner",
      granteeUserId: "friend",
      canContribute: true,
    });
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      shareId: "share1",
    });
  });

  it("rolls back when the invite was revoked meanwhile", async () => {
    db.shareInvite.findMany.mockResolvedValueOnce([invite]).mockResolvedValueOnce([invite]);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      acceptShareInvitesForProvenEmail({ ...user, emailVerified: true }),
    ).rejects.toThrow();
  });

  it("accepts through the link whatever the account's e-mail, leaving a reserved invite alone", async () => {
    const now = new Date();
    db.shareInvite.findFirst.mockResolvedValue(invite);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      acceptShareInviteByLink({ id: "friend", email: "other@example.test" }, TOKEN, now),
    ).resolves.toBe("accepted");
    expect(lockOrder.fenceOwners).toHaveBeenCalledWith(db, ["friend", "owner"]);
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      tokenDigest: credentialDigest("shareInvite", TOKEN),
      AND: [pending(now), unclaimed(now)],
    });
    // The guarded write repeats the hold: a sign-up claiming meanwhile wins.
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "inv1",
      AND: [pending(now), unclaimed(now)],
    });
  });

  it("refuses a malformed or unknown link, and the owner's own invite", async () => {
    await expect(acceptShareInviteByLink(user, "not-a-token")).resolves.toBe("invalid");
    db.shareInvite.findFirst.mockResolvedValueOnce(null);
    await expect(acceptShareInviteByLink(user, TOKEN)).resolves.toBe("invalid");
    db.shareInvite.findFirst.mockResolvedValueOnce(invite);
    await expect(
      acceptShareInviteByLink({ id: "owner", email: "o@example.test" }, TOKEN),
    ).resolves.toBe("own_pool");
    expect(db.share.create).not.toHaveBeenCalled();
  });

  it("finds nothing to accept when the invite expired or was revoked after the check", async () => {
    const claimedAt = new Date();
    // Pending at the first read, gone at the re-read under the fences.
    db.shareInvite.findFirst.mockResolvedValueOnce(invite).mockResolvedValueOnce(null);
    await expect(
      acceptClaimedShareInvite({ id: "friend", email: "other@example.test" }, TOKEN, claimedAt),
    ).resolves.toBe(false);
    expect(db.share.create).not.toHaveBeenCalled();
    expect(db.shareInvite.updateMany).not.toHaveBeenCalled();
  });

  it("accepts the invite a sign-up reserved only under that sign-up's claim", async () => {
    const claimedAt = new Date(Date.now() - 1_000);
    const now = new Date();
    db.shareInvite.findFirst.mockResolvedValue(invite);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      acceptClaimedShareInvite(
        { id: "friend", email: "other@example.test" },
        TOKEN,
        claimedAt,
        now,
      ),
    ).resolves.toBe(true);
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "inv1",
      AND: [pending(now), { signupClaimedAt: claimedAt }],
    });
  });
});

describe("invite-link sign-up claim", () => {
  it("reserves a pending, unclaimed (or stale) invite with one guarded update", async () => {
    const now = new Date();
    db.shareInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(claimShareInviteForSignup(TOKEN, now)).resolves.toEqual(now);
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        tokenDigest: credentialDigest("shareInvite", TOKEN),
        AND: [
          pending(now),
          {
            OR: [
              { signupClaimedAt: null },
              { signupClaimedAt: { lt: new Date(now.getTime() - SHARE_INVITE_SIGNUP_CLAIM_MS) } },
            ],
          },
        ],
      },
      data: { signupClaimedAt: now },
    });
  });

  it("gives the claim to one of two sign-ups with one token at once", async () => {
    // The database serializes the two guarded updates: the second sees the fresh claim.
    db.shareInvite.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const [first, second] = await Promise.all([
      claimShareInviteForSignup(TOKEN),
      claimShareInviteForSignup(TOKEN),
    ]);
    expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);
  });

  it("claims nothing for a malformed token", async () => {
    await expect(claimShareInviteForSignup("wsmp_inv_short")).resolves.toBeNull();
    expect(db.shareInvite.updateMany).not.toHaveBeenCalled();
  });
});

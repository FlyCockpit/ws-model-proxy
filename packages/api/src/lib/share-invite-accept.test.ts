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
  user: { findUnique: vi.fn() },
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
import { pendingInviteWhere as pending, SHARE_INVITE_SIGNUP_CLAIM_MS } from "./share-invites";

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
  signupClaimedAt: null as Date | null,
  signupClaimedEmail: null as string | null,
};
const user = { id: "friend", email: "Friend@Example.test" };
/** A signed-in or signing-up person whose e-mail is not the invited one. */
const other = { id: "friend", email: "other@example.test" };
/** The invite as claimed by a sign-up with `email` at `at`. */
const claimedBy = (email: string, at: Date = new Date()) => ({
  ...invite,
  signupClaimedAt: at,
  signupClaimedEmail: email,
});

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

  it("accepts through the link whatever the account's e-mail, guarded on the claim as read", async () => {
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
      ...pending(now),
    });
    // The guarded write repeats the claim as read: a sign-up claiming meanwhile wins.
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "inv1",
      AND: [pending(now), { signupClaimedAt: null, signupClaimedEmail: null }],
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

  it("answers invalid when it loses the guarded write to a concurrent change", async () => {
    db.shareInvite.findFirst.mockResolvedValue(invite);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 0 });
    await expect(acceptShareInviteByLink(other, TOKEN)).resolves.toBe("invalid");
  });

  it("finds nothing to accept when the invite expired or was revoked after the check", async () => {
    // Pending at the first read, gone at the re-read under the fences.
    db.shareInvite.findFirst
      .mockResolvedValueOnce(claimedBy(other.email))
      .mockResolvedValueOnce(null);
    await expect(acceptClaimedShareInvite(other, TOKEN)).resolves.toBe(false);
    expect(db.share.create).not.toHaveBeenCalled();
    expect(db.shareInvite.updateMany).not.toHaveBeenCalled();
  });

  it("accepts for the new account only the claim of its own e-mail", async () => {
    const now = new Date();
    const claimed = claimedBy("other@example.test", now);
    db.shareInvite.findFirst.mockResolvedValue(claimed);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    // Better Auth stores the e-mail lower-cased; the key also trims.
    await expect(
      acceptClaimedShareInvite({ id: "friend", email: " Other@example.test" }, TOKEN, now),
    ).resolves.toBe(true);
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "inv1",
      AND: [
        pending(now),
        { signupClaimedAt: claimed.signupClaimedAt, signupClaimedEmail: "other@example.test" },
      ],
    });
    db.shareInvite.findFirst.mockResolvedValue(claimedBy("someone@example.test", now));
    await expect(acceptClaimedShareInvite(other, TOKEN, now)).resolves.toBe(false);
  });
});

describe("signed-in acceptance against a sign-up claim", () => {
  const now = new Date();
  const fresh = new Date(now.getTime() - 60_000);
  const stale = new Date(now.getTime() - SHARE_INVITE_SIGNUP_CLAIM_MS - 60_000);

  beforeEach(() => {
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
  });

  it("leaves a fresh claim of another e-mail to that sign-up", async () => {
    db.shareInvite.findFirst.mockResolvedValue(claimedBy("someone@example.test", fresh));
    await expect(acceptShareInviteByLink(other, TOKEN, now)).resolves.toBe("in_use");
    expect(db.share.create).not.toHaveBeenCalled();
  });

  it("lets the claimant account recover the invite its sign-up failed to accept", async () => {
    db.shareInvite.findFirst.mockResolvedValue(claimedBy(other.email, stale));
    await expect(acceptShareInviteByLink(other, TOKEN, now)).resolves.toBe("accepted");
  });

  it("keeps a stale claim with the claimant's account, and frees it when there is none", async () => {
    db.shareInvite.findFirst.mockResolvedValue(claimedBy("someone@example.test", stale));
    db.user.findUnique.mockResolvedValueOnce({ id: "someone" });
    await expect(acceptShareInviteByLink(other, TOKEN, now)).resolves.toBe("invalid");
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "someone@example.test" },
      select: { id: true },
    });
    db.user.findUnique.mockResolvedValueOnce(null);
    await expect(acceptShareInviteByLink(other, TOKEN, now)).resolves.toBe("accepted");
  });
});

describe("invite-link sign-up claim", () => {
  const now = new Date();

  it("claims a free invite for the e-mail with a compare-and-swap on the claim as read", async () => {
    db.shareInvite.findFirst.mockResolvedValueOnce(invite);
    db.shareInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(claimShareInviteForSignup(TOKEN, " Other@example.test", now)).resolves.toBe(
      "claimed",
    );
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: "inv1",
        AND: [pending(now), { signupClaimedAt: null, signupClaimedEmail: null }],
      },
      data: { signupClaimedAt: now, signupClaimedEmail: "other@example.test" },
    });
  });

  it("gives the claim to one of two sign-ups with one token at once", async () => {
    // Both read the free invite; the database serializes the two swaps, the second matches no row.
    db.shareInvite.findFirst.mockResolvedValue(invite);
    db.shareInvite.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const results = await Promise.all([
      claimShareInviteForSignup(TOKEN, "a@example.test", now),
      claimShareInviteForSignup(TOKEN, "b@example.test", now),
    ]);
    expect(results.sort()).toEqual(["claimed", "in_use"]);
  });

  it("answers invalid when the swap lost to a revoke, not 'in use'", async () => {
    db.shareInvite.findFirst.mockResolvedValueOnce(invite).mockResolvedValueOnce(null);
    db.shareInvite.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(claimShareInviteForSignup(TOKEN, "a@example.test", now)).resolves.toBe("invalid");
  });

  it("lets the same e-mail take over its own fresh claim (a rolled-back sign-up)", async () => {
    const own = claimedBy("other@example.test", new Date(now.getTime() - 1_000));
    db.shareInvite.findFirst.mockResolvedValueOnce(own);
    db.shareInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(claimShareInviteForSignup(TOKEN, "other@example.test", now)).resolves.toBe(
      "claimed",
    );
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "inv1",
      AND: [
        pending(now),
        { signupClaimedAt: own.signupClaimedAt, signupClaimedEmail: "other@example.test" },
      ],
    });
  });

  it("refuses another e-mail inside the window, and after it while the claimant has an account", async () => {
    db.shareInvite.findFirst.mockResolvedValueOnce(
      claimedBy("someone@example.test", new Date(now.getTime() - 60_000)),
    );
    await expect(claimShareInviteForSignup(TOKEN, "other@example.test", now)).resolves.toBe(
      "in_use",
    );
    const stale = new Date(now.getTime() - SHARE_INVITE_SIGNUP_CLAIM_MS - 1);
    db.shareInvite.findFirst.mockResolvedValueOnce(claimedBy("someone@example.test", stale));
    db.user.findUnique.mockResolvedValueOnce({ id: "someone" });
    await expect(claimShareInviteForSignup(TOKEN, "other@example.test", now)).resolves.toBe(
      "invalid",
    );
    db.shareInvite.findFirst.mockResolvedValueOnce(claimedBy("someone@example.test", stale));
    db.user.findUnique.mockResolvedValueOnce(null);
    db.shareInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(claimShareInviteForSignup(TOKEN, "other@example.test", now)).resolves.toBe(
      "claimed",
    );
    expect(db.shareInvite.updateMany).toHaveBeenCalledTimes(1);
  });

  it("claims nothing for a malformed token or an invite that is not pending", async () => {
    await expect(claimShareInviteForSignup("wsmp_inv_short", "a@example.test")).resolves.toBe(
      "invalid",
    );
    db.shareInvite.findFirst.mockResolvedValueOnce(null);
    await expect(claimShareInviteForSignup(TOKEN, "a@example.test")).resolves.toBe("invalid");
    expect(db.shareInvite.updateMany).not.toHaveBeenCalled();
  });
});

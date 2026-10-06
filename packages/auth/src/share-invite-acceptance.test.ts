import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123" },
}));
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  shareInvite: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  share: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));

import { credentialDigest } from "@ws-model-proxy/db/node-security";
import {
  acceptShareInviteByToken,
  acceptShareInvitesForVerifiedEmail,
} from "./share-invite-acceptance";

const invite = {
  id: "inv1",
  poolId: "pool1",
  ownerUserId: "owner",
  canUse: true,
  canContribute: true,
  priorityClass: null,
};
const user = { id: "friend", email: "Friend@Example.test", emailVerified: true };

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

describe("accepting share invites", () => {
  it("does nothing by e-mail match without SMTP (verification is not proven there)", async () => {
    await expect(
      acceptShareInvitesForVerifiedEmail(user, { emailConfigured: false }),
    ).resolves.toBe(0);
    expect(db.shareInvite.findMany).not.toHaveBeenCalled();
  });

  it("does nothing for an unverified e-mail", async () => {
    await expect(
      acceptShareInvitesForVerifiedEmail(
        { ...user, emailVerified: false },
        { emailConfigured: true },
      ),
    ).resolves.toBe(0);
    expect(db.shareInvite.findMany).not.toHaveBeenCalled();
  });

  it("creates the share for a verified e-mail and marks the invite accepted", async () => {
    db.shareInvite.findMany.mockResolvedValue([invite]);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    await expect(acceptShareInvitesForVerifiedEmail(user, { emailConfigured: true })).resolves.toBe(
      1,
    );
    expect(db.shareInvite.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      email: "friend@example.test",
      acceptedAt: null,
      revokedAt: null,
    });
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
    db.shareInvite.findMany.mockResolvedValue([invite]);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      acceptShareInvitesForVerifiedEmail(user, { emailConfigured: true }),
    ).rejects.toThrow();
  });

  it("accepts by token only for the invited e-mail", async () => {
    const token = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    db.shareInvite.findFirst.mockResolvedValue(null);
    await expect(acceptShareInviteByToken(user, token)).resolves.toBe(false);
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      tokenDigest: credentialDigest("shareInvite", token),
      email: "friend@example.test",
    });
    await expect(acceptShareInviteByToken(user, "not-a-token")).resolves.toBe(false);
  });
});

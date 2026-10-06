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
const registry = vi.hoisted(() => ({ registerShareInviteAcceptor: vi.fn() }));
vi.mock("@ws-model-proxy/auth/share-invite-acceptance", () => registry);

import { credentialDigest } from "@ws-model-proxy/db/node-security";
import { acceptShareInviteByLink, acceptShareInvitesForProvenEmail } from "./share-invite-accept";

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

  it("accepts through the link whatever the account's e-mail", async () => {
    const token = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    db.shareInvite.findFirst.mockResolvedValue(invite);
    db.shareInvite.findMany.mockResolvedValue([invite]);
    db.share.findUnique.mockResolvedValue(null);
    db.share.create.mockResolvedValue({ id: "share1" });
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      acceptShareInviteByLink({ id: "friend", email: "other@example.test" }, token),
    ).resolves.toBe(true);
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      tokenDigest: credentialDigest("shareInvite", token),
      acceptedAt: null,
      revokedAt: null,
    });
  });

  it("refuses a malformed or unknown link", async () => {
    await expect(acceptShareInviteByLink(user, "not-a-token")).resolves.toBe(false);
    db.shareInvite.findFirst.mockResolvedValue(null);
    await expect(
      acceptShareInviteByLink(user, "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    ).resolves.toBe(false);
    expect(db.share.create).not.toHaveBeenCalled();
  });
});

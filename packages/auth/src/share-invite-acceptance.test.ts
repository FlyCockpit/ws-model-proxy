import { describe, expect, it, vi } from "vitest";

import {
  acceptClaimedShareInviteToken,
  acceptShareInvitesForProvenEmail,
  claimShareInviteToken,
  isEmailVerificationPath,
  isPendingShareInviteToken,
  registerShareInviteAcceptor,
  registerShareInviteLinkAcceptor,
} from "./share-invite-acceptance";

describe("share invite acceptance registry", () => {
  it("accepts nothing until the API registers its acceptor, then delegates", async () => {
    const user = { id: "u", email: "u@example.test", emailVerified: true };
    await expect(acceptShareInvitesForProvenEmail(user)).resolves.toBe(0);
    const acceptor = vi.fn(async () => 2);
    registerShareInviteAcceptor(acceptor);
    await expect(acceptShareInvitesForProvenEmail(user)).resolves.toBe(2);
    expect(acceptor).toHaveBeenCalledWith(user);
  });

  it("treats no link token as pending and accepts none until the API registers, then delegates", async () => {
    const token = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const user = { id: "u", email: "other@example.test" };
    const claimedAt = new Date();
    await expect(isPendingShareInviteToken(token)).resolves.toBe(false);
    await expect(claimShareInviteToken(token)).resolves.toBeNull();
    await expect(acceptClaimedShareInviteToken(user, token, claimedAt)).resolves.toBe(false);
    const isPending = vi.fn(async () => true);
    const claim = vi.fn(async () => claimedAt);
    const accept = vi.fn(async () => true);
    registerShareInviteLinkAcceptor({ isPending, claim, accept });
    await expect(isPendingShareInviteToken(token)).resolves.toBe(true);
    await expect(claimShareInviteToken(token)).resolves.toBe(claimedAt);
    await expect(acceptClaimedShareInviteToken(user, token, claimedAt)).resolves.toBe(true);
    expect(isPending).toHaveBeenCalledWith(token);
    expect(claim).toHaveBeenCalledWith(token);
    expect(accept).toHaveBeenCalledWith(user, token, claimedAt);
  });

  it("proves an e-mail only on the verification routes", () => {
    expect(isEmailVerificationPath("/verify-email")).toBe(true);
    expect(isEmailVerificationPath("/email-otp/verify-email")).toBe(true);
    expect(isEmailVerificationPath("/admin/update-user")).toBe(false);
    expect(isEmailVerificationPath(undefined)).toBe(false);
  });
});

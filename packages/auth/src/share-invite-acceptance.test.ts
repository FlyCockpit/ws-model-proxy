import { describe, expect, it, vi } from "vitest";

import {
  acceptShareInvitesForProvenEmail,
  isEmailVerificationPath,
  registerShareInviteAcceptor,
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

  it("proves an e-mail only on the verification routes", () => {
    expect(isEmailVerificationPath("/verify-email")).toBe(true);
    expect(isEmailVerificationPath("/email-otp/verify-email")).toBe(true);
    expect(isEmailVerificationPath("/admin/update-user")).toBe(false);
    expect(isEmailVerificationPath(undefined)).toBe(false);
  });
});

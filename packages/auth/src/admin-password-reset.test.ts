import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ assert: vi.fn(), revoke: vi.fn(async () => {}) }));
vi.mock("./password-write-lock", () => ({
  assertPasswordWriteLocked: state.assert,
  passwordWriteLockUserId: () => "target",
}));
vi.mock("./credential-revocation", () => ({ revokeUserCredentials: state.revoke }));

import { secureAdminPasswordReset } from "./admin-password-reset";

it("only validated admin account-write hooks sweep and assert target identity", async () => {
  await secureAdminPasswordReset({ path: "/change-password" }, "u");
  await secureAdminPasswordReset(null);
  expect(state.revoke).not.toHaveBeenCalled();
  await secureAdminPasswordReset({ path: "/admin/set-user-password" }, "target");
  expect(state.assert).toHaveBeenCalledWith("target");
  expect(state.revoke).toHaveBeenCalledExactlyOnceWith("target");
  state.assert.mockImplementationOnce(() => {
    throw new Error("outside lock");
  });
  await expect(secureAdminPasswordReset({ path: "/admin/set-user-password" })).rejects.toThrow(
    "outside lock",
  );
  expect(state.revoke).toHaveBeenCalledTimes(1);
});

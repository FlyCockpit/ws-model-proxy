import { describe, expect, it, vi } from "vitest";

const getSessionFromCtx = vi.fn();
vi.mock("better-auth/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth/api")>()),
  getSessionFromCtx: (...args: unknown[]) => getSessionFromCtx(...args),
}));

import { impersonationRefuses, refuseImpersonatedAuthWrite } from "./impersonation-read-only";

type Ctx = Parameters<typeof refuseImpersonatedAuthWrite>[0];
const ctx = (path: string, method = "POST") =>
  ({ path, request: new Request(`https://proxy.example.test/api/auth${path}`, { method }) }) as Ctx;

describe("impersonationRefuses", () => {
  it("refuses Better Auth writes and every MCP OAuth step", () => {
    for (const path of [
      "/change-password",
      "/change-email",
      "/update-user",
      "/delete-user",
      "/revoke-sessions",
      "/two-factor/enable",
    ])
      expect(impersonationRefuses(path, "POST"), path).toBe(true);
    for (const [path, method] of [
      ["/oauth2/consent", "POST"],
      ["/oauth2/continue", "POST"],
      ["/oauth2/authorize", "GET"],
    ] as const)
      expect(impersonationRefuses(path, method), path).toBe(true);
  });

  it("allows reads, stopping the impersonation, signing out and signing in", () => {
    expect(impersonationRefuses("/get-session", "GET")).toBe(false);
    expect(impersonationRefuses("/admin/stop-impersonating", "POST")).toBe(false);
    expect(impersonationRefuses("/sign-out", "POST")).toBe(false);
    expect(impersonationRefuses("/sign-in/email", "POST")).toBe(false);
  });
});

describe("refuseImpersonatedAuthWrite", () => {
  it("refuses a write through an impersonation session with FORBIDDEN", async () => {
    getSessionFromCtx.mockResolvedValueOnce({ session: { impersonatedBy: "admin-1" } });
    await expect(refuseImpersonatedAuthWrite(ctx("/change-password"))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("lets the person's own session, and server-side calls, through", async () => {
    getSessionFromCtx.mockResolvedValueOnce({ session: { impersonatedBy: null } });
    await expect(refuseImpersonatedAuthWrite(ctx("/change-password"))).resolves.toBeUndefined();
    getSessionFromCtx.mockClear();
    await expect(
      refuseImpersonatedAuthWrite({ path: "/change-password" } as Ctx),
    ).resolves.toBeUndefined();
    await expect(refuseImpersonatedAuthWrite(ctx("/sign-out"))).resolves.toBeUndefined();
    expect(getSessionFromCtx).not.toHaveBeenCalled();
  });
});

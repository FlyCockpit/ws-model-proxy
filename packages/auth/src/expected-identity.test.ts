import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("better-auth/api", async (original) => ({
  ...(await original<typeof import("better-auth/api")>()),
  getSession: () => resolve,
}));

import { refuseUnexpectedIdentity } from "./expected-identity";

type Ctx = Parameters<typeof refuseUnexpectedIdentity>[0];
function context(
  path = "/update-user",
  expected: string | null = "a",
  user?: { id: string; banned?: boolean },
) {
  const headers = new Headers(expected ? { "X-Expected-User": expected } : {});
  return { path, headers, context: { session: user ? { user } : null } } as Ctx;
}
beforeEach(() => {
  resolve.mockReset().mockResolvedValue({ user: { id: "b", banned: true } });
});
describe("Better Auth expected identity", () => {
  it.each([
    "/update-user",
    "/sign-in/email",
    "/sign-up/email",
    "/reset-password",
    "/request-password-reset",
    "/two-factor/enable",
  ])("refuses %s using the raw owner, before policy filtering", async (path) => {
    await expect(refuseUnexpectedIdentity(context(path))).rejects.toMatchObject({
      statusCode: 409,
      body: { code: "IDENTITY_CHANGED" },
    });
    expect(resolve).toHaveBeenCalledOnce();
  });
  it.each(["/get-session", "/sign-out"])("exempts %s", async (path) => {
    await refuseUnexpectedIdentity(context(path));
    expect(resolve).not.toHaveBeenCalled();
  });
  it("does no lookup without the header", async () => {
    await refuseUnexpectedIdentity(context("/update-user", null));
    expect(resolve).not.toHaveBeenCalled();
  });
  it("reuses a raw context session and preserves normal authorization on a match", async () => {
    await refuseUnexpectedIdentity(context("/update-user", "a", { id: "a", banned: true }));
    expect(resolve).not.toHaveBeenCalled();
  });
  it("does not confuse lookup failure with anonymity", async () => {
    resolve.mockRejectedValue(new Error("private db details"));
    await expect(refuseUnexpectedIdentity(context())).rejects.toMatchObject({
      statusCode: 503,
      body: { code: "SESSION_UNAVAILABLE" },
    });
  });
  it("leaves confirmed anonymity to the endpoint", async () => {
    resolve.mockResolvedValue(null);
    await refuseUnexpectedIdentity(context());
  });
  it("runs before policy hooks and password reset side effects", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const fence = source.indexOf("await refuseUnexpectedIdentity(ctx)");
    expect(fence).toBeGreaterThan(0);
    for (const hook of [
      "await refuseImpersonatedAuthWrite(ctx)",
      "await secureAccountBeforePasswordReset(ctx)",
      "const resetToken = resetTokenOf(",
    ])
      expect(fence).toBeLessThan(source.indexOf(hook));
  });
});

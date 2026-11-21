import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("./diagnostics.js", () => ({ runPoolMemberTest: vi.fn() }));

import { runPoolMemberTest } from "./diagnostics.js";
import { createPoolMemberTestRoutes } from "./pool-member-test.js";

function app(enrolled: boolean | null, policy: boolean) {
  const root = new Hono<{ Variables: { session: Session | null } }>();
  root.use("*", async (c, next) => {
    c.set(
      "session",
      enrolled === null ? null : ({ user: { id: "owner", twoFactorEnabled: enrolled } } as Session),
    );
    await next();
  });
  root.route("/pools", createPoolMemberTestRoutes({ twoFactorRequired: async () => policy }));
  return root;
}

beforeEach(() => vi.mocked(runPoolMemberTest).mockReset());

describe("pool member test forced 2FA", () => {
  it("refuses unenrolled sessions before dispatch with the Chat Test 403 body", async () => {
    const response = await app(false, true).request("/pools/members/member/test", {
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        message: "Two-factor authentication setup is required.",
        type: "invalid_request_error",
        param: null,
        code: "two_factor_required",
      },
    });
    expect(runPoolMemberTest).not.toHaveBeenCalled();
  });

  it.each([
    [true, true],
    [false, false],
  ])("admits enrolled=%s policy=%s", async (enrolled, policy) => {
    vi.mocked(runPoolMemberTest).mockResolvedValue({ outcome: "not-found" });
    const response = await app(enrolled, policy).request("/pools/members/member/test", {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(runPoolMemberTest).toHaveBeenCalledOnce();
  });

  it("preserves the anonymous 401", async () => {
    const response = await app(null, true).request("/pools/members/member/test", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(runPoolMemberTest).not.toHaveBeenCalled();
  });
});

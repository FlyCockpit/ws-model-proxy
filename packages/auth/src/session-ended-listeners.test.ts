import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "session-ended-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
  },
}));
function makePrismaStub(): unknown {
  return new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
}
vi.mock("@ws-model-proxy/db", () => ({ default: makePrismaStub() }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => true),
}));

const { notifySessionEnded, onSessionEnded } = await import("./session-ended-listeners");
const { auth } = await import("./index");

describe("session ended listeners", () => {
  it("runs every listener, and a failing one never stops the others", () => {
    const seen: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const offFailing = onSessionEnded(() => {
      throw new Error("boom");
    });
    const offSeen = onSessionEnded((session) => seen.push(session.id));
    notifySessionEnded({ id: "sess-1", userId: "user-1" });
    offFailing();
    offSeen();
    notifySessionEnded({ id: "sess-2", userId: "user-1" });
    expect(seen).toEqual(["sess-1"]);
    expect(error).toHaveBeenCalledWith("[auth] session ended listener failed", "Error");
    error.mockRestore();
  });

  it("is told by Better Auth's session delete hook (sign-out, revoked sessions)", async () => {
    const after = auth.options.databaseHooks?.session?.delete?.after;
    if (!after) throw new Error("no session delete hook");
    const seen: Array<{ id: string; userId: string }> = [];
    const off = onSessionEnded((session) => seen.push(session));
    const row = {
      id: "sess-1",
      userId: "user-1",
      token: "t",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await after(row);
    off();
    expect(seen).toEqual([{ id: "sess-1", userId: "user-1" }]);
  });
});

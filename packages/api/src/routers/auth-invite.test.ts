import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123" },
}));
vi.mock("@ws-model-proxy/mailer", () => ({ verifyTransport: vi.fn() }));
const accept = vi.hoisted(() => ({ acceptShareInviteByLink: vi.fn() }));
vi.mock("../lib/share-invite-accept", () => accept);

const { default: prisma } = await import("@ws-model-proxy/db");
const { authRouter } = await import("./auth");
const db = prisma as unknown as { shareInvite: { findFirst: ReturnType<typeof vi.fn> } };

const TOKEN = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const session = {
  user: { id: "friend", email: "other@example.test", name: "Friend", role: "user" },
  session: { id: "s", userId: "friend", expiresAt: new Date(Date.now() + 60_000) },
} as unknown as Session;
const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: "friend",
  sessionId: "s",
  csrfVerified: true,
};

function client(context: Context) {
  return createRouterClient(authRouter, { context });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth.inviteInfo limiter", () => {
  const anonymous = { session: null, auth: { kind: "anonymous" } } satisfies Context;

  it("fails closed without the per-address limiter", async () => {
    await expect(client(anonymous).inviteInfo({ token: TOKEN })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.shareInvite.findFirst).not.toHaveBeenCalled();
  });

  it("refuses over the budget without a lookup", async () => {
    const limited = { ...anonymous, services: { limitInviteLookup: async () => false } };
    await expect(client(limited).inviteInfo({ token: TOKEN })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(db.shareInvite.findFirst).not.toHaveBeenCalled();
  });
});

describe("auth.acceptInvite (signed in)", () => {
  const limitInviteAccept = vi.fn(async (_userId: string) => true);
  const signedIn = (
    auth: CallerAuth = PERSON,
    services: Context["services"] = { limitInviteAccept },
  ) => ({ session, auth, services }) satisfies Context;

  it("accepts the link for the signed-in person, charged to them", async () => {
    accept.acceptShareInviteByLink.mockResolvedValue("accepted");
    await expect(client(signedIn()).acceptInvite({ token: TOKEN })).resolves.toEqual({
      result: "accepted",
    });
    expect(limitInviteAccept).toHaveBeenCalledWith("friend");
    expect(accept.acceptShareInviteByLink).toHaveBeenCalledWith(
      { id: "friend", email: "other@example.test" },
      TOKEN,
    );
  });

  it("answers invalid and own_pool as results", async () => {
    accept.acceptShareInviteByLink.mockResolvedValueOnce("invalid");
    await expect(client(signedIn()).acceptInvite({ token: TOKEN })).resolves.toEqual({
      result: "invalid",
    });
    accept.acceptShareInviteByLink.mockResolvedValueOnce("own_pool");
    await expect(client(signedIn()).acceptInvite({ token: TOKEN })).resolves.toEqual({
      result: "own_pool",
    });
  });

  it("refuses over the per-user budget, and fails closed without the limiter", async () => {
    limitInviteAccept.mockResolvedValueOnce(false);
    await expect(client(signedIn()).acceptInvite({ token: TOKEN })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    await expect(client(signedIn(PERSON, {})).acceptInvite({ token: TOKEN })).rejects.toMatchObject(
      { code: "SERVICE_UNAVAILABLE" },
    );
    expect(accept.acceptShareInviteByLink).not.toHaveBeenCalled();
  });

  it.each<[string, CallerAuth]>([
    ["cookie without CSRF", { ...PERSON, csrfVerified: false }],
    [
      "Full agent token",
      { kind: "agent_token", userId: "friend", agentTokenId: "t", level: "FULL" },
    ],
    ["API key", { kind: "api_key", userId: "friend", apiKeyId: "k" }],
  ])("is for a person only: refuses a %s", async (_label, auth) => {
    await expect(client(signedIn(auth)).acceptInvite({ token: TOKEN })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(accept.acceptShareInviteByLink).not.toHaveBeenCalled();
  });

  it("rejects a malformed token before anything else", async () => {
    await expect(
      client(signedIn()).acceptInvite({ token: "wsmp_inv_short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(limitInviteAccept).not.toHaveBeenCalled();
  });
});

import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

const envMock = vi.hoisted(() => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    WMP_MCP_ENABLED: true,
    WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: false,
  },
}));
vi.mock("@ws-model-proxy/env/server", () => envMock);
vi.mock("@ws-model-proxy/db", async () => {
  const actual = await vi.importActual<typeof import("../../../db/prisma/generated/client")>(
    "../../../db/prisma/generated/client",
  );
  return { default: mockDeep<PrismaClient>(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
const mailer = vi.hoisted(() => ({
  isEmailConfigured: vi.fn(() => false),
  sendEmail: vi.fn(async () => undefined),
  renderShareInvite: vi.fn(() => ({ subject: "s", html: "h" })),
  verifyTransport: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/mailer", () => mailer);

import prisma from "@ws-model-proxy/db";
import { credentialDigest } from "@ws-model-proxy/db/node-security";
import type { Context } from "../context";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";
import { accessRouter } from "./access";
import { authRouter } from "./auth";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

const session = {
  user: {
    id: "owner",
    email: "owner@example.test",
    name: "Owner",
    role: "user",
    emailVerified: true,
    twoFactorEnabled: false,
  },
  session: { id: "s", userId: "owner", expiresAt: new Date(Date.now() + 60_000) },
} as unknown as Session;

const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: "owner",
  sessionId: "s",
  csrfVerified: true,
};

function client(auth: CallerAuth | AnonymousAuth = PERSON, services?: Context["services"]) {
  return createRouterClient(accessRouter, {
    context: { session, auth, ...(services ? { services } : {}) } satisfies Context,
  });
}

const NOT_A_PERSON: ReadonlyArray<[string, CallerAuth]> = [
  ["Full agent token", { kind: "agent_token", userId: "owner", agentTokenId: "t", level: "FULL" }],
  ["OAuth token", { kind: "oauth_access_token", userId: "owner", grantId: "g", level: "FULL" }],
  ["API key", { kind: "api_key", userId: "owner", apiKeyId: "k" }],
  ["cookie without CSRF", { ...PERSON, csrfVerified: false }],
];

const now = new Date("2026-10-06T12:00:00Z");
const keyRow = {
  id: "key1",
  name: "laptop",
  scope: "ALL_POOLS" as const,
  lookupPrefix: "wsmp_key_abcdefghijkl",
  createdAt: now,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  Pools: [],
};
const tokenRow = {
  id: "tok1",
  name: "claude",
  level: "FULL" as const,
  lookupPrefix: "wsmp_agent_abcdefghijkl",
  createdAt: now,
  lastUsedAt: null,
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  revokedAt: null,
};
const shareRow = {
  id: "share1",
  poolId: "pool1",
  canUse: true,
  canContribute: false,
  priorityClass: null,
  protectionPercent: null,
  ownKeyProviderModelId: null,
  ownKeyProtocolAdaptation: false,
  createdAt: now,
  Pool: { slug: "chat" },
  Owner: { email: "owner@example.test", slug: "owner" },
  Grantee: { email: "friend@example.test" },
  SpendCap: null,
  _count: { Contributed: 0 },
};

const inviteRow = {
  id: "inv1",
  poolId: "pool1",
  email: "friend@example.test",
  canUse: true,
  canContribute: false,
  priorityClass: null,
  createdAt: now,
  expiresAt: now,
  emailSentAt: null,
  Pool: { slug: "chat", User: { slug: "owner" } },
};

/** Every fence requested through `wsmp_acquire_fences`, in request order. */
function heldFences(): string[] {
  return db.$queryRaw.mock.calls.flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
}

function inTransaction() {
  db.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: typeof db) => unknown)(db);
    return Promise.all(arg as Promise<unknown>[]);
  });
}

beforeEach(() => {
  mockReset(db);
  vi.clearAllMocks();
  mailer.isEmailConfigured.mockReturnValue(false);
  envMock.env.WMP_MCP_ENABLED = true;
  envMock.env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = false;
  inTransaction();
});

describe("only a person may mint credentials or grant access", () => {
  const mutations: Array<[string, (c: ReturnType<typeof client>) => Promise<unknown>]> = [
    [
      "apiKeys.create",
      (c) => c.apiKeys.create({ name: "x", scope: "ALL_POOLS", poolIds: [], expiresAt: null }),
    ],
    ["apiKeys.revoke", (c) => c.apiKeys.revoke({ apiKeyId: "key1" })],
    [
      "agentTokens.create",
      (c) => c.agentTokens.create({ name: "x", level: "FULL", expiresAt: null }),
    ],
    ["agentTokens.revoke", (c) => c.agentTokens.revoke({ agentTokenId: "tok1" })],
    ["oauthGrants.revoke", (c) => c.oauthGrants.revoke({ grantId: "g" })],
    [
      "shares.create",
      (c) =>
        c.shares.create({
          poolId: "pool1",
          email: "friend@example.test",
          canUse: true,
          canContribute: true,
          priorityClass: null,
          protectionPercent: null,
          monthlyCap: null,
        }),
    ],
    ["shares.update", (c) => c.shares.update({ shareId: "share1", canContribute: true })],
    ["shares.delete", (c) => c.shares.delete({ shareId: "share1" })],
    ["shares.setOwnKey", (c) => c.shares.setOwnKey({ shareId: "share1", providerModelId: null })],
    ["invites.resend", (c) => c.invites.resend({ inviteId: "inv1" })],
    ["invites.revoke", (c) => c.invites.revoke({ inviteId: "inv1" })],
  ];
  for (const [label, auth] of NOT_A_PERSON)
    for (const [path, call] of mutations)
      it(`refuses ${path} for a ${label} before touching the database`, async () => {
        await expect(call(client(auth))).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(db.apiKey.create).not.toHaveBeenCalled();
        expect(db.agentToken.create).not.toHaveBeenCalled();
        expect(db.mcpGrant.create).not.toHaveBeenCalled();
        expect(db.share.create).not.toHaveBeenCalled();
        expect(db.shareInvite.create).not.toHaveBeenCalled();
      });

  it("keeps the lists away from tokens too", async () => {
    await expect(client(NOT_A_PERSON[0]?.[1] ?? PERSON).agentTokens.list()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("API keys", () => {
  it("returns the secret once and stores only its HMAC digest", async () => {
    db.apiKey.count.mockResolvedValue(0);
    db.apiKey.create.mockResolvedValue(keyRow);
    const result = await client().apiKeys.create({
      name: "laptop",
      scope: "ALL_POOLS",
      poolIds: [],
      expiresAt: null,
    });
    expect(result.secret).toMatch(/^wsmp_key_[A-Za-z0-9_-]{43}$/);
    const data = db.apiKey.create.mock.calls[0]?.[0].data;
    expect(data?.secretDigest).toBe(credentialDigest("apiKey", result.secret));
    expect(data?.secretDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain(result.secret);
    expect(data?.lookupPrefix).toBe(result.secret.slice(0, "wsmp_key_".length + 12));
    expect(JSON.stringify(result.key)).not.toContain(result.secret);
  });

  it("never lists a secret or digest", async () => {
    db.apiKey.findMany.mockResolvedValue([keyRow]);
    const listed = await client().apiKeys.list();
    expect(listed.baseUrl).toBe("https://proxy.example.com/v1");
    expect(Object.keys(listed.keys[0] ?? {})).not.toContain("secretDigest");
    const select = db.apiKey.findMany.mock.calls[0]?.[0]?.select;
    expect(select).not.toHaveProperty("secretDigest");
  });

  it("refuses pools the caller may not use", async () => {
    db.apiKey.count.mockResolvedValue(0);
    db.pool.findMany.mockResolvedValue([{ id: "mine", userId: "owner" } as never]);
    await expect(
      client().apiKeys.create({
        name: "x",
        scope: "SELECTED_POOLS",
        poolIds: ["mine", "theirs"],
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.apiKey.create).not.toHaveBeenCalled();
  });

  it("refuses an expiry in the past", async () => {
    await expect(
      client().apiKeys.create({
        name: "x",
        scope: "ALL_POOLS",
        poolIds: [],
        expiresAt: "2000-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("revokes only the caller's own key", async () => {
    db.apiKey.findFirst.mockResolvedValue(null);
    await expect(client().apiKeys.revoke({ apiKeyId: "other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.apiKey.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({ userId: "owner" });
    expect(db.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it("tells the server a key was revoked", async () => {
    const onAccessRevoked = vi.fn(async () => undefined);
    db.apiKey.findFirst.mockResolvedValue({ id: "key1", revokedAt: null } as never);
    db.apiKey.updateMany.mockResolvedValue({ count: 1 });
    await client(PERSON, { onAccessRevoked }).apiKeys.revoke({ apiKeyId: "key1" });
    expect(db.apiKey.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "key1",
      userId: "owner",
      revokedAt: null,
    });
    expect(onAccessRevoked).toHaveBeenCalledWith({
      kind: "api_key",
      userId: "owner",
      apiKeyId: "key1",
    });
  });
});

describe("agent tokens", () => {
  it("mints a Read-only or Full token with its grant; the secret is shown once", async () => {
    db.agentToken.count.mockResolvedValue(0);
    db.mcpGrant.create.mockResolvedValue({ id: "grant1" } as never);
    db.agentToken.create.mockResolvedValue(tokenRow);
    const result = await client().agentTokens.create({
      name: "claude",
      level: "FULL",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(result.secret).toMatch(/^wsmp_agent_/);
    expect(db.mcpGrant.create.mock.calls[0]?.[0].data).toMatchObject({
      userId: "owner",
      level: "FULL",
      referenceId: "pat",
    });
    const data = db.agentToken.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ userId: "owner", level: "FULL", grantId: "grant1" });
    expect(data?.secretDigest).toBe(credentialDigest("agentToken", result.secret));
    expect(JSON.stringify(data)).not.toContain(result.secret);
  });

  it("refuses a token without expiry unless the server allows it", async () => {
    await expect(
      client().agentTokens.create({ name: "x", level: "READ", expiresAt: null }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.agentToken.create).not.toHaveBeenCalled();
  });

  it("refuses an expiry beyond a year", async () => {
    await expect(
      client().agentTokens.create({
        name: "x",
        level: "READ",
        expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses minting while MCP is off", async () => {
    envMock.env.WMP_MCP_ENABLED = false;
    await expect(
      client().agentTokens.create({
        name: "x",
        level: "READ",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("caps active tokens", async () => {
    db.agentToken.count.mockResolvedValue(10);
    await expect(
      client().agentTokens.create({
        name: "x",
        level: "READ",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("revokes the token and its grant together", async () => {
    db.agentToken.findFirst.mockResolvedValue({
      id: "tok1",
      grantId: "grant1",
      revokedAt: null,
    } as never);
    db.agentToken.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    await client().agentTokens.revoke({ agentTokenId: "tok1" });
    expect(db.agentToken.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "tok1",
      userId: "owner",
    });
    expect(db.mcpGrant.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "grant1",
      userId: "owner",
    });
  });
});

describe("OAuth connections", () => {
  it("never disconnects an agent token's grant or another person's grant", async () => {
    db.mcpGrant.findFirst.mockResolvedValueOnce({
      id: "g1",
      clientId: "pat:tok1",
      revokedAt: null,
    } as never);
    await expect(client().oauthGrants.revoke({ grantId: "g1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    db.mcpGrant.findFirst.mockResolvedValueOnce(null);
    await expect(client().oauthGrants.revoke({ grantId: "theirs" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.mcpGrant.findFirst.mock.calls[1]?.[0]?.where).toEqual({
      id: "theirs",
      userId: "owner",
    });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });
});

describe("shares", () => {
  const input = {
    poolId: "pool1",
    email: "Friend@Example.test",
    canUse: true,
    canContribute: false,
    priorityClass: null,
    protectionPercent: null,
    monthlyCap: null,
  };
  const pool = {
    id: "pool1",
    slug: "chat",
    User: { slug: "owner", name: "Owner", locale: "en-US" },
  };

  it("shares only the caller's own pool", async () => {
    db.pool.findFirst.mockResolvedValue(null);
    await expect(client().shares.create(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.pool.findFirst.mock.calls[0]?.[0]?.where).toEqual({ id: "pool1", userId: "owner" });
  });

  it("shares directly with a verified account, under both owners' fences", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue({ id: "friend", emailVerified: true } as never);
    db.share.create.mockResolvedValue({ id: "share1" } as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    const result = await client().shares.create(input);
    expect(result.kind).toBe("share");
    expect(db.share.create.mock.calls[0]?.[0].data).toMatchObject({
      poolId: "pool1",
      ownerUserId: "owner",
      granteeUserId: "friend",
      canUse: true,
    });
    expect(db.user.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      email: { equals: "friend@example.test", mode: "insensitive" },
    });
    expect(heldFences()).toEqual(["00:owner:friend", "00:owner:owner"]);
  });

  it("invites an unverified account instead of sharing directly", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue({ id: "squatter", emailVerified: false } as never);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    const result = await client().shares.create(input);
    expect(result.kind).toBe("invite");
    expect(db.share.create).not.toHaveBeenCalled();
  });

  it("invites an unknown e-mail: token hashed, link shown once when no e-mail is sent", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockImplementation((async (args: { data: { email: string } }) => ({
      id: "inv1",
      poolId: "pool1",
      email: args.data.email,
      canUse: true,
      canContribute: false,
      priorityClass: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 14 * 86_400_000),
      emailSentAt: null,
      Pool: { slug: "chat", User: { slug: "owner" } },
    })) as never);
    const result = await client().shares.create(input);
    if (result.kind !== "invite") throw new Error("expected an invite");
    expect(result.invite.email).toBe("friend@example.test");
    expect(result.link).toMatch(
      /^https:\/\/proxy\.example\.com\/en-US\/signup\?invite=wsmp_inv_[A-Z2-7]{26}$/,
    );
    const token = new URL(result.link ?? "").searchParams.get("invite") ?? "";
    const data = db.shareInvite.create.mock.calls[0]?.[0].data;
    expect(data?.tokenDigest).toBe(credentialDigest("shareInvite", token));
    expect(JSON.stringify(data)).not.toContain(token);
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("e-mails the invite when SMTP works and then returns no link", async () => {
    mailer.isEmailConfigured.mockReturnValue(true);
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    const inviteRow = {
      id: "inv1",
      poolId: "pool1",
      email: "friend@example.test",
      canUse: true,
      canContribute: false,
      priorityClass: null,
      createdAt: now,
      expiresAt: now,
      emailSentAt: null,
      Pool: { slug: "chat", User: { slug: "owner" } },
    };
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    db.shareInvite.update.mockResolvedValue({ ...inviteRow, emailSentAt: now } as never);
    const result = await client().shares.create(input);
    expect(result).toMatchObject({ kind: "invite", link: null });
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "friend@example.test" }),
    );
  });

  it("refuses a second pending invite to the same e-mail and pool", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.findFirst.mockResolvedValue({ id: "inv0" } as never);
    await expect(client().shares.create(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.shareInvite.create).not.toHaveBeenCalled();
  });

  it("refuses sharing with yourself", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    await expect(
      client().shares.create({ ...input, email: "owner@example.test" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("changes only shares of the caller's pools", async () => {
    db.share.findFirst.mockResolvedValue(null);
    await expect(
      client().shares.update({ shareId: "share1", canContribute: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.share.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "share1",
      ownerUserId: "owner",
    });
  });

  it("refuses clearing both permissions", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      canUse: true,
      canContribute: false,
      SpendCap: null,
    } as never);
    await expect(
      client().shares.update({ shareId: "share1", canUse: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rotates an invite's token on resend (the old link stops working)", async () => {
    db.user.findUnique.mockResolvedValue({ name: "Owner", locale: "en-US" } as never);
    db.shareInvite.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 86_400_000),
      updatedAt: new Date(Date.now() - 86_400_000),
    } as never);
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    db.shareInvite.findUniqueOrThrow.mockResolvedValue({
      id: "inv1",
      poolId: "pool1",
      email: "friend@example.test",
      canUse: true,
      canContribute: false,
      priorityClass: null,
      createdAt: now,
      expiresAt: now,
      emailSentAt: null,
      Pool: { slug: "chat", User: { slug: "owner" } },
    } as never);
    const result = await client().invites.resend({ inviteId: "inv1" });
    const token = new URL(result.link ?? "").searchParams.get("invite") ?? "";
    const call = db.shareInvite.updateMany.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ id: "inv1", ownerUserId: "owner", acceptedAt: null });
    expect(call?.data).toMatchObject({ tokenDigest: credentialDigest("shareInvite", token) });
    // Never past 30 days from the invite's creation.
    const expiry = (call?.data as { expiresAt: Date } | undefined)?.expiresAt.getTime() ?? 0;
    expect(expiry).toBeLessThanOrEqual(Date.now() - 86_400_000 + 30 * 86_400_000);
  });

  it("refuses a resend within a minute of the last one", async () => {
    db.user.findUnique.mockResolvedValue({ name: "Owner", locale: "en-US" } as never);
    db.shareInvite.findFirst.mockResolvedValue({
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await expect(client().invites.resend({ inviteId: "inv1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.shareInvite.updateMany).not.toHaveBeenCalled();
  });

  it("resends and withdraws only the caller's own invites", async () => {
    db.user.findUnique.mockResolvedValue({ name: "Owner", locale: "en-US" } as never);
    db.shareInvite.findFirst.mockResolvedValue(null);
    await expect(client().invites.resend({ inviteId: "theirs" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client().invites.revoke({ inviteId: "theirs" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    for (const call of db.shareInvite.findFirst.mock.calls)
      expect(call[0]?.where).toMatchObject({ ownerUserId: "owner" });
  });

  it("deletes only a share the caller owns or holds", async () => {
    db.share.findFirst.mockResolvedValue(null);
    await expect(client().shares.delete({ shareId: "other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.share.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "other",
      OR: [{ ownerUserId: "owner" }, { granteeUserId: "owner" }],
    });
    expect(db.share.deleteMany).not.toHaveBeenCalled();
  });

  it("sets an own key only from the share holder's own provider models", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      ownKeyProtocolAdaptation: false,
      Pool: { Fallback: { ownKeyEquivalentModel: "openai/gpt" } },
    } as never);
    db.providerModel.findFirst.mockResolvedValue(null);
    await expect(
      client().shares.setOwnKey({ shareId: "share1", providerModelId: "someone-elses" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.share.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "share1",
      granteeUserId: "owner",
    });
    expect(db.providerModel.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "someone-elses",
      userId: "owner",
    });
    expect(db.share.update).not.toHaveBeenCalled();
  });

  it("takes the pool's capacity-policy fences when a permission changes", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      poolId: "pool1",
      granteeUserId: "friend",
      canUse: true,
      canContribute: false,
      priorityClass: null,
      SpendCap: null,
    } as never);
    db.poolMember.findMany.mockResolvedValue([
      { runtimeModelId: "rm1", providerModelId: null },
    ] as never);
    db.executionTarget.findMany.mockResolvedValue([{ id: "target1" }] as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    const onAccessRevoked = vi.fn(async () => undefined);
    await client(PERSON, { onAccessRevoked }).shares.update({
      shareId: "share1",
      canUse: false,
      canContribute: true,
    });
    expect(heldFences()).toEqual([
      "00:owner:friend",
      "00:owner:owner",
      "06:capacity-policy:target1",
    ]);
    expect(onAccessRevoked).toHaveBeenCalledWith({
      kind: "share",
      ownerUserId: "owner",
      granteeUserId: "friend",
      poolId: "pool1",
    });
  });
});

describe("auth.inviteInfo (public)", () => {
  const auth = () =>
    createRouterClient(authRouter, {
      context: { session: null, auth: { kind: "anonymous" } } satisfies Context,
    });

  it("answers valid: false and nothing else for an unknown link", async () => {
    db.shareInvite.findFirst.mockResolvedValue(null);
    await expect(
      auth().inviteInfo({ token: "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ" }),
    ).resolves.toEqual({ valid: false, email: null, ownerName: null, callableId: null });
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      tokenDigest: credentialDigest("shareInvite", "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      acceptedAt: null,
      revokedAt: null,
    });
  });
});

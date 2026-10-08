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
// The revision-correct spend reads (their SQL runs on real Postgres in
// integration/spend-flows.postgres.integration.test.ts).
const spend = vi.hoisted(() => ({ sharesSpend: vi.fn(), shareSpendCurrencies: vi.fn() }));
vi.mock("@ws-model-proxy/db/spend", () => spend);

import prisma, { Prisma } from "@ws-model-proxy/db";
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
  Pool: { slug: "chat", modelType: "LLM" as const, Fallback: null },
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
  runtimeId: null,
  Runtime: null,
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
  db.poolMember.findMany.mockResolvedValue([]);
  spend.sharesSpend.mockImplementation(
    async (_db: unknown, input: { shareIds: string[] }) =>
      new Map(input.shareIds.map((id) => [id, usage("0", "0")])),
  );
  spend.shareSpendCurrencies.mockResolvedValue([]);
});

function capOf(id: string, currency: string) {
  return { id, monthlyLimit: new Prisma.Decimal("20"), currency };
}

function usage(spentThisMonth: string, reservedNow: string) {
  return {
    spentThisMonth: new Prisma.Decimal(spentThisMonth),
    reservedNow: new Prisma.Decimal(reservedNow),
  };
}

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
      "oauthGrants.setLevel (raise)",
      (c) => c.oauthGrants.setLevel({ grantId: "g", level: "FULL" }),
    ],
    [
      "oauthGrants.setLevel (lower)",
      (c) => c.oauthGrants.setLevel({ grantId: "g", level: "READ" }),
    ],
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
        expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
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

describe("OAuth disconnect sweeps pending authorization codes", () => {
  const CLIENT = "https://client.example.com/meta";
  function code(userId: string, clientId: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: "authorization_code",
      query: { client_id: clientId, redirect_uri: "https://client.example.com/cb" },
      userId,
      referenceId: "ref1",
      ...extra,
    });
  }
  function grant(userId = "owner") {
    db.mcpGrant.findFirst.mockResolvedValue({
      id: "g1",
      clientId: CLIENT,
      revokedAt: null,
      userId,
    } as never);
  }

  it("deletes only the person's codes for that client, under the person's fence", async () => {
    grant();
    db.verification.findMany.mockResolvedValueOnce([
      { id: "v1", value: code("owner", CLIENT) },
      // Another client of the same person, another person, and an e-mail OTP row.
      { id: "v2", value: code("owner", "https://other.example.com/meta") },
      { id: "v3", value: code("owner2", CLIENT) },
      { id: "v4", value: JSON.stringify({ type: "email-otp", userId: "owner" }) },
    ] as never);
    db.verification.deleteMany.mockResolvedValue({ count: 1 });
    await client().oauthGrants.revoke({ grantId: "g1" });

    // The revocation and the sweep each run under the person's fence.
    expect(heldFences()).toEqual(["00:owner:owner", "00:owner:owner"]);
    const scan = db.verification.findMany.mock.calls[0]?.[0];
    expect(scan?.where).toMatchObject({
      AND: [
        { value: { contains: '"type":"authorization_code"' } },
        { value: { contains: '"userId":"owner"' } },
      ],
    });
    // A delete with a WHERE: the exact rows found, re-fenced to the person's markers.
    expect(db.verification.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.verification.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: { in: ["v1"] },
        AND: [
          { value: { contains: '"type":"authorization_code"' } },
          { value: { contains: '"userId":"owner"' } },
        ],
      },
    });
    expect(db.oauthConsent.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: { userId: "owner", clientId: CLIENT },
    });
  });

  it("deletes nothing when no pending code matches", async () => {
    grant();
    db.verification.findMany.mockResolvedValueOnce([
      { id: "v3", value: code("owner2", CLIENT) },
    ] as never);
    await client().oauthGrants.revoke({ grantId: "g1" });
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.updateMany).toHaveBeenCalled();
  });

  it("fails closed on a pending code it cannot read, after revoking the tokens", async () => {
    grant();
    const onAccessRevoked = vi.fn();
    db.verification.findMany.mockResolvedValueOnce([
      { id: "v1", value: '{"type":"authorization_code","userId":"owner"' },
    ] as never);
    await expect(
      client(PERSON, { onAccessRevoked }).oauthGrants.revoke({ grantId: "g1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    // A crowded or unreadable sweep never holds back the disconnect itself.
    expect(db.mcpGrant.updateMany).toHaveBeenCalled();
    expect(db.oauthAccessToken.updateMany).toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).toHaveBeenCalled();
    expect(onAccessRevoked).toHaveBeenCalledTimes(1);
  });

  it("pages by id, so a code redeemed between pages cannot end the scan early", async () => {
    grant();
    const other = code("owner", "https://other.example.com/meta");
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `v${String(index).padStart(5, "0")}`,
      value: other,
    }));
    db.verification.findMany
      .mockResolvedValueOnce(firstPage as never)
      .mockResolvedValueOnce([{ id: "v99999", value: code("owner", CLIENT) }] as never);
    db.verification.deleteMany.mockResolvedValue({ count: 1 });
    await client().oauthGrants.revoke({ grantId: "g1" });
    const second = db.verification.findMany.mock.calls[1]?.[0];
    expect(second?.where).toMatchObject({ id: { gt: "v00499" } });
    expect(second).not.toHaveProperty("cursor");
    expect(second).not.toHaveProperty("skip");
    expect(db.verification.deleteMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: { in: ["v99999"] },
    });
  });

  it("gives up loudly past the scan cap", async () => {
    grant();
    let page = 0;
    db.verification.findMany.mockImplementation((async () => {
      page += 1;
      return Array.from({ length: 500 }, (_, index) => ({
        id: `p${String(page).padStart(3, "0")}-${String(index).padStart(3, "0")}`,
        value: code("owner", "https://other.example.com/meta"),
      }));
    }) as never);
    await expect(client().oauthGrants.revoke({ grantId: "g1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.verification.findMany).toHaveBeenCalledTimes(20);
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("never sweeps another person's codes: their grant is not found", async () => {
    db.mcpGrant.findFirst.mockResolvedValue(null);
    await expect(client().oauthGrants.revoke({ grantId: "theirs" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.verification.findMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });
});

describe("Contributing", () => {
  it("lists only the caller's shares and the caller's own served models", async () => {
    db.share.findMany.mockResolvedValue([]);
    db.runtimeModel.findMany.mockResolvedValue([
      {
        id: "rm1",
        upstreamModelId: "qwen",
        type: "LLM",
        runtimeId: "rt1",
        Runtime: { name: "Qwen box" },
      },
    ] as never);
    const result = await client().contributing.pools();
    expect(db.share.findMany.mock.calls[0]?.[0]?.where).toEqual({
      granteeUserId: "owner",
      canContribute: true,
    });
    expect(db.runtimeModel.findMany.mock.calls[0]?.[0]?.where).toEqual({
      userId: "owner",
      retired: false,
    });
    expect(result.servedModels).toEqual([
      {
        runtimeModelId: "rm1",
        upstreamModelId: "qwen",
        type: "LLM",
        runtimeId: "rt1",
        runtimeName: "Qwen box",
      },
    ]);
  });
});

describe("OAuth connection level", () => {
  function grantRow(level: "READ" | "FULL", clientId = "https://client.example.com/meta") {
    db.mcpGrant.findFirst.mockResolvedValue({
      id: "g1",
      clientId,
      referenceId: "ref1",
      level,
    } as never);
  }
  function writeApproved(clientId = "https://client.example.com/meta") {
    db.oauthConsent.findMany.mockResolvedValue([{ clientId, referenceId: "ref1" }] as never);
  }

  it("refuses Full for a connection whose approval did not include mcp:write", async () => {
    grantRow("READ");
    db.oauthConsent.findMany.mockResolvedValue([]);
    await expect(
      client().oauthGrants.setLevel({ grantId: "g1", level: "FULL" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.oauthConsent.findMany.mock.calls[0]?.[0]?.where).toEqual({
      userId: "owner",
      clientId: { in: ["https://client.example.com/meta"] },
      scopes: { has: "mcp:write" },
    });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("lists whether Full can apply to each connection", async () => {
    db.mcpGrant.findMany.mockResolvedValue([
      {
        id: "g1",
        clientId: "c1",
        referenceId: "ref1",
        level: "READ",
        createdAt: now,
        revokedAt: null,
      },
      {
        id: "g2",
        clientId: "c1",
        referenceId: "ref2",
        level: "READ",
        createdAt: now,
        revokedAt: null,
      },
    ] as never);
    db.oauthClient.findMany.mockResolvedValue([]);
    writeApproved("c1");
    const { connections } = await client().oauthGrants.list();
    expect(connections.map((row) => [row.grantId, row.fullAvailable])).toEqual([
      ["g1", true],
      ["g2", false],
    ]);
  });

  it("lowers Full to Read-only conditionally, audits it as the person, then ends Full work", async () => {
    grantRow("FULL");
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    const lowered = vi.fn(async () => undefined);
    const result = await client(PERSON, { onAccessLevelLowered: lowered }).oauthGrants.setLevel({
      grantId: "g1",
      level: "READ",
    });
    expect(result).toEqual({ level: "READ" });
    expect(db.mcpGrant.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "g1",
      userId: "owner",
      revokedAt: null,
    });
    // Conditional on the level read: a concurrent change is never overwritten silently.
    expect(db.mcpGrant.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: "g1", userId: "owner", revokedAt: null, level: "FULL" },
      data: { level: "READ" },
    });
    expect(db.auditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      userId: "owner",
      actor: "USER",
      actorUserId: "owner",
      action: "mcp_grant.level",
      resourceType: "mcp_grant",
      resourceId: "g1",
      before: { level: "FULL" },
      after: { level: "READ" },
    });
    expect(db.auditEvent.create.mock.calls[0]?.[0]?.data).not.toHaveProperty("mcpGrantId");
    expect(lowered).toHaveBeenCalledWith({ kind: "oauth_grant", userId: "owner", grantId: "g1" });
  });

  it("raises Read-only to Full without ending anything (it applies from the next call)", async () => {
    grantRow("READ");
    writeApproved();
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    const lowered = vi.fn(async () => undefined);
    const result = await client(PERSON, { onAccessLevelLowered: lowered }).oauthGrants.setLevel({
      grantId: "g1",
      level: "FULL",
    });
    expect(result).toEqual({ level: "FULL" });
    expect(db.mcpGrant.updateMany.mock.calls[0]?.[0]?.data).toEqual({ level: "FULL" });
    expect(db.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(lowered).not.toHaveBeenCalled();
  });

  it("writes and audits nothing when the level is unchanged", async () => {
    grantRow("READ");
    const lowered = vi.fn(async () => undefined);
    await client(PERSON, { onAccessLevelLowered: lowered }).oauthGrants.setLevel({
      grantId: "g1",
      level: "READ",
    });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
    expect(lowered).not.toHaveBeenCalled();
  });

  it("refuses an agent token's grant, a revoked one and another person's alike", async () => {
    grantRow("FULL", "pat:tok1");
    await expect(
      client().oauthGrants.setLevel({ grantId: "g1", level: "READ" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.mcpGrant.findFirst.mockResolvedValue(null);
    await expect(
      client().oauthGrants.setLevel({ grantId: "theirs", level: "FULL" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });

  it("reports a concurrent change (revoked or re-levelled meanwhile) instead of writing over it", async () => {
    grantRow("FULL");
    db.mcpGrant.updateMany.mockResolvedValue({ count: 0 });
    const lowered = vi.fn(async () => undefined);
    await expect(
      client(PERSON, { onAccessLevelLowered: lowered }).oauthGrants.setLevel({
        grantId: "g1",
        level: "READ",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.auditEvent.create).not.toHaveBeenCalled();
    expect(lowered).not.toHaveBeenCalled();
  });

  it("keeps a committed lowering even when ending the Full work fails", async () => {
    grantRow("FULL");
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await client(PERSON, {
      onAccessLevelLowered: async () => {
        throw new Error("relay down");
      },
    }).oauthGrants.setLevel({ grantId: "g1", level: "READ" });
    expect(result).toEqual({ level: "READ" });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
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

  it("shares directly with an account whose mailbox was proved, under both owners' fences", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue({
      id: "friend",
      email: "Friend@example.test",
      provedEmail: "friend@example.test",
    } as never);
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
    db.user.findFirst.mockResolvedValue({
      id: "squatter",
      email: "friend@example.test",
      provedEmail: null,
    } as never);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    const result = await client().shares.create(input);
    expect(result.kind).toBe("invite");
    expect(db.share.create).not.toHaveBeenCalled();
  });

  // Codex finding 2: without SMTP (or for an admin-created account) `emailVerified` is forced
  // true with no proof, so a squatter who registered the address must not get the share.
  it("invites a login-verified account whose mailbox was never proved", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue({
      id: "squatter",
      email: "friend@example.test",
      emailVerified: true,
      provedEmail: null,
    } as never);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    const result = await client().shares.create(input);
    expect(result.kind).toBe("invite");
    expect(db.share.create).not.toHaveBeenCalled();
    expect(db.user.findFirst.mock.calls[0]?.[0]?.select).toEqual({
      id: true,
      email: true,
      provedEmail: true,
    });
  });

  it("invites an account whose proof is for an address it no longer has", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue({
      id: "changed",
      email: "friend@example.test",
      provedEmail: "old@example.test",
    } as never);
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
      runtimeId: null,
      Runtime: null,
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
      runtimeId: null,
      Runtime: null,
    };
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    const result = await client().shares.create(input);
    expect(result).toMatchObject({ kind: "invite", link: null });
    if (result.kind !== "invite") throw new Error("expected an invite");
    expect(result.invite.emailSentAt).not.toBeNull();
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "friend@example.test" }),
    );
    // Marked sent only while the invite still has the link that went out.
    const marked = db.shareInvite.updateMany.mock.calls.at(-1)?.[0];
    expect(marked?.where).toEqual({
      id: "inv1",
      tokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(marked?.data).toEqual({ emailSentAt: expect.any(Date) });
    expect(db.shareInvite.update).not.toHaveBeenCalled();
  });

  it("answers the invite as written when it vanished before it could be marked e-mailed", async () => {
    mailer.isEmailConfigured.mockReturnValue(true);
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    // The pool's delete removed the invite (or a resend rotated it) after it was written.
    db.shareInvite.updateMany.mockResolvedValue({ count: 0 });
    const result = await client().shares.create(input);
    expect(result).toMatchObject({ kind: "invite", link: null, invite: { emailSentAt: null } });
  });

  it("withdraws a pending invite to the address when the share is made directly", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue({
      id: "friend",
      email: "friend@example.test",
      provedEmail: "friend@example.test",
    } as never);
    const order: string[] = [];
    db.shareInvite.updateMany.mockImplementation((async () => {
      order.push("withdraw");
      return { count: 1 };
    }) as never);
    db.share.create.mockImplementation((async () => {
      order.push("share");
      return { id: "share1" };
    }) as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    await client().shares.create(input);
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        poolId: "pool1",
        email: "friend@example.test",
        ownerUserId: "owner",
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(order).toEqual(["withdraw", "share"]);
  });

  it("withdraws an expired invite to the same address before inviting again", async () => {
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockResolvedValue(inviteRow as never);
    await client().shares.create(input);
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        poolId: "pool1",
        email: "friend@example.test",
        ownerUserId: "owner",
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
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
      poolId: "pool1",
      granteeUserId: "friend",
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
      runtimeId: null,
      Runtime: null,
    } as never);
    const result = await client().invites.resend({ inviteId: "inv1" });
    const token = new URL(result.link ?? "").searchParams.get("invite") ?? "";
    const call = db.shareInvite.updateMany.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ id: "inv1", ownerUserId: "owner", acceptedAt: null });
    expect(call?.data).toMatchObject({
      tokenDigest: credentialDigest("shareInvite", token),
      // The new link starts free of the old link's sign-up claim.
      signupClaimedAt: null,
      signupClaimedEmail: null,
    });
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

  it("resends a runtime invite: a new link, e-mailed naming the runtime definition", async () => {
    mailer.isEmailConfigured.mockReturnValue(true);
    db.user.findUnique.mockResolvedValue({ name: "Owner", locale: "en-US" } as never);
    db.shareInvite.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 86_400_000),
      updatedAt: new Date(Date.now() - 86_400_000),
    } as never);
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    const runtimeInvite = {
      ...inviteRow,
      id: "inv-rt",
      poolId: null,
      Pool: null,
      runtimeId: "rt1",
      Runtime: { name: "Qwen" },
    };
    db.shareInvite.findUniqueOrThrow.mockResolvedValue(runtimeInvite as never);
    db.shareInvite.update.mockResolvedValue({ ...runtimeInvite, emailSentAt: now } as never);
    const result = await client().invites.resend({ inviteId: "inv-rt" });
    expect(result.link).toBeNull();
    expect(result.invite.target).toEqual({ kind: "runtime", runtimeId: "rt1", name: "Qwen" });
    expect(mailer.renderShareInvite).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "runtime", name: "Qwen" } }),
    );
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "inv-rt",
      ownerUserId: "owner",
    });
  });

  it("withdraws a pending runtime invite", async () => {
    db.shareInvite.findFirst.mockResolvedValue({
      id: "inv-rt",
      acceptedAt: null,
      revokedAt: null,
    } as never);
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    await expect(client().invites.revoke({ inviteId: "inv-rt" })).resolves.toEqual({ ok: true });
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "inv-rt", ownerUserId: "owner", acceptedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("withdraws under the owner's fence and refuses when an acceptance won the race", async () => {
    db.shareInvite.findFirst
      .mockResolvedValueOnce({ id: "inv-rt", acceptedAt: null, revokedAt: null } as never)
      .mockResolvedValueOnce({ acceptedAt: new Date() } as never);
    // The acceptance committed between the read and the guarded revoke.
    db.shareInvite.updateMany.mockResolvedValue({ count: 0 });
    await expect(client().invites.revoke({ inviteId: "inv-rt" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This invite was accepted. Delete the share instead.",
    });
    expect(heldFences()).toEqual(["00:owner:owner"]);
  });

  it("refuses to withdraw an accepted invite, and is a no-op for a withdrawn one", async () => {
    db.shareInvite.findFirst.mockResolvedValueOnce({
      id: "inv1",
      acceptedAt: new Date(),
      revokedAt: null,
    } as never);
    await expect(client().invites.revoke({ inviteId: "inv1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    db.shareInvite.findFirst.mockResolvedValueOnce({
      id: "inv1",
      acceptedAt: null,
      revokedAt: new Date(),
    } as never);
    await expect(client().invites.revoke({ inviteId: "inv1" })).resolves.toEqual({ ok: true });
    expect(db.shareInvite.updateMany).not.toHaveBeenCalled();
  });

  it("lists pending pool and runtime invites with their targets", async () => {
    db.share.findMany.mockResolvedValue([]);
    db.shareInvite.findMany.mockResolvedValue([
      inviteRow,
      {
        ...inviteRow,
        id: "inv-rt",
        poolId: null,
        Pool: null,
        runtimeId: "rt1",
        Runtime: { name: "Qwen" },
      },
    ] as never);
    const result = await client().shares.list();
    expect(result.invites.map((invite) => invite.target)).toEqual([
      { kind: "pool", poolId: "pool1", callableId: "owner/chat" },
      { kind: "runtime", runtimeId: "rt1", name: "Qwen" },
    ]);
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

  it("tells a share holder which model the owner lets them bring their own key for", async () => {
    db.share.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...shareRow,
        Pool: {
          slug: "chat",
          modelType: "LLM",
          Fallback: { ownKeyEquivalentModel: "openai/gpt" },
        },
      },
      { ...shareRow, id: "share2", Pool: { slug: "chat", modelType: "LLM", Fallback: null } },
    ] as never);
    db.shareInvite.findMany.mockResolvedValue([]);
    const listed = await client().shares.list();
    expect(db.share.findMany.mock.calls[1]?.[0]?.where).toEqual({ granteeUserId: "owner" });
    expect(listed.withMe.map((share) => share.ownKeyEquivalentModel)).toEqual(["openai/gpt", null]);
    expect(listed.withMe[0]?.modelType).toBe("LLM");
  });

  it("sets an own key only from the share holder's own provider models", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      ownerUserId: "pool-owner",
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

  it("sets an own key under both owners' fences, re-checking the owner's consent there", async () => {
    db.share.findFirst
      .mockResolvedValueOnce({ id: "share1", ownerUserId: "pool-owner" } as never)
      .mockResolvedValueOnce({
        ownKeyProtocolAdaptation: false,
        Pool: { modelType: "LLM", Fallback: { ownKeyEquivalentModel: "openai/gpt" } },
      } as never);
    db.providerModel.findFirst.mockResolvedValue({ id: "mine", type: "LLM" } as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    await client().shares.setOwnKey({ shareId: "share1", providerModelId: "mine" });
    expect(heldFences()).toEqual(["00:owner:owner", "00:owner:pool-owner"]);
    expect(db.share.update.mock.calls[0]?.[0]).toEqual({
      where: { id: "share1" },
      data: { ownKeyProviderModelId: "mine", ownKeyProtocolAdaptation: false },
    });

    // The owner withdrew the equivalent between the read and the fences: refused.
    db.share.update.mockClear();
    db.share.findFirst
      .mockResolvedValueOnce({ id: "share1", ownerUserId: "pool-owner" } as never)
      .mockResolvedValueOnce({
        ownKeyProtocolAdaptation: false,
        Pool: { modelType: "LLM", Fallback: null },
      } as never);
    await expect(
      client().shares.setOwnKey({ shareId: "share1", providerModelId: "mine" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.share.update).not.toHaveBeenCalled();
  });

  it("refuses an own key of another type than the pool's", async () => {
    db.share.findFirst
      .mockResolvedValueOnce({ id: "share1", ownerUserId: "pool-owner" } as never)
      .mockResolvedValueOnce({
        ownKeyProtocolAdaptation: false,
        Pool: { modelType: "EMBEDDINGS", Fallback: { ownKeyEquivalentModel: "openai/embed" } },
      } as never);
    db.providerModel.findFirst.mockResolvedValue({ id: "mine", type: "LLM" } as never);
    await expect(
      client().shares.setOwnKey({ shareId: "share1", providerModelId: "mine" }),
    ).rejects.toMatchObject({ data: { reason: "model_type_mismatch" } });
    expect(db.share.update).not.toHaveBeenCalled();
  });

  it("shows capped shares' month as settled plus reserved spend, batched per currency", async () => {
    db.share.findMany
      .mockResolvedValueOnce([
        { ...shareRow, id: "s1", SpendCap: capOf("cap1", "EUR") },
        { ...shareRow, id: "s2", SpendCap: capOf("cap2", "EUR") },
        { ...shareRow, id: "s3", SpendCap: capOf("cap3", "USD") },
        { ...shareRow, id: "s4", SpendCap: null },
      ] as never)
      .mockResolvedValueOnce([]);
    db.shareInvite.findMany.mockResolvedValue([]);
    spend.sharesSpend.mockImplementation(
      async (_db: unknown, input: { shareIds: string[]; currency: string }) =>
        new Map(
          input.shareIds.map((id) => [id, id === "s1" ? usage("1.5", "0.25") : usage("0", "0")]),
        ),
    );
    const listed = await client().shares.list();
    // One statement per cap currency, never one per share.
    expect(spend.sharesSpend).toHaveBeenCalledTimes(2);
    expect(spend.sharesSpend).toHaveBeenCalledWith(prisma, {
      shareIds: ["s1", "s2"],
      currency: "EUR",
    });
    expect(spend.sharesSpend).toHaveBeenCalledWith(prisma, { shareIds: ["s3"], currency: "USD" });
    expect(listed.byMe.map((share) => share.monthlyCap?.spentThisMonth ?? null)).toEqual([
      "1.75",
      "0",
      "0",
      null,
    ]);
  });

  it("edits a share cap under the share's spend fence", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      poolId: "pool1",
      granteeUserId: "friend",
      canUse: true,
      canContribute: true,
      SpendCap: { id: "cap1", currency: "USD" },
    } as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    spend.shareSpendCurrencies.mockResolvedValue(["USD"]);
    await client().shares.update({
      shareId: "share1",
      monthlyCap: { limit: "30", currency: "USD" },
    });
    expect(heldFences()).toEqual(["00:owner:friend", "00:owner:owner", "04:spend-share:share1"]);
    expect(spend.shareSpendCurrencies).toHaveBeenCalledWith(db, { shareId: "share1" });
    expect(db.spendCap.update.mock.calls[0]?.[0]?.data).toMatchObject({ currency: "USD" });
  });

  it("a share cap names only the currency the share has spent in this month", async () => {
    const found = (SpendCap: unknown) =>
      db.share.findFirst.mockResolvedValue({
        id: "share1",
        poolId: "pool1",
        granteeUserId: "friend",
        canUse: true,
        canContribute: true,
        SpendCap,
      } as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    spend.shareSpendCurrencies.mockResolvedValue(["USD"]);
    // A currency change, and a first cap (also one set again after a clear).
    for (const cap of [{ id: "cap1", currency: "USD" }, null]) {
      found(cap);
      await expect(
        client().shares.update({ shareId: "share1", monthlyCap: { limit: "30", currency: "EUR" } }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "cap_currency_has_spend" } });
    }
    expect(db.spendCap.update).not.toHaveBeenCalled();
    expect(db.spendCap.create).not.toHaveBeenCalled();

    spend.shareSpendCurrencies.mockResolvedValue([]);
    found({ id: "cap1", currency: "USD" });
    await client().shares.update({
      shareId: "share1",
      monthlyCap: { limit: "30", currency: "EUR" },
    });
    expect(db.spendCap.update.mock.calls[0]?.[0]?.data).toMatchObject({ currency: "EUR" });
  });

  it("writes only the fields a share update names", async () => {
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      poolId: "pool1",
      granteeUserId: "friend",
      canUse: true,
      canContribute: true,
      SpendCap: null,
    } as never);
    db.share.findUnique.mockResolvedValue(shareRow as never);
    await client().shares.update({ shareId: "share1", protectionPercent: 20 });
    expect(db.share.update.mock.calls[0]?.[0].data).toEqual({ protectionPercent: 20 });
    // No permission named: no capacity-policy fences.
    expect(heldFences()).toEqual(["00:owner:friend", "00:owner:owner"]);
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
      context: {
        session: null,
        auth: { kind: "anonymous" },
        services: { limitInviteLookup: async () => true },
      } satisfies Context,
    });

  it("names a runtime invite's owner and runtime definition", async () => {
    db.shareInvite.findFirst.mockResolvedValue({
      email: "friend@example.test",
      poolId: null,
      runtimeId: "rt1",
      Owner: { name: "Owner" },
      Pool: null,
      Runtime: { name: "Qwen" },
    } as never);
    await expect(
      auth().inviteInfo({ token: "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ" }),
    ).resolves.toEqual({
      valid: true,
      email: "friend@example.test",
      ownerName: "Owner",
      target: { kind: "runtime", name: "Qwen" },
    });
  });

  it("answers valid: false and nothing else for an unknown link", async () => {
    db.shareInvite.findFirst.mockResolvedValue(null);
    await expect(
      auth().inviteInfo({ token: "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ" }),
    ).resolves.toEqual({ valid: false, email: null, ownerName: null, target: null });
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      tokenDigest: credentialDigest("shareInvite", "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      acceptedAt: null,
      revokedAt: null,
    });
  });
});

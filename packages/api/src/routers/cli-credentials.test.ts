import { createRouterClient, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { cliCredentialsRouter } = await import("./cli-credentials");

const LOGIN_IDENTITY_PUBLIC_KEY =
  "BBERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERE";

const db = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
  appSetting: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  cliToken: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  cliDevice: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  cliDeviceCredential: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  deviceCode: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

function deviceCodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "device-code-row-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 10 * 60_000),
    status: "approved",
    lastPolledAt: null,
    // Better Auth stores the polling interval in milliseconds (`ms("5s")`).
    pollingInterval: 5000,
    scope: "cli-slug:desk-01",
    ...overrides,
  };
}

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
  services?: Context["services"],
): Context {
  if (sessionOverride === null) return { session: null, services };

  return {
    services,
    session: {
      user: {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...sessionOverride?.user,
      },
      session: {
        id: "session-1",
        userId: sessionOverride?.user?.id ?? "user-1",
        token: "session-token",
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("cliCredentialsRouter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.deviceCode.deleteMany.mockResolvedValue({ count: 1 });
    // The exchange's FOR SHARE read of the approving owner: active.
    db.$queryRaw.mockResolvedValue([
      { banned: false, banExpires: null, deletionRequestedAt: null },
    ]);
    db.cliDevice.findUnique.mockResolvedValue(null);
    db.cliDevice.upsert.mockResolvedValue({ id: "cli-device-1" });
    db.cliDeviceCredential.create.mockResolvedValue({ id: "credential-1", userId: "user-1" });
    db.cliDeviceCredential.findMany.mockResolvedValue([]);
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 0 });
  });

  it("requires authentication", async () => {
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    await expect(client.listTokens()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("UNAUTHORIZED");
      return true;
    });
  });

  it("lists only the signed-in user's non-revoked CLI tokens by default", async () => {
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    db.cliToken.findMany.mockResolvedValue([
      {
        id: "token-1",
        createdAt,
        updatedAt: createdAt,
        userId: "user-1",
        cliDeviceId: null,
        name: "Laptop",
        lookupPrefix: "wsmp_cli_abcdefghijkl",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        identityPublicKey: null,
        lastRefusedAt: null,
        lastRefusedReason: null,
      },
    ]);
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

    await expect(client.listTokens()).resolves.toEqual([
      {
        id: "token-1",
        createdAt,
        updatedAt: createdAt,
        cliDeviceId: null,
        name: "Laptop",
        lookupPrefix: "wsmp_cli_abcdefghijkl",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        identityBound: false,
        lastRefusedAt: null,
        lastRefusedReason: null,
      },
    ]);
    expect(db.cliToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", revokedAt: null },
      }),
    );
  });

  it("creates one-time CLI token secrets and stores only lookup prefix plus digest", async () => {
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    db.cliToken.create.mockResolvedValue({
      id: "token-1",
      createdAt,
      updatedAt: createdAt,
      userId: "user-1",
      cliDeviceId: null,
      name: "Laptop",
      lookupPrefix: "wsmp_cli_abcdefghijkl",
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
    });
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

    const result = await client.createToken({ name: "Laptop" });

    expect(result.secret).toMatch(/^wsmp_cli_[A-Za-z0-9_-]{43}$/);
    expect(result.token.lookupPrefix).toBe("wsmp_cli_abcdefghijkl");
    expect(db.cliToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        name: "Laptop",
        lookupPrefix: expect.stringMatching(/^wsmp_cli_[A-Za-z0-9_-]{12}$/),
        secretDigest: expect.any(String),
      }),
      select: expect.any(Object),
    });
    expect(JSON.stringify(db.cliToken.create.mock.calls)).not.toContain(result.secret);
  });

  it("exchanges an approved device code without a session and creates a CLI device", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow());
    const onCliCredentialsRevoked = vi.fn();
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(null, { onCliCredentialsRevoked }),
    });

    const result = await client.exchangeDeviceCode({
      deviceCode: "approved-device-code",
      cliSlug: "desk-01",
      identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
    });

    // The CLI gets exactly its credential; nothing about other credentials.
    expect(Object.keys(result).sort()).toEqual(["credentialId", "secret", "userId"]);
    expect(result).toMatchObject({ credentialId: "credential-1", userId: "user-1" });
    expect(result.secret).toMatch(/^wsmp_device_/);
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_slug: { userId: "user-1", slug: "desk-01" } },
        create: { userId: "user-1", slug: "desk-01" },
      }),
    );
    expect(db.cliDeviceCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        cliDeviceId: "cli-device-1",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
      select: { id: true, userId: true },
    });
    // The credential takes its name from the device; none is stored.
    expect(db.cliDeviceCredential.create.mock.calls[0]?.[0].data).not.toHaveProperty("name");
    expect(db.deviceCode.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "device-code-row-1",
        status: "approved",
        userId: "user-1",
        expiresAt: { gt: expect.any(Date) },
      },
    });
    // Nothing was revoked, so no live session is touched.
    expect(onCliCredentialsRevoked).not.toHaveBeenCalled();
  });

  it("reattaches a re-login to the existing device and closes the revoked credentials' sessions", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow());
    db.cliDevice.upsert.mockResolvedValue({ id: "existing-cli-device" });
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "old-credential" }]);
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 1 });
    const onCliCredentialsRevoked = vi.fn(() => {
      // Runs after the transaction committed.
      expect(db.cliDeviceCredential.updateMany).toHaveBeenCalled();
    });
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(null, { onCliCredentialsRevoked }),
    });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).resolves.toMatchObject({ credentialId: "credential-1" });
    expect(db.cliDeviceCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cliDeviceId: "existing-cli-device" }),
      }),
    );
    expect(onCliCredentialsRevoked).toHaveBeenCalledWith({
      kind: "deviceCredential",
      ids: ["old-credential"],
    });
  });

  it("still returns the new credential when closing revoked sessions fails", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow());
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "old-credential" }]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(null, {
        onCliCredentialsRevoked: () => {
          throw new Error("socket gone");
        },
      }),
    });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).resolves.toMatchObject({ credentialId: "credential-1" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[cli-credentials] closing revoked relay sessions failed",
      "Error",
    );
    errorSpy.mockRestore();
  });

  it("rejects an exchange for a slug other than the one the approver saw", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow({ scope: "cli-slug:other-box" }));
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.data).toBeUndefined();
      return true;
    });
    expect(db.deviceCode.deleteMany).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  });

  it("rejects invalid CLI slugs before reading the device code", async () => {
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk.01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).rejects.toThrow();
    expect(db.deviceCode.findUnique).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  });

  it("keeps pending device codes pending and does not check slug availability", async () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    db.deviceCode.findUnique.mockResolvedValue(
      deviceCodeRow({
        userId: null,
        expiresAt: new Date("2026-07-01T00:10:00.000Z"),
        status: "pending",
      }),
    );
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "pending-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.data).toEqual({ deviceFlowError: "authorization_pending" });
      return true;
    });
    expect(db.deviceCode.update).toHaveBeenCalledWith({
      where: { id: "device-code-row-1" },
      data: { lastPolledAt: now },
      select: { id: true },
    });
    expect(db.cliDevice.upsert).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.each([
    [
      "slow_down",
      { status: "pending", userId: null, lastPolledAt: new Date(), expiresAt: 10 * 60_000 },
    ],
    [
      "access_denied",
      { status: "denied", userId: null, lastPolledAt: null, expiresAt: 10 * 60_000 },
    ],
    ["expired_token", { status: "pending", userId: null, lastPolledAt: null, expiresAt: -60_000 }],
  ] as const)("tags the %s device-flow state in the error data", async (expected, row) => {
    db.deviceCode.findUnique.mockResolvedValue(
      deviceCodeRow({
        userId: row.userId,
        expiresAt: new Date(Date.now() + row.expiresAt),
        status: row.status,
        lastPolledAt: row.lastPolledAt,
      }),
    );
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    const error = await client
      .exchangeDeviceCode({
        deviceCode: "device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    if (error instanceof ORPCError) expect(error.data).toEqual({ deviceFlowError: expected });
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  });

  it("sends the device-flow state on the wire the CLI reads", async () => {
    db.deviceCode.findUnique.mockResolvedValue(
      deviceCodeRow({ userId: null, status: "pending", scope: "cli-slug:pending-ci" }),
    );
    const handler = new RPCHandler(cliCredentialsRouter);

    const result = await handler.handle(
      new Request("https://example.test/rpc/exchangeDeviceCode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            deviceCode: "device-code",
            cliSlug: "pending-ci",
            identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
          },
        }),
      }),
      { prefix: "/rpc", context: buildContext(null) },
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.response.status).toBe(400);
    // apps/cli/src/auth.rs parses `json.code` and `json.data.deviceFlowError`.
    expect(await result.response.json()).toMatchObject({
      json: {
        code: "BAD_REQUEST",
        data: { deviceFlowError: "authorization_pending" },
      },
    });
  });

  it("charges the exchange limiter with the device code before any database read", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow());
    const limitDeviceCodeExchange = vi.fn(async () => ({ allowed: true as const }));
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(null, { limitDeviceCodeExchange }),
    });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).resolves.toMatchObject({ credentialId: "credential-1" });
    expect(limitDeviceCodeExchange).toHaveBeenCalledWith("approved-device-code");
  });

  it("answers a limited exchange with slow_down on the wire and reads nothing", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow());
    const limitDeviceCodeExchange = vi.fn(async () => ({
      allowed: false as const,
      retryAfterMs: 30_000,
    }));
    const handler = new RPCHandler(cliCredentialsRouter);

    const result = await handler.handle(
      new Request("https://example.test/rpc/exchangeDeviceCode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            deviceCode: "approved-device-code",
            cliSlug: "desk-01",
            identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
          },
        }),
      }),
      { prefix: "/rpc", context: buildContext(null, { limitDeviceCodeExchange }) },
    );

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.response.status).toBe(429);
    // apps/cli/src/auth.rs backs off on `slow_down` instead of ending the login.
    // The refusal carries the computed wait so a client can back off precisely.
    expect(await result.response.json()).toMatchObject({
      json: {
        code: "TOO_MANY_REQUESTS",
        data: { deviceFlowError: "slow_down", retryAfterMs: 30_000 },
      },
    });
    expect(db.deviceCode.findUnique).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  });

  it("clamps a refusal's retryAfterMs to the device-code lifetime", async () => {
    const { CLI_DEVICE_CODE_LIFETIME_MS } = await import("@ws-model-proxy/config/cli-device-login");
    const limitDeviceCodeExchange = vi.fn(async () => ({
      allowed: false as const,
      retryAfterMs: CLI_DEVICE_CODE_LIFETIME_MS * 10,
    }));
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(null, { limitDeviceCodeExchange }),
    });

    const error = await client
      .exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    if (error instanceof ORPCError) {
      expect(error.data).toEqual({
        deviceFlowError: "slow_down",
        retryAfterMs: CLI_DEVICE_CODE_LIFETIME_MS,
      });
    }
  });

  it("never charges the exchange limiter for the pre-0.4.0 upgrade sentinel", async () => {
    const { CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE } = await import(
      "@ws-model-proxy/config/cli-device-login"
    );
    // Saturate: the limiter refuses every call. The sentinel must short-circuit
    // before it is charged, or one caller could starve the whole fleet's
    // upgrade message.
    const limitDeviceCodeExchange = vi.fn(async () => ({
      allowed: false as const,
      retryAfterMs: 60_000,
    }));
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(null, { limitDeviceCodeExchange }),
    });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
        cliSlug: "desk-01",
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
    expect(limitDeviceCodeExchange).not.toHaveBeenCalled();
  });

  it("tells a pre-0.4.0 wsmp login to upgrade through the envelope 0.3.x prints", async () => {
    const { CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE, CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE } =
      await import("@ws-model-proxy/config/cli-device-login");
    const handler = new RPCHandler(cliCredentialsRouter);
    // 0.3.x sends `name` too; it is stripped, not rejected.
    const result = await handler.handle(
      new Request("https://example.test/rpc/exchangeDeviceCode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            deviceCode: CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
            name: "CLI device",
            cliSlug: "desk-01",
          },
        }),
      }),
      { prefix: "/rpc", context: buildContext(null) },
    );
    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.response.status).toBe(400);
    // 0.3.x `rpc_status_error` prints `json.message` verbatim.
    expect(await result.response.json()).toMatchObject({
      json: { code: "BAD_REQUEST", message: CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE },
    });
    // The sentinel never reaches the credential mint.
    expect(db.deviceCode.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  });

  it("mints for the approved device-code user instead of the session user", async () => {
    db.deviceCode.findUnique.mockResolvedValue(deviceCodeRow({ userId: "approved-user" }));
    db.cliDeviceCredential.create.mockResolvedValue({
      id: "credential-1",
      userId: "approved-user",
    });
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext({ user: { id: "wrong-session-user" } }),
    });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        cliSlug: "desk-01",
        identityPublicKey: LOGIN_IDENTITY_PUBLIC_KEY,
      }),
    ).resolves.toMatchObject({ credentialId: "credential-1", userId: "approved-user" });
    expect(db.cliDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_slug: { userId: "approved-user", slug: "desk-01" } },
      }),
    );
  });

  it("revokes only tokens owned by the signed-in user", async () => {
    const revokedAt = new Date("2026-07-01T00:00:00.000Z");
    db.cliToken.findUnique.mockResolvedValueOnce({
      id: "token-1",
      userId: "user-2",
      revokedAt: null,
    });
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

    await expect(client.revokeToken({ id: "token-1" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      return true;
    });

    db.cliToken.findUnique.mockResolvedValueOnce({
      id: "token-1",
      userId: "user-1",
      revokedAt,
    });
    db.cliToken.update.mockResolvedValue({
      id: "token-1",
      createdAt: revokedAt,
      updatedAt: revokedAt,
      userId: "user-1",
      cliDeviceId: null,
      name: "Laptop",
      lookupPrefix: "wsmp_cli_abcdefghijkl",
      lastUsedAt: null,
      revokedAt,
      expiresAt: null,
    });

    await expect(client.revokeToken({ id: "token-1" })).resolves.toMatchObject({
      id: "token-1",
      revokedAt,
    });
    expect(db.cliToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { revokedAt },
      select: expect.any(Object),
    });
  });

  it("closes live relay sessions of a revoked CLI token", async () => {
    const revokedAt = new Date("2026-07-01T00:00:00.000Z");
    db.cliToken.findUnique.mockResolvedValue({ id: "token-1", userId: "user-1", revokedAt: null });
    db.cliToken.update.mockResolvedValue({
      id: "token-1",
      createdAt: revokedAt,
      updatedAt: revokedAt,
      cliDeviceId: null,
      name: "Laptop",
      lookupPrefix: "wsmp_cli_abcdefghijkl",
      lastUsedAt: null,
      revokedAt,
      expiresAt: null,
    });
    const onCliCredentialsRevoked = vi.fn();
    const client = createRouterClient(cliCredentialsRouter, {
      context: buildContext(undefined, { onCliCredentialsRevoked }),
    });

    await client.revokeToken({ id: "token-1" });

    expect(onCliCredentialsRevoked).toHaveBeenCalledWith({ kind: "cliToken", ids: ["token-1"] });
  });

  it("resets a CLI token identity bind without revoking it", async () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    db.cliToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      revokedAt: null,
    });
    db.cliToken.update.mockResolvedValue({
      id: "token-1",
      createdAt: now,
      updatedAt: now,
      userId: "user-1",
      cliDeviceId: "cli-device-1",
      name: "Laptop",
      lookupPrefix: "wsmp_cli_abcdefghijkl",
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      identityPublicKey: null,
      lastRefusedAt: null,
      lastRefusedReason: null,
    });
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

    await expect(client.resetTokenIdentity({ id: "token-1" })).resolves.toMatchObject({
      id: "token-1",
      identityBound: false,
      lastRefusedAt: null,
    });
    expect(db.cliToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: {
        identityPublicKey: null,
        lastRefusedAt: null,
        lastRefusedReason: null,
      },
      select: expect.any(Object),
    });
  });

  describe("deviceLoginRequest", () => {
    it("shows a new device for a slug the user does not have yet", async () => {
      db.deviceCode.findFirst.mockResolvedValue(deviceCodeRow({ status: "pending" }));
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(client.deviceLoginRequest({ userCode: "ABCD-EFGH" })).resolves.toEqual({
        status: "pending",
        slug: "desk-01",
        existingDevice: null,
      });
      // An unclaimed pending code or one this user holds; exact and
      // normalized user code. The read writes nothing.
      expect(db.deviceCode.findFirst).toHaveBeenCalledWith({
        where: {
          userCode: { in: ["ABCD-EFGH", "ABCDEFGH"] },
          OR: [{ userId: null, status: "pending" }, { userId: "user-1" }],
        },
        select: { status: true, expiresAt: true, scope: true },
      });
      expect(db.deviceCode.update).not.toHaveBeenCalled();
      expect(db.deviceCode.updateMany).not.toHaveBeenCalled();
      expect(db.cliDevice.findUnique).toHaveBeenCalledWith({
        where: { userId_slug: { userId: "user-1", slug: "desk-01" } },
        select: { id: true, slug: true, name: true, reportedHostname: true },
      });
    });

    it("shows the device a re-login would replace by its display name", async () => {
      db.deviceCode.findFirst.mockResolvedValue(deviceCodeRow({ status: "pending" }));
      db.cliDevice.findUnique.mockResolvedValue({
        id: "cli-device-1",
        slug: "desk-01",
        name: null,
        reportedHostname: "desk-01.local",
      });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(client.deviceLoginRequest({ userCode: "ABCDEFGH" })).resolves.toEqual({
        status: "pending",
        slug: "desk-01",
        existingDevice: { id: "cli-device-1", slug: "desk-01", displayName: "desk-01.local" },
      });
    });

    it("hides codes another account holds, expired codes, and slug-less requests", async () => {
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      const reasonOf = (error: ORPCError) =>
        (error.data as { reason?: unknown } | undefined)?.reason;

      db.deviceCode.findFirst.mockResolvedValueOnce(null);
      await expect(client.deviceLoginRequest({ userCode: "ABCDEFGH" })).rejects.toSatisfy(
        (error: ORPCError) => error.code === "NOT_FOUND" && reasonOf(error) === "not_found",
      );

      db.deviceCode.findFirst.mockResolvedValueOnce(
        deviceCodeRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(client.deviceLoginRequest({ userCode: "ABCDEFGH" })).rejects.toSatisfy(
        (error: ORPCError) => error.code === "BAD_REQUEST" && reasonOf(error) === "expired",
      );

      db.deviceCode.findFirst.mockResolvedValueOnce(deviceCodeRow({ scope: null }));
      await expect(client.deviceLoginRequest({ userCode: "ABCDEFGH" })).rejects.toSatisfy(
        (error: ORPCError) => error.code === "BAD_REQUEST" && reasonOf(error) === "no_slug",
      );
      expect(db.cliDevice.findUnique).not.toHaveBeenCalled();
    });

    it("requires a session", async () => {
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

      await expect(client.deviceLoginRequest({ userCode: "ABCDEFGH" })).rejects.toSatisfy(
        (error: ORPCError) => error.code === "UNAUTHORIZED",
      );
      expect(db.deviceCode.findFirst).not.toHaveBeenCalled();
    });
  });
  describe("approveDeviceLogin", () => {
    const refusedWith = (code: string, reason: string) => (error: ORPCError) =>
      error.code === code && (error.data as { reason?: unknown } | undefined)?.reason === reason;
    function pendingRow(overrides: Record<string, unknown> = {}) {
      return deviceCodeRow({ userId: null, status: "pending", ...overrides });
    }

    it("claims and approves an unclaimed code in one conditional write", async () => {
      db.deviceCode.findFirst.mockResolvedValue(pendingRow());
      db.deviceCode.updateMany.mockResolvedValue({ count: 1 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCD-EFGH", slug: "desk-01" }),
      ).resolves.toEqual({ status: "approved", slug: "desk-01" });
      expect(db.deviceCode.updateMany).toHaveBeenCalledWith({
        where: {
          id: "device-code-row-1",
          status: "pending",
          expiresAt: { gt: expect.any(Date) },
          scope: "cli-slug:desk-01",
          OR: [{ userId: null }, { userId: "user-1" }],
        },
        data: { status: "approved", userId: "user-1" },
      });
      expect(db.deviceCode.update).not.toHaveBeenCalled();
    });

    it("lets the right account approve after the wrong account only looked", async () => {
      // The wrong account opens the page: a read, no write.
      db.deviceCode.findFirst.mockResolvedValue(pendingRow());
      const wrong = createRouterClient(cliCredentialsRouter, {
        context: buildContext({ user: { id: "wrong-user" } }),
      });
      await wrong.deviceLoginRequest({ userCode: "ABCDEFGH" });
      expect(db.deviceCode.updateMany).not.toHaveBeenCalled();

      // The row is still unclaimed, so the owner's approve claims it.
      db.deviceCode.updateMany.mockResolvedValue({ count: 1 });
      const owner = createRouterClient(cliCredentialsRouter, {
        context: buildContext({ user: { id: "owner" } }),
      });
      await expect(
        owner.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).resolves.toEqual({ status: "approved", slug: "desk-01" });
      expect(db.deviceCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "approved", userId: "owner" } }),
      );
    });

    it("loses a race to another account with CONFLICT", async () => {
      db.deviceCode.findFirst.mockResolvedValue(pendingRow());
      db.deviceCode.updateMany.mockResolvedValue({ count: 0 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).rejects.toSatisfy(refusedWith("CONFLICT", "already_handled"));
    });

    it("reports the request as used, not CONFLICT-handled, when the CLI redeemed it between the two reads", async () => {
      // Read as approvable; this account's own (or another's) approval won the
      // write and the CLI redeemed (deleted) the row before the re-read.
      db.deviceCode.findFirst.mockResolvedValueOnce(pendingRow()).mockResolvedValueOnce(null);
      db.deviceCode.updateMany.mockResolvedValue({ count: 0 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).rejects.toSatisfy(refusedWith("CONFLICT", "already_used"));
    });

    it("is idempotent when the SAME account's double-submit loses the conditional write", async () => {
      // Both requests read the row as pending; one updateMany wins (count 1),
      // the other's matches 0 rows. The loser re-reads and finds it approved
      // by its own account, so it reports the idempotent success.
      db.deviceCode.findFirst
        .mockResolvedValueOnce(pendingRow())
        .mockResolvedValueOnce(deviceCodeRow({ userId: "user-1", status: "approved" }));
      db.deviceCode.updateMany.mockResolvedValue({ count: 0 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).resolves.toEqual({ status: "approved", slug: "desk-01" });
      expect(db.deviceCode.findFirst).toHaveBeenCalledTimes(2);
    });

    it("locks the row before the conditional write, inside one transaction", async () => {
      db.deviceCode.findFirst.mockResolvedValue(pendingRow());
      db.deviceCode.updateMany.mockResolvedValue({ count: 1 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" });

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      const [lockSql] = db.$queryRaw.mock.calls[0] ?? [];
      expect((lockSql as TemplateStringsArray).join("?")).toMatch(
        /FROM device_code WHERE id = \? FOR UPDATE/,
      );
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.deviceCode.updateMany.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("reports expiry, not CONFLICT, when the code expired before the write", async () => {
      // Read while live; by the time the row lock was held it had expired, so
      // the conditional write matched nothing.
      db.deviceCode.findFirst
        .mockResolvedValueOnce(pendingRow())
        .mockResolvedValueOnce(pendingRow({ expiresAt: new Date(Date.now() - 1) }));
      db.deviceCode.updateMany.mockResolvedValue({ count: 0 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).rejects.toSatisfy(refusedWith("BAD_REQUEST", "expired"));
    });

    it("still CONFLICTs when a DIFFERENT account won the same race", async () => {
      // The inverse failure: the re-read must re-check userId. A status-only
      // check would report another account's win as this caller's success.
      db.deviceCode.findFirst
        .mockResolvedValueOnce(pendingRow())
        .mockResolvedValueOnce(deviceCodeRow({ userId: "other-user", status: "approved" }));
      db.deviceCode.updateMany.mockResolvedValue({ count: 0 });
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).rejects.toSatisfy(refusedWith("CONFLICT", "already_handled"));
    });

    it("hides a code another account holds", async () => {
      db.deviceCode.findFirst.mockResolvedValue(
        deviceCodeRow({ userId: "someone-else", status: "approved" }),
      );
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).rejects.toSatisfy(refusedWith("NOT_FOUND", "not_found"));
      expect(db.deviceCode.updateMany).not.toHaveBeenCalled();
    });

    it("refuses expired, handled, slug-less, and different-slug requests without writing", async () => {
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });
      const approve = () => client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" });

      db.deviceCode.findFirst.mockResolvedValueOnce(null);
      await expect(approve()).rejects.toSatisfy(refusedWith("NOT_FOUND", "not_found"));

      db.deviceCode.findFirst.mockResolvedValueOnce(
        pendingRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(approve()).rejects.toSatisfy(refusedWith("BAD_REQUEST", "expired"));

      db.deviceCode.findFirst.mockResolvedValueOnce(pendingRow({ status: "denied" }));
      await expect(approve()).rejects.toSatisfy(refusedWith("CONFLICT", "already_handled"));

      db.deviceCode.findFirst.mockResolvedValueOnce(pendingRow({ scope: null }));
      await expect(approve()).rejects.toSatisfy(refusedWith("BAD_REQUEST", "no_slug"));

      db.deviceCode.findFirst.mockResolvedValueOnce(pendingRow({ scope: "cli-slug:other-01" }));
      await expect(approve()).rejects.toSatisfy(refusedWith("CONFLICT", "slug_mismatch"));

      expect(db.deviceCode.updateMany).not.toHaveBeenCalled();
    });

    it("is idempotent for the account that already approved", async () => {
      db.deviceCode.findFirst.mockResolvedValue(
        deviceCodeRow({ userId: "user-1", status: "approved" }),
      );
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext() });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).resolves.toEqual({ status: "approved", slug: "desk-01" });
      expect(db.deviceCode.updateMany).not.toHaveBeenCalled();
    });

    it("requires a session", async () => {
      const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

      await expect(
        client.approveDeviceLogin({ userCode: "ABCDEFGH", slug: "desk-01" }),
      ).rejects.toSatisfy((error: ORPCError) => error.code === "UNAUTHORIZED");
      expect(db.deviceCode.findFirst).not.toHaveBeenCalled();
    });
  });
});

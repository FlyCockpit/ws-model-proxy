import { createRouterClient, ORPCError } from "@orpc/server";
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

const db = prisma as unknown as {
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
    create: ReturnType<typeof vi.fn>;
  };
  cliDeviceCredential: {
    create: ReturnType<typeof vi.fn>;
  };
  deviceCode: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };

  return {
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
        expiresAt: new Date("2026-07-02T00:00:00.000Z"),
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
    db.cliDevice.findUnique.mockResolvedValue(null);
    db.cliDevice.create.mockResolvedValue({ id: "cli-device-1" });
    db.cliDeviceCredential.create.mockResolvedValue({ id: "credential-1", userId: "user-1" });
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
    const expiresAt = new Date("2026-08-01T00:10:00.000Z");
    db.deviceCode.findUnique.mockResolvedValue({
      id: "device-code-row-1",
      userId: "user-1",
      expiresAt,
      status: "approved",
      lastPolledAt: null,
      pollingInterval: 5,
    });
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    const result = await client.exchangeDeviceCode({
      deviceCode: "approved-device-code",
      name: "Desk CLI",
      cliSlug: "desk-01",
    });

    expect(result).toMatchObject({ credentialId: "credential-1", userId: "user-1" });
    expect(result.secret).toMatch(/^wsmp_device_/);
    expect(db.cliDevice.findUnique).toHaveBeenCalledWith({
      where: { userId_slug: { userId: "user-1", slug: "desk-01" } },
      select: { id: true },
    });
    expect(db.cliDevice.create).toHaveBeenCalledWith({
      data: { userId: "user-1", slug: "desk-01", label: "Desk CLI" },
      select: { id: true },
    });
    expect(db.cliDeviceCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        cliDeviceId: "cli-device-1",
        name: "Desk CLI",
      }),
      select: { id: true, userId: true },
    });
    expect(db.deviceCode.delete).toHaveBeenCalledWith({ where: { id: "device-code-row-1" } });
  });

  it("rejects invalid CLI slugs before reading the device code", async () => {
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        name: "Desk CLI",
        cliSlug: "desk.01",
      }),
    ).rejects.toThrow();
    expect(db.deviceCode.findUnique).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  });

  it("keeps pending device codes pending and does not check slug availability", async () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    db.deviceCode.findUnique.mockResolvedValue({
      id: "device-code-row-1",
      userId: null,
      expiresAt: new Date("2026-07-01T00:10:00.000Z"),
      status: "pending",
      lastPolledAt: null,
      pollingInterval: 5,
    });
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "pending-device-code",
        name: "Desk CLI",
        cliSlug: "desk-01",
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
    expect(db.deviceCode.update).toHaveBeenCalledWith({
      where: { id: "device-code-row-1" },
      data: { lastPolledAt: now },
      select: { id: true },
    });
    expect(db.cliDevice.findUnique).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("returns a conflict before creating a credential when the approved user already has the slug", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      id: "device-code-row-1",
      userId: "user-1",
      expiresAt: new Date("2026-08-01T00:10:00.000Z"),
      status: "approved",
      lastPolledAt: null,
      pollingInterval: 5,
    });
    db.cliDevice.findUnique.mockResolvedValue({ id: "existing-cli-device" });
    const client = createRouterClient(cliCredentialsRouter, { context: buildContext(null) });

    await expect(
      client.exchangeDeviceCode({
        deviceCode: "approved-device-code",
        name: "Desk CLI",
        cliSlug: "desk-01",
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("CONFLICT");
      return true;
    });
    expect(db.cliDevice.findUnique).toHaveBeenCalledWith({
      where: { userId_slug: { userId: "user-1", slug: "desk-01" } },
      select: { id: true },
    });
    expect(db.cliDevice.create).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
    expect(db.deviceCode.delete).not.toHaveBeenCalled();
  });

  it("uses the approved device-code user for slug availability instead of the session user", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      id: "device-code-row-1",
      userId: "approved-user",
      expiresAt: new Date("2026-08-01T00:10:00.000Z"),
      status: "approved",
      lastPolledAt: null,
      pollingInterval: 5,
    });
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
        name: "Desk CLI",
        cliSlug: "desk-01",
      }),
    ).resolves.toMatchObject({ credentialId: "credential-1", userId: "approved-user" });
    expect(db.cliDevice.findUnique).toHaveBeenCalledWith({
      where: { userId_slug: { userId: "approved-user", slug: "desk-01" } },
      select: { id: true },
    });
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
});

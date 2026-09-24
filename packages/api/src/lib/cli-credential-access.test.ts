import { ORPCError } from "@orpc/server";
import {
  credentialLookupPrefix,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
} from "@ws-model-proxy/db/forwarder-security";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret" },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const {
  authenticateCliWebsocketSecret,
  digestCliDeviceCredentialSecret,
  digestCliTokenSecret,
  checkCliCredentialForDevice,
  deleteCliDeviceAndCredentials,
  mintCliDeviceCredentialFromApprovedDeviceCode,
} = await import("./cli-credential-access");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  cliToken: {
    findUnique: MockInstance;
    findMany: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  cliDevice: {
    upsert: MockInstance;
    updateMany: MockInstance;
    findUnique: MockInstance;
    delete: MockInstance;
  };
  cliDeviceCredential: {
    findUnique: MockInstance;
    findMany: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    create: MockInstance;
  };
  deviceCode: {
    findUnique: MockInstance;
    update: MockInstance;
    deleteMany: MockInstance;
  };
};

const now = new Date("2026-01-01T00:00:00.000Z");

describe("cliCredentialAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.deviceCode.deleteMany.mockResolvedValue({ count: 1 });
    db.cliDevice.upsert.mockResolvedValue({ id: "cli-device-id" });
    db.cliDeviceCredential.create.mockResolvedValue({ id: "credential-id", userId: "user-id" });
    db.cliDeviceCredential.findMany.mockResolvedValue([]);
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 0 });
  });

  it("verifies active wsmp_cli_ tokens with the CLI-token HMAC context", async () => {
    const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.cliToken}${"a".repeat(43)}`;
    const lookupPrefix = credentialLookupPrefix(rawSecret);
    db.cliToken.findUnique.mockResolvedValue({
      id: "token-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      lookupPrefix,
      secretDigest: digestCliTokenSecret(rawSecret),
      revokedAt: null,
      expiresAt: null,
    });
    db.cliToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toEqual({
      kind: "cliToken",
      id: "token-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      lookupPrefix,
    });
    expect(db.cliToken.updateMany).toHaveBeenCalledWith({
      where: { id: "token-id" },
      data: { lastUsedAt: now },
    });
  });

  it("verifies active wsmp_device_ credentials with the device HMAC context", async () => {
    const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.deviceCredential}${"b".repeat(43)}`;
    const lookupPrefix = credentialLookupPrefix(rawSecret);
    db.cliDeviceCredential.findUnique.mockResolvedValue({
      id: "credential-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      lookupPrefix,
      secretDigest: digestCliDeviceCredentialSecret(rawSecret),
      revokedAt: null,
    });
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 1 });

    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toEqual({
      kind: "deviceCredential",
      id: "credential-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      lookupPrefix,
    });
  });

  it("refuses a device credential deleted (with its device) since it was read", async () => {
    const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.deviceCredential}${"d".repeat(43)}`;
    db.cliDeviceCredential.findUnique.mockResolvedValue({
      id: "credential-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      lookupPrefix: credentialLookupPrefix(rawSecret),
      secretDigest: digestCliDeviceCredentialSecret(rawSecret),
      revokedAt: null,
    });
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 0 });

    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toBeNull();
  });

  it("rejects revoked, expired, and wrong-purpose credentials", async () => {
    const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.cliToken}${"c".repeat(43)}`;
    db.cliToken.findUnique.mockResolvedValue({
      id: "token-id",
      userId: "user-id",
      cliDeviceId: null,
      lookupPrefix: credentialLookupPrefix(rawSecret),
      secretDigest: hmacDigestForForwarderPurpose({
        purpose: "deviceCredential",
        value: rawSecret,
      }),
      revokedAt: null,
      expiresAt: null,
    });
    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toBeNull();

    db.cliToken.findUnique.mockResolvedValue({
      id: "token-id",
      userId: "user-id",
      cliDeviceId: null,
      lookupPrefix: credentialLookupPrefix(rawSecret),
      secretDigest: digestCliTokenSecret(rawSecret),
      revokedAt: now,
      expiresAt: null,
    });
    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toBeNull();

    db.cliToken.findUnique.mockResolvedValue({
      id: "token-id",
      userId: "user-id",
      cliDeviceId: null,
      lookupPrefix: credentialLookupPrefix(rawSecret),
      secretDigest: digestCliTokenSecret(rawSecret),
      revokedAt: null,
      expiresAt: now,
    });
    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toBeNull();
  });

  it("registers a device credential only as the device it was minted for", async () => {
    const check = () =>
      checkCliCredentialForDevice(
        prisma,
        { kind: "deviceCredential", id: "credential-id" },
        "cli-device-id",
        now,
      );
    db.cliDeviceCredential.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      cliDeviceId: "cli-device-id",
    });
    await expect(check()).resolves.toBe("ok");
    db.cliDeviceCredential.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      cliDeviceId: "another-device-id",
    });
    await expect(check()).resolves.toBe("otherDevice");
    db.cliDeviceCredential.findUnique.mockResolvedValueOnce({
      revokedAt: now,
      cliDeviceId: "cli-device-id",
    });
    await expect(check()).resolves.toBe("revoked");
    // Deleted with its device.
    db.cliDeviceCredential.findUnique.mockResolvedValueOnce(null);
    await expect(check()).resolves.toBe("revoked");
    // A device credential is never (re)bound.
    expect(db.cliDeviceCredential.update).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.updateMany).not.toHaveBeenCalled();
  });

  it("binds an unbound CLI token on its first hello with a conditional write", async () => {
    const check = () =>
      checkCliCredentialForDevice(
        prisma,
        { kind: "cliToken", id: "token-id" },
        "cli-device-id",
        now,
      );
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      expiresAt: null,
      cliDeviceId: null,
    });
    db.cliToken.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(check()).resolves.toBe("ok");
    expect(db.cliToken.updateMany).toHaveBeenCalledWith({
      where: { id: "token-id", cliDeviceId: null, revokedAt: null },
      data: { cliDeviceId: "cli-device-id" },
    });

    // Another hello bound it to a different device between the read and the write.
    db.cliToken.findUnique
      .mockResolvedValueOnce({ revokedAt: null, expiresAt: null, cliDeviceId: null })
      .mockResolvedValueOnce({ revokedAt: null, cliDeviceId: "another-device-id" });
    db.cliToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(check()).resolves.toBe("otherDevice");
  });

  it("refuses bound-elsewhere, revoked, and expired CLI tokens", async () => {
    const check = () =>
      checkCliCredentialForDevice(
        prisma,
        { kind: "cliToken", id: "token-id" },
        "cli-device-id",
        now,
      );
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      expiresAt: null,
      cliDeviceId: "cli-device-id",
    });
    await expect(check()).resolves.toBe("ok");
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      expiresAt: null,
      cliDeviceId: "another-device-id",
    });
    await expect(check()).resolves.toBe("otherDevice");
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: now,
      expiresAt: null,
      cliDeviceId: "cli-device-id",
    });
    await expect(check()).resolves.toBe("revoked");
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      expiresAt: now,
      cliDeviceId: "cli-device-id",
    });
    await expect(check()).resolves.toBe("revoked");
    expect(db.cliToken.updateMany).not.toHaveBeenCalled();
  });
});

function approvedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "device-code-row-id",
    userId: "user-id",
    expiresAt: new Date("2026-01-01T00:10:00.000Z"),
    status: "approved",
    lastPolledAt: null,
    // The value Better Auth 1.7 stores for `interval: "5s"`: milliseconds.
    pollingInterval: 5000,
    scope: "cli-slug:desk-01",
    ...overrides,
  };
}

describe("mintCliDeviceCredentialFromApprovedDeviceCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.deviceCode.deleteMany.mockResolvedValue({ count: 1 });
    db.cliDevice.upsert.mockResolvedValue({ id: "cli-device-id" });
    db.cliDeviceCredential.create.mockResolvedValue({ id: "credential-id", userId: "user-id" });
    db.cliDeviceCredential.findMany.mockResolvedValue([]);
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 0 });
  });

  function mint(cliSlug = "desk-01") {
    return mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: "short-lived-device-code",
      cliSlug,
      now,
    });
  }

  function expectNothingMinted() {
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.cliDevice.upsert).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
  }

  it("does not mint a durable device credential from an expired device code", async () => {
    db.deviceCode.findUnique.mockResolvedValue(
      approvedRow({ expiresAt: new Date("2025-12-31T23:59:59.000Z") }),
    );

    await expect(mint()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
    expectNothingMinted();
    expect(db.deviceCode.deleteMany).toHaveBeenCalledWith({
      where: { id: "device-code-row-id" },
    });
  });

  it("creates the device on a first login and revokes nothing", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow());

    const result = await mint();

    expect(result).toMatchObject({
      credentialId: "credential-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      revoked: { kind: "deviceCredential", ids: [] },
    });
    expect(result.secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.deviceCredential)).toBe(true);
    expect(db.cliDevice.upsert).toHaveBeenCalledWith({
      where: { userId_slug: { userId: "user-id", slug: "desk-01" } },
      create: { userId: "user-id", slug: "desk-01" },
      update: { updatedAt: now },
      select: { id: true },
    });
    expect(db.cliDeviceCredential.create).toHaveBeenCalledWith({
      data: {
        userId: "user-id",
        cliDeviceId: "cli-device-id",
        lookupPrefix: expect.stringMatching(/^wsmp_device_/),
        secretDigest: expect.any(String),
      },
      select: { id: true, userId: true },
    });
    expect(db.cliDeviceCredential.updateMany).not.toHaveBeenCalled();
  });

  it("reattaches a re-login to the existing device and revokes its other credentials", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow());
    db.cliDevice.upsert.mockResolvedValue({ id: "existing-device-id" });
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 2 });

    const result = await mint();

    // The device keeps its id; the upsert's update touches nothing user-owned.
    expect(result.cliDeviceId).toBe("existing-device-id");
    expect(db.cliDevice.upsert.mock.calls[0]?.[0].update).toEqual({ updatedAt: now });
    expect(db.cliDeviceCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cliDeviceId: "existing-device-id" }),
      }),
    );
    expect(db.cliDeviceCredential.findMany).toHaveBeenCalledWith({
      where: { cliDeviceId: "existing-device-id", revokedAt: null, id: { not: "credential-id" } },
      select: { id: true },
    });
    expect(db.cliDeviceCredential.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-1", "old-2"] }, revokedAt: null },
      data: { revokedAt: now },
    });
    expect(result.revoked).toEqual({ kind: "deviceCredential", ids: ["old-1", "old-2"] });
  });

  it("consumes the code conditionally, first, inside one transaction", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow());
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "old-1" }]);

    await mint();

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.deviceCode.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "device-code-row-id",
        status: "approved",
        userId: "user-id",
        expiresAt: { gt: now },
      },
    });
    const order = [
      db.deviceCode.deleteMany,
      db.cliDevice.upsert,
      db.cliDeviceCredential.create,
      db.cliDeviceCredential.updateMany,
    ].map((mock) => mock.mock.invocationCallOrder[0] ?? Number.NaN);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("mints nothing when a concurrent exchange consumed the code first", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow());
    db.deviceCode.deleteMany.mockResolvedValue({ count: 0 });

    await expect(mint()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("NOT_FOUND");
      expect(error.data).toBeUndefined();
      return true;
    });
    expect(db.cliDevice.upsert).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
    expect(db.cliDeviceCredential.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an exchange for a slug other than the approved one", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow({ scope: "cli-slug:victim-box" }));

    await expect(mint("desk-01")).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      // Not a device-flow state: the CLI stops.
      expect(error.data).toBeUndefined();
      return true;
    });
    expectNothingMinted();
    expect(db.deviceCode.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a device code whose request named no CLI slug", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow({ scope: null }));

    await expect(mint()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.data).toBeUndefined();
      return true;
    });
    expectNothingMinted();
  });

  it("lets a concurrent first login reattach instead of failing (last approved login wins)", async () => {
    // On Postgres the upsert is one `INSERT … ON CONFLICT DO UPDATE`: the second
    // first-login of a new slug waits, then takes the update branch on the
    // device the first one created, and revokes that login's credential.
    db.deviceCode.findUnique.mockResolvedValue(approvedRow());
    db.cliDevice.upsert.mockResolvedValue({ id: "device-created-by-the-other-login" });
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "other-login-credential" }]);
    db.cliDeviceCredential.updateMany.mockResolvedValue({ count: 1 });

    const result = await mint();

    expect(result.cliDeviceId).toBe("device-created-by-the-other-login");
    expect(result.revoked).toEqual({ kind: "deviceCredential", ids: ["other-login-credential"] });
  });

  it("does not map an unexpected unique violation to a retryable conflict", async () => {
    db.deviceCode.findUnique.mockResolvedValue(approvedRow());
    const unique = Object.assign(new Error("unique"), { code: "P2002" });
    db.$transaction.mockRejectedValue(unique);

    await expect(mint()).rejects.toBe(unique);
  });
});

describe("device-flow polling against the stored interval (milliseconds)", () => {
  const pending = (lastPolledAt: Date | null) =>
    approvedRow({ status: "pending", userId: null, lastPolledAt, pollingInterval: 5000 });

  beforeEach(() => {
    vi.clearAllMocks();
    db.deviceCode.update.mockResolvedValue({ id: "device-code-row-id" });
  });

  async function pollError(lastPolledAt: Date | null) {
    db.deviceCode.findUnique.mockResolvedValue(pending(lastPolledAt));
    return mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: "short-lived-device-code",
      cliSlug: "desk-01",
      now,
    }).catch((error: unknown) => error);
  }

  it("answers the first poll with authorization_pending and records it", async () => {
    const error = await pollError(null);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).data).toEqual({
      deviceFlowError: "authorization_pending",
    });
    expect(db.deviceCode.update).toHaveBeenCalledWith({
      where: { id: "device-code-row-id" },
      data: { lastPolledAt: now },
      select: { id: true },
    });
  });

  it("answers a poll 1s after the last one with slow_down and does not record it", async () => {
    const error = await pollError(new Date(now.getTime() - 1_000));
    expect((error as ORPCError<string, unknown>).data).toEqual({ deviceFlowError: "slow_down" });
    expect(db.deviceCode.update).not.toHaveBeenCalled();
  });

  it.each([5_000, 6_000, 60_000])(
    "answers a poll %ims after the last one with authorization_pending",
    async (elapsedMs) => {
      const error = await pollError(new Date(now.getTime() - elapsedMs));
      expect((error as ORPCError<string, unknown>).data).toEqual({
        deviceFlowError: "authorization_pending",
      });
      expect(db.deviceCode.update).toHaveBeenCalledTimes(1);
    },
  );

  it("falls back to 5s when the row has no interval", async () => {
    db.deviceCode.findUnique.mockResolvedValue(
      approvedRow({
        status: "pending",
        userId: null,
        lastPolledAt: new Date(now.getTime() - 4_000),
        pollingInterval: null,
      }),
    );
    const error = await mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: "short-lived-device-code",
      cliSlug: "desk-01",
      now,
    }).catch((caught: unknown) => caught);
    expect((error as ORPCError<string, unknown>).data).toEqual({ deviceFlowError: "slow_down" });
  });
});

describe("deleteCliDeviceAndCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.cliDevice.updateMany.mockResolvedValue({ count: 1 });
    db.cliDevice.findUnique.mockResolvedValue({ lastHeartbeatAt: null });
    db.cliDevice.delete.mockResolvedValue({ id: "cli-device-id" });
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "device-credential-1" }]);
    db.cliToken.findMany.mockResolvedValue([{ id: "cli-token-1" }]);
    db.cliToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it("locks the device, revokes its CLI tokens, deletes it, and reports every credential", async () => {
    const result = await deleteCliDeviceAndCredentials({
      cliDeviceId: "cli-device-id",
      userId: "user-id",
      now,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.cliDevice.updateMany).toHaveBeenCalledWith({
      where: { id: "cli-device-id", userId: "user-id" },
      data: { updatedAt: now },
    });
    expect(db.cliDeviceCredential.findMany).toHaveBeenCalledWith({
      where: { cliDeviceId: "cli-device-id", revokedAt: null },
      select: { id: true },
    });
    expect(db.cliToken.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cli-token-1"] }, revokedAt: null },
      data: { revokedAt: now },
    });
    expect(db.cliDevice.delete).toHaveBeenCalledWith({
      where: { id: "cli-device-id" },
      select: { id: true },
    });
    const order = [
      db.cliDevice.updateMany,
      db.cliDeviceCredential.findMany,
      db.cliToken.updateMany,
      db.cliDevice.delete,
    ].map((mock) => mock.mock.invocationCallOrder[0] ?? Number.NaN);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result.revoked).toEqual([
      { kind: "deviceCredential", ids: ["device-credential-1"] },
      { kind: "cliToken", ids: ["cli-token-1"] },
    ]);
  });

  it("is NOT_FOUND for another user's (or a missing) device and deletes nothing", async () => {
    db.cliDevice.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      deleteCliDeviceAndCredentials({ cliDeviceId: "cli-device-id", userId: "intruder", now }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.cliToken.updateMany).not.toHaveBeenCalled();
    expect(db.cliDevice.delete).not.toHaveBeenCalled();
  });

  it("refuses to prune a device that heartbeated since staleBefore", async () => {
    db.cliDevice.findUnique.mockResolvedValue({ lastHeartbeatAt: now });

    await expect(
      deleteCliDeviceAndCredentials({
        cliDeviceId: "cli-device-id",
        userId: "user-id",
        staleBefore: new Date(now.getTime() - 60_000),
        now,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.cliToken.updateMany).not.toHaveBeenCalled();
    expect(db.cliDevice.delete).not.toHaveBeenCalled();
  });
});

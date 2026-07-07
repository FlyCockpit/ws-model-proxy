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
  mintCliDeviceCredentialFromApprovedDeviceCode,
} = await import("./cli-credential-access");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  cliToken: {
    findUnique: MockInstance;
    update: MockInstance;
  };
  cliDevice: {
    findUnique: MockInstance;
    create: MockInstance;
  };
  cliDeviceCredential: {
    findUnique: MockInstance;
    update: MockInstance;
    create: MockInstance;
  };
  deviceCode: {
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
};

const now = new Date("2026-01-01T00:00:00.000Z");

describe("cliCredentialAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.cliDevice.findUnique.mockResolvedValue(null);
    db.cliDevice.create.mockResolvedValue({ id: "cli-device-id" });
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
    db.cliToken.update.mockResolvedValue({ id: "token-id" });

    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toEqual({
      kind: "cliToken",
      id: "token-id",
      userId: "user-id",
      cliDeviceId: "cli-device-id",
      lookupPrefix,
    });
    expect(db.cliToken.update).toHaveBeenCalledWith({
      where: { id: "token-id" },
      data: { lastUsedAt: now },
      select: { id: true },
    });
  });

  it("verifies active wsmp_device_ credentials with the device HMAC context", async () => {
    const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.deviceCredential}${"b".repeat(43)}`;
    const lookupPrefix = credentialLookupPrefix(rawSecret);
    db.cliDeviceCredential.findUnique.mockResolvedValue({
      id: "credential-id",
      userId: "user-id",
      cliDeviceId: null,
      lookupPrefix,
      secretDigest: digestCliDeviceCredentialSecret(rawSecret),
      revokedAt: null,
    });
    db.cliDeviceCredential.update.mockResolvedValue({ id: "credential-id" });

    await expect(authenticateCliWebsocketSecret(rawSecret, now)).resolves.toEqual({
      kind: "deviceCredential",
      id: "credential-id",
      userId: "user-id",
      cliDeviceId: null,
      lookupPrefix,
    });
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

  it("does not mint a durable device credential from an expired device code", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      id: "device-code-row-id",
      userId: "user-id",
      expiresAt: new Date("2025-12-31T23:59:59.000Z"),
      status: "approved",
      lastPolledAt: null,
      pollingInterval: 5,
    });

    await expect(
      mintCliDeviceCredentialFromApprovedDeviceCode({
        deviceCode: "short-lived-device-code",
        name: "Laptop",
        cliSlug: "desk-01",
        now,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
    expect(db.cliDeviceCredential.create).not.toHaveBeenCalled();
    expect(db.deviceCode.delete).toHaveBeenCalledWith({ where: { id: "device-code-row-id" } });
  });

  it("mints a durable device credential after approval and deletes the short-lived code", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      id: "device-code-row-id",
      userId: "user-id",
      expiresAt: new Date("2026-01-01T00:10:00.000Z"),
      status: "approved",
      lastPolledAt: null,
      pollingInterval: 5,
    });
    db.cliDeviceCredential.create.mockResolvedValue({
      id: "credential-id",
      userId: "user-id",
    });

    const result = await mintCliDeviceCredentialFromApprovedDeviceCode({
      deviceCode: "short-lived-device-code",
      name: "Laptop",
      cliSlug: "desk-01",
      now,
    });

    expect(result.credentialId).toBe("credential-id");
    expect(result.userId).toBe("user-id");
    expect(result.secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.deviceCredential)).toBe(true);
    expect(db.cliDevice.findUnique).toHaveBeenCalledWith({
      where: { userId_slug: { userId: "user-id", slug: "desk-01" } },
      select: { id: true },
    });
    expect(db.cliDevice.create).toHaveBeenCalledWith({
      data: {
        userId: "user-id",
        slug: "desk-01",
        label: "Laptop",
      },
      select: { id: true },
    });
    expect(db.cliDeviceCredential.create).toHaveBeenCalledWith({
      data: {
        userId: "user-id",
        cliDeviceId: "cli-device-id",
        name: "Laptop",
        lookupPrefix: expect.stringMatching(/^wsmp_device_/),
        secretDigest: expect.any(String),
      },
      select: { id: true, userId: true },
    });
    expect(db.deviceCode.delete).toHaveBeenCalledWith({ where: { id: "device-code-row-id" } });
  });
});

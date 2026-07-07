import { ORPCError } from "@orpc/server";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  generateProductCredentialSecret,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";

export type CliCredentialKind = "cliToken" | "deviceCredential";

export type CliWebsocketIdentity = {
  kind: CliCredentialKind;
  id: string;
  userId: string;
  cliDeviceId: string | null;
  lookupPrefix: string;
};

type CliCredentialRow = {
  id: string;
  userId: string;
  cliDeviceId: string | null;
  lookupPrefix: string;
  secretDigest: string;
  revokedAt: Date | null;
  expiresAt?: Date | null;
};

export function digestCliTokenSecret(rawSecret: string): string {
  return hmacDigestForForwarderPurpose({ purpose: "cliToken", value: rawSecret });
}

export function digestCliDeviceCredentialSecret(rawSecret: string): string {
  return hmacDigestForForwarderPurpose({ purpose: "deviceCredential", value: rawSecret });
}

function isExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  return Boolean(expiresAt && expiresAt <= now);
}

async function authenticateCliToken(
  rawSecret: string,
  now: Date,
): Promise<CliWebsocketIdentity | null> {
  const lookupPrefix = credentialLookupPrefix(rawSecret);
  const token = (await prisma.cliToken.findUnique({
    where: { lookupPrefix },
    select: {
      id: true,
      userId: true,
      cliDeviceId: true,
      lookupPrefix: true,
      secretDigest: true,
      revokedAt: true,
      expiresAt: true,
    },
  })) as CliCredentialRow | null;

  if (!token || token.revokedAt || isExpired(token.expiresAt, now)) return null;
  if (
    !verifyForwarderHmacDigest({
      purpose: "cliToken",
      value: rawSecret,
      digest: token.secretDigest,
    })
  ) {
    return null;
  }

  await prisma.cliToken.update({
    where: { id: token.id },
    data: { lastUsedAt: now },
    select: { id: true },
  });

  return {
    kind: "cliToken",
    id: token.id,
    userId: token.userId,
    cliDeviceId: token.cliDeviceId,
    lookupPrefix: token.lookupPrefix,
  };
}

async function authenticateDeviceCredential(
  rawSecret: string,
  now: Date,
): Promise<CliWebsocketIdentity | null> {
  const lookupPrefix = credentialLookupPrefix(rawSecret);
  const credential = (await prisma.cliDeviceCredential.findUnique({
    where: { lookupPrefix },
    select: {
      id: true,
      userId: true,
      cliDeviceId: true,
      lookupPrefix: true,
      secretDigest: true,
      revokedAt: true,
    },
  })) as CliCredentialRow | null;

  if (!credential || credential.revokedAt) return null;
  if (
    !verifyForwarderHmacDigest({
      purpose: "deviceCredential",
      value: rawSecret,
      digest: credential.secretDigest,
    })
  ) {
    return null;
  }

  await prisma.cliDeviceCredential.update({
    where: { id: credential.id },
    data: { lastUsedAt: now },
    select: { id: true },
  });

  return {
    kind: "deviceCredential",
    id: credential.id,
    userId: credential.userId,
    cliDeviceId: credential.cliDeviceId,
    lookupPrefix: credential.lookupPrefix,
  };
}

export async function authenticateCliWebsocketSecret(
  rawSecret: string,
  now = new Date(),
): Promise<CliWebsocketIdentity | null> {
  if (rawSecret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.cliToken)) {
    return authenticateCliToken(rawSecret, now);
  }
  if (rawSecret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.deviceCredential)) {
    return authenticateDeviceCredential(rawSecret, now);
  }
  return null;
}

export async function mintCliDeviceCredentialFromApprovedDeviceCode({
  deviceCode,
  name,
  cliSlug,
  now = new Date(),
}: {
  deviceCode: string;
  name: string;
  cliSlug: string;
  now?: Date;
}): Promise<{ credentialId: string; userId: string; secret: string }> {
  const slugValidation = validateForwarderSlug(cliSlug);
  if (!slugValidation.ok) {
    throw new ORPCError("BAD_REQUEST", {
      message: "CLI slug must use lowercase letters, numbers, and hyphens only.",
    });
  }
  const row = await prisma.deviceCode.findUnique({
    where: { deviceCode },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      status: true,
      lastPolledAt: true,
      pollingInterval: true,
    },
  });

  if (!row) throw new ORPCError("NOT_FOUND", { message: "Device code not found." });
  if (row.expiresAt <= now) {
    await prisma.deviceCode.delete({ where: { id: row.id } });
    throw new ORPCError("BAD_REQUEST", { message: "Device code expired." });
  }
  if (row.status === "denied") {
    await prisma.deviceCode.delete({ where: { id: row.id } });
    throw new ORPCError("FORBIDDEN", { message: "Device authorization denied." });
  }
  if (row.status !== "approved" || !row.userId) {
    const intervalSeconds = row.pollingInterval ?? 5;
    if (row.lastPolledAt && row.lastPolledAt.getTime() + intervalSeconds * 1000 > now.getTime()) {
      throw new ORPCError("BAD_REQUEST", { message: "Device authorization polling too fast." });
    }
    await prisma.deviceCode.update({
      where: { id: row.id },
      data: { lastPolledAt: now },
      select: { id: true },
    });
    throw new ORPCError("BAD_REQUEST", { message: "Device authorization is pending." });
  }

  const existingDevice = await prisma.cliDevice.findUnique({
    where: { userId_slug: { userId: row.userId, slug: cliSlug } },
    select: { id: true },
  });
  if (existingDevice) {
    throw new ORPCError("CONFLICT", {
      message: `CLI slug \`${cliSlug}\` is already in use for your account; choose a different slug.`,
    });
  }

  const cliDevice = await prisma.cliDevice.create({
    data: {
      userId: row.userId,
      slug: cliSlug,
      label: name,
    },
    select: { id: true },
  });
  const secret = generateProductCredentialSecret("deviceCredential");
  const created = await prisma.cliDeviceCredential.create({
    data: {
      userId: row.userId,
      cliDeviceId: cliDevice.id,
      name,
      lookupPrefix: credentialLookupPrefix(secret),
      secretDigest: digestCliDeviceCredentialSecret(secret),
    },
    select: { id: true, userId: true },
  });
  await prisma.deviceCode.delete({ where: { id: row.id } });

  return { credentialId: created.id, userId: created.userId, secret };
}

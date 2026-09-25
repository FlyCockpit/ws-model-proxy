import { ORPCError } from "@orpc/server";
import { cliSlugFromDeviceLoginScope } from "@ws-model-proxy/config/cli-device-login";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  isRetryableCapacityTransactionError,
  lockCapacityGraphForDelete,
  runCapacityOrderedTransaction,
} from "@ws-model-proxy/db/capacity-lock-order";
import {
  credentialLookupPrefix,
  generateProductCredentialSecret,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { Context } from "../context";
import { deletionConflict } from "./deletion-conflict";
import {
  drainBeforeParentDelete,
  throwParentDeletionPendingConflict,
} from "./serializable-transaction";

export type CliCredentialKind = "cliToken" | "deviceCredential";

type CliWebsocketIdentityBase = {
  id: string;
  userId: string;
  lookupPrefix: string;
};

/**
 * An authenticated relay socket's credential. A device credential is always
 * bound to the device it was minted for. A CLI token may be unbound until its
 * first hello binds it (at auth time; registration re-reads the row).
 */
export type CliWebsocketIdentity =
  | (CliWebsocketIdentityBase & { kind: "deviceCredential"; cliDeviceId: string })
  | (CliWebsocketIdentityBase & { kind: "cliToken"; cliDeviceId: string | null });

const cliTokenCredentialSelect = {
  id: true,
  userId: true,
  cliDeviceId: true,
  lookupPrefix: true,
  secretDigest: true,
  revokedAt: true,
  expiresAt: true,
} satisfies Prisma.CliTokenSelect;

const cliDeviceCredentialSelect = {
  id: true,
  userId: true,
  cliDeviceId: true,
  lookupPrefix: true,
  secretDigest: true,
  revokedAt: true,
} satisfies Prisma.CliDeviceCredentialSelect;

type CliTokenCredentialRow = Prisma.CliTokenGetPayload<{
  select: typeof cliTokenCredentialSelect;
}>;
type CliDeviceCredentialRow = Prisma.CliDeviceCredentialGetPayload<{
  select: typeof cliDeviceCredentialSelect;
}>;

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
  const token: CliTokenCredentialRow | null = await prisma.cliToken.findUnique({
    where: { lookupPrefix },
    select: cliTokenCredentialSelect,
  });

  if (!token || token.revokedAt || isExpired(token.expiresAt, now)) return null;
  const owner = await prisma.user.findUnique({
    where: { id: token.userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
  if (!owner || userCredentialAccessBlocked(owner, new Date())) return null;
  if (
    !verifyForwarderHmacDigest({
      purpose: "cliToken",
      value: rawSecret,
      digest: token.secretDigest,
    })
  ) {
    return null;
  }

  // `updateMany` so a token deleted since the read (its owner removed) is a
  // refused login, not an error.
  const touched = await prisma.cliToken.updateMany({
    where: { id: token.id },
    data: { lastUsedAt: now },
  });
  if (touched.count !== 1) return null;

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
  const credential: CliDeviceCredentialRow | null = await prisma.cliDeviceCredential.findUnique({
    where: { lookupPrefix },
    select: cliDeviceCredentialSelect,
  });

  if (!credential || credential.revokedAt) return null;
  const owner = await prisma.user.findUnique({
    where: { id: credential.userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
  if (!owner || userCredentialAccessBlocked(owner, new Date())) return null;
  if (
    !verifyForwarderHmacDigest({
      purpose: "deviceCredential",
      value: rawSecret,
      digest: credential.secretDigest,
    })
  ) {
    return null;
  }

  // `updateMany` so a credential deleted since the read (its device was
  // deleted) is a refused login, not an error.
  const touched = await prisma.cliDeviceCredential.updateMany({
    where: { id: credential.id },
    data: { lastUsedAt: now },
  });
  if (touched.count !== 1) return null;

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

/**
 * Outcome of checking a relay identity's credential against the device a hello
 * names: `ok`, `revoked` (revoked, expired, or deleted with its device), or
 * `otherDevice` (bound to a different device).
 */
export type CliCredentialDeviceCheck = "ok" | "revoked" | "otherDevice";

/**
 * Registration's credential check, run inside its transaction right after the
 * device upsert (which holds the device row lock a re-login's revoking
 * transaction and a device delete also take), so it reads the committed state
 * of both. It re-reads the credential row rather than trusting the identity
 * captured at websocket auth:
 *
 * - A device credential authenticates only as the device it was minted for
 *   (`cliDeviceId` is required and never rewritten).
 * - A CLI token is bound on its first hello: a conditional write claims an
 *   unbound token, so two first hellos naming different devices cannot both
 *   bind it. Once bound, it authenticates only as that device.
 */
export async function checkCliCredentialForDevice(
  db: Pick<Prisma.TransactionClient, "cliToken" | "cliDeviceCredential">,
  identity: Pick<CliWebsocketIdentity, "kind" | "id">,
  cliDeviceId: string,
  now: Date,
): Promise<CliCredentialDeviceCheck> {
  if (identity.kind === "deviceCredential") {
    const credential = await db.cliDeviceCredential.findUnique({
      where: { id: identity.id },
      select: { revokedAt: true, cliDeviceId: true },
    });
    if (!credential || credential.revokedAt) return "revoked";
    return credential.cliDeviceId === cliDeviceId ? "ok" : "otherDevice";
  }

  const token = await db.cliToken.findUnique({
    where: { id: identity.id },
    select: { revokedAt: true, expiresAt: true, cliDeviceId: true },
  });
  if (!token || token.revokedAt || isExpired(token.expiresAt, now)) return "revoked";
  if (token.cliDeviceId !== null) {
    return token.cliDeviceId === cliDeviceId ? "ok" : "otherDevice";
  }
  const claimed = await db.cliToken.updateMany({
    where: { id: identity.id, cliDeviceId: null, revokedAt: null },
    data: { cliDeviceId },
  });
  if (claimed.count === 1) return "ok";
  // Another hello bound (or a revoke hit) the token since the read above.
  const current = await db.cliToken.findUnique({
    where: { id: identity.id },
    select: { revokedAt: true, cliDeviceId: true },
  });
  if (!current || current.revokedAt) return "revoked";
  return current.cliDeviceId === cliDeviceId ? "ok" : "otherDevice";
}

/**
 * Device-flow states the polling CLI must tell apart (RFC 8628 §3.5 names).
 * Sent as `data.deviceFlowError` on the error so the CLI classifies by this
 * field, never by message text (a message can echo the user's slug). Every
 * other error (bad slug, unknown or already used code) has no such field and
 * ends the login.
 */
export type DeviceFlowError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token";

function deviceFlowErrorData(deviceFlowError: DeviceFlowError): {
  deviceFlowError: DeviceFlowError;
} {
  return { deviceFlowError };
}

/**
 * `DeviceCode.pollingInterval` is in MILLISECONDS: Better Auth writes
 * `ms(opts.interval)` (5000 for the configured "5s") and compares it against
 * elapsed milliseconds in its own redeem path, while it tells the client the
 * interval in seconds. This fallback only applies to a row without a value.
 */
const DEFAULT_DEVICE_POLLING_INTERVAL_MS = 5_000;

/** Credentials revoked (or deleted) by a write, for closing their live relay sessions. */
export type RevokedCliCredentials = { kind: CliCredentialKind; ids: string[] };

/**
 * Closes live relay sessions of credentials a write just revoked or deleted.
 * Runs after that write committed; a failure here must not undo or hide the
 * write (a re-login's new secret is already minted), so it is logged, not
 * thrown. Registration re-checks the credential on every hello and inventory
 * update, and websocket auth refuses it on reconnect.
 */
export async function closeRevokedCliCredentialSessions(
  services: Context["services"],
  revoked: RevokedCliCredentials,
): Promise<void> {
  if (revoked.ids.length === 0) return;
  try {
    await services?.onCliCredentialsRevoked?.(revoked);
  } catch (error) {
    console.error(
      "[cli-credentials] closing revoked relay sessions failed",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  }
}

/**
 * Deletes a user's CLI device so that nothing can act as it afterwards. One
 * transaction:
 *
 * 1. Lock the device row (owner-scoped write; NOT_FOUND otherwise). Relay
 *    registration and re-login mints take the same lock, so a hello or login
 *    for this device either committed before (and is seen below) or runs
 *    after the delete (and finds no device: a device credential is gone, a
 *    CLI token bound here is revoked).
 * 2. With `staleBefore`, refuse (CONFLICT) a device that heartbeated since.
 * 3. Revoke every CLI token bound to the device. Tokens are user-managed rows,
 *    so they stay listed (revoked) with their device link cleared by the
 *    foreign key; an unbound token is not this device's and is untouched.
 * 4. Delete the device. Its device credentials cascade away with it
 *    (`CliDeviceCredential.cliDeviceId` is required, `onDelete: Cascade`).
 *
 * Returns the credentials whose live relay sessions the caller closes after
 * the commit (`closeRevokedCliCredentialSessions`).
 */
export async function deleteCliDeviceAndCredentials({
  cliDeviceId,
  userId,
  staleBefore,
  now = new Date(),
}: {
  cliDeviceId: string;
  userId: string;
  staleBefore?: Date;
  now?: Date;
}): Promise<{ revoked: RevokedCliCredentials[] }> {
  // Read-only checks first, so a refused delete drains nothing; the ordered
  // transaction repeats them under the device lock.
  const precheck = await prisma.cliDevice.findFirst({
    where: { id: cliDeviceId, userId },
    select: { lastHeartbeatAt: true },
  });
  if (!precheck) throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
  if (staleBefore && precheck.lastHeartbeatAt && precheck.lastHeartbeatAt >= staleBefore) {
    throw deletionConflict("not_stale", "CLI device is not stale.");
  }
  // The request history the cascade deletes or detaches (relay requests,
  // terminal admission history, stickiness records) is drained in short
  // batches first (DL1-TXBOUND), so the ordered transaction holds the
  // capacity locks only for the device's graph.
  await drainBeforeParentDelete({ userId, cliDeviceIds: [cliDeviceId] });
  // READ COMMITTED with deadlock/lock-set retries: the device delete cascades
  // into endpoints, models, execution targets, pool members and admission
  // rows, so it takes the capacity locks in order first (step 4). A residual
  // above the final-phase bound found by the in-transaction recount rolls it
  // back and answers CONFLICT, like the pre-lock count.
  try {
    return await deleteCliDeviceInCapacityLockOrder({ cliDeviceId, userId, staleBefore, now });
  } catch (error) {
    throwParentDeletionPendingConflict(error);
    if (!isRetryableCapacityTransactionError(error)) throw error;
    throw deletionConflict(
      "delete_contended",
      "Configuration changed concurrently. Retry the request.",
    );
  }
}

async function deleteCliDeviceInCapacityLockOrder({
  cliDeviceId,
  userId,
  staleBefore,
  now,
}: {
  cliDeviceId: string;
  userId: string;
  staleBefore?: Date;
  now: Date;
}): Promise<{ revoked: RevokedCliCredentials[] }> {
  return runCapacityOrderedTransaction(prisma, async (tx) => {
    const locked = await tx.cliDevice.updateMany({
      where: { id: cliDeviceId, userId },
      data: { updatedAt: now },
    });
    if (locked.count !== 1) {
      throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
    }
    if (staleBefore) {
      const device = await tx.cliDevice.findUnique({
        where: { id: cliDeviceId },
        select: { lastHeartbeatAt: true },
      });
      if (device?.lastHeartbeatAt && device.lastHeartbeatAt >= staleBefore) {
        throw deletionConflict("not_stale", "CLI device is not stale.");
      }
    }

    const deviceCredentials = await tx.cliDeviceCredential.findMany({
      where: { cliDeviceId, revokedAt: null },
      select: { id: true },
    });
    const tokens = await tx.cliToken.findMany({
      where: { cliDeviceId, revokedAt: null },
      select: { id: true },
    });
    const tokenIds = tokens.map((token) => token.id);
    if (tokenIds.length > 0) {
      await tx.cliToken.updateMany({
        where: { id: { in: tokenIds }, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    // Capacity lock order: the device row above is L0; take every lock the
    // cascade can reach (pools, targets, capacities, live admission rows)
    // before the DELETE, so no admitter holding a capacity lock can be
    // waiting on a row this delete removes.
    await lockCapacityGraphForDelete(tx, { userId, cliDeviceIds: [cliDeviceId] });
    await tx.cliDevice.delete({ where: { id: cliDeviceId }, select: { id: true } });

    return {
      revoked: [
        { kind: "deviceCredential", ids: deviceCredentials.map((credential) => credential.id) },
        { kind: "cliToken", ids: tokenIds },
      ],
    };
  });
}

/**
 * Exchanges an approved device code for a device credential.
 *
 * The slug comes from the device authorization request itself (`scope =
 * "cli-slug:<slug>"`, validated by Better Auth's `onDeviceAuthRequest`), so the
 * approver saw exactly this slug; `cliSlug` from the exchange must equal it.
 *
 * Re-login reattaches: when the user already has a device with this slug, the
 * new credential joins that device (id, name, grants, pools, endpoints and
 * model ids are kept) and every other active credential of that device is
 * revoked. One transaction does all of it, in this order:
 *
 * 1. Consume the device code with a conditional delete (still approved, same
 *    user, unexpired). Exactly one row must go, so a code mints at most once even under
 *    concurrent exchanges (the loser blocks on the row lock, then deletes 0).
 * 2. Find or create the device. The upsert (a native `INSERT … ON CONFLICT
 *    DO UPDATE`) takes the device row lock, so two logins for one slug (two
 *    different codes) run one after the other, whether or not the device
 *    existed before: the later one reattaches to the device and revokes the
 *    earlier one's credential. Last approved login wins; the earlier CLI
 *    already holds a revoked secret and its relay auth fails until it logs in
 *    again.
 * 3. Mint the credential, then revoke the device's other active credentials.
 *
 * The caller closes live relay sessions of the returned revoked ids after the
 * commit (`ContextServices.onCliCredentialsRevoked`). Manually created
 * `CliToken`s bound to the device are a separate credential kind the user
 * manages in the dashboard; re-login leaves them alone.
 */
export async function mintCliDeviceCredentialFromApprovedDeviceCode({
  deviceCode,
  cliSlug,
  now = new Date(),
}: {
  deviceCode: string;
  cliSlug: string;
  now?: Date;
}): Promise<{
  credentialId: string;
  userId: string;
  cliDeviceId: string;
  secret: string;
  revoked: RevokedCliCredentials;
}> {
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
      scope: true,
    },
  });

  if (!row) throw new ORPCError("NOT_FOUND", { message: "Device code not found." });
  if (row.expiresAt <= now) {
    await prisma.deviceCode.deleteMany({ where: { id: row.id } });
    throw new ORPCError("BAD_REQUEST", {
      message: "Device code expired.",
      data: deviceFlowErrorData("expired_token"),
    });
  }
  if (row.status === "denied") {
    await prisma.deviceCode.deleteMany({ where: { id: row.id } });
    throw new ORPCError("FORBIDDEN", {
      message: "Device authorization denied.",
      data: deviceFlowErrorData("access_denied"),
    });
  }
  const boundSlug = cliSlugFromDeviceLoginScope(row.scope);
  if (boundSlug === null) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Device authorization does not name a CLI slug; upgrade wsmp and log in again.",
    });
  }
  if (boundSlug !== cliSlug) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Device authorization was requested for a different CLI slug.",
    });
  }
  if (row.status !== "approved" || !row.userId) {
    const intervalMs = row.pollingInterval ?? DEFAULT_DEVICE_POLLING_INTERVAL_MS;
    if (row.lastPolledAt && row.lastPolledAt.getTime() + intervalMs > now.getTime()) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Device authorization polling too fast.",
        data: deviceFlowErrorData("slow_down"),
      });
    }
    await prisma.deviceCode.update({
      where: { id: row.id },
      data: { lastPolledAt: now },
      select: { id: true },
    });
    throw new ORPCError("BAD_REQUEST", {
      message: "Device authorization is pending.",
      data: deviceFlowErrorData("authorization_pending"),
    });
  }

  const userId = row.userId;
  const secret = generateProductCredentialSecret("deviceCredential");
  return prisma.$transaction(async (tx) => {
    const consumed = await tx.deviceCode.deleteMany({
      where: { id: row.id, status: "approved", userId, expiresAt: { gt: now } },
    });
    if (consumed.count !== 1) {
      throw new ORPCError("NOT_FOUND", { message: "Device code not found." });
    }

    // Prisma runs this as one native `INSERT … ON CONFLICT ("userId", "slug")
    // DO UPDATE`, so a concurrent first login of the same new slug never fails
    // with a unique violation: it waits for the other transaction and then
    // takes the update branch on the row it created.
    const cliDevice = await tx.cliDevice.upsert({
      where: { userId_slug: { userId, slug: boundSlug } },
      create: { userId, slug: boundSlug },
      // Nothing user-owned changes; the write takes the device row lock.
      update: { updatedAt: now },
      select: { id: true },
    });
    const created = await tx.cliDeviceCredential.create({
      data: {
        userId,
        cliDeviceId: cliDevice.id,
        lookupPrefix: credentialLookupPrefix(secret),
        secretDigest: digestCliDeviceCredentialSecret(secret),
      },
      select: { id: true, userId: true },
    });
    const previous = await tx.cliDeviceCredential.findMany({
      where: { cliDeviceId: cliDevice.id, revokedAt: null, id: { not: created.id } },
      select: { id: true },
    });
    const revokedIds = previous.map((credential) => credential.id);
    if (revokedIds.length > 0) {
      await tx.cliDeviceCredential.updateMany({
        where: { id: { in: revokedIds }, revokedAt: null },
        data: { revokedAt: now },
      });
    }

    return {
      credentialId: created.id,
      userId: created.userId,
      cliDeviceId: cliDevice.id,
      secret,
      revoked: { kind: "deviceCredential" as const, ids: revokedIds },
    };
  });
}

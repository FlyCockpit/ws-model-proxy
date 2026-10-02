import { ORPCError } from "@orpc/server";
import {
  CLI_DEVICE_CODE_LIFETIME_MS,
  CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
  cliSlugFromDeviceLoginScope,
  type DeviceLoginRefusalReason,
} from "@ws-model-proxy/config/cli-device-login";
import { cliDeviceDisplayName } from "@ws-model-proxy/config/cli-device-name";
import { normalizeIdentityPublicKey } from "@ws-model-proxy/config/cli-identity-key";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  generateProductCredentialSecret,
} from "@ws-model-proxy/db/forwarder-security";
import { z } from "zod";
import { protectedProcedure, publicProcedure } from "../index";
import {
  closeRevokedCliCredentialSessions,
  deviceFlowErrorData,
  digestCliTokenSecret,
  mintCliDeviceCredentialFromApprovedDeviceCode,
} from "../lib/cli-credential-access";

const credentialNameSchema = z.string().trim().min(1).max(120);
const userCodeSchema = z.string().trim().min(1).max(191);
const cliSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .refine((value) => validateForwarderSlug(value).ok, {
    message: "CLI slug must use lowercase letters, numbers, and hyphens only.",
  });

const cliTokenSelection = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  lookupPrefix: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
  cliDeviceId: true,
  identityPublicKey: true,
  lastRefusedAt: true,
  lastRefusedReason: true,
} satisfies Prisma.CliTokenSelect;

type CliTokenRow = Prisma.CliTokenGetPayload<{ select: typeof cliTokenSelection }>;

function serializeCliToken(row: CliTokenRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    lookupPrefix: row.lookupPrefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    cliDeviceId: row.cliDeviceId,
    identityBound: row.identityPublicKey != null,
    lastRefusedAt: row.lastRefusedAt,
    lastRefusedReason: row.lastRefusedReason,
  };
}

/**
 * Better Auth's user-code lookup: the exact code, else (for the default
 * alphabet) the code with separators removed and upper-cased.
 */
function userCodeCandidates(userCode: string): string[] {
  const normalized = userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return normalized && normalized !== userCode ? [userCode, normalized] : [userCode];
}

export const cliCredentialsRouter = {
  listTokens: protectedProcedure
    .input(
      z
        .object({
          includeRevoked: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .handler(async ({ input, context }) => {
      const includeRevoked = input?.includeRevoked ?? false;
      const rows = await prisma.cliToken.findMany({
        where: {
          userId: context.session.user.id,
          ...(includeRevoked ? {} : { revokedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
        select: cliTokenSelection,
      });

      return rows.map(serializeCliToken);
    }),

  createToken: protectedProcedure
    .input(
      z.object({
        name: credentialNameSchema,
        expiresAt: z.date().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const secret = generateProductCredentialSecret("cliToken");
      const token = await prisma.cliToken.create({
        data: {
          userId: context.session.user.id,
          name: input.name,
          lookupPrefix: credentialLookupPrefix(secret),
          secretDigest: digestCliTokenSecret(secret),
          expiresAt: input.expiresAt ?? null,
        },
        select: cliTokenSelection,
      });

      return {
        token: serializeCliToken(token),
        secret,
      };
    }),

  revokeToken: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const existing = await prisma.cliToken.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true, revokedAt: true },
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI token not found." });
      }

      const row = await prisma.cliToken.update({
        where: { id: input.id },
        data: { revokedAt: existing.revokedAt ?? new Date() },
        select: cliTokenSelection,
      });
      await closeRevokedCliCredentialSessions(context.services, {
        kind: "cliToken",
        ids: [row.id],
      });
      return serializeCliToken(row);
    }),

  resetTokenIdentity: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const existing = await prisma.cliToken.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true, revokedAt: true },
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI token not found." });
      }
      if (existing.revokedAt) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Revoked CLI tokens cannot reset their identity bind.",
        });
      }
      const row = await prisma.cliToken.update({
        where: { id: input.id },
        data: {
          identityPublicKey: null,
          lastRefusedAt: null,
          lastRefusedReason: null,
        },
        select: cliTokenSelection,
      });
      return serializeCliToken(row);
    }),

  exchangeDeviceCode: publicProcedure
    .input(
      z.object({
        deviceCode: z.string().trim().min(1).max(512),
        cliSlug: cliSlugSchema,
        // Optional only so a pre-0.4.0 login still reaches the upgrade
        // sentinel below. Every other exchange must carry the CLI identity
        // public key; the handler refuses a missing or invalid one before it
        // mints.
        identityPublicKey: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      // The device code a pre-0.4.0 `wsmp login` got from /device/code (it
      // sends no slug scope). Those releases print this message. This branch
      // runs BEFORE the exchange limiter and must stay side-effect-free: it
      // neither reads nor writes the database (a DB read here would reopen an
      // unrate-limited path), and every old CLI polls with this same constant
      // code, so charging the per-code bucket here would let one caller
      // suppress the upgrade message for the whole fleet.
      if (input.deviceCode === CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE) {
        throw new ORPCError("BAD_REQUEST", { message: CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE });
      }
      const identityPublicKey = normalizeIdentityPublicKey(input.identityPublicKey ?? "");
      if (!identityPublicKey) {
        throw new ORPCError("BAD_REQUEST", {
          message: "identityPublicKey must be an uncompressed P-256 public key.",
        });
      }
      // Per IP and per device code, before any database work. A refusal is
      // RFC 8628 `slow_down`, so a polling CLI backs off instead of failing.
      const limit = await context.services?.limitDeviceCodeExchange?.(input.deviceCode);
      if (limit && !limit.allowed) {
        // RFC 8628 §3.5 `slow_down`, with the wait the limiter computed so a
        // client can back off precisely. Clamped to the device-code lifetime: an
        // inflated value must not tell a client to wait past the code's expiry.
        const retryAfterMs = Math.min(limit.retryAfterMs, CLI_DEVICE_CODE_LIFETIME_MS);
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "Device authorization polling too fast.",
          data: { ...deviceFlowErrorData("slow_down"), retryAfterMs },
        });
      }
      const minted = await mintCliDeviceCredentialFromApprovedDeviceCode({
        deviceCode: input.deviceCode,
        cliSlug: input.cliSlug,
        identityPublicKey,
      });
      await closeRevokedCliCredentialSessions(context.services, minted.revoked);
      return { credentialId: minted.credentialId, userId: minted.userId, secret: minted.secret };
    }),

  /**
   * What approving a `wsmp login` request authorizes, for the approval page:
   * the CLI slug bound to the request and the signed-in user's existing device
   * it would take over, if any. Reading claims nothing: a pending, unclaimed
   * code is visible to any signed-in account holding its user code, so the
   * wrong account opening the link leaves it for the right one. A code another
   * account approved is NOT_FOUND. Refusals carry a `data.reason`
   * (`DEVICE_LOGIN_REFUSAL_REASONS`) so the page can say what to do next.
   */
  deviceLoginRequest: protectedProcedure
    .input(z.object({ userCode: userCodeSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const row = await prisma.deviceCode.findFirst({
        where: {
          userCode: { in: userCodeCandidates(input.userCode) },
          OR: [{ userId: null, status: "pending" }, { userId }],
        },
        select: { status: true, expiresAt: true, scope: true },
      });
      if (!row) throw loginRefusal("NOT_FOUND", "not_found", "Device login request not found.");
      if (row.expiresAt <= new Date()) throw expiredLoginRequest();
      const slug = requireDeviceLoginSlug(row.scope);
      const device = await prisma.cliDevice.findUnique({
        where: { userId_slug: { userId, slug } },
        select: { id: true, slug: true, name: true, reportedHostname: true },
      });
      return {
        status: row.status,
        slug,
        existingDevice: device
          ? { id: device.id, slug: device.slug, displayName: cliDeviceDisplayName(device) }
          : null,
      };
    }),

  /**
   * Approves a pending `wsmp login` for the signed-in account. The claim and
   * the approval are one conditional write: it succeeds only while the code is
   * pending, unexpired, and unclaimed (or already this account's), and only
   * for the CLI slug the page showed. Of two accounts approving at once, one
   * write matches and the other gets CONFLICT. Better Auth's own `/device`,
   * `/device/approve` and `/device/deny` are disabled
   * (`DISABLED_DEVICE_AUTHORIZATION_PATHS`), so nothing else claims a code.
   * The server requires the CSRF header on this procedure on every deployment
   * (`ALWAYS_CSRF_PROTECTED_PROCEDURES`, apps/server/src/csrf-policy.ts), as
   * Better Auth's origin check did on the route it replaces.
   */
  approveDeviceLogin: protectedProcedure
    .input(z.object({ userCode: userCodeSchema, slug: cliSlugSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const row = await prisma.deviceCode.findFirst({
        where: { userCode: { in: userCodeCandidates(input.userCode) } },
        select: { id: true, userId: true, status: true, expiresAt: true, scope: true },
      });
      if (!row || (row.userId !== null && row.userId !== userId)) {
        throw loginRefusal("NOT_FOUND", "not_found", "Device login request not found.");
      }
      if (row.expiresAt <= new Date()) throw expiredLoginRequest();
      const slug = requireDeviceLoginSlug(row.scope);
      if (slug !== input.slug) {
        throw loginRefusal(
          "CONFLICT",
          "slug_mismatch",
          "This login request is for a different CLI slug. Reload the page.",
        );
      }
      if (row.status === "approved" && row.userId === userId) return { status: "approved", slug };
      if (row.status !== "pending") throw alreadyHandled();

      const approved = await prisma.$transaction(async (tx) => {
        // Lock the row, THEN read the clock: the expiry cut-off must be taken
        // after any wait for a concurrent writer's lock, or a code that
        // expired during that wait would still be approved.
        await tx.$queryRaw`SELECT id FROM device_code WHERE id = ${row.id} FOR UPDATE`;
        return tx.deviceCode.updateMany({
          where: {
            id: row.id,
            status: "pending",
            expiresAt: { gt: new Date() },
            scope: row.scope,
            OR: [{ userId: null }, { userId }],
          },
          data: { status: "approved", userId },
        });
      });
      if (approved.count !== 1) {
        // The conditional write lost the race. When the winner was THIS
        // account (a double-click or double-fired mutation of the same
        // approval), the caller's own approval did happen: report the
        // idempotent success. The re-read re-checks `userId`, so a different
        // account's win is still CONFLICT — never misreported as this
        // caller's success.
        const current = await prisma.deviceCode.findFirst({
          where: { id: row.id },
          select: { userId: true, status: true, expiresAt: true },
        });
        if (current?.status === "approved" && current.userId === userId) {
          return { status: "approved", slug };
        }
        if (current?.status === "pending" && current.expiresAt <= new Date()) {
          throw expiredLoginRequest();
        }
        // The row is gone: this request was read as approvable, so it was
        // approved and redeemed by the CLI between the read and the write, or
        // it was swept after expiring, or it was denied and then swept by the
        // denied-poll sweep. Say so, rather than "already handled".
        if (current === null) throw alreadyUsed();
        throw alreadyHandled();
      }
      return { status: "approved", slug };
    }),
};

function requireDeviceLoginSlug(scope: string | null): string {
  const slug = cliSlugFromDeviceLoginScope(scope);
  if (slug === null) {
    throw loginRefusal(
      "BAD_REQUEST",
      "no_slug",
      "This device login request does not name a CLI slug; upgrade wsmp.",
    );
  }
  return slug;
}

function loginRefusal<Code extends "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT">(
  code: Code,
  reason: DeviceLoginRefusalReason,
  message: string,
): ORPCError<Code, { reason: DeviceLoginRefusalReason }> {
  return new ORPCError(code, { message, data: { reason } });
}

function expiredLoginRequest() {
  return loginRefusal(
    "BAD_REQUEST",
    "expired",
    "This login request has expired. Run `wsmp login` again.",
  );
}

function alreadyHandled() {
  return loginRefusal(
    "CONFLICT",
    "already_handled",
    "This login request was already handled. Run `wsmp login` again if you need to.",
  );
}

function alreadyUsed() {
  return loginRefusal(
    "CONFLICT",
    "already_used",
    "This login request was already approved and used. Nothing more to approve.",
  );
}

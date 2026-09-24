import { ORPCError } from "@orpc/server";
import { cliSlugFromDeviceLoginScope } from "@ws-model-proxy/config/cli-device-login";
import { cliDeviceDisplayName } from "@ws-model-proxy/config/cli-device-name";
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
  digestCliTokenSecret,
  mintCliDeviceCredentialFromApprovedDeviceCode,
} from "../lib/cli-credential-access";

const credentialNameSchema = z.string().trim().min(1).max(120);
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

  exchangeDeviceCode: publicProcedure
    .input(
      z.object({
        deviceCode: z.string().trim().min(1).max(512),
        cliSlug: cliSlugSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      const minted = await mintCliDeviceCredentialFromApprovedDeviceCode({
        deviceCode: input.deviceCode,
        cliSlug: input.cliSlug,
      });
      await closeRevokedCliCredentialSessions(context.services, minted.revoked);
      return { credentialId: minted.credentialId, userId: minted.userId, secret: minted.secret };
    }),

  /**
   * What approving a `wsmp login` request authorizes, for the approval page:
   * the CLI slug bound to the request and the existing device it would take
   * over, if any. Only the account that claimed the code (Better Auth's
   * `GET /device`) sees it; everything else is NOT_FOUND.
   */
  deviceLoginRequest: protectedProcedure
    .input(z.object({ userCode: z.string().trim().min(1).max(191) }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const row = await prisma.deviceCode.findFirst({
        where: { userCode: { in: userCodeCandidates(input.userCode) }, userId },
        select: { status: true, expiresAt: true, scope: true },
      });
      if (!row || row.expiresAt <= new Date()) {
        throw new ORPCError("NOT_FOUND", { message: "Device login request not found." });
      }
      const slug = cliSlugFromDeviceLoginScope(row.scope);
      if (slug === null) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This device login request does not name a CLI slug; upgrade wsmp.",
        });
      }
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
};

import { ORPCError } from "@orpc/server";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  generateProductCredentialSecret,
} from "@ws-model-proxy/db/forwarder-security";
import { z } from "zod";
import { protectedProcedure, publicProcedure } from "../index";
import {
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
} as const;

type CliTokenRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  lookupPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  cliDeviceId: string | null;
};

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
      const rows = (await prisma.cliToken.findMany({
        where: {
          userId: context.session.user.id,
          ...(includeRevoked ? {} : { revokedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
        select: cliTokenSelection,
      })) as CliTokenRow[];

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
      const token = (await prisma.cliToken.create({
        data: {
          userId: context.session.user.id,
          name: input.name,
          lookupPrefix: credentialLookupPrefix(secret),
          secretDigest: digestCliTokenSecret(secret),
          expiresAt: input.expiresAt ?? null,
        },
        select: cliTokenSelection,
      })) as CliTokenRow;

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

      const row = (await prisma.cliToken.update({
        where: { id: input.id },
        data: { revokedAt: existing.revokedAt ?? new Date() },
        select: cliTokenSelection,
      })) as CliTokenRow;
      return serializeCliToken(row);
    }),

  exchangeDeviceCode: publicProcedure
    .input(
      z.object({
        deviceCode: z.string().trim().min(1).max(512),
        name: credentialNameSchema.default("CLI device"),
        cliSlug: cliSlugSchema,
      }),
    )
    .handler(async ({ input }) => {
      return mintCliDeviceCredentialFromApprovedDeviceCode({
        deviceCode: input.deviceCode,
        name: input.name,
        cliSlug: input.cliSlug,
      });
    }),
};

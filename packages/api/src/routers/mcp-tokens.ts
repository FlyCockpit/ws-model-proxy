import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  MCP_PAT_GRANT_REFERENCE,
  MCP_PAT_MAX_ACTIVE_PER_USER,
  mcpPatClientId,
} from "@ws-model-proxy/auth/mcp-config";
import {
  MCP_PAT_MAX_TTL_DAYS,
  MCP_PAT_NAME_MAX_LENGTH,
  MCP_PAT_NO_EXPIRY_DISABLED_REASON,
  mcpPatExpiryRejection,
  mcpPatOmittedExpiresAt,
} from "@ws-model-proxy/auth/mcp-pat-limits";
import prisma from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  generateProductCredentialSecret,
} from "@ws-model-proxy/db/forwarder-security";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  activeMcpPersonalTokenWhere,
  digestMcpPersonalTokenSecret,
  type McpPersonalTokenRow,
  mcpPersonalTokenSelection,
  revokeMcpPersonalTokenById,
} from "../lib/mcp-token-access";
import { runSerializableTransaction } from "../lib/serializable-transaction";

/**
 * Human MCP personal-token management. Browser-session only: never accepts a
 * caller-supplied user id, and never exposed as MCP tools (see
 * MCP_TOOL_EXCLUSIONS). Create is gated on WMP_MCP_ENABLED and capped at
 * MCP_PAT_MAX_ACTIVE_PER_USER active tokens per user; list/revoke stay
 * available during an emergency MCP shutdown so outstanding tokens can be
 * killed (invariant 13). An omitted expiresAt lasts 90 days
 * (mcpPatOmittedExpiresAt). An explicit null is no expiry and requires
 * WMP_MCP_PAT_ALLOW_NO_EXPIRY at mint time; a client-chosen timestamp is
 * allowed under the MCP_PAT_MAX_TTL_DAYS cap. Existing tokens are unaffected
 * by the flag or the default. listMine defaults to
 * active tokens only — token and grant both unrevoked and not yet expired;
 * includeRevoked returns the full history.
 */

const tokenNameSchema = z.string().trim().min(1).max(MCP_PAT_NAME_MAX_LENGTH);

// The RPC wire is JSON: oRPC round-trips Date objects through its codec, and
// form-driven clients may equally send ISO date strings. z.coerce.date()
// accepts both, while null/undefined bypass coercion (.nullable().optional()).
const tokenExpiresAtSchema = z.coerce.date().nullable().optional();

function validateTokenExpiry(expiresAt: Date | null | undefined, ctx: z.RefinementCtx): void {
  if (expiresAt == null) return;
  const rejection = mcpPatExpiryRejection(expiresAt.getTime(), Date.now());
  if (rejection === "past") {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Expiry must be in the future.",
    });
    return;
  }
  if (rejection === "too_far") {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: `Expiry must be at most ${MCP_PAT_MAX_TTL_DAYS} days from now.`,
    });
  }
}

function serializeToken(row: McpPersonalTokenRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    lookupPrefix: row.lookupPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    allowCliCommands: row.allowCliCommands,
  };
}

function resolveRequestedScopes(allowWrite: boolean): string[] {
  return allowWrite ? ["mcp:read", "mcp:write"] : ["mcp:read"];
}

function newPersonalTokenId(): string {
  return randomBytes(16).toString("hex");
}

export const mcpTokensRouter = {
  listMine: protectedProcedure
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
      const now = new Date();
      const rows = await prisma.mcpPersonalToken.findMany({
        where: includeRevoked
          ? { userId: context.session.user.id }
          : activeMcpPersonalTokenWhere(context.session.user.id, now),
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
        select: mcpPersonalTokenSelection,
      });
      return rows.map(serializeToken);
    }),

  create: protectedProcedure
    .input(
      z
        .object({
          name: tokenNameSchema,
          allowWrite: z.boolean().default(false),
          allowCliCommands: z.boolean().default(false),
          expiresAt: tokenExpiresAtSchema,
        })
        .superRefine((value, ctx) => {
          validateTokenExpiry(value.expiresAt, ctx);
          // CLI commands can change a device, so a read-only token cannot opt in.
          if (value.allowCliCommands && !value.allowWrite) {
            ctx.addIssue({
              code: "custom",
              path: ["allowCliCommands"],
              message: "CLI commands require write access.",
            });
          }
        }),
    )
    .handler(async ({ input, context }) => {
      if (env.WMP_MCP_ENABLED !== true) {
        throw new ORPCError("FORBIDDEN", {
          message: "MCP personal tokens cannot be created while MCP is disabled.",
        });
      }

      const now = new Date();
      // undefined is omission (90 days). null is an explicit no-expiry request.
      const expiresAt =
        input.expiresAt === undefined ? mcpPatOmittedExpiresAt(now) : input.expiresAt;
      if (expiresAt === null && env.WMP_MCP_PAT_ALLOW_NO_EXPIRY !== true) {
        throw new ORPCError("FORBIDDEN", {
          message: "No-expiry MCP tokens are disabled on this deployment. Choose an expiry date.",
          data: { reason: MCP_PAT_NO_EXPIRY_DISABLED_REASON },
        });
      }

      const secret = generateProductCredentialSecret("mcpToken");
      const tokenId = newPersonalTokenId();
      const scopes = resolveRequestedScopes(input.allowWrite);

      const token = await runSerializableTransaction(async (tx) => {
        // Active-token cap inside the serializable transaction: concurrent
        // creators that both pass the count serialize-conflict (40001) and
        // the retry sees the updated count — no explicit locking needed.
        const activeCount = await tx.mcpPersonalToken.count({
          where: activeMcpPersonalTokenWhere(context.session.user.id, now),
        });
        if (activeCount >= MCP_PAT_MAX_ACTIVE_PER_USER) {
          throw new ORPCError("CONFLICT", {
            message: "Active MCP token limit reached. Revoke a token before creating another.",
          });
        }

        const grant = await tx.mcpGrant.create({
          data: {
            userId: context.session.user.id,
            clientId: mcpPatClientId(tokenId),
            referenceId: MCP_PAT_GRANT_REFERENCE,
          },
          select: { id: true },
        });
        return tx.mcpPersonalToken.create({
          data: {
            id: tokenId,
            userId: context.session.user.id,
            name: input.name,
            lookupPrefix: credentialLookupPrefix(secret),
            secretDigest: digestMcpPersonalTokenSecret(secret),
            scopes,
            // Omission is now+90d. Explicit null is no expiry (flag-gated).
            // Any other value is the client timestamp already validated above.
            expiresAt,
            allowCliCommands: input.allowCliCommands,
            grantId: grant.id,
          },
          select: mcpPersonalTokenSelection,
        });
      });

      return {
        token: serializeToken(token),
        secret,
      };
    }),

  revokeMine: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const row = await runSerializableTransaction((tx) =>
        revokeMcpPersonalTokenById(tx, { userId, tokenId: input.id, now: new Date() }),
      );
      context.services?.cancelMcpTokenCommands?.(row.id);
      return serializeToken(row);
    }),
};

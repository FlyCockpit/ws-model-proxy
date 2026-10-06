/**
 * Access (lane D): API keys, agent tokens, OAuth connections, shares and share invites.
 *
 * Every mutation here is `human` in the contract: a cookie session with a verified CSRF header
 * (`isHumanCaller`), never an MCP token, so an agent can neither mint credentials nor grant
 * anyone access. Secrets are returned once by `create` and stored only as their purpose HMAC
 * (`credentialDigest`); list views carry the lookup prefix, never the secret or its digest.
 */
import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  canonicalMcpResource,
  isMcpPatClientId,
  MCP_PAT_GRANT_REFERENCE,
  MCP_PAT_MAX_ACTIVE_PER_USER,
  mcpPatClientId,
} from "@ws-model-proxy/auth/mcp-config";
import { MCP_PAT_MAX_TTL_DAYS, mcpPatExpiryRejection } from "@ws-model-proxy/auth/mcp-pat-limits";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  credentialDigest,
  credentialLookupPrefix,
  generateProductCredentialSecret,
} from "@ws-model-proxy/db/node-security";
import { shareSpendCurrencies, sharesSpend } from "@ws-model-proxy/db/spend";
import { env } from "@ws-model-proxy/env/server";
import type { Context } from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { accessContract as c } from "../contracts/access";
import { runAccessTransaction } from "../lib/access-transaction";
import {
  agentTokenSelect,
  agentTokenView,
  apiKeySelect,
  apiKeyView,
  callableIdOf,
  moneyString,
  type ShareRow,
  shareInviteSelect,
  shareInviteView,
  shareSelect,
  shareView,
} from "../lib/access-views";
import { isUniqueViolation, notFound, refuse } from "../lib/refuse";
import { runSerializableTransaction } from "../lib/serializable-transaction";
import {
  generateShareInviteToken,
  pendingInviteWhere,
  SHARE_INVITE_MAX_PENDING_PER_OWNER,
  SHARE_INVITE_RESEND_COOLDOWN_MS,
  SHARE_INVITE_TTL_MS,
  sendShareInviteEmail,
  shareInviteDigest,
  shareInviteUrl,
} from "../lib/share-invites";

/** Active (unrevoked, unexpired) API keys one person may hold. */
export const API_KEY_MAX_ACTIVE_PER_USER = 50;
/** An API key may expire at most this far ahead (or never). */
export const API_KEY_MAX_TTL_MS = 5 * 365 * 86_400_000;

function badRequest(message: string): ORPCError<"BAD_REQUEST", unknown> {
  return new ORPCError("BAD_REQUEST", { message });
}

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

async function notifyRevoked(
  context: Context,
  event: Parameters<NonNullable<NonNullable<Context["services"]>["onAccessRevoked"]>>[0],
): Promise<void> {
  // The revocation is committed; a failed cache drop must not turn it into an error.
  try {
    await context.services?.onAccessRevoked?.(event);
  } catch (error) {
    // Every credential lookup reads revokedAt; this only ends live work early. The class only.
    console.error(
      "[access] ending a revoked credential's live work failed",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  }
}

function activeWhere(now: Date) {
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/**
 * The month's consumption (settled plus still reserved) of each capped share, keyed by cap id:
 * the revision-correct read the cap enforcement uses (`@ws-model-proxy/db/spend`), one batched
 * statement per cap currency.
 */
async function spentThisMonthByCap(rows: readonly ShareRow[]): Promise<Map<string, string>> {
  const byCurrency = new Map<string, Array<{ shareId: string; capId: string }>>();
  for (const row of rows) {
    if (!row.SpendCap) continue;
    const group = byCurrency.get(row.SpendCap.currency) ?? [];
    group.push({ shareId: row.id, capId: row.SpendCap.id });
    byCurrency.set(row.SpendCap.currency, group);
  }
  const spent = new Map<string, string>();
  await Promise.all(
    [...byCurrency].map(async ([currency, capped]) => {
      const usage = await sharesSpend(prisma, {
        shareIds: capped.map((entry) => entry.shareId),
        currency,
      });
      for (const { shareId, capId } of capped) {
        const share = usage.get(shareId);
        if (share) spent.set(capId, moneyString(share.spentThisMonth.plus(share.reservedNow)));
      }
    }),
  );
  return spent;
}

async function shareViews(rows: readonly ShareRow[]) {
  const spent = await spentThisMonthByCap(rows);
  return rows.map((row) => shareView(row, spent));
}

async function loadShareView(shareId: string) {
  const row = await prisma.share.findUnique({ where: { id: shareId }, select: shareSelect });
  if (!row) throw notFound("That key, token, connection, share or invite does not exist.");
  const [view] = await shareViews([row]);
  if (!view) throw notFound("That key, token, connection, share or invite does not exist.");
  return view;
}

function parseFutureExpiry(expiresAt: string | null, now: Date, maxMs: number): Date | null {
  if (expiresAt === null) return null;
  const date = new Date(expiresAt);
  if (date.getTime() <= now.getTime()) throw badRequest("Expiry must be in the future.");
  if (date.getTime() - now.getTime() > maxMs) throw badRequest("Expiry is too far ahead.");
  return date;
}

// ── API keys ──

const apiKeys = {
  list: contractProcedure(c.apiKeys.list).handler(async ({ context }) => {
    const rows = await prisma.apiKey.findMany({
      where: { userId: userIdOf(context) },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: apiKeySelect,
    });
    return {
      keys: rows.map(apiKeyView),
      baseUrl: new URL("/v1", env.BETTER_AUTH_URL).toString(),
    };
  }),

  create: contractProcedure(c.apiKeys.create).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const now = new Date();
    const expiresAt = parseFutureExpiry(input.expiresAt, now, API_KEY_MAX_TTL_MS);
    const poolIds = [...new Set(input.poolIds)];
    const secret = generateProductCredentialSecret("apiKey");
    // api_key_pool rows need the fence of each pool's owner too (shared pools).
    const poolOwners =
      input.scope === "SELECTED_POOLS"
        ? await prisma.pool.findMany({
            where: { id: { in: poolIds } },
            select: { userId: true },
          })
        : [];
    const owners = [userId, ...poolOwners.map((pool) => pool.userId)];
    const row = await runAccessTransaction({ owners }, async (tx) => {
      const active = await tx.apiKey.count({ where: { userId, ...activeWhere(now) } });
      if (active >= API_KEY_MAX_ACTIVE_PER_USER) {
        throw new ORPCError("CONFLICT", {
          message: "Active API key limit reached. Revoke a key before creating another.",
        });
      }
      if (input.scope === "SELECTED_POOLS") {
        // Own pools, or pools shared with the caller with can use (the
        // api_key_pool_access trigger enforces the same rule).
        const usable = await tx.pool.findMany({
          where: {
            id: { in: poolIds },
            OR: [{ userId }, { Shares: { some: { granteeUserId: userId, canUse: true } } }],
          },
          select: { id: true },
        });
        if (usable.length !== poolIds.length)
          throw notFound("That key, token, connection, share or invite does not exist.");
      }
      return tx.apiKey.create({
        data: {
          userId,
          name: input.name,
          scope: input.scope,
          lookupPrefix: credentialLookupPrefix(secret),
          secretDigest: credentialDigest("apiKey", secret),
          expiresAt,
          ...(input.scope === "SELECTED_POOLS"
            ? { Pools: { create: poolIds.map((poolId) => ({ poolId })) } }
            : {}),
        },
        select: apiKeySelect,
      });
    });
    return { key: apiKeyView(row), secret };
  }),

  revoke: contractProcedure(c.apiKeys.revoke).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const key = await prisma.apiKey.findFirst({
      where: { id: input.apiKeyId, userId },
      select: { id: true, revokedAt: true },
    });
    if (!key) throw notFound("That key, token, connection, share or invite does not exist.");
    if (!key.revokedAt) {
      await prisma.apiKey.updateMany({
        where: { id: key.id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await notifyRevoked(context, { kind: "api_key", userId, apiKeyId: key.id });
    }
    return { ok: true as const };
  }),
};

// ── Agent tokens ──

function newAgentTokenId(): string {
  return randomBytes(16).toString("hex");
}

const agentTokens = {
  list: contractProcedure(c.agentTokens.list).handler(async ({ context }) => {
    const rows = await prisma.agentToken.findMany({
      where: { userId: userIdOf(context) },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: agentTokenSelect,
    });
    return {
      tokens: rows.map(agentTokenView),
      mcpUrl: canonicalMcpResource(env.BETTER_AUTH_URL),
    };
  }),

  create: contractProcedure(c.agentTokens.create).handler(async ({ context, input }) => {
    if (env.WMP_MCP_ENABLED !== true) {
      throw new ORPCError("FORBIDDEN", {
        message: "Agent tokens cannot be created while MCP is turned off on this server.",
      });
    }
    const userId = userIdOf(context);
    const now = new Date();
    let expiresAt: Date | null = null;
    if (input.expiresAt === null) {
      if (env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY !== true) {
        throw badRequest("This server requires agent tokens to expire. Choose an expiry date.");
      }
    } else {
      expiresAt = new Date(input.expiresAt);
      const rejection = mcpPatExpiryRejection(expiresAt.getTime(), now.getTime());
      if (rejection === "past") throw badRequest("Expiry must be in the future.");
      if (rejection === "too_far") {
        throw badRequest(`Expiry must be at most ${MCP_PAT_MAX_TTL_DAYS} days ahead.`);
      }
    }
    const tokenId = newAgentTokenId();
    const secret = generateProductCredentialSecret("agentToken");
    const row = await runSerializableTransaction(async (tx) => {
      const active = await tx.agentToken.count({ where: { userId, ...activeWhere(now) } });
      if (active >= MCP_PAT_MAX_ACTIVE_PER_USER) {
        throw new ORPCError("CONFLICT", {
          message: "Active agent token limit reached. Revoke a token before creating another.",
        });
      }
      const grant = await tx.mcpGrant.create({
        data: {
          userId,
          clientId: mcpPatClientId(tokenId),
          referenceId: MCP_PAT_GRANT_REFERENCE,
          level: input.level,
        },
        select: { id: true },
      });
      return tx.agentToken.create({
        data: {
          id: tokenId,
          userId,
          name: input.name,
          level: input.level,
          lookupPrefix: credentialLookupPrefix(secret),
          secretDigest: credentialDigest("agentToken", secret),
          grantId: grant.id,
          expiresAt,
        },
        select: agentTokenSelect,
      });
    });
    return { token: agentTokenView(row), secret };
  }),

  revoke: contractProcedure(c.agentTokens.revoke).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const token = await prisma.agentToken.findFirst({
      where: { id: input.agentTokenId, userId },
      select: { id: true, grantId: true, revokedAt: true },
    });
    if (!token) throw notFound("That key, token, connection, share or invite does not exist.");
    const now = new Date();
    await prisma.$transaction([
      prisma.agentToken.updateMany({
        where: { id: token.id, userId, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.mcpGrant.updateMany({
        where: { id: token.grantId, userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    if (!token.revokedAt) {
      await notifyRevoked(context, {
        kind: "agent_token",
        userId,
        agentTokenId: token.id,
        grantId: token.grantId,
      });
    }
    return { ok: true as const };
  }),
};

// ── OAuth connections ──

function redirectHostOf(uris: readonly string[]): string | null {
  for (const uri of uris) {
    try {
      return new URL(uri).host || null;
    } catch {
      // Not a URL (a custom scheme without a host); try the next one.
    }
  }
  return null;
}

const oauthGrants = {
  list: contractProcedure(c.oauthGrants.list).handler(async ({ context }) => {
    const userId = userIdOf(context);
    const grants = await prisma.mcpGrant.findMany({
      where: { userId, NOT: { clientId: { startsWith: "pat:" } } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, clientId: true, level: true, createdAt: true, revokedAt: true },
    });
    const clients = await prisma.oauthClient.findMany({
      where: { clientId: { in: [...new Set(grants.map((grant) => grant.clientId))] } },
      select: { clientId: true, name: true, redirectUris: true },
    });
    const byClientId = new Map(clients.map((client) => [client.clientId, client]));
    return {
      connections: grants
        .filter((grant) => !isMcpPatClientId(grant.clientId))
        .map((grant) => {
          const client = byClientId.get(grant.clientId);
          return {
            grantId: grant.id,
            clientId: grant.clientId,
            clientName: client?.name ?? null,
            redirectHost: client ? redirectHostOf(client.redirectUris) : null,
            level: grant.level,
            createdAt: grant.createdAt.toISOString(),
            revokedAt: grant.revokedAt?.toISOString() ?? null,
          };
        }),
    };
  }),

  revoke: contractProcedure(c.oauthGrants.revoke).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const grant = await prisma.mcpGrant.findFirst({
      where: { id: input.grantId, userId },
      select: { id: true, clientId: true, revokedAt: true },
    });
    if (!grant || isMcpPatClientId(grant.clientId))
      throw notFound("That key, token, connection, share or invite does not exist.");
    const now = new Date();
    // Revoke every live token this client holds for the person and forget the consent, so
    // reconnecting asks again. TODO(server): pending authorization codes are not swept here
    // (0.3 `mcp-grants.revokeMine` did); they expire within minutes.
    await prisma.$transaction([
      prisma.mcpGrant.updateMany({
        where: { id: grant.id, userId, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.oauthRefreshToken.updateMany({
        where: { userId, clientId: grant.clientId, revoked: null },
        data: { revoked: now },
      }),
      prisma.oauthAccessToken.updateMany({
        where: { userId, clientId: grant.clientId, revoked: null },
        data: { revoked: now },
      }),
      prisma.oauthConsent.deleteMany({ where: { userId, clientId: grant.clientId } }),
    ]);
    if (!grant.revokedAt) {
      await notifyRevoked(context, {
        kind: "oauth_grant",
        userId,
        grantId: grant.id,
        clientId: grant.clientId,
      });
    }
    return { ok: true as const };
  }),
};

// ── Shares and invites ──

async function ownedPool(userId: string, poolId: string) {
  const pool = await prisma.pool.findFirst({
    where: { id: poolId, userId },
    select: { id: true, slug: true, User: { select: { slug: true, name: true, locale: true } } },
  });
  if (!pool) throw notFound("That key, token, connection, share or invite does not exist.");
  return pool;
}

type InviteSettings = {
  canUse: boolean;
  canContribute: boolean;
  priorityClass: "BACKGROUND" | "NORMAL" | "HIGH" | null;
};

/**
 * Writes a pending invite for (pool, e-mail) with a fresh token (contract fix): a new invite
 * when none is pending, or, for a resend, the pending one with its token and expiry rotated
 * (the old link stops working). Earlier accepted, revoked or expired rows stay as history.
 */
async function writeInvite(
  args:
    | {
        mode: "create";
        ownerUserId: string;
        poolId: string;
        email: string;
        settings: InviteSettings;
      }
    | { mode: "resend"; ownerUserId: string; inviteId: string },
) {
  const now = new Date();
  const token = generateShareInviteToken();
  const tokenDigest = shareInviteDigest(token);
  const expiresAt = new Date(now.getTime() + SHARE_INVITE_TTL_MS);
  const row = await runAccessTransaction({ owners: [args.ownerUserId] }, async (tx) => {
    if (args.mode === "resend") {
      const invite = await tx.shareInvite.findFirst({
        where: { id: args.inviteId, ownerUserId: args.ownerUserId, ...pendingInviteWhere(now) },
        select: { createdAt: true, updatedAt: true },
      });
      if (!invite) throw notFound("That key, token, connection, share or invite does not exist.");
      if (now.getTime() - invite.updatedAt.getTime() < SHARE_INVITE_RESEND_COOLDOWN_MS) {
        throw new ORPCError("CONFLICT", {
          message: "This invite was just sent. Wait a minute before sending it again.",
          data: { reason: "rate_limited" },
        });
      }
      const rotated = await tx.shareInvite.updateMany({
        where: { id: args.inviteId, ownerUserId: args.ownerUserId, ...pendingInviteWhere(now) },
        data: { tokenDigest, expiresAt, emailSentAt: null },
      });
      if (rotated.count !== 1)
        throw notFound("That key, token, connection, share or invite does not exist.");
      return tx.shareInvite.findUniqueOrThrow({
        where: { id: args.inviteId },
        select: shareInviteSelect,
      });
    }
    // An expired invite still holds the one-pending slot (the partial unique index ignores
    // expiry): withdraw it so the address can be invited again.
    await tx.shareInvite.updateMany({
      where: {
        poolId: args.poolId,
        email: args.email,
        ownerUserId: args.ownerUserId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { lte: now },
      },
      data: { revokedAt: now },
    });
    const pending = await tx.shareInvite.findFirst({
      where: { poolId: args.poolId, email: args.email, ...pendingInviteWhere(now) },
      select: { id: true },
    });
    if (pending) {
      throw new ORPCError("CONFLICT", {
        message: "This e-mail already has a pending invite to this pool. Resend it instead.",
      });
    }
    const pendingCount = await tx.shareInvite.count({
      where: { ownerUserId: args.ownerUserId, ...pendingInviteWhere(now) },
    });
    if (pendingCount >= SHARE_INVITE_MAX_PENDING_PER_OWNER) {
      throw new ORPCError("CONFLICT", {
        message: "Too many pending invites. Withdraw some before inviting more people.",
      });
    }
    return tx.shareInvite
      .create({
        data: {
          poolId: args.poolId,
          ownerUserId: args.ownerUserId,
          email: args.email,
          tokenDigest,
          canUse: args.settings.canUse,
          canContribute: args.settings.canContribute,
          priorityClass: args.settings.priorityClass,
          expiresAt,
        },
        select: shareInviteSelect,
      })
      .catch((error: unknown) => {
        // One pending invite per pool and e-mail (partial unique index): a concurrent invite
        // to the same address won.
        if (isUniqueViolation(error)) {
          throw new ORPCError("CONFLICT", {
            message: "This e-mail already has a pending invite to this pool. Resend it instead.",
          });
        }
        throw error;
      });
  });
  return { row, token, expiresAt: row.expiresAt };
}

/** E-mails the invite; returns the view and, only when no e-mail went out, the link. */
async function deliverInvite(args: {
  row: Awaited<ReturnType<typeof writeInvite>>["row"];
  token: string;
  expiresAt: Date;
  owner: { name: string; locale: string };
}) {
  const callableId = callableIdOf(args.row.Pool.User.slug, args.row.Pool.slug);
  const sent = await sendShareInviteEmail({
    to: args.row.email,
    ownerName: args.owner.name,
    callableId,
    token: args.token,
    expiresAt: args.expiresAt,
    locale: args.owner.locale,
  });
  if (!sent) {
    return {
      invite: shareInviteView(args.row),
      link: shareInviteUrl(args.token, args.owner.locale),
    };
  }
  const updated = await prisma.shareInvite.update({
    where: { id: args.row.id },
    data: { emailSentAt: new Date() },
    select: shareInviteSelect,
  });
  return { invite: shareInviteView(updated), link: null };
}

const shares = {
  list: contractProcedure(c.shares.list).handler(async ({ context }) => {
    const userId = userIdOf(context);
    const now = new Date();
    const [byMe, withMe, invites] = await Promise.all([
      prisma.share.findMany({
        where: { ownerUserId: userId },
        orderBy: { createdAt: "desc" },
        take: 1000,
        select: shareSelect,
      }),
      prisma.share.findMany({
        where: { granteeUserId: userId },
        orderBy: { createdAt: "desc" },
        take: 1000,
        select: shareSelect,
      }),
      prisma.shareInvite.findMany({
        where: { ownerUserId: userId, ...pendingInviteWhere(now) },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: shareInviteSelect,
      }),
    ]);
    const views = await shareViews([...byMe, ...withMe]);
    return {
      byMe: views.slice(0, byMe.length),
      withMe: views.slice(byMe.length),
      invites: invites.map(shareInviteView),
    };
  }),

  create: contractProcedure(c.shares.create).handler(async ({ context, input }) => {
    const ownerUserId = userIdOf(context);
    const pool = await ownedPool(ownerUserId, input.poolId);
    const email = input.email;
    if (email === context.session.user.email.trim().toLowerCase()) {
      throw badRequest("You already own this pool.");
    }
    const account = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, emailVerified: true },
    });
    // Only an account whose e-mail is verified gets the share directly; anyone else proves
    // the address through the invite (verification or the invite link).
    const grantee = account?.emailVerified ? account : null;
    if (!grantee) {
      if (input.monthlyCap !== null || input.protectionPercent !== null) {
        throw badRequest(
          "A monthly cap and warm protection are set on the share once this person has an account.",
        );
      }
      const written = await writeInvite({
        mode: "create",
        ownerUserId,
        poolId: pool.id,
        email,
        settings: {
          canUse: input.canUse,
          canContribute: input.canContribute,
          priorityClass: input.priorityClass,
        },
      });
      const delivered = await deliverInvite({
        ...written,
        owner: { name: pool.User.name, locale: pool.User.locale },
      });
      return { kind: "invite" as const, ...delivered };
    }
    if (grantee.id === ownerUserId) throw badRequest("You already own this pool.");
    let shareId: string;
    try {
      shareId = await runAccessTransaction({ owners: [ownerUserId, grantee.id] }, async (tx) => {
        const share = await tx.share.create({
          data: {
            poolId: pool.id,
            ownerUserId,
            granteeUserId: grantee.id,
            canUse: input.canUse,
            canContribute: input.canContribute,
            priorityClass: input.priorityClass,
            protectionPercent: input.protectionPercent,
          },
          select: { id: true },
        });
        if (input.monthlyCap) {
          await tx.spendCap.create({
            data: {
              userId: ownerUserId,
              scope: "SHARE",
              shareId: share.id,
              monthlyLimit: new Prisma.Decimal(input.monthlyCap.limit),
              currency: input.monthlyCap.currency,
            },
          });
        }
        return share.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ORPCError("CONFLICT", {
          message: "This pool is already shared with this person. Change the existing share.",
        });
      }
      throw error;
    }
    return { kind: "share" as const, share: await loadShareView(shareId) };
  }),

  update: contractProcedure(c.shares.update).handler(async ({ context, input }) => {
    const ownerUserId = userIdOf(context);
    const found = await prisma.share.findFirst({
      where: { id: input.shareId, ownerUserId },
      select: { id: true, poolId: true, granteeUserId: true },
    });
    if (!found) throw notFound("That key, token, connection, share or invite does not exist.");
    const touchesPolicy =
      input.canUse !== undefined ||
      input.canContribute !== undefined ||
      input.priorityClass !== undefined;
    const fenced = {
      owners: [ownerUserId, found.granteeUserId],
      // Owner-paid admissions through the share serialize on it: a cap edit linearizes with them.
      ...(input.monthlyCap !== undefined ? { spendShareId: found.id } : {}),
      ...(touchesPolicy ? { policyPoolId: found.poolId } : {}),
    };
    const revokedUse = await runAccessTransaction(fenced, async (tx) => {
      // Re-read under the fences and write only what the request names, so concurrent edits
      // of other fields are never undone.
      const share = await tx.share.findFirst({
        where: { id: found.id, ownerUserId },
        select: {
          canUse: true,
          canContribute: true,
          SpendCap: { select: { id: true, currency: true } },
        },
      });
      if (!share) throw notFound("That key, token, connection, share or invite does not exist.");
      const canUse = input.canUse ?? share.canUse;
      const canContribute = input.canContribute ?? share.canContribute;
      if (!canUse && !canContribute) {
        throw badRequest("A share needs can use, can contribute, or both. Delete it instead.");
      }
      await tx.share.update({
        where: { id: found.id },
        data: {
          ...(input.canUse !== undefined ? { canUse: input.canUse } : {}),
          ...(input.canContribute !== undefined ? { canContribute: input.canContribute } : {}),
          ...(input.priorityClass !== undefined ? { priorityClass: input.priorityClass } : {}),
          ...(input.protectionPercent !== undefined
            ? { protectionPercent: input.protectionPercent }
            : {}),
        },
      });
      if (input.monthlyCap === null && share.SpendCap) {
        await tx.spendCap.deleteMany({ where: { id: share.SpendCap.id, shareId: found.id } });
      } else if (input.monthlyCap) {
        const limit = new Prisma.Decimal(input.monthlyCap.limit);
        // Any set (a first cap, or one set again after a clear included) names the one
        // currency the share has spent in this month. Exact under the share's spend fence:
        // no admission through it runs meanwhile.
        const spentIn = await shareSpendCurrencies(tx, { shareId: found.id });
        if (spentIn.some((spent) => spent !== input.monthlyCap?.currency)) {
          throw refuse(
            "cap_currency_has_spend",
            "The cap's currency must be the one this share has spent in this month.",
          );
        }
        if (share.SpendCap) {
          await tx.spendCap.update({
            where: { id: share.SpendCap.id },
            data: {
              monthlyLimit: limit,
              currency: input.monthlyCap.currency,
              version: { increment: 1 },
            },
          });
        } else {
          await tx.spendCap.create({
            data: {
              userId: ownerUserId,
              scope: "SHARE",
              shareId: found.id,
              monthlyLimit: limit,
              currency: input.monthlyCap.currency,
            },
          });
        }
      }
      return share.canUse && !canUse;
    });
    if (revokedUse) {
      await notifyRevoked(context, {
        kind: "share",
        ownerUserId,
        granteeUserId: found.granteeUserId,
        poolId: found.poolId,
      });
    }
    return loadShareView(found.id);
  }),

  delete: contractProcedure(c.shares.delete).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    // The owner removes a share; the person it was shared with may leave it.
    const share = await prisma.share.findFirst({
      where: { id: input.shareId, OR: [{ ownerUserId: userId }, { granteeUserId: userId }] },
      select: { id: true, poolId: true, ownerUserId: true, granteeUserId: true },
    });
    if (!share) throw notFound("That key, token, connection, share or invite does not exist.");
    await runAccessTransaction({ owners: [share.ownerUserId, share.granteeUserId] }, (tx) =>
      tx.share.deleteMany({ where: { id: share.id } }),
    );
    await notifyRevoked(context, {
      kind: "share",
      ownerUserId: share.ownerUserId,
      granteeUserId: share.granteeUserId,
      poolId: share.poolId,
    });
    return { ok: true as const };
  }),

  setOwnKey: contractProcedure(c.shares.setOwnKey).handler(async ({ context, input }) => {
    const granteeUserId = userIdOf(context);
    const share = await prisma.share.findFirst({
      where: { id: input.shareId, granteeUserId },
      select: { id: true, ownerUserId: true },
    });
    if (!share) throw notFound("That key, token, connection, share or invite does not exist.");
    // Under the owner's fence the equivalent cannot change meanwhile (a change clears every
    // choice), so the choice consents to the equivalent read here; under the share holder's,
    // the chosen model cannot be deleted.
    await runAccessTransaction({ owners: [share.ownerUserId, granteeUserId] }, async (tx) => {
      if (input.providerModelId !== null) {
        const model = await tx.providerModel.findFirst({
          where: { id: input.providerModelId, userId: granteeUserId, deletedAt: null },
          select: { id: true },
        });
        if (!model) throw notFound("That key, token, connection, share or invite does not exist.");
      }
      const current = await tx.share.findFirst({
        where: { id: share.id, granteeUserId },
        select: {
          ownKeyProtocolAdaptation: true,
          Pool: { select: { Fallback: { select: { ownKeyEquivalentModel: true } } } },
        },
      });
      if (!current) throw notFound("That key, token, connection, share or invite does not exist.");
      if (input.providerModelId !== null && !current.Pool.Fallback?.ownKeyEquivalentModel) {
        throw new ORPCError("FORBIDDEN", {
          message: "The pool's owner has not allowed using your own provider key for this pool.",
        });
      }
      await tx.share.update({
        where: { id: share.id },
        data: {
          ownKeyProviderModelId: input.providerModelId,
          ownKeyProtocolAdaptation:
            input.providerModelId === null
              ? false
              : (input.protocolAdaptation ?? current.ownKeyProtocolAdaptation),
        },
      });
    });
    return loadShareView(share.id);
  }),
};

const invites = {
  resend: contractProcedure(c.invites.resend).handler(async ({ context, input }) => {
    const ownerUserId = userIdOf(context);
    const owner = await prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { name: true, locale: true },
    });
    if (!owner) throw notFound("That key, token, connection, share or invite does not exist.");
    const written = await writeInvite({ mode: "resend", ownerUserId, inviteId: input.inviteId });
    return deliverInvite({ ...written, owner });
  }),

  revoke: contractProcedure(c.invites.revoke).handler(async ({ context, input }) => {
    const ownerUserId = userIdOf(context);
    const invite = await prisma.shareInvite.findFirst({
      where: { id: input.inviteId, ownerUserId },
      select: { id: true, acceptedAt: true, revokedAt: true },
    });
    if (!invite) throw notFound("That key, token, connection, share or invite does not exist.");
    if (invite.acceptedAt) {
      throw new ORPCError("CONFLICT", {
        message: "This invite was accepted. Delete the share instead.",
      });
    }
    if (!invite.revokedAt) {
      await prisma.shareInvite.updateMany({
        where: { id: invite.id, ownerUserId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true as const };
  }),
};

const contributing = {
  pools: contractProcedure(c.contributing.pools).handler(async ({ context }) => {
    const userId = userIdOf(context);
    const rows = await prisma.share.findMany({
      where: { granteeUserId: userId, canContribute: true },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        poolId: true,
        Owner: { select: { email: true, slug: true } },
        Pool: {
          select: {
            slug: true,
            modelType: true,
            Routing: { select: { ownHardwareOnly: true } },
          },
        },
        Contributed: {
          select: {
            id: true,
            runtimeModelId: true,
            RuntimeModel: { select: { upstreamModelId: true } },
          },
        },
      },
    });
    return {
      pools: rows.map((row) => ({
        shareId: row.id,
        poolId: row.poolId,
        callableId: callableIdOf(row.Owner.slug, row.Pool.slug),
        ownerEmail: row.Owner.email,
        modelType: row.Pool.modelType,
        ownHardwareOnly: row.Pool.Routing?.ownHardwareOnly ?? false,
        yourMembers: row.Contributed.flatMap((member) =>
          member.runtimeModelId && member.RuntimeModel
            ? [
                {
                  memberId: member.id,
                  runtimeModelId: member.runtimeModelId,
                  upstreamModelId: member.RuntimeModel.upstreamModelId,
                },
              ]
            : [],
        ),
      })),
    };
  }),
};

export const accessRouter = {
  apiKeys,
  agentTokens,
  oauthGrants,
  shares,
  invites,
  contributing,
};

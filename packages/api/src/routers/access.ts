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
  type AgentScope,
  agentScopeToDb,
  oauthScopeCeiling,
} from "@ws-model-proxy/auth/agent-scopes";
import { hasLiveCredentialSession } from "@ws-model-proxy/auth/credential-session";
import {
  canonicalMcpResource,
  isMcpPatClientId,
  MCP_PAT_GRANT_REFERENCE,
  MCP_PAT_MAX_ACTIVE_PER_USER,
  mcpPatClientId,
} from "@ws-model-proxy/auth/mcp-config";
import { deriveMcpConsentReferenceId } from "@ws-model-proxy/auth/mcp-grant";
import {
  type AgentAccessNarrowedEvent,
  assertOwnedAgentNodes,
  MCP_GRANT_ACCESS_AUDIT,
  mcpGrantAccessOf,
  mcpGrantAccessSelect,
  setActiveMcpGrantAccess,
} from "@ws-model-proxy/auth/mcp-grant-access";
import { hasProvedEmail } from "@ws-model-proxy/auth/proved-email";
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
import { sweepPendingAuthorizationCodes } from "../lib/oauth-code-sweep";
import { isUniqueViolation, notFound, refuse, refuseAbout } from "../lib/refuse";
import { runSerializableTransaction } from "../lib/serializable-transaction";
import { deliverInvite, writeInvite } from "../lib/share-invite-write";
import { pendingInviteWhere } from "../lib/share-invites";

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

async function notifyNarrowed(context: Context, event: AgentAccessNarrowedEvent): Promise<void> {
  try {
    await context.services?.onAgentAccessNarrowed?.(event);
  } catch (error) {
    console.error(
      "[access] ending a narrowed credential's work failed",
      error instanceof Error ? error.constructor.name : typeof error,
    );
  }
}
async function validateAgentNodes(
  tx: Prisma.TransactionClient,
  userId: string,
  nodeIds: readonly string[] | null,
): Promise<void> {
  try {
    await assertOwnedAgentNodes(tx, userId, nodeIds);
  } catch (error) {
    if (error instanceof Error && error.message === "One or more selected nodes do not exist.")
      throw notFound("That node does not exist.");
    throw error;
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
      if (!(await hasLiveCredentialSession(tx, userId, context.session.session.id)))
        throw new ORPCError("UNAUTHORIZED");
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
      tokens: rows.map((row) => agentTokenView(row, env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY === true)),
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
      if (expiresAt.getTime() <= now.getTime()) throw badRequest("Expiry must be in the future.");
      if (
        expiresAt.getTime() - now.getTime() >
        env.WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS * 86_400_000
      ) {
        throw badRequest(
          `Expiry must be at most ${env.WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS} days ahead.`,
        );
      }
    }
    const tokenId = newAgentTokenId();
    const secret = generateProductCredentialSecret("agentToken");
    const row = await runAccessTransaction({ owners: [userId] }, async (tx) => {
      if (!(await hasLiveCredentialSession(tx, userId, context.session.session.id)))
        throw new ORPCError("UNAUTHORIZED");
      await validateAgentNodes(tx, userId, input.nodeIds);
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
          scopes: input.scopes.map(agentScopeToDb),
          allNodes: input.nodeIds === null,
        },
        select: { id: true },
      });
      // Separate rows: `userId` belongs to both composite relations, so a nested create cannot
      // set it (the FKs then prove the node and the grant have the same owner).
      if (input.nodeIds?.length) {
        await tx.mcpGrantNode.createMany({
          data: input.nodeIds.map((nodeId) => ({ grantId: grant.id, nodeId, userId })),
        });
      }
      return tx.agentToken.create({
        data: {
          id: tokenId,
          userId,
          name: input.name,
          lookupPrefix: credentialLookupPrefix(secret),
          secretDigest: credentialDigest("agentToken", secret),
          grantId: grant.id,
          expiresAt,
        },
        select: agentTokenSelect,
      });
    });
    return { token: agentTokenView(row, env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY === true), secret };
  }),

  setAccess: contractProcedure(c.agentTokens.setAccess).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const change = await runSerializableTransaction(async (tx) => {
      const token = await tx.agentToken.findFirst({
        where: { id: input.agentTokenId, userId, ...activeWhere(new Date()) },
        select: { id: true, grant: { select: { id: true, ...mcpGrantAccessSelect } } },
      });
      if (!token) throw notFound("That key, token, connection, share or invite does not exist.");
      await validateAgentNodes(tx, userId, input.nodeIds);
      const change = await setActiveMcpGrantAccess(tx, {
        grantId: token.grant.id,
        userId,
        expected: mcpGrantAccessOf(token.grant),
        access: input,
        action: MCP_GRANT_ACCESS_AUDIT.access,
      });
      if (!change)
        throw new ORPCError("CONFLICT", {
          message: "This token changed meanwhile. Reload and try again.",
        });
      return change;
    });
    if (change.narrowed && change.before)
      await notifyNarrowed(context, {
        kind: "agent_token",
        userId,
        grantId: change.grantId,
        agentTokenId: input.agentTokenId,
        before: change.before,
        after: change.after,
      });
    return {
      scopes: [...change.after.scopes],
      nodeIds: change.after.nodeIds === null ? null : [...change.after.nodeIds],
    };
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

function generationKey(clientId: string, referenceId: string): string {
  return `${clientId}\0${referenceId}`;
}

/** OAuth ceilings are tied to the exact consent generation, never just the client. */
async function approvedGenerations(
  userId: string,
  clientIds: readonly string[],
): Promise<Map<string, AgentScope[]>> {
  if (!clientIds.length) return new Map();
  const consents = await prisma.oauthConsent.findMany({
    where: { userId, clientId: { in: [...clientIds] } },
    select: { clientId: true, referenceId: true, scopes: true },
  });
  return new Map(
    consents.flatMap((consent) =>
      consent.referenceId === null
        ? []
        : [
            [
              generationKey(consent.clientId, consent.referenceId),
              oauthScopeCeiling(consent.scopes),
            ],
          ],
    ),
  );
}

const oauthGrants = {
  list: contractProcedure(c.oauthGrants.list).handler(async ({ context }) => {
    const userId = userIdOf(context);
    const grants = await prisma.mcpGrant.findMany({
      where: { userId, NOT: { clientId: { startsWith: "pat:" } } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        clientId: true,
        referenceId: true,
        ...mcpGrantAccessSelect,
        createdAt: true,
        revokedAt: true,
      },
    });
    const clientIds = [...new Set(grants.map((grant) => grant.clientId))];
    const [clients, writeApproved] = await Promise.all([
      prisma.oauthClient.findMany({
        where: { clientId: { in: clientIds } },
        select: { clientId: true, name: true, redirectUris: true },
      }),
      approvedGenerations(userId, clientIds),
    ]);
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
            scopes: [...mcpGrantAccessOf(grant).scopes],
            nodeIds: grant.allNodes ? null : grant.Nodes.map((node) => node.nodeId),
            availableScopes: writeApproved.get(
              generationKey(grant.clientId, grant.referenceId),
            ) ?? ["read"],
            currentSession:
              grant.referenceId ===
              deriveMcpConsentReferenceId({
                secret: env.BETTER_AUTH_SECRET,
                sessionId: context.session.session.id,
                clientId: grant.clientId,
              }),
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
    // Revoke every live token this client holds for the person and forget the consent (so
    // reconnecting asks again), under the person's fence; every write names the person.
    await runAccessTransaction({ owners: [userId] }, async (tx) => {
      await tx.mcpGrant.updateMany({
        where: { id: grant.id, userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.oauthRefreshToken.updateMany({
        where: { userId, clientId: grant.clientId, revoked: null },
        data: { revoked: now },
      });
      await tx.oauthAccessToken.updateMany({
        where: { userId, clientId: grant.clientId, revoked: null },
        data: { revoked: now },
      });
      await tx.oauthConsent.deleteMany({ where: { userId, clientId: grant.clientId } });
    });
    if (!grant.revokedAt) {
      await notifyRevoked(context, {
        kind: "oauth_grant",
        userId,
        grantId: grant.id,
        clientId: grant.clientId,
      });
    }
    // Then drop the client's pending authorization codes, which could otherwise still be
    // exchanged. Its own step, so rows it cannot clear (fail closed: CONFLICT, retry) never
    // hold back the token revocation above; a retry runs the whole revoke again.
    await runAccessTransaction({ owners: [userId] }, (tx) =>
      sweepPendingAuthorizationCodes(tx, { userId, clientId: grant.clientId, now }),
    );
    return { ok: true as const };
  }),

  setAccess: contractProcedure(c.oauthGrants.setAccess).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const change = await runSerializableTransaction(async (tx) => {
      const grant = await tx.mcpGrant.findFirst({
        where: { id: input.grantId, userId, revokedAt: null },
        select: { id: true, clientId: true, referenceId: true, ...mcpGrantAccessSelect },
      });
      if (!grant || isMcpPatClientId(grant.clientId))
        throw notFound("That key, token, connection, share or invite does not exist.");
      const consent = await tx.oauthConsent.findFirst({
        where: { userId, clientId: grant.clientId, referenceId: grant.referenceId },
        select: { scopes: true },
      });
      const ceiling = oauthScopeCeiling(consent?.scopes ?? []);
      if (input.scopes.some((scope) => !ceiling.includes(scope)))
        throw badRequest(
          "This agent did not request those OAuth scopes. Reconnect it with the required scopes.",
        );
      await validateAgentNodes(tx, userId, input.nodeIds);
      const change = await setActiveMcpGrantAccess(tx, {
        grantId: grant.id,
        userId,
        expected: mcpGrantAccessOf(grant),
        access: input,
        action: MCP_GRANT_ACCESS_AUDIT.access,
      });
      if (!change)
        throw new ORPCError("CONFLICT", {
          message: "This connection changed meanwhile. Reload and try again.",
        });
      return change;
    });
    if (change.narrowed && change.before)
      await notifyNarrowed(context, {
        kind: "oauth_grant",
        userId,
        grantId: change.grantId,
        agentTokenId: null,
        before: change.before,
        after: change.after,
      });
    return {
      scopes: [...change.after.scopes],
      nodeIds: change.after.nodeIds === null ? null : [...change.after.nodeIds],
    };
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
      select: { id: true, email: true, provedEmail: true },
    });
    // Only an account whose mailbox the verify-email flow proved gets the share directly.
    // `emailVerified` is no proof: it is forced true without SMTP (anyone may register the
    // address) and for admin-created accounts. Anyone else gets an invite that needs its link.
    const grantee = account && hasProvedEmail(account) ? account : null;
    if (!grantee) {
      if (input.monthlyCap !== null || input.protectionPercent !== null) {
        throw badRequest(
          "A monthly cap and warm protection are set on the share once this person has an account.",
        );
      }
      const written = await writeInvite({
        mode: "create",
        ownerUserId,
        target: {
          kind: "pool",
          poolId: pool.id,
          settings: {
            canUse: input.canUse,
            canContribute: input.canContribute,
            priorityClass: input.priorityClass,
          },
        },
        email,
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
        // The share replaces a pending invite to this address: its link stops working.
        await tx.shareInvite.updateMany({
          where: { poolId: pool.id, email, ownerUserId, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
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
        throw refuse(
          "already_shared",
          "This pool is already shared with this person. Change the existing share.",
        );
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
      const model =
        input.providerModelId === null
          ? null
          : await tx.providerModel.findFirst({
              where: { id: input.providerModelId, userId: granteeUserId, deletedAt: null },
              select: { id: true, type: true },
            });
      if (input.providerModelId !== null && !model)
        throw notFound("That key, token, connection, share or invite does not exist.");
      const current = await tx.share.findFirst({
        where: { id: share.id, granteeUserId },
        select: {
          ownKeyProtocolAdaptation: true,
          Pool: {
            select: { modelType: true, Fallback: { select: { ownKeyEquivalentModel: true } } },
          },
        },
      });
      if (!current) throw notFound("That key, token, connection, share or invite does not exist.");
      if (model && model.type !== current.Pool.modelType)
        throw refuseAbout(
          "model_type_mismatch",
          model.id,
          "This model's type does not match the pool's type.",
        );
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
    const accepted = () =>
      refuse("invite_accepted", "This invite was accepted. Delete the share instead.");
    // Under the owner's fence, which every acceptance also takes: an acceptance either committed
    // before the read (refused here) or waits until this revoke commits (and then finds it
    // revoked). The count check still catches a write this read did not see.
    await runAccessTransaction({ owners: [ownerUserId] }, async (tx) => {
      const invite = await tx.shareInvite.findFirst({
        where: { id: input.inviteId, ownerUserId },
        select: { id: true, acceptedAt: true, revokedAt: true },
      });
      if (!invite) throw notFound("That key, token, connection, share or invite does not exist.");
      if (invite.acceptedAt) throw accepted();
      if (invite.revokedAt) return;
      const revoked = await tx.shareInvite.updateMany({
        where: { id: invite.id, ownerUserId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 1) return;
      const now = await tx.shareInvite.findFirst({
        where: { id: invite.id, ownerUserId },
        select: { acceptedAt: true },
      });
      if (now?.acceptedAt) throw accepted();
    });
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
    const served = await prisma.runtimeModel.findMany({
      where: { userId, retired: false },
      orderBy: [{ runtimeId: "asc" }, { upstreamModelId: "asc" }],
      take: 500,
      select: {
        id: true,
        upstreamModelId: true,
        type: true,
        runtimeId: true,
        Runtime: { select: { name: true } },
      },
    });
    return {
      servedModels: served.map((model) => ({
        runtimeModelId: model.id,
        upstreamModelId: model.upstreamModelId,
        type: model.type,
        runtimeId: model.runtimeId,
        runtimeName: model.Runtime.name,
      })),
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

/** Row → view serializers for the Access procedures (`contracts/access.ts`). */
import type { Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import type {
  agentTokenViewSchema,
  apiKeyViewSchema,
  shareInviteTargetSchema,
  shareInviteViewSchema,
  shareViewSchema,
} from "../contracts/access";

export function iso(date: Date): string {
  return date.toISOString();
}

export function isoOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** A pool's callable id: `<owner slug>/<pool slug>`. */
export function callableIdOf(ownerSlug: string, poolSlug: string): string {
  return `${ownerSlug}/${poolSlug}`;
}

/**
 * A Prisma Decimal (or anything with `toFixed`) as the contract's money string: plain digits,
 * at most 9 decimals, no exponent, no trailing zeros.
 */
export function moneyString(
  value: { toFixed(digits?: number): string } | null | undefined,
): string {
  if (!value) return "0";
  const fixed = value.toFixed(9);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}

export const apiKeySelect = {
  id: true,
  name: true,
  scope: true,
  lookupPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  Pools: { select: { poolId: true } },
} satisfies Prisma.ApiKeySelect;
export type ApiKeyRow = Prisma.ApiKeyGetPayload<{ select: typeof apiKeySelect }>;

export function apiKeyView(row: ApiKeyRow): z.infer<typeof apiKeyViewSchema> {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    poolIds: row.Pools.map((pool) => pool.poolId),
    lookupPrefix: row.lookupPrefix,
    createdAt: iso(row.createdAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    expiresAt: isoOrNull(row.expiresAt),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

export const agentTokenSelect = {
  id: true,
  name: true,
  level: true,
  lookupPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
} satisfies Prisma.AgentTokenSelect;
export type AgentTokenRow = Prisma.AgentTokenGetPayload<{ select: typeof agentTokenSelect }>;

export function agentTokenView(row: AgentTokenRow): z.infer<typeof agentTokenViewSchema> {
  return {
    id: row.id,
    name: row.name,
    level: row.level,
    lookupPrefix: row.lookupPrefix,
    createdAt: iso(row.createdAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    expiresAt: isoOrNull(row.expiresAt),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

export const shareSelect = {
  id: true,
  poolId: true,
  canUse: true,
  canContribute: true,
  priorityClass: true,
  protectionPercent: true,
  ownKeyProviderModelId: true,
  ownKeyProtocolAdaptation: true,
  createdAt: true,
  Pool: { select: { slug: true, Fallback: { select: { ownKeyEquivalentModel: true } } } },
  Owner: { select: { email: true, slug: true } },
  Grantee: { select: { email: true } },
  SpendCap: { select: { id: true, monthlyLimit: true, currency: true } },
  _count: { select: { Contributed: true } },
} satisfies Prisma.ShareSelect;
export type ShareRow = Prisma.ShareGetPayload<{ select: typeof shareSelect }>;

export function shareView(
  row: ShareRow,
  spentThisMonth: ReadonlyMap<string, string>,
): z.infer<typeof shareViewSchema> {
  return {
    id: row.id,
    poolId: row.poolId,
    callableId: callableIdOf(row.Owner.slug, row.Pool.slug),
    ownerEmail: row.Owner.email,
    granteeEmail: row.Grantee.email,
    canUse: row.canUse,
    canContribute: row.canContribute,
    priorityClass: row.priorityClass,
    protectionPercent: row.protectionPercent,
    monthlyCap: row.SpendCap
      ? {
          limit: moneyString(row.SpendCap.monthlyLimit),
          currency: row.SpendCap.currency,
          spentThisMonth: spentThisMonth.get(row.SpendCap.id) ?? "0",
        }
      : null,
    ownKeyEquivalentModel: row.Pool.Fallback?.ownKeyEquivalentModel ?? null,
    ownKeyProviderModelId: row.ownKeyProviderModelId,
    ownKeyProtocolAdaptation: row.ownKeyProtocolAdaptation,
    contributedMembers: row._count.Contributed,
    createdAt: iso(row.createdAt),
  };
}

export const shareInviteSelect = {
  id: true,
  poolId: true,
  runtimeId: true,
  email: true,
  canUse: true,
  canContribute: true,
  priorityClass: true,
  createdAt: true,
  expiresAt: true,
  emailSentAt: true,
  Pool: { select: { slug: true, User: { select: { slug: true } } } },
  Runtime: { select: { name: true } },
} satisfies Prisma.ShareInviteSelect;
export type ShareInviteRow = Prisma.ShareInviteGetPayload<{ select: typeof shareInviteSelect }>;
type ShareInviteTarget = z.infer<typeof shareInviteTargetSchema>;

/** What an invite shares (the hardening keeps exactly one of pool and runtime). */
export function shareInviteTarget(row: {
  poolId: string | null;
  runtimeId: string | null;
  Pool: { slug: string; User: { slug: string } } | null;
  Runtime: { name: string } | null;
}): ShareInviteTarget {
  if (row.poolId !== null && row.Pool)
    return {
      kind: "pool",
      poolId: row.poolId,
      callableId: callableIdOf(row.Pool.User.slug, row.Pool.slug),
    };
  if (row.runtimeId !== null && row.Runtime)
    return { kind: "runtime", runtimeId: row.runtimeId, name: row.Runtime.name };
  throw new Error("share invite without a target");
}

export function shareInviteView(row: ShareInviteRow): z.infer<typeof shareInviteViewSchema> {
  return {
    id: row.id,
    target: shareInviteTarget(row),
    email: row.email,
    canUse: row.canUse,
    canContribute: row.canContribute,
    priorityClass: row.priorityClass,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    emailSentAt: isoOrNull(row.emailSentAt),
  };
}

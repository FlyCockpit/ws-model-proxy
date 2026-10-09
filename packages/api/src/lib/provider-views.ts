/**
 * Provider account/model views and spend sums (`contracts/providers.ts`). Secrets never leave
 * the database: views carry the credential's status and last four characters only.
 */
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { providerAccountSpend } from "@ws-model-proxy/db/spend";
import type { z } from "zod";
import type {
  providerAccountViewSchema,
  providerModelViewSchema,
  spendViewSchema,
} from "../contracts/providers";
import { jsonObject } from "./registry-view";

/** A Decimal(30,9) (or its string) as the contract's money string: no exponent, ≤ 9 decimals. */
export function moneyString(
  value: { toFixed(digits?: number): string } | string | null | undefined,
) {
  if (value === null || value === undefined) return "0";
  const text = typeof value === "string" ? value : value.toFixed(9);
  const [whole = "0", fraction = ""] = text.split(".");
  const trimmed = fraction.slice(0, 9).replace(/0+$/, "");
  const normalizedWhole = whole.replace(/^(-?)0+(?=\d)/, "$1");
  const result = trimmed ? `${normalizedWhole}.${trimmed}` : normalizedWhole;
  return result === "-0" ? "0" : result;
}

export const ACCOUNT_SELECT = {
  id: true,
  providerType: true,
  label: true,
  baseUrl: true,
  authType: true,
  enabled: true,
  allowDataCollection: true,
  health: true,
  healthCheckedAt: true,
  createdAt: true,
  CurrentCredential: {
    select: { id: true, status: true, displaySuffix: true, lastUsedAt: true },
  },
  SpendCap: { select: { id: true, monthlyLimit: true, currency: true } },
} as const satisfies Prisma.ProviderAccountSelect;
export type AccountRow = Prisma.ProviderAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

type SpendView = z.infer<typeof spendViewSchema>;

/**
 * This month's settled spend and the live reservations through the account, in the cap's
 * currency (USD when uncapped): the revision-correct read the cap enforcement uses
 * (`@ws-model-proxy/db/spend`), so a superseded ledger snapshot is never counted twice.
 */
export async function spendFor(account: Pick<AccountRow, "id" | "SpendCap">): Promise<SpendView> {
  const currency = account.SpendCap?.currency ?? "USD";
  const usage = await providerAccountSpend(prisma, { providerAccountId: account.id, currency });
  return {
    monthlyLimit: account.SpendCap ? moneyString(account.SpendCap.monthlyLimit) : null,
    currency,
    spentThisMonth: moneyString(usage.spentThisMonth),
    reservedNow: moneyString(usage.reservedNow),
  };
}

export async function accountView(
  account: AccountRow,
): Promise<z.infer<typeof providerAccountViewSchema>> {
  return {
    id: account.id,
    providerType: account.providerType === "openrouter" ? "openrouter" : "generic",
    label: account.label,
    baseUrl: account.baseUrl,
    authType: account.authType,
    enabled: account.enabled,
    allowDataCollection: account.allowDataCollection,
    health: account.health,
    healthCheckedAt: account.healthCheckedAt?.toISOString() ?? null,
    credential: account.CurrentCredential
      ? {
          id: account.CurrentCredential.id,
          status: account.CurrentCredential.status,
          displaySuffix: account.CurrentCredential.displaySuffix,
          lastUsedAt: account.CurrentCredential.lastUsedAt?.toISOString() ?? null,
        }
      : null,
    spend: await spendFor(account),
    createdAt: account.createdAt.toISOString(),
  };
}

export const MODEL_SELECT = {
  id: true,
  providerAccountId: true,
  upstreamModelId: true,
  displayName: true,
  type: true,
  enabled: true,
  health: true,
  contextWindow: true,
  maxOutputTokens: true,
  PricingVersions: {
    where: { status: "ACTIVE" },
    orderBy: { effectiveAt: "desc" },
    take: 1,
    select: { pricing: true, currency: true },
  },
} as const satisfies Prisma.ProviderModelSelect;
export type ModelRow = Prisma.ProviderModelGetPayload<{ select: typeof MODEL_SELECT }>;

function priceOf(row: ModelRow) {
  const active = row.PricingVersions[0];
  if (!active) return null;
  const pricing = jsonObject(jsonObject(active.pricing).ratesPerMillion);
  const input = pricing.input;
  const output = pricing.output;
  if (typeof input !== "string" || typeof output !== "string") return null;
  return { input: moneyString(input), output: moneyString(output), currency: active.currency };
}

export function modelView(row: ModelRow): z.infer<typeof providerModelViewSchema> {
  return {
    id: row.id,
    providerAccountId: row.providerAccountId,
    upstreamModelId: row.upstreamModelId,
    displayName: row.displayName,
    type: row.type,
    enabled: row.enabled,
    health: row.health,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    price: priceOf(row),
  };
}

import { ORPCError } from "@orpc/server";
import {
  CLI_DEVICE_NAME_MAX_LENGTH,
  cliDeviceNameIssue,
} from "@ws-model-proxy/config/cli-device-name";
import {
  validateForwarderPoolSlug,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import { MEDIA_ATTACHMENT_MAX_BYTES_MAX } from "@ws-model-proxy/config/media-policy";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import {
  assertEffectiveConcurrencyPolicy,
  type CapacityPolicyFailureReasons,
} from "../lib/capacity-policy-safety";
import type { GuardedPoolCreateFailureReason } from "../lib/guarded-pool-create-reasons";
import {
  getConfiguredMediaAttachmentMaxBytes,
  resolveAttachmentLimit,
} from "../lib/media-attachment-limits";
import { poolMemberRoutingStatuses } from "../lib/model-pool-routing";

export const slugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: `forwarderSlug.${result.reason}` });
    }
  });

export const poolSlugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderPoolSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: "forwarderSlug." + result.reason });
    }
  });

export const poolNameSchema = z.string().trim().min(1).max(120);
export const poolDescriptionSchema = z.string().trim().max(1000).nullable().optional();
export const idSchema = z.string().min(1);
const CLI_DEVICE_NAME_ISSUE_MESSAGES = {
  empty: "CLI device name must not be blank; send null to clear it.",
  tooLong: `CLI device name must be at most ${CLI_DEVICE_NAME_MAX_LENGTH} characters.`,
  invisibleCharacters:
    "CLI device name must not contain control or invisible formatting characters.",
} as const;
/**
 * A user-set CLI device name; null clears it. Validated by the shared
 * `cliDeviceNameIssue` policy (also used by the dashboard form).
 */
export const cliDeviceNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const issue = cliDeviceNameIssue(name);
    if (issue) ctx.addIssue({ code: "custom", message: CLI_DEVICE_NAME_ISSUE_MESSAGES[issue] });
  })
  .nullable();
export const routingStatusSchema = z.enum(poolMemberRoutingStatuses);
export const poolRecommendedSurfaceSchema = z.enum([
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
]);
export const attachmentLimitSchema = z
  .number()
  .int()
  .positive()
  .max(MEDIA_ATTACHMENT_MAX_BYTES_MAX)
  .nullable()
  .optional();
export const poolTransformerFields = {
  transformerDiscoveredModelId: z.string().min(1).nullable().optional(),
  transformerSystemPrompt: z.string().max(16_000).nullable().optional(),
  transformerImages: z.boolean().optional(),
  transformerAudio: z.boolean().optional(),
  transformerVideo: z.boolean().optional(),
  transformerCacheMode: z.enum(["OFF", "MEMORY"]).optional(),
  transformerIncludePrimaryTools: z.boolean().optional(),
  transformerMaxTools: z.number().int().min(1).max(128).optional(),
  transformerMaxToolChars: z.number().int().min(256).max(32_000).optional(),
  transformerTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
  transformerMaxAssets: z.number().int().min(1).max(64).nullable().optional(),
};

export function hasModelPoolCapacityPolicy(input: Record<string, unknown>): boolean {
  return (
    input.capacityPriority !== undefined ||
    input.capacityConcurrencyLimit !== undefined ||
    input.capacityReservedSlots !== undefined ||
    input.capacityBorrowPolicy !== undefined ||
    input.capacityWaitBudgetMs !== undefined ||
    input.capacityContextCeiling !== undefined ||
    input.capacityContextMargin !== undefined
  );
}

export function assertLossyDeveloperRoleCollapseRequiresAdaptation(
  {
    protocolAdaptationEnabled,
    allowLossyDeveloperRoleCollapse,
  }: {
    protocolAdaptationEnabled: boolean;
    allowLossyDeveloperRoleCollapse: boolean;
  },
  reason?: GuardedPoolCreateFailureReason,
): void {
  if (allowLossyDeveloperRoleCollapse && !protocolAdaptationEnabled) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Lossy developer-role collapse requires protocol adaptation to be enabled.",
      data: {
        fields: ["allowLossyDeveloperRoleCollapse", "protocolAdaptationEnabled"],
        ...(reason !== undefined ? { reason } : {}),
      },
    });
  }
}

/** Owner fallback settings on the pool create/update procedures (and MCP pool update). */
export const poolFallbackFields = {
  /** Owner allows external fallback for `owner/pool:external` requests. */
  fallbackEnabled: z.boolean().optional(),
  /** Owner pays for grantees' external fallback. Off by default. */
  fallbackForGrantees: z.boolean().optional(),
  /** How long an `:external` request waits for local capacity (0 = only if free now). */
  externalAfterWaitMs: z.number().int().min(0).max(600_000).optional(),
};

/**
 * Warm-session protection settings (saturation S-C): ordinary owner pool
 * settings, also writable through the MCP pool tools. Redirect-only; no value
 * can make a pool sit idle.
 */
export const poolProtectionFields = {
  protectionEnabled: z.boolean().optional(),
  /** Keep protection but freeze eviction-derived effective K. Default on. */
  evictionFeedbackEnabled: z.boolean().optional(),
  /** Only sessions used within this window are protected (seconds). */
  protectionWindowSeconds: z.number().int().min(1).max(3600).optional(),
  /** Only sessions of at least this many prompt tokens are protected. */
  protectMinTokens: z.number().int().min(0).max(10_000_000).optional(),
  protectionShare: z.enum(["EQUAL_SHARE", "FIRST_COME", "FIXED_PERCENT"]).optional(),
  /** Per-user percent for FIXED_PERCENT (required then; cleared otherwise). */
  protectionFixedPercent: z.number().int().min(1).max(100).nullable().optional(),
  /** The owner's own share: null = share mode, 0 = unprotected, 1..100 = percent. */
  ownerProtectionPercent: z.number().int().min(0).max(100).nullable().optional(),
};

type PoolProtectionShare = "EQUAL_SHARE" | "FIRST_COME" | "FIXED_PERCENT";

/**
 * The share mode and fixed percent a save leaves on the pool: FIXED_PERCENT
 * needs a percent, and every other mode stores none. Returns the fields to
 * write (empty when the save touches neither).
 */
export function resolvePoolProtectionShare(
  input: {
    protectionShare?: PoolProtectionShare;
    protectionFixedPercent?: number | null;
  },
  current: { protectionShare: PoolProtectionShare; protectionFixedPercent: number | null },
): { protectionShare?: PoolProtectionShare; protectionFixedPercent?: number | null } {
  if (input.protectionShare === undefined && input.protectionFixedPercent === undefined) return {};
  const share = input.protectionShare ?? current.protectionShare;
  const fixed =
    input.protectionFixedPercent !== undefined
      ? input.protectionFixedPercent
      : current.protectionFixedPercent;
  if (share !== "FIXED_PERCENT") return { protectionShare: share, protectionFixedPercent: null };
  if (fixed === null)
    throw new ORPCError("BAD_REQUEST", {
      message: "The fixed-percent protection share needs a percent from 1 to 100.",
      data: { fields: ["protectionFixedPercent", "protectionShare"] },
    });
  return { protectionShare: share, protectionFixedPercent: fixed };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function createPoolMember<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ORPCError("CONFLICT", {
        message: "That model is already a member of this pool.",
        cause: error,
      });
    }
    throw error;
  }
}

export function assertConcurrencyPolicyWithinHardLimit(
  input: {
    hardLimit: number | null | undefined;
    poolLimit: number | null;
    poolReserved: number;
    memberMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
    memberLimit?: number | null;
    memberReserved?: number | null;
  },
  reasons?: CapacityPolicyFailureReasons,
): void {
  assertEffectiveConcurrencyPolicy(input, reasons);
}

/** MCP list page size. A short page is the end; `nextCursor` continues. */
const SUMMARY_PAGE_DEFAULT = 20;
const SUMMARY_PAGE_MAX = 50;

export const summaryPageInput = z.object({
  limit: z.number().int().min(1).max(SUMMARY_PAGE_MAX).default(SUMMARY_PAGE_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
});

/** Keyset cursor over `(createdAt desc, id desc)`: `<epoch ms>.<id>`. */
export function encodeSummaryCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

function decodeSummaryCursor(cursor: string): { createdAt: Date; id: string } {
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{1,128})$/.exec(cursor);
  const createdAt = match?.[1] === undefined ? null : new Date(Number(match[1]));
  if (match?.[2] === undefined || createdAt === null || Number.isNaN(createdAt.getTime())) {
    throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor." });
  }
  return { createdAt, id: match[2] };
}

export function summaryPageWhere(userId: string, cursor: string | undefined) {
  if (cursor === undefined) return { userId };
  const after = decodeSummaryCursor(cursor);
  return {
    userId,
    OR: [
      { createdAt: { lt: after.createdAt } },
      { createdAt: after.createdAt, id: { lt: after.id } },
    ],
  };
}

export async function assertAttachmentLimitWithinGlobal(
  maxAttachmentBytes: number | null | undefined,
) {
  if (maxAttachmentBytes === undefined || maxAttachmentBytes === null) return;
  const globalMax = resolveAttachmentLimit({
    configuredBytes: await getConfiguredMediaAttachmentMaxBytes(),
    deploymentMaxBytes: env.MEDIA_MAX_UPLOAD_BYTES,
  });
  if (maxAttachmentBytes > globalMax) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Attachment limit cannot exceed the global attachment limit.",
    });
  }
}

export function slugValidationError(slug: string) {
  const result = validateForwarderSlug(slug);
  if (result.ok) return null;
  return new ORPCError("BAD_REQUEST", { message: `forwarderSlug.${result.reason}` });
}

export async function assertPoolSlugAvailable(
  slug: string,
  userId: string,
  currentPoolId?: string,
  reasons?: {
    invalid?: GuardedPoolCreateFailureReason;
    taken?: GuardedPoolCreateFailureReason;
  },
) {
  const validation = validateForwarderPoolSlug(slug);
  if (!validation.ok) {
    throw new ORPCError("BAD_REQUEST", {
      message: "forwarderSlug." + validation.reason,
      ...(reasons?.invalid !== undefined ? { data: { reason: reasons.invalid } } : {}),
    });
  }

  const existing = await prisma.modelPool.findUnique({
    where: { userId_slug: { userId, slug } },
    select: { id: true },
  });
  if (existing && existing.id !== currentPoolId) {
    throw new ORPCError("CONFLICT", {
      message: "Model pool slug already exists.",
      ...(reasons?.taken !== undefined ? { data: { reason: reasons.taken } } : {}),
    });
  }
}

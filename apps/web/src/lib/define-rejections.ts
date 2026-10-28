import type { TFunction } from "i18next";

/** Codes a node gives when it refuses a runtime definition (server `DEFINE_REJECT_REASONS`). */
export const DEFINE_REJECT_REASONS = [
  "trust_relay",
  "hash_mismatch",
  "invalid",
  "base_url_not_allowed",
  "env_not_allowed",
  "conflict",
  "limit",
] as const;

/** Plain-language copy for a node's define refusal; an unknown code is shown as it is. */
export function defineRejectReasonText(t: TFunction, reason: string | null): string {
  if (reason === null) return t("dashboard:runtime.defineReject.unknown");
  return (DEFINE_REJECT_REASONS as readonly string[]).includes(reason)
    ? t(`dashboard:runtime.defineReject.${reason}`)
    : t("dashboard:runtime.defineReject.other", { code: reason });
}

type DefineResult = { status: string; reason: string | null; detail?: string | null };

/**
 * A warning after a save or create when nodes refused the new version (`define[]` entries with
 * `status: "rejected"`), else null. The runtime's page lists each node with its reason.
 */
export function rejectedDefinesWarning(
  t: TFunction,
  define: readonly DefineResult[],
): string | null {
  const rejected = define.filter((entry) => entry.status === "rejected");
  if (rejected.length === 0) return null;
  const [first] = rejected;
  const values = {
    count: rejected.length,
    reason: defineRejectReasonText(t, first?.reason ?? null),
  };
  return first?.detail
    ? t("dashboard:runtime.defineReject.savedAt", { ...values, at: first.detail })
    : t("dashboard:runtime.defineReject.saved", values);
}

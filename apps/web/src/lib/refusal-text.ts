import i18n from "i18next";

import { friendly } from "@/utils/friendly-error";

/** The `data.reason` of an oRPC refusal (contracts/refusals.ts), when there is one. */
export function refusalReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data: unknown }).data;
  if (typeof data !== "object" || data === null || !("reason" in data)) return null;
  const reason = (data as { reason: unknown }).reason;
  return typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : null;
}

/**
 * Localized copy for a runtime/pool refusal (`dashboard:runtime.refusals.<reason>`), else the
 * generic friendly copy. Never shows a server message verbatim.
 */
export function refusalText(error: unknown, fallback?: string): string {
  const reason = refusalReason(error);
  const key = `dashboard:runtime.refusals.${reason}`;
  if (reason && i18n.exists(key)) return i18n.t(key);
  return friendly(error, fallback);
}

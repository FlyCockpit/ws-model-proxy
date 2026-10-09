import { toast } from "@ws-model-proxy/ui/components/sileo";
import type { TFunction } from "i18next";

import { friendly } from "@/utils/friendly-error";

/** The machine reason an API refusal carries (`data.reason`), or null. Reads codes only. */
export function refusalReasonOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = Reflect.get(error, "data");
  if (!data || typeof data !== "object") return null;
  const reason = Reflect.get(data, "reason");
  return typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : null;
}

/**
 * Keys for a refusal reason, most specific first: the node and profile copy
 * (`dashboard:refusals.*`), then the shared runtime copy (`dashboard:runtime.refusals.*`).
 */
export function refusalKeys(reason: string): string[] {
  return [`dashboard:refusals.${reason}`, `dashboard:runtime.refusals.${reason}`];
}

/** Copy for a refusal reason ({@link refusalKeys}), else the generic friendly copy. */
export function refusalMessage(t: TFunction, error: unknown, fallbackKey?: string): string {
  const reason = refusalReasonOf(error);
  const specific = reason ? t(refusalKeys(reason), { defaultValue: "" }) : "";
  if (specific) return specific;
  return friendly(error, fallbackKey ? t(fallbackKey) : undefined);
}

/**
 * Options for lane B mutations: the global toast is skipped and the refusal reason is shown
 * instead of the generic conflict copy.
 */
export function refusalToastOptions(t: TFunction, fallbackKey?: string) {
  return {
    meta: { skipGlobalErrorToast: true },
    onError: (error: unknown) => {
      toast.error(refusalMessage(t, error, fallbackKey));
    },
  } as const;
}

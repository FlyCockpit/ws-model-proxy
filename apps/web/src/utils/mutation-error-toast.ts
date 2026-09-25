import { type Mutation, MutationCache } from "@tanstack/react-query";
import { toast } from "@ws-model-proxy/ui/components/sileo";

import { deletionConflictMessageKey, friendly } from "./friendly-error";

type Translate = (key: string) => string;

/**
 * Copy for a failed mutation's global error toast: a delete mutation that
 * declares `meta.deletionEntity` gets the localized copy for a structured
 * deletion CONFLICT (retained history, requests in flight, …); everything
 * else — including a CONFLICT without a known reason — gets `friendly()`
 * with the mutation's optional `errorFallbackKey`.
 */
export function mutationErrorMessage(
  error: unknown,
  meta: Mutation["meta"],
  translate: Translate,
): string {
  if (meta?.deletionEntity) {
    const key = deletionConflictMessageKey(error, meta.deletionEntity);
    if (key) return translate(key);
  }
  const fallback = meta?.errorFallbackKey ? translate(meta.errorFallbackKey) : undefined;
  return friendly(error, fallback);
}

/**
 * The app's MutationCache: surfaces mutation failures by default so no action
 * ever fails silently. Mutations that handle their own errors (e.g. inline
 * form errors) opt out with `meta: { skipGlobalErrorToast: true }`.
 */
export function createAppMutationCache(translate: Translate): MutationCache {
  return new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.meta?.skipGlobalErrorToast) return;
      toast.error(mutationErrorMessage(error, mutation.meta, translate));
    },
  });
}

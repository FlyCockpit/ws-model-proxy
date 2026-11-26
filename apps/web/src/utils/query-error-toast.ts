import { type Query, QueryCache, type QueryClient } from "@tanstack/react-query";
import { toast } from "@ws-model-proxy/ui/lib/toast";

import { skipErrorToastForIdentity } from "@/lib/document-identity";

import { friendly } from "./friendly-error";

type Translate = (key: string) => string;
type AppQuery = Query<unknown, unknown, unknown>;

/**
 * The app's QueryCache: surfaces query failures by default so no read ever
 * fails silently. A query that owns its error UI opts out with
 * `meta: { skipGlobalErrorToast: true }` — the device approval page renders a
 * structured refusal card (or an inline load error) instead of a generic toast
 * over the same read failure. Before any opt-out, a 401 asks Better Auth to
 * check the session once instead of toasting (a session lost elsewhere then
 * replaces the document, lib/document-identity.ts), and nothing toasts once
 * the document is being replaced.
 */
export function createAppQueryCache(
  translate: Translate,
  invalidate: (query: AppQuery) => void,
): QueryCache {
  return new QueryCache({
    onError: (error, query) => {
      if (skipErrorToastForIdentity(error, "query")) return;
      if (query.meta?.skipGlobalErrorToast) return;
      toast.error(friendly(error), {
        action: {
          label: translate("common:actions.retry"),
          onClick: () => invalidate(query),
        },
      });
    },
  });
}

/**
 * The global toast's Retry action: refetch exactly the failed query (only if
 * it is still observed; a disabled or unmounted query stays idle).
 */
export function retryQueryWith(client: QueryClient): (query: AppQuery) => void {
  return (query) => {
    void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
  };
}

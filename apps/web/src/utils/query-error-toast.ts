import { type Query, QueryCache } from "@tanstack/react-query";
import { toast } from "@ws-model-proxy/ui/components/sileo";

import { friendly } from "./friendly-error";

type Translate = (key: string) => string;
type AppQuery = Query<unknown, unknown, unknown>;

/**
 * The app's QueryCache: surfaces query failures by default so no read ever
 * fails silently. A query that owns its error UI opts out with
 * `meta: { skipGlobalErrorToast: true }` — the device approval page renders a
 * structured refusal card (or an inline load error) instead of a generic toast
 * over the same read failure.
 */
export function createAppQueryCache(
  translate: Translate,
  invalidate: (query: AppQuery) => void,
): QueryCache {
  return new QueryCache({
    onError: (error, query) => {
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

import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

import ErrorState from "./components/error-state";
import Loader from "./components/loader";
import i18n from "./i18n";
import { MAIN_SCROLLER_SELECTOR } from "./lib/main-scroller";
import { routeTree } from "./routeTree.gen";
import { type DeletionEntity } from "./utils/friendly-error";
import { createAppMutationCache } from "./utils/mutation-error-toast";
import { orpc } from "./utils/orpc";
import { createAppQueryCache, retryQueryWith } from "./utils/query-error-toast";
import { shouldRetryQuery } from "./utils/query-retry";

// Read the per-request CSP nonce forwarded by the API server on the
// `x-csp-nonce` request header (set in apps/server/src/index.ts). Server-only:
// createIsomorphicFn strips the `.server()` branch — and its server-only
// import — from the client bundle, so this is safe in this shared module.
const getCspNonce = createIsomorphicFn()
  .server(() => getRequestHeader("x-csp-nonce") ?? undefined)
  .client(() => undefined);

export function getRouter() {
  // Retry needs the client, which owns this cache; resolved on click.
  const retryQuery: Parameters<typeof createAppQueryCache>[1] = (query) =>
    retryQueryWith(queryClient)(query);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery, staleTime: 1000 * 60 * 5 },
    },
    // Surface query failures by default so no read fails silently. A query
    // that renders its own error UI opts out with
    // `meta: { skipGlobalErrorToast: true }` (utils/query-error-toast).
    queryCache: createAppQueryCache(
      (key) => i18n.t(key),
      (query) => retryQuery(query),
    ),
    // Surface mutation failures by default so no action ever fails silently.
    // Mutations that handle their own errors (e.g. inline form errors) can
    // opt out with `useMutation({ meta: { skipGlobalErrorToast: true } })`.
    // Mutations that just want context-specific fallback copy (instead of the
    // generic "Something didn't work") set
    // `meta: { errorFallbackKey: "ns:key" }` — no per-call onError toast.
    // Delete mutations set `meta: { deletionEntity }` so a structured
    // deletion CONFLICT shows its specific copy (utils/mutation-error-toast).
    mutationCache: createAppMutationCache((key) => i18n.t(key)),
  });

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: () => <Loader />,
    defaultErrorComponent: ErrorState,
    context: { orpc, queryClient },
    // The document never scrolls; <main> does. Back/forward restore its position (keyed by
    // its data-scroll-restoration-id) and a new navigation starts it at the top. In-page
    // search-param updates pass `resetScroll: false` to keep the reader's place.
    scrollRestoration: true,
    scrollToTopSelectors: [MAIN_SCROLLER_SELECTOR],
    // `#id` targets are revealed by useHashTargetScroll (root component), which waits for gated
    // content to mount and leaves back/forward to the restored position.
    defaultHashScrollIntoView: false,
    // CSP nonce for SSR-injected inline scripts (hydration, etc.). Matches the
    // nonce in the script-src CSP header set by the API server. undefined on
    // the client (the document already carries the server-rendered nonce).
    ssr: { nonce: getCspNonce() },
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
  interface StaticDataRouteOption {
    /**
     * Dashboard page geometry. "fill" pages (terminals, chat test) own the
     * whole content pane; everything else renders in the padded container.
     */
    dashboardLayout?: "padded" | "fill";
  }
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /** Suppress the global error toast for this query. */
      skipGlobalErrorToast?: boolean;
    };
    mutationMeta: {
      /** Suppress the global error toast for this mutation. */
      skipGlobalErrorToast?: boolean;
      /**
       * i18n key resolved (outside React, via the app i18n instance) and
       * passed to `friendly()` as the context-specific fallback copy for the
       * global error toast. Use this instead of a per-call `onError` that only
       * called `toast.error(friendly(err, t("ns:key")))`.
       */
      errorFallbackKey?: string;
      /**
       * Set on delete mutations: a CONFLICT carrying a structured deletion
       * reason (`data.reason`) toasts the entity's specific copy instead of
       * the generic conflict message.
       */
      deletionEntity?: DeletionEntity;
    };
  }
}

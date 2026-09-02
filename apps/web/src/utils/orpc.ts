import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  ClientRetryPlugin,
  DedupeRequestsPlugin,
  SimpleCsrfProtectionLinkPlugin,
} from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { env } from "@ws-model-proxy/env/web";
import { createRpcBatchLinkPlugin } from "./rpc-batch-link";

const link = new RPCLink({
  url: `${env.VITE_SERVER_URL}/rpc`,
  plugins: [
    new SimpleCsrfProtectionLinkPlugin(),
    createRpcBatchLinkPlugin(),
    new DedupeRequestsPlugin({ groups: [{ condition: () => true, context: {} }] }),
    // ClientRetryPlugin only retries procedures that explicitly opt in via
    // `context: { retry: N }`. No procedure in this app opts in, so 429s are
    // never silently retried here — the global error handler in router.tsx
    // surfaces them as a friendly toast instead.
    new ClientRetryPlugin(),
  ],
  fetch(url, options) {
    return fetch(url, {
      ...options,
      credentials: "include",
    });
  },
});

const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);

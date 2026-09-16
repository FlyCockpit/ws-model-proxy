// Load root `.env` before any workspace import validates process.env.
// Production injects env vars and has no `.env` file — this is a local-dev no-op there.
import "@ws-model-proxy/env/load-dotenv";

import { serve } from "@hono/node-server";
import { auth } from "@ws-model-proxy/auth";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { installBetterCallErrorLogShim } from "./better-call-error-log-shim.js";
import { startMediaCleanup } from "./media/cleanup.js";
import { startCacheAffinityCleanup } from "./model-api/cache-affinity-runtime.js";
import {
  providerAttemptExpiryEnabled,
  startProviderAttemptExpiry,
} from "./model-api/provider-attempt-lifecycle.js";
import { startProviderBudgetRepair } from "./model-api/provider-budget-runtime.js";
import { startRelayTelemetryRecovery } from "./model-api/relay-telemetry-recovery.js";
import { RELAY_SUBPROTOCOL } from "./relay/protocol.js";
import { relaySessionManager } from "./relay/session-manager.js";

// ---------------------------------------------------------------------------
// Startup guards
// ---------------------------------------------------------------------------

// Sanitize better-call's unconditional `console.error('# SERVER_ERROR: ',
// error)` fallback (raw error objects would hit the logs verbatim). Must run
// before ANY request handling; see better-call-error-log-shim.ts for the
// removal condition (TEMPORARY shim).
installBetterCallErrorLogShim();

// Reject wildcard CORS origin — it disables credential support and effectively
// opens the API to any website. Fail hard at startup so the misconfiguration
// is caught immediately in staging/CI, not silently in production.
if (env.CORS_ORIGIN === "*") {
  console.error(
    "[server] FATAL: CORS_ORIGIN must not be '*'. Set it to the exact origin of your frontend (e.g. https://app.example.com).",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App construction (middleware + routes live in ./app.ts — createApp)
// ---------------------------------------------------------------------------

const { app, capacityLifecycle } = await createApp({ prisma, auth });

// ---------------------------------------------------------------------------
// Startup retry — wait for Postgres before accepting traffic
// ---------------------------------------------------------------------------

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

async function waitForDependencies() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("[server] Postgres is reachable.");
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error("[server] FATAL: Postgres not reachable after max retries. Exiting.");
        process.exit(1);
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[server] Postgres not ready (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms…`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

await waitForDependencies();

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

const DRAIN_TIMEOUT_MS = 10_000;
const serverPort = env.SERVER_PORT ?? env.PORT ?? 3000;

const server = serve(
  {
    fetch: app.fetch,
    port: serverPort,
    websocket: {
      server: new WebSocketServer({
        noServer: true,
        handleProtocols(protocols) {
          return protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false;
        },
      }),
    },
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

// Ephemeral media cleanup — hourly in-process sweep of expired assets (rows +
// bytes). No-op when media storage is not configured. Complements the lazy
// delete-on-GET in media/routes.ts.
const stopMediaCleanup = startMediaCleanup();
const stopCacheAffinityCleanup = startCacheAffinityCleanup();
const stopRelayTelemetryRecovery = startRelayTelemetryRecovery();
const stopProviderBudgetRepair = startProviderBudgetRepair();
const stopProviderAttemptExpiry = providerAttemptExpiryEnabled(
  env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
)
  ? startProviderAttemptExpiry()
  : undefined;

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight requests, then close dependencies
// ---------------------------------------------------------------------------

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[server] Received ${signal} — starting graceful shutdown…`);

  // Stop the media cleanup timer so it can't fire mid-shutdown.
  stopMediaCleanup?.();
  stopCacheAffinityCleanup();
  stopRelayTelemetryRecovery();
  stopProviderBudgetRepair();
  stopProviderAttemptExpiry?.();
  relaySessionManager.dispose();
  await capacityLifecycle?.close();

  // 1. Stop accepting new connections and drain in-flight requests.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[server] Drain timeout reached, forcing close.");
      resolve();
    }, DRAIN_TIMEOUT_MS);

    server.close((err) => {
      clearTimeout(timeout);
      if (err) {
        console.error("[server] Error closing HTTP server:", err.message);
      }
      resolve();
    });
  });

  // 2. Close database connections.
  try {
    await prisma.$disconnect();
    console.log("[server] Prisma disconnected.");
  } catch (err) {
    console.error("[server] Error disconnecting Prisma:", err);
  }
  console.log("[server] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Load root `.env` before any workspace import validates process.env.
// Production injects env vars and has no `.env` file — this is a local-dev no-op there.
import "@ws-model-proxy/env/load-dotenv";

import { serve } from "@hono/node-server";
import { backfillDiscoveredInferenceCapacities } from "@ws-model-proxy/api/lib/discovered-inference-capacity";
import { auth } from "@ws-model-proxy/auth";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { installBetterCallErrorLogShim } from "./better-call-error-log-shim.js";
import {
  drainHttpWithDeadline,
  runGracefulShutdownSequence,
  runWithDeadline,
} from "./graceful-shutdown.js";
import { startOauthCleanup } from "./mcp/oauth-cleanup.js";
import { startMediaCleanup } from "./media/cleanup.js";
import { startCacheAffinityCleanup } from "./model-api/cache-affinity-runtime.js";
import {
  providerAttemptExpiryEnabled,
  startProviderAttemptExpiry,
} from "./model-api/provider-attempt-lifecycle.js";
import { startProviderBudgetRepair } from "./model-api/provider-budget-runtime.js";
import { startRelayTelemetryRecovery } from "./model-api/relay-telemetry-recovery.js";
import { startUsageRetention } from "./model-api/usage-retention.js";
import { warnMissingProviderCredentialKeyring } from "./provider-keyring-startup.js";
import { sweepExpiredTokenCommands } from "./relay/cli-commands.js";
import { RELAY_SUBPROTOCOL, RELAY_WS_MAX_PAYLOAD_BYTES } from "./relay/protocol.js";
import { relaySessionManager } from "./relay/session-manager.js";
import { terminalBrowserHub } from "./relay/terminal-websocket.js";
import { configureHttpServerTimeouts } from "./server-timeouts.js";
import { startSessionCleanup } from "./session-cleanup.js";

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

warnMissingProviderCredentialKeyring({
  egressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
  keyring: env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS,
});

// ---------------------------------------------------------------------------
// App construction (middleware + routes live in ./app.ts — createApp)
// ---------------------------------------------------------------------------

const { app, capacityLifecycle, mcpHandler, mcpAdmissionGate } = await createApp({
  prisma,
  auth,
});

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
      // Sanitized (L19): constructor name / typeof only — connection errors
      // can carry host strings and driver internals in their messages.
      console.warn(
        `[server] Postgres not ready (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms… (${
          err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err
        })`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

await waitForDependencies();

// Attach missing discovered capacities and fill a null hard limit on an
// auto-created one. Finish before listen so admission does not fail those
// requests or treat a trigger-created null as unlimited.
try {
  await backfillDiscoveredInferenceCapacities();
} catch (error) {
  console.error(
    "[server] FATAL: discovered inference capacity backfill failed.",
    error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

const DRAIN_TIMEOUT_MS = 10_000;
/** Bound on the final relay close (DB writes for CLIs still busy at drain end). */
const RELAY_CLOSE_TIMEOUT_MS = 5_000;
const serverPort = env.SERVER_PORT ?? env.PORT ?? 3000;

const server = serve(
  {
    fetch: app.fetch,
    port: serverPort,
    websocket: {
      server: new WebSocketServer({
        noServer: true,
        maxPayload: RELAY_WS_MAX_PAYLOAD_BYTES,
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

// Keep the application-side idle timeout slightly longer than the common
// reverse-proxy idle window. This prevents a proxy from selecting a socket
// Node has already closed, which otherwise surfaces as an avoidable reset.
// headersTimeout must remain greater than keepAliveTimeout (Node invariant).
configureHttpServerTimeouts(server as { keepAliveTimeout: number; headersTimeout: number });

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
// OAuth/MCP retention cleanup (Phase 8) — same periodic lifecycle as the
// jobs above; null when WMP_MCP_ENABLED is off (rollback stops token-data
// deletion). In-flight runs abort cleanly between batches via the shared DB
// shutdown fence (see mcp/oauth-cleanup.ts).
const stopOauthCleanup = startOauthCleanup();
// Better Auth does not remove expired browser sessions eagerly. This bounded,
// idempotent sweep uses the same shutdown-fenced lifecycle as OAuth cleanup.
const stopSessionCleanup = startSessionCleanup();
// Metrics retention: reaps abandoned PENDING relay requests, deletes raw
// RelayRequest rows past RELAY_REQUEST_RETENTION_DAYS, compacts minute usage
// rollups to hourly after 30 days and drops hourly rollups after 13 months.
const stopUsageRetention = startUsageRetention({
  retentionDays: env.RELAY_REQUEST_RETENTION_DAYS,
});

function startUnrefInterval(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

const stopStaleRelaySessions = startUnrefInterval(() => {
  void relaySessionManager.checkStaleSessions().catch((error: unknown) => {
    console.error(
      "[server] stale relay session sweep failed",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  });
  try {
    relaySessionManager.sweepExpiredPendingTerminals();
  } catch (error) {
    console.error(
      "[server] pending terminal sweep failed",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  }
}, 15_000);
const stopCliCommandSweep = startUnrefInterval(() => {
  try {
    sweepExpiredTokenCommands();
  } catch (error) {
    console.error(
      "[server] CLI command sweep failed",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  }
}, 60_000);
const stopTerminalSessionRecheck = startUnrefInterval(() => {
  void terminalBrowserHub.recheckSessions().catch((error: unknown) => {
    console.error(
      "[server] terminal session recheck failed",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
  });
}, 60_000);

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight requests, then close dependencies
// ---------------------------------------------------------------------------

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[server] Received ${signal} — starting graceful shutdown…`);

  await runGracefulShutdownSequence({
    // Stop the periodic jobs so they can't fire mid-shutdown.
    stopPeriodicJobs: async () => {
      stopMediaCleanup?.();
      stopCacheAffinityCleanup();
      stopRelayTelemetryRecovery();
      stopProviderBudgetRepair();
      stopProviderAttemptExpiry?.();
      stopOauthCleanup?.();
      stopSessionCleanup();
      stopUsageRetention();
      stopStaleRelaySessions();
      stopCliCommandSweep();
      stopTerminalSessionRecheck();
      relaySessionManager.dispose();
      await capacityLifecycle?.close();
    },
    closeBrowserSockets: () => {
      terminalBrowserHub.closeAll();
    },
    closeRelaySessions: () =>
      runWithDeadline(
        () => relaySessionManager.closeRelaySessions(),
        RELAY_CLOSE_TIMEOUT_MS,
        "relay session close",
      ),
    // 1. Stop accepting new connections and drain in-flight requests.
    //    ORDER: admission stops first (relay drain flag makes terminal and
    //    CLI upgrades return 503; server.close stops new connections), THEN
    //    the drain deadline starts, THEN idle CLI sockets close and their DB
    //    writes run inside that deadline. A locked device row can use up the
    //    deadline but never extend it.
    //    NORMAL drain: graceful — server.close waits for in-flight requests
    //    to finish; busy CLI sockets stay until their request finishes.
    //    DRAIN TIMEOUT (F8): forcibly terminate every lingering
    //    connection so requests that are still reading their bodies ABORT
    //    (their request signals fire, their body streams error) — the MCP
    //    admission gate below then settles and the teardown sequence is
    //    never held hostage by a stalled body. Without this, a request that
    //    passed the body cap but never finished sending could proceed to
    //    the MCP factory DURING/AFTER the Prisma disconnect.
    drainHttp: () =>
      drainHttpWithDeadline({
        timeoutMs: DRAIN_TIMEOUT_MS,
        stopAdmission: () => {
          relaySessionManager.beginDrain();
          return new Promise<void>((resolve) => {
            server.close((err) => {
              if (err) {
                // Sanitized (L19): constructor name only — close errors can
                // carry arbitrary message content.
                console.error(
                  `[server] Error closing HTTP server: (${err.constructor?.name ?? "Error"})`,
                );
              }
              resolve();
            });
          });
        },
        // Drop CLI sockets that are not carrying a model request.
        closeIdleRelaySessions: () => relaySessionManager.closeIdleRelaySessions(),
        forceCloseConnections: () => {
          // Feature-detect for TYPE reasons, not runtime availability:
          // serve() uses Node's default HTTP constructor here, so the
          // runtime server always implements closeAllConnections() /
          // closeIdleConnections() (Node >= 18.2) — but @hono/node-server's
          // ServerType UNION (http | http2 | https variants) does not
          // declare these methods on every member, so the cast stays.
          const nodeServer = server as {
            closeAllConnections?: () => void;
            closeIdleConnections?: () => void;
          };
          nodeServer.closeAllConnections?.();
          nodeServer.closeIdleConnections?.();
        },
      }),
    // 2. Close the admission gate AND the module-lifetime MCP handler —
    //    AFTER the HTTP drain (normal-drain requests finished; nothing
    //    admitted loses its exchange prematurely) and BEFORE the Prisma
    //    disconnect. The SDK owns closing each request-created server; the
    //    gate (F8 pass 4/5) additionally owns every ADMITTED exchange the
    //    SDK does not track (including requests still awaiting body parse):
    //    close() flips the gate closed — arming the AUTH DB-SEAM FENCE
    //    synchronously (every NEW better-auth adapter DB operation rejects
    //    from that instant: the installed requireMcpAuth continuation chain
    //    drops the abort signal, so its stray verifier continuations would
    //    otherwise open DB operations after teardown began) — then ABORTS
    //    every outstanding admitted controller. The handler's abort race
    //    settles it, its stage fences stop every continuation at its
    //    current await, and (pass 5) the permit release SHADOW-AWAITS the
    //    admitted promise (bounded by a 10s cap) so close() resolves only
    //    when every admitted exchange has genuinely settled or the cap is
    //    reached. New admissions get 503 from the moment close begins.
    //    This is the ONLY application-side close() call site
    //    (graceful-shutdown.ts order is unit-tested).
    closeMcpHandler: async () => {
      await Promise.all([mcpAdmissionGate.close(), mcpHandler?.close()]);
    },
    // 3. Close database connections last.
    disconnectPrisma: () => prisma.$disconnect(),
  });
  console.log("[server] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

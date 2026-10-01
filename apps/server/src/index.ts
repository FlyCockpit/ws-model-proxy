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
import { startOauthCleanup } from "./mcp/oauth-cleanup.js";
import { startMediaCleanup } from "./media/cleanup.js";
import { startCacheAffinityCleanup } from "./model-api/cache-affinity-runtime.js";
import { closeDiagnosticsCapacityRuntime } from "./model-api/diagnostics.js";
import { stopKvEvictionFeedback } from "./model-api/kv-eviction-feedback.js";
import {
  providerAttemptExpiryEnabled,
  startProviderAttemptExpiry,
} from "./model-api/provider-attempt-lifecycle.js";
import { startProviderBudgetRepair } from "./model-api/provider-budget-runtime.js";
import { startRelayTelemetryRecovery } from "./model-api/relay-telemetry-recovery.js";
import { startUsageRetention } from "./model-api/usage-retention.js";
import { warnMissingProviderCredentialKeyring } from "./provider-keyring-startup.js";
import { flushCliAgentAudit, stopCliAgentAuditWriter } from "./relay/cli-agent-audit.js";
import { sweepExpiredTokenCommands } from "./relay/cli-commands.js";
import { sweepExpiredFileOps } from "./relay/cli-file-ops.js";
import { RELAY_SUBPROTOCOL, RELAY_WS_MAX_PAYLOAD_BYTES } from "./relay/protocol.js";
import { relaySessionManager } from "./relay/session-manager.js";
import { terminalBrowserHub } from "./relay/terminal-websocket.js";
import { startRelayMaintenance } from "./relay-maintenance.js";
import { installServerShutdown } from "./server-shutdown.js";
import { configureHttpServerTimeouts } from "./server-timeouts.js";
import { startSessionCleanup } from "./session-cleanup.js";
import { runStartupCapacityRepairs } from "./startup-capacity-repairs.js";
import { createUserDeletionSweepClient, startUserDeletionSweep } from "./user-deletion-sweep.js";

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
// requests or treat a trigger-created null as unlimited. Then repair idle
// orphan discovery rows left by older model/device deletes.
try {
  await runStartupCapacityRepairs();
} catch (error) {
  console.error(
    "[server] FATAL: discovered inference capacity backfill/cleanup failed.",
    error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

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
// Accepted user deletions whose completion failed transiently or was cut
// short by a restart: the durable marker (User.deletionRequestedAt) is
// resumed here until the user is gone (see user-deletion-sweep.ts). The sweep
// runs on its own fenced client whose connections carry a server-side
// statement_timeout; shutdown waits on it for a bounded time and quarantines
// it past that (shutDownUserDeletionSweep, via server-shutdown.ts). Request paths keep the
// shared client.
const userDeletionSweepClient = createUserDeletionSweepClient(env.DATABASE_URL);
const stopUserDeletionSweep = startUserDeletionSweep({ prisma: userDeletionSweepClient.prisma });
// Metrics retention: reaps abandoned PENDING relay requests, deletes raw
// RelayRequest rows past RELAY_REQUEST_RETENTION_DAYS, compacts minute usage
// rollups to hourly after 30 days and drops hourly rollups after 13 months.
const stopUsageRetention = startUsageRetention({
  retentionDays: env.RELAY_REQUEST_RETENTION_DAYS,
});

// Relay maintenance: stale relay sessions and expired pending terminals
// (15 s), expired token-scoped CLI commands (60 s), and browser terminal
// session rechecks (60 s); see relay-maintenance.ts.
const stopRelayMaintenance = startRelayMaintenance({
  relaySessions: relaySessionManager,
  // Token-scoped CLI work: commands and (relay 2.8) node file ops.
  sweepExpiredTokenCommands: () => {
    sweepExpiredTokenCommands();
    sweepExpiredFileOps();
  },
  terminalHub: terminalBrowserHub,
  stopCliAgentAudit: stopCliAgentAuditWriter,
});

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight requests, then close dependencies
// ---------------------------------------------------------------------------

// SIGTERM / SIGINT arm the process watchdog and run the graceful sequence
// (server-shutdown.ts; its wiring is unit-tested in server-shutdown.test.ts,
// the step order in graceful-shutdown.test.ts). Every shutdown bound and the
// process deadline that sums them live in ./shutdown-timeouts.ts.
installServerShutdown({
  periodicJobStops: [
    stopMediaCleanup,
    stopCacheAffinityCleanup,
    stopRelayTelemetryRecovery,
    stopProviderBudgetRepair,
    stopProviderAttemptExpiry,
    stopOauthCleanup,
    stopSessionCleanup,
    stopUsageRetention,
    stopKvEvictionFeedback,
    stopRelayMaintenance,
  ],
  stopUserDeletionSweep,
  userDeletionSweepClient,
  relaySessions: relaySessionManager,
  flushAgentAudit: flushCliAgentAudit,
  terminalHub: terminalBrowserHub,
  server,
  capacityLifecycle,
  closeDiagnosticsCapacityRuntime,
  mcpAdmissionGate,
  mcpHandler,
  shared: prisma,
});

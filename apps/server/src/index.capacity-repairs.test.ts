import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  reachable: vi.fn(),
  backfill: vi.fn(),
  sweep: vi.fn(),
  serve: vi.fn(() => ({})),
}));
vi.mock("@ws-model-proxy/db", () => ({ default: { $queryRaw: deps.reachable } }));
vi.mock("@ws-model-proxy/env/server", () => ({ env: { CORS_ORIGIN: "https://app.example.test" } }));
vi.mock("@ws-model-proxy/api/lib/discovered-inference-capacity", () => ({
  backfillDiscoveredInferenceCapacities: deps.backfill,
}));
vi.mock("@ws-model-proxy/api/lib/engine-process-capacity", () => ({
  sweepOrphanAutoCapacities: deps.sweep,
}));
vi.mock("@hono/node-server", () => ({ serve: deps.serve }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: {} }));
vi.mock("ws", () => ({ WebSocketServer: class {} }));
vi.mock("./app.js", () => ({ createApp: async () => ({ app: { fetch: vi.fn() } }) }));
vi.mock("./better-call-error-log-shim.js", () => ({ installBetterCallErrorLogShim: vi.fn() }));
vi.mock("./provider-keyring-startup.js", () => ({ warnMissingProviderCredentialKeyring: vi.fn() }));
vi.mock("./server-timeouts.js", () => ({ configureHttpServerTimeouts: vi.fn() }));
vi.mock("./server-shutdown.js", () => ({ installServerShutdown: vi.fn() }));
vi.mock("./mcp/oauth-cleanup.js", () => ({ startOauthCleanup: vi.fn() }));
vi.mock("./media/cleanup.js", () => ({ startMediaCleanup: vi.fn() }));
vi.mock("./model-api/cache-affinity-runtime.js", () => ({ startCacheAffinityCleanup: vi.fn() }));
vi.mock("./model-api/diagnostics.js", () => ({ closeDiagnosticsCapacityRuntime: vi.fn() }));
vi.mock("./model-api/provider-attempt-lifecycle.js", () => ({
  providerAttemptExpiryEnabled: vi.fn(),
  startProviderAttemptExpiry: vi.fn(),
}));
vi.mock("./model-api/provider-budget-runtime.js", () => ({ startProviderBudgetRepair: vi.fn() }));
vi.mock("./model-api/relay-telemetry-recovery.js", () => ({
  startRelayTelemetryRecovery: vi.fn(),
}));
vi.mock("./model-api/usage-retention.js", () => ({ startUsageRetention: vi.fn() }));
vi.mock("./relay/cli-commands.js", () => ({ sweepExpiredTokenCommands: vi.fn() }));
vi.mock("./relay/protocol.js", () => ({
  RELAY_SUBPROTOCOL: "test",
  RELAY_WS_MAX_PAYLOAD_BYTES: 1,
}));
vi.mock("./relay/session-manager.js", () => ({ relaySessionManager: {} }));
vi.mock("./relay/terminal-websocket.js", () => ({ terminalBrowserHub: {} }));
vi.mock("./relay-maintenance.js", () => ({ startRelayMaintenance: vi.fn() }));
vi.mock("./session-cleanup.js", () => ({ startSessionCleanup: vi.fn() }));
vi.mock("./user-deletion-sweep.js", () => ({
  createUserDeletionSweepClient: vi.fn(() => ({ prisma: {} })),
  startUserDeletionSweep: vi.fn(),
}));

describe("entrypoint capacity repairs", () => {
  let ready: ReturnType<typeof Promise.withResolvers<void>>;
  let backfill: ReturnType<typeof Promise.withResolvers<void>>;
  let sweep: ReturnType<typeof Promise.withResolvers<void>>;
  const boots: Promise<unknown>[] = [];
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    ready = Promise.withResolvers<void>();
    backfill = Promise.withResolvers<void>();
    sweep = Promise.withResolvers<void>();
    deps.reachable.mockReturnValue(ready.promise);
    deps.backfill.mockReturnValue(backfill.promise);
    deps.sweep.mockReturnValue(sweep.promise);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("fatal exit");
    });
  });
  afterEach(async () => {
    ready.resolve();
    backfill.resolve();
    sweep.resolve();
    await Promise.all(boots.splice(0));
    vi.restoreAllMocks();
  });

  function boot() {
    // Capture failures immediately, including the intentional fatal exit.
    const result = import("./index.js").then(
      () => undefined,
      (error: unknown) => error,
    );
    boots.push(result);
    return result;
  }

  it("awaits database readiness, backfill, then sweep before listening", async () => {
    const result = boot();
    await vi.waitFor(() => expect(deps.reachable).toHaveBeenCalledOnce());
    expect(deps.backfill).not.toHaveBeenCalled();
    ready.resolve();
    await vi.waitFor(() => expect(deps.backfill).toHaveBeenCalledOnce());
    expect(deps.sweep).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
    backfill.resolve();
    await vi.waitFor(() => expect(deps.sweep).toHaveBeenCalledOnce());
    expect(deps.serve).not.toHaveBeenCalled();
    sweep.resolve();
    expect(await result).toBeUndefined();
    expect(deps.serve).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each(["backfill", "sweep"] as const)("keeps %s failure fatal in index.ts", async (step) => {
    const result = boot();
    ready.resolve();
    await vi.waitFor(() => expect(deps.backfill).toHaveBeenCalledOnce());
    if (step === "sweep") {
      backfill.resolve();
      await vi.waitFor(() => expect(deps.sweep).toHaveBeenCalledOnce());
    }
    (step === "backfill" ? backfill : sweep).reject(new TypeError("private connection details"));
    expect(await result).toEqual(new Error("fatal exit"));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(deps.serve).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[server] FATAL: discovered inference capacity backfill/cleanup failed.",
      "TypeError",
    );
    if (step === "backfill") expect(deps.sweep).not.toHaveBeenCalled();
  });
});

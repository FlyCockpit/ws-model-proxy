import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context as HonoContext } from "hono";
import type { McpCommandModeName } from "./lib/mcp-command-mode";
import type { SupervisedCommandServices } from "./lib/supervised-command-types";

export type CreateContextOptions = {
  context: HonoContext;
  services?: ContextServices;
};

/** Live relay facts for one connected CLI. Absent map entries are offline. */
export type LiveCliFeatureSnapshot = {
  protocolVersion: string | null;
  cliVersion: string | null;
  humanTerminal: boolean;
  /** The CLI's own MCP command mode, from its hello. */
  mcpCommandMode: McpCommandModeName;
  /** 2.6: the CLI implements supervised terminals (`term.spawn`). */
  supervisedCommands: boolean;
  terminalSupported: boolean;
  terminalApproval: boolean;
  /** 2.8: the CLI implements `file.op`. */
  fileOps: boolean;
  /** 2.8: the CLI's own read-only file grant. */
  mcpFileRead: boolean;
  /** 2.8: the CLI has `fileRoots` configured. */
  fileRootsConfigured: boolean;
  /** 2.8: the CLI's `allowFileToolsAsRoot` config. */
  allowFileToolsAsRoot: boolean;
  /** Uncompressed P-256 public key, base64url, when the live session is 2.4. */
  terminalPublicKey: string | null;
  /**
   * 2.5: the CLI identity key and its signature over the terminal key. Relayed
   * to browsers unverified; they verify and pin it.
   */
  terminalIdentity?: { publicKey: string; signature: string } | null;
};

/** Outcome of the per-process `exchangeDeviceCode` limiter. */
export type DeviceCodeExchangeLimit = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Relay 2.7 `endpoint.load` as the relay session keeps it (in memory only). */
export type LiveEndpointLoad = {
  endpointSlug: string;
  modelSlug: string | null;
  running: number;
  waiting: number;
  kvUsage?: number;
  slotsBusy?: number;
  deferred?: number;
  prefixCacheHitsDelta?: number;
  prefixCacheQueriesDelta?: number;
  source: "llama.cpp-slots" | "llama.cpp-metrics" | "vllm-metrics" | "sglang-metrics";
  /** The CLI's sample time. */
  ts: string;
  receivedAt: Date;
};

/** The freshest 2.7 telemetry a connected CLI sent. Absent map entries are offline. */
export type LiveNodeTelemetrySnapshot = {
  /** The latest `node.metrics` body (schema-validated by the relay). */
  nodeMetrics: Record<string, unknown> | null;
  nodeMetricsReceivedAt: Date | null;
  endpointLoad: LiveEndpointLoad[];
};

export type ContextServices = {
  /** Server-owned accounting repair. Kept injectable so the API package does not depend on the server. */
  repairExpiredProviderBudgets?: (scope: {
    userId: string;
    providerAccountId: string;
  }) => Promise<number>;
  /**
   * Caller-owned cancellation (Part G/G1): the OWNING request's abort
   * signal. Optional — the MCP transport threads the verified request's
   * admission signal so long-running procedures (e.g. the external
   * credential test) can refuse to START network work after the caller is
   * gone; the ordinary HTTP path may leave it unset, preserving the
   * pre-existing behavior.
   */
  signal?: AbortSignal;
  /** Close terminals or cancel CLI commands after a dashboard grant change. */
  onCliFeatureGrantsChanged?: (cliDeviceId: string) => void | Promise<void>;
  /**
   * Push a device's remote metric sources to its live relay session. Resolves
   * true when a session in this process received them.
   */
  onRemoteMetricSourcesChanged?: (cliDeviceId: string) => boolean | Promise<boolean>;
  /**
   * A pool's metric routing rules were replaced (committed). The relay clears
   * the pool's stored verdicts: they are hot-path (H) rows, which a management
   * (M) writer must not write, so the clearing runs in the H module after
   * the rules commit.
   */
  onPoolRoutingRulesChanged?: (poolId: string) => Promise<void>;
  /**
   * Close live relay sessions authenticated by credentials that were just
   * revoked (re-login, CLI token revoke). Called after the revoking write
   * commits. Per-process: it reaches the sessions this server holds.
   */
  onCliCredentialsRevoked?: (revoked: {
    kind: "cliToken" | "deviceCredential";
    ids: readonly string[];
  }) => void | Promise<void>;
  /** Cancel in-memory CLI commands bound to a revoked personal token. */
  cancelMcpTokenCommands?: (tokenId: string) => void;
  /** In-memory supervised-command requests (dashboard awareness and output review). */
  supervisedCommands?: SupervisedCommandServices;
  /**
   * Charges one `cliCredentials.exchangeDeviceCode` call to the caller's IP
   * and to the device code (per process; one replica is the supported
   * topology). The HTTP transport binds it to the request's client IP.
   * Absent where no network caller exists (unit tests); the procedure is not
   * an MCP surface.
   */
  limitDeviceCodeExchange?: (deviceCode: string) => Promise<DeviceCodeExchangeLimit>;
  /** Live protocol/feature snapshot for dashboard and MCP device lists. */
  getLiveCliFeatures?: (
    cliDeviceIds: readonly string[],
  ) =>
    | ReadonlyMap<string, LiveCliFeatureSnapshot>
    | Promise<ReadonlyMap<string, LiveCliFeatureSnapshot>>;
  /** Live node metrics and endpoint load (dashboard and MCP reads). */
  getLiveNodeTelemetry?: (
    cliDeviceIds: readonly string[],
  ) => ReadonlyMap<string, LiveNodeTelemetrySnapshot>;
};

export async function createContext({ context, services }: CreateContextOptions) {
  // The session is resolved once per request by `sessionMiddleware` in
  // apps/server. Test harnesses that bypass the Hono middleware stack will
  // see undefined here — fall back to a direct lookup so they still work.
  const preresolved = context.get("session") as Session | null | undefined;
  const session =
    preresolved !== undefined
      ? preresolved
      : ((await auth.api.getSession({
          headers: cookieSessionHeaders(context.req.raw.headers),
        })) as Session | null);
  return {
    session,
    services,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

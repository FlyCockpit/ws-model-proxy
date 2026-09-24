import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  context: HonoContext;
  services?: ContextServices;
};

/** Live relay facts for one connected CLI. Absent map entries are offline. */
export type LiveCliFeatureSnapshot = {
  protocolVersion: string | null;
  cliVersion: string | null;
  humanTerminal: boolean;
  mcpCommands: boolean;
  terminalSupported: boolean;
  terminalApproval: boolean;
  /** Uncompressed P-256 public key, base64url, when the live session is 2.4. */
  terminalPublicKey: string | null;
  /**
   * 2.5: the CLI identity key and its signature over the terminal key. Relayed
   * to browsers unverified; they verify and pin it.
   */
  terminalIdentity?: { publicKey: string; signature: string } | null;
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
  /** Live protocol/feature snapshot for dashboard and MCP device lists. */
  getLiveCliFeatures?: (
    cliDeviceIds: readonly string[],
  ) =>
    | ReadonlyMap<string, LiveCliFeatureSnapshot>
    | Promise<ReadonlyMap<string, LiveCliFeatureSnapshot>>;
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

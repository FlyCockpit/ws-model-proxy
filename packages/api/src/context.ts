import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context as HonoContext } from "hono";
import type { z } from "zod";
import type { AnonymousAuth, CallerAuth } from "./contracts/auth-context";
import type { modelsContract } from "./contracts/models";
import type { NodeRelayServices } from "./lib/node-relay-services";

export type CreateContextOptions = {
  context: HonoContext;
  services?: ContextServices;
};

/**
 * Server-owned hooks the procedures may call. Injected so the API package never depends on
 * the server; the lanes add the hooks their procedures need (relay pushes, revocations).
 */
export type ContextServices = {
  /**
   * The owning request's abort signal. Long-running procedures (external credential tests)
   * refuse to START network work after the caller is gone.
   */
  signal?: AbortSignal;
  /**
   * A pool's routing rules (or a member's engine-load override) changed and committed. The
   * relay clears the pool's stored verdicts: hot-path rows a management writer must not write.
   */
  onPoolRoutingRulesChanged?: (poolId: string) => Promise<void>;
  /** Lane B: node and profile relay hooks (`lib/node-relay-services.ts`). */
  nodes?: NodeRelayServices;
  /**
   * TODO(server, lane C hook): a runtime got a new version (create, update, fork). Push
   * `runtime.define` to the nodes that need it and answer per node. Absent: the procedures
   * answer `define: []` and nodes pick the version up on their next definition sync.
   */
  pushRuntimeDefinitions?: (input: { userId: string; runtimeId: string }) => Promise<
    Array<{
      nodeId: string;
      status: "applied" | "unchanged" | "rejected" | "pending" | "skipped_trust_relay";
      reason: string | null;
    }>
  >;
  /**
   * TODO(server, lane C hook): a start, restart or stop operation was recorded (instances,
   * ranks and claims written; desired state set). Create and dispatch its steps. Absent: the
   * rows wait for the server's lifecycle sweep.
   */
  dispatchRuntimeOperation?: (input: { userId: string; operationId: string }) => Promise<void>;
  /**
   * Lane D (access): a credential or grant was revoked and committed. The server drops any
   * cached admission for it and closes live MCP sessions or terminals it authorized.
   * TODO(server): wire in apps/server; until then a revoked credential stops working on the
   * next lookup (every lookup reads `revokedAt`).
   */
  onAccessRevoked?: (event: AccessRevokedEvent) => Promise<void>;
  /** Charges one public invite lookup to the caller's address; false: over its budget. */
  limitInviteLookup?: () => Promise<boolean>;
  /** Lane D (terminals, node commands): the relay surfaces these procedures need. */
  nodeOperator?: NodeOperatorServices;
  /**
   * `models.test`: send the test through the production admission and routing path as source
   * `AGENT_TEST`. The procedure has already checked that the caller may use the target (and,
   * for a bench, owns it) and resolved it. Absent: the procedure answers SERVICE_UNAVAILABLE.
   */
  modelTest?: (input: ModelTestServiceInput) => Promise<ModelTestServiceOutput>;
};

type ModelTestInput = z.infer<typeof modelsContract.test.input>;
export type ModelTestServiceOutput = z.infer<typeof modelsContract.test.output>;
export type ModelTestKind = NonNullable<ModelTestInput["kind"]>;
export type ModelTestBench = NonNullable<ModelTestInput["bench"]>;

/** A `models.test` target the procedure resolved and checked the caller may use. */
export type ModelTestServiceTarget =
  | {
      kind: "pool";
      poolId: string;
      /** `owner/pool` (`:external` cannot be tested), exactly as an API caller would send it. */
      callableId: string;
    }
  | {
      kind: "runtime";
      runtimeId: string;
      runtimeModelId: string;
      /** The upstream model id the runtime serves. */
      model: string;
      /** Pin the test to this instance (the caller's); null lets routing pick one. */
      instanceId: string | null;
    };

export type ModelTestServiceInput = {
  userId: string;
  /** The verified caller (cookie session or MCP token); the server reads it for bench limits. */
  auth: CallerAuth;
  target: ModelTestServiceTarget;
  kind: ModelTestKind;
  prompt?: string;
  maxTokens?: number;
  bench?: ModelTestBench;
  signal?: AbortSignal;
};

export type AccessRevokedEvent =
  | { kind: "api_key"; userId: string; apiKeyId: string }
  | { kind: "agent_token"; userId: string; agentTokenId: string; grantId: string }
  | { kind: "oauth_grant"; userId: string; grantId: string; clientId: string }
  | { kind: "share"; ownerUserId: string; granteeUserId: string; poolId: string };

/** A node command's live status from the node (`exec.status`); null output when offline. */
export type NodeCommandLiveStatus = {
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "INTERRUPTED" | "UNKNOWN";
  exitCode?: number;
  /** Masked end of the output. */
  output: string;
  truncated?: boolean;
  finishedAt?: Date;
};

/**
 * Relay hooks for browser terminals and node commands (implemented in apps/server). Every hook
 * receives ids the procedure already checked belong to `userId`; the server re-checks the node
 * is online and at Full control and refuses otherwise.
 */
export type NodeOperatorServices = {
  /**
   * Mint a one-use ticket for the browser terminal socket. `typedCommand` is written into the
   * shell without a newline (the person presses Enter).
   */
  openTerminalTicket(args: {
    userId: string;
    sessionId: string;
    /** The admin acting through an impersonation session (revoking that admin drops it). */
    impersonatedBy?: string | null;
    nodeId: string;
    cols: number;
    rows: number;
    typedCommand?: string;
  }): Promise<{ ticket: string; terminalId: string; expiresAt: Date }>;
  /** `exec.start`: start a command; resolves once the node answered `exec.started`. */
  startCommand(args: {
    userId: string;
    nodeId: string;
    commandId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
  }): Promise<{ startedAt: Date; endsBy: Date }>;
  /**
   * `exec.poll` (or `exec.cancel` when `cancel`): the node's view of a command, waiting up to
   * `waitMs` for it to finish. Null when the node is offline.
   */
  pollCommand(args: {
    userId: string;
    nodeId: string;
    commandId: string;
    waitMs: number;
    /**
     * Recorded before the node is reached: an offline node gets the cancel when it reconnects.
     * The answer is then null (offline) or the state before the end, until the node reports it.
     */
    cancel: boolean;
    /** The command's stored end time (bounds how long a pending cancel is remembered). */
    endsBy?: Date;
  }): Promise<NodeCommandLiveStatus | null>;
};

/**
 * The header oRPC's `SimpleCsrfProtectionLinkPlugin` sends on every `/rpc` call from the web
 * app. A cross-origin page cannot add it without a CORS preflight, which the server grants
 * only to `CORS_ORIGIN`. The server's handler plugin requires it on every procedure in
 * `CSRF_REQUIRED_PROCEDURES` (on every deployment shape) and on every procedure when
 * `CORS_ORIGIN` is set.
 */
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CSRF_HEADER_VALUE = "orpc";

export function requestCarriesCsrfHeader(headers: Headers): boolean {
  return headers.get(CSRF_HEADER_NAME) === CSRF_HEADER_VALUE;
}

export type Context = {
  session: Session | null;
  /** Who is calling, from the credential the transport verified (`contracts/auth-context.ts`). */
  auth: CallerAuth | AnonymousAuth;
  services?: ContextServices;
};

/** The `/rpc` context: a Better Auth cookie session, or anonymous. Never a token. */
export async function createContext({ context, services }: CreateContextOptions): Promise<Context> {
  // The session is resolved once per request by `sessionMiddleware` in apps/server. Test
  // harnesses that bypass the Hono middleware stack see undefined here and look it up.
  const preresolved = context.get("session") as Session | null | undefined;
  const session =
    preresolved !== undefined
      ? preresolved
      : ((await auth.api.getSession({
          headers: cookieSessionHeaders(context.req.raw.headers),
        })) as Session | null);
  return {
    session,
    auth: session
      ? {
          kind: "cookie_session",
          userId: session.user.id,
          sessionId: session.session.id,
          csrfVerified: requestCarriesCsrfHeader(context.req.raw.headers),
        }
      : { kind: "anonymous" },
    services,
  };
}

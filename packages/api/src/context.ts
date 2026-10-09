import { auth, type Session } from "@ws-model-proxy/auth";
import { cookieSessionHeaders } from "@ws-model-proxy/auth/cookie-session";
import type { Context as HonoContext } from "hono";
import type { z } from "zod";
import type { AnonymousAuth, CallerAuth } from "./contracts/auth-context";
import type { modelsContract } from "./contracts/models";
import type { LiveLoadReader } from "./lib/live-load";
import type { NodeRelayServices } from "./lib/node-relay-services";

export type CreateContextOptions = {
  context: HonoContext;
  services?: ContextServices;
};

/**
 * Server-owned hooks the procedures may call. Injected so the API package never depends on
 * the server. `apps/server/src/app.ts` (`contextServices`) wires them; tests leave them out.
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
  /** Node and profile relay hooks (`lib/node-relay-services.ts`). */
  nodes?: NodeRelayServices;
  /**
   * A runtime got a new version (create, update, fork). Push `runtime.define` to the nodes
   * that need it and answer per node. Absent (tests): the procedures answer `define: []` and
   * nodes pick the version up on their next definition sync.
   */
  pushRuntimeDefinitions?: (input: { userId: string; runtimeId: string }) => Promise<
    Array<{
      nodeId: string;
      status: "applied" | "unchanged" | "rejected" | "pending" | "skipped_trust_relay";
      reason: string | null;
    }>
  >;
  /**
   * A start, restart or stop operation was recorded (instances, ranks and claims written;
   * desired state set). Create and dispatch its steps. Absent (tests): the rows wait for the
   * server's lifecycle sweep.
   */
  dispatchRuntimeOperation?: (input: { userId: string; operationId: string }) => Promise<void>;
  /**
   * A credential or grant was revoked and committed. The server drops any
   * cached admission for it and closes live MCP sessions or terminals it authorized. Absent
   * (tests): a revoked credential still stops working on the next lookup (every lookup reads
   * `revokedAt`).
   */
  onAccessRevoked?: (event: AccessRevokedEvent) => Promise<void>;
  /**
   * A grant was lowered from Full to Read-only and committed. Every later lookup already reads
   * READ; the server ends the work its Full level started (in-flight write tool calls, node
   * commands and file ops, queued commands).
   */
  onAccessLevelLowered?: (event: AccessLevelLoweredEvent) => Promise<void>;
  /** Charges one public invite lookup to the caller's address; false: over its budget. */
  limitInviteLookup?: () => Promise<boolean>;
  /** Charges one signed-in invite acceptance (`auth.acceptInvite`) to the user; false: over. */
  limitInviteAccept?: (userId: string) => Promise<boolean>;
  /** Terminals and node commands: the relay surfaces these procedures need. */
  nodeOperator?: NodeOperatorServices;
  /**
   * Node file tools (`nodes.files.*`) over relay 3.0. The procedure has checked the caller (a
   * FULL agent credential), the node's owner and its stored trust; the server admits again
   * (live credential, owner, trust, live session and its owner, file roots) before sending.
   */
  nodeFiles?: NodeFileServices;
  /**
   * Interactive steps (`runtimes.steps.*`): the lifecycle engine and the relay's operator
   * terminals. People only; the procedure has checked nothing but the caller.
   */
  runtimeSteps?: RuntimeStepServices;
  /**
   * `models.test`: send the test through the production admission and routing path as source
   * `AGENT_TEST`. The procedure has already checked that the caller may use the target (and,
   * for a bench, owns it) and resolved it. Absent: the procedure answers SERVICE_UNAVAILABLE.
   */
  modelTest?: (input: ModelTestServiceInput) => Promise<ModelTestServiceOutput>;
  /**
   * The relay's in-memory engine load per instance (instance and pool member views). Absent,
   * or an instance whose node's session is held by another server process: load is unknown.
   */
  liveLoad?: LiveLoadReader;
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

/** A grant's level went from Full to Read-only and committed (`access.oauthGrants.setLevel`). */
export type AccessLevelLoweredEvent = { kind: "oauth_grant"; userId: string; grantId: string };

/** A node command's live status from the node (`exec.status`); null output when offline. */
export type NodeCommandLiveStatus = {
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "INTERRUPTED" | "UNKNOWN";
  exitCode?: number;
  /** Masked end of the output. */
  output: string;
  truncated?: boolean;
  finishedAt?: Date;
};

/** Why `runtimes.steps.*` refused a step. */
export type RuntimeStepRefusal =
  | "not_found"
  | "not_interactive"
  /** The step does not wait for its person (finished, or its terminal is still open/closed). */
  | "not_waiting"
  /** A person's run is in progress: it is answered in its terminal, never cut off. */
  | "running"
  /** The step is no longer the instance's step to run (stopped or restarted meanwhile). */
  | "superseded"
  /** The terminal closed: reopen the step first. */
  | "terminal_closed"
  /** The terminal is not up on the node (still coming up, or the node is offline). */
  | "terminal_unavailable"
  /** An agent started the instance and the node is Relay only: its steps never run there. */
  | "trust_relay";

export type RuntimeStepResult = { ok: true } | { ok: false; code: RuntimeStepRefusal };

export type RuntimeStepServices = {
  /** A one-use attach ticket bound to the step's live operator terminal. */
  attach(args: {
    userId: string;
    sessionId: string;
    impersonatedBy?: string | null;
    stepId: string;
  }): Promise<
    | { ok: true; ticket: string; terminalId: string; expiresAt: Date }
    | { ok: false; code: RuntimeStepRefusal }
  >;
  reopen(args: { userId: string; stepId: string }): Promise<RuntimeStepResult>;
  cancel(args: { userId: string; stepId: string }): Promise<RuntimeStepResult>;
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

/** A relay 3.0 file op (`apps/server/src/relay/file-protocol.ts`). */
export type NodeFileOp =
  | "read"
  | "stat"
  | "list"
  | "search"
  | "edit"
  | "write"
  | "rename"
  | "mkdir"
  | "delete";

/** The agent credential a file op runs under (the one its audit row names). */
export type NodeFileCredential = { kind: "agent_token" | "oauth_grant"; id: string };

export type NodeFileRunInput = {
  userId: string;
  credential: NodeFileCredential;
  nodeId: string;
  op: NodeFileOp;
  /** The relay args for `op`; a write's content is `body`, never in the args. */
  args: Record<string, unknown>;
  /** Write content (at most 1 MiB). */
  body?: Uint8Array;
  signal?: AbortSignal;
};

export type NodeFileOutcome =
  | { ok: true; result: Record<string, unknown> }
  | {
      ok: false;
      /** An admission refusal (`trust_relay`, `no_roots`, ...) or a file error code. */
      code: string;
      detail?: Record<string, unknown>;
      retryAfterMs?: number;
      /** A mutation whose result the server does not know (check with a stat first). */
      outcome?: "unknown";
      /** `path_denied` by the server's root check: the node's file roots. */
      roots?: string[];
    };

export type NodeFileServices = {
  /** Admit, send and wait for one file op. The server audits it; content is never kept. */
  run(input: NodeFileRunInput): Promise<NodeFileOutcome>;
  /**
   * Record a request the procedure refused before `run`, on a node it verified is the
   * caller's: an input the relay cannot carry, or a node that is not at Full control.
   * Metadata only.
   */
  auditRefused(
    input: Omit<NodeFileRunInput, "body" | "signal"> & { reason: "invalid_input" | "trust_relay" },
  ): void;
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

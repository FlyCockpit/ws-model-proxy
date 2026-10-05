import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import {
  authenticateModelApiTokenSecret,
  type ModelApiTokenIdentity,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { WebSocket } from "ws";
import { resolveClientIp } from "../../client-ip.js";
import { createRateLimiterMiddleware, realtimeUpgradeLimiter } from "../../rate-limit.js";
import { relaySessionManager } from "../../relay/session-manager.js";
import type { CapacityAdmissionRuntime } from "../capacity/runtime.js";
import { openAiErrorBody } from "../openai-errors.js";
import { createRealtimeAdmit } from "./capacity.js";
import {
  REALTIME_KEY_SUBPROTOCOL_PREFIX,
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
} from "./constants.js";
import { REALTIME_MODEL_MAX_BYTES } from "./events.js";
import {
  type RealtimeAdmission,
  type RealtimeSessionCounters,
  realtimeSessionCounters,
} from "./limits.js";
import {
  type RealtimeRegistration,
  type RealtimeSessionRegistry,
  realtimeSessionRegistry,
} from "./registry.js";
import { createRealtimeRouter, type RealtimeResolvedTarget } from "./routing.js";
import {
  REALTIME_CLOSE_CODES,
  type RealtimeClientSocket,
  type RealtimeRelay,
  type RealtimeRouter,
  type RealtimeSessionHooks,
  RealtimeTranscriptionSession,
} from "./transcription-session.js";

/**
 * `GET /v1/realtime?intent=transcription` (design §2): the OpenAI Realtime
 * transcription subset over a WebSocket, for model API tokens.
 *
 * Upgrade checks, in order: an upgrade request (426), not draining (503), the
 * per-IP pre-auth limiter (429, failed authentications count), a query of
 * only `intent=transcription` and an optional `model` (400; a credential in
 * the URL is refused, never read), the credential (401), then the live
 * session caps per token, user and server (429). The credential is the
 * `Authorization: Bearer` header or, for browsers, the subprotocol pair
 * `realtime` + `openai-insecure-api-key.<token>`; the server selects only
 * `realtime` and never echoes the key. It goes through the same
 * `authenticateModelApiTokenSecret` as every `/v1` route; no cookie session
 * is ever read here, so there is no CSRF surface.
 *
 * The admission taken before the upgrade is released exactly once: by the
 * session when it ends, or here when the handshake never completes.
 */

export { REALTIME_KEY_SUBPROTOCOL_PREFIX, REALTIME_PATH, REALTIME_SUBPROTOCOL };
export const REALTIME_INTENT = "transcription";
/** WebSocket ping cadence and how long a client may stay silent. */
export const REALTIME_PING_INTERVAL_MS = 25_000;
export const REALTIME_PONG_TIMEOUT_MS = 60_000;
/** An admitted upgrade whose socket never opens gives its admission back after this. */
export const REALTIME_OPEN_GUARD_MS = 10_000;

export type RealtimeEndpointDeps = {
  relay: RealtimeRelay & {
    getActiveCliDeviceIds(): string[];
    isDraining(): boolean;
  };
  counters: RealtimeSessionCounters;
  registry: RealtimeSessionRegistry;
  authenticate: (secret: string) => Promise<ModelApiTokenIdentity | null>;
  capacityRuntime?: CapacityAdmissionRuntime;
  /** Tests replace the database router. */
  router?: (input: {
    token: ModelApiTokenIdentity;
    onResolved: (target: RealtimeResolvedTarget, model: string) => void;
  }) => RealtimeRouter;
};

export function productionRealtimeDeps(
  capacityRuntime?: CapacityAdmissionRuntime,
): RealtimeEndpointDeps {
  return {
    relay: relaySessionManager,
    counters: realtimeSessionCounters,
    registry: realtimeSessionRegistry,
    authenticate: authenticateModelApiTokenSecret,
    ...(capacityRuntime ? { capacityRuntime } : {}),
  };
}

type RealtimeAuth = {
  token: ModelApiTokenIdentity;
  admission: RealtimeAdmission;
  model: string | null;
};

type RealtimeVariables = { realtimeAuth: RealtimeAuth };

function errorResponse(
  c: Context,
  status: 400 | 401 | 426 | 429 | 503,
  type: string,
  code: string,
  message: string,
) {
  return c.json(openAiErrorBody({ message, type, code }), status);
}

function bearerSecret(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** The offered subprotocols, trimmed. */
export function offeredSubprotocols(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The token from `openai-insecure-api-key.<token>`, if offered. */
export function subprotocolSecret(header: string | undefined): string | null {
  for (const protocol of offeredSubprotocols(header)) {
    if (protocol.startsWith(REALTIME_KEY_SUBPROTOCOL_PREFIX)) {
      const secret = protocol.slice(REALTIME_KEY_SUBPROTOCOL_PREFIX.length);
      return secret.length > 0 ? secret : null;
    }
  }
  return null;
}

const encoder = new TextEncoder();

/** The query: `intent=transcription` once, `model` at most once, nothing else. */
export function readRealtimeQuery(
  url: string,
): { ok: true; model: string | null } | { ok: false; code: string; message: string } {
  const params = new URL(url).searchParams;
  for (const key of new Set(params.keys())) {
    if (key === "intent" || key === "model") continue;
    if (/key|token|auth|secret/i.test(key)) {
      return {
        ok: false,
        code: "credential_in_url",
        message:
          "Send the API key in the Authorization header or the realtime subprotocol, never in the URL.",
      };
    }
    return { ok: false, code: "unknown_parameter", message: "Unknown query parameter." };
  }
  const intents = params.getAll("intent");
  if (intents.length !== 1 || intents[0] !== REALTIME_INTENT) {
    return {
      ok: false,
      code: "unsupported_intent",
      message: "Only intent=transcription is supported.",
    };
  }
  const models = params.getAll("model");
  if (models.length > 1) {
    return { ok: false, code: "invalid_value", message: "Give 'model' at most once." };
  }
  const model = models[0];
  if (model === undefined) return { ok: true, model: null };
  if (
    model.length === 0 ||
    !model.isWellFormed() ||
    model.includes("\0") ||
    encoder.encode(model).byteLength > REALTIME_MODEL_MAX_BYTES
  ) {
    return { ok: false, code: "invalid_value", message: "'model' must be a model name." };
  }
  return { ok: true, model };
}

export function createRealtimeWebsocketMiddleware(
  deps: RealtimeEndpointDeps = productionRealtimeDeps(),
): MiddlewareHandler<{ Variables: RealtimeVariables }> {
  const rateLimit = createRateLimiterMiddleware(realtimeUpgradeLimiter, {
    // Pre-auth: keyed by address only, never by credential bytes.
    resolveKey: (c) => `ip:${resolveClientIp(c)}`,
  });
  return async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(
        c,
        426,
        "invalid_request_error",
        "upgrade_required",
        "WebSocket upgrade required.",
      );
    }
    if (deps.relay.isDraining() || deps.registry.closing) {
      return errorResponse(
        c,
        503,
        "server_error",
        "server_shutting_down",
        "The server is shutting down.",
      );
    }
    const limited = await rateLimit(c, async () => undefined);
    if (limited instanceof Response) return limited;
    const query = readRealtimeQuery(c.req.url);
    if (!query.ok) return errorResponse(c, 400, "invalid_request_error", query.code, query.message);
    const secret =
      bearerSecret(c.req.header("authorization")) ??
      subprotocolSecret(c.req.header("sec-websocket-protocol"));
    if (!secret) {
      return errorResponse(c, 401, "invalid_request_error", "invalid_api_key", "Missing API key.");
    }
    const token = await deps.authenticate(secret);
    if (!token) {
      return errorResponse(
        c,
        401,
        "invalid_request_error",
        "invalid_api_key",
        "Invalid or revoked API key.",
      );
    }
    // The session caps, before the upgrade and before any relay session.
    const admitted = deps.counters.acquire({ tokenId: token.id, userId: token.userId });
    if (!admitted.ok) {
      return errorResponse(
        c,
        429,
        "invalid_request_error",
        "rate_limited",
        "Too many live transcription sessions.",
      );
    }
    c.set("realtimeAuth", { token, admission: admitted.admission, model: query.model });
    try {
      await next();
    } finally {
      // Hono records a handler's throw in `c.error` instead of rethrowing.
      // No socket will ever own this admission then; a handshake that fails
      // later is covered by the open guard in the socket events. Release is
      // idempotent.
      if (c.error) admitted.admission.release();
    }
  };
}

function rawSocket(ws: WSContext<WebSocketLike>): WebSocket | null {
  const raw = ws.raw;
  return raw instanceof WebSocket ? raw : null;
}

/** The socket events of one admitted upgrade. Exported for the wiring tests. */
export function realtimeSocketEvents(
  auth: RealtimeAuth,
  deps: RealtimeEndpointDeps,
): WSEvents<WebSocketLike> {
  let session: RealtimeTranscriptionSession | null = null;
  let opened = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  // The handshake can fail after the middleware admitted it (the client
  // vanished, the server is closing): onOpen then never runs.
  const guard = setTimeout(() => {
    if (!opened) auth.admission.release();
  }, REALTIME_OPEN_GUARD_MS);
  guard.unref?.();
  const stopKeepalive = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  };

  return {
    onOpen(_event, ws) {
      opened = true;
      clearTimeout(guard);
      const raw = rawSocket(ws);
      let paused = false;
      let lastPong = Date.now();
      const client: RealtimeClientSocket = {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        pause: () => {
          paused = true;
          raw?.pause();
        },
        resume: () => {
          paused = false;
          lastPong = Date.now();
          raw?.resume();
        },
        bufferedAmount: () => raw?.bufferedAmount ?? 0,
      };
      const holder: { registration: RealtimeRegistration | null } = { registration: null };
      const onResolved = (target: RealtimeResolvedTarget, model: string) =>
        holder.registration?.resolved(target, model);
      const router = deps.router
        ? deps.router({ token: auth.token, onResolved })
        : createRealtimeRouter({
            token: auth.token,
            activeCliDeviceIds: () => deps.relay.getActiveCliDeviceIds(),
            onResolved,
          });
      const hooks: RealtimeSessionHooks = {
        ...(deps.capacityRuntime ? { admit: createRealtimeAdmit(deps.capacityRuntime) } : {}),
        opened: (candidate, info) => holder.registration?.opened(candidate, info.lease),
        // Metering persistence is chunk 7; this chunk only plumbs `itemFinished`.
        ended: () => {
          holder.registration?.remove();
          stopKeepalive();
        },
      };
      const created = new RealtimeTranscriptionSession({
        client,
        router,
        relay: deps.relay,
        admission: auth.admission,
        initialModel: auth.model,
        hooks,
      });
      session = created;
      const registration = deps.registry.add(created, auth.token.id);
      if (!registration || deps.relay.isDraining()) {
        registration?.remove();
        created.terminate(REALTIME_CLOSE_CODES.goingAway, {
          type: "server_error",
          code: "server_shutting_down",
          message: "The server is shutting down.",
        });
        return;
      }
      holder.registration = registration;
      created.start();
      if (raw && created.status !== "closed") {
        raw.on("pong", () => {
          lastPong = Date.now();
        });
        keepalive = setInterval(() => {
          const now = Date.now();
          // Paused by us for backpressure: the backlog rules cover it.
          if (paused) {
            lastPong = now;
            return;
          }
          if (now - lastPong > REALTIME_PONG_TIMEOUT_MS) {
            raw.terminate();
            return;
          }
          try {
            raw.ping();
          } catch {
            // Closing; the close event ends the session.
          }
        }, REALTIME_PING_INTERVAL_MS);
        keepalive.unref?.();
      }
    },
    onMessage(event) {
      if (typeof event.data === "string") session?.handleText(event.data);
      else session?.handleBinary();
    },
    onClose() {
      stopKeepalive();
      session?.clientClosed();
    },
    onError() {
      stopKeepalive();
      session?.clientClosed();
    },
  };
}

export function realtimeUpgradeHandler(deps: RealtimeEndpointDeps = productionRealtimeDeps()) {
  return upgradeWebSocket((c: Context<{ Variables: RealtimeVariables }>) =>
    realtimeSocketEvents(c.get("realtimeAuth"), deps),
  );
}

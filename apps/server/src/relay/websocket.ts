import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { resolveClientIp } from "../client-ip.js";
import {
  chargeRelayUpgradeFailure,
  createRateLimiterMiddleware,
  relayUpgradeFailureBudget,
  relayUpgradeNodeLimiter,
} from "../rate-limit.js";
import { SERVER_VERSION } from "../version.js";
import { authenticateNodeCredential, type NodeIdentity } from "./node-credential-auth.js";
import {
  parseRelaySubprotocolHeader,
  protocolErrorMessage,
  RELAY_SUBPROTOCOL,
} from "./protocol.js";
import { recordRejectedNodeHello } from "./registration.js";
import { type RelaySocket, relaySessionManager } from "./session-manager.js";
import { settleSocketHandler } from "./socket-handler.js";
import { retainUpgradeRefusalBody } from "./upgrade-refusal-body.js";

type RelayVariables = {
  relayIdentity: NodeIdentity;
};

function bearerSecret(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const relayIpKey = (c: Context) => `ip:${resolveClientIp(c)}`;

/**
 * Relay upgrades have their own limiters, never the sign-in bucket. An address whose failed
 * upgrades used up its relay budget is refused before the credential is checked; only failures
 * spend that budget, so many honest nodes behind one NAT connecting at once never do. An
 * authenticated upgrade is charged to its node, keyed by the verified id (never by the presented
 * secret's bytes, so a caller cannot pick a bucket).
 */
export function createRelayWebsocketMiddleware(): MiddlewareHandler<{ Variables: RelayVariables }> {
  return async (c, next) => {
    const refuse = (response: Response) => retainUpgradeRefusalBody(c.env, response);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return refuse(c.json({ error: "WebSocket upgrade required." }, 426));
    }
    if (relaySessionManager.isDraining()) {
      return refuse(c.json({ error: "Server is shutting down." }, 503));
    }

    const ipKey = relayIpKey(c);
    const budget = await relayUpgradeFailureBudget(ipKey);
    if (!budget.allowed) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))));
      return refuse(
        c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429),
      );
    }

    const requestedProtocol = parseRelaySubprotocolHeader(c.req.header("sec-websocket-protocol"));
    if (!requestedProtocol.supported) {
      const oldToken = (c.req.header("sec-websocket-protocol") ?? "")
        .split(",")
        .map((token) => token.trim())
        .find((token) => /^ws-model-proxy\.relay\.v3$/.test(token));
      const secret = oldToken ? bearerSecret(c.req.header("authorization")) : null;
      const identity = secret ? await authenticateNodeCredential(secret) : null;
      if (identity && oldToken) {
        const nodeLimited = await createRateLimiterMiddleware(relayUpgradeNodeLimiter, {
          resolveKey: () => `node:${identity.nodeId}`,
        })(c, async () => undefined);
        if (nodeLimited instanceof Response) return refuse(nodeLimited);
        await recordRejectedNodeHello(
          identity,
          { protocolVersion: "3.0", cliVersion: null },
          new Date(),
        ).catch(() => console.error("[relay] recording a protocol refusal failed"));
      } else {
        await chargeRelayUpgradeFailure(ipKey);
      }
      return refuse(
        c.json(
          {
            ...protocolErrorMessage({
              code: "upgrade_cli",
              message:
                "This server runs WS Model Proxy 1.0 and needs wsmp 1.0 or later. Upgrade wsmp (re-run the server's install.sh, or brew upgrade wsmp), then restart it.",
            }),
            supportedSubprotocol: RELAY_SUBPROTOCOL,
            serverVersion: SERVER_VERSION,
            minimumCliVersion: "1.0.0",
          },
          426,
        ),
      );
    }

    const secret = bearerSecret(c.req.header("authorization"));
    if (!secret) {
      await chargeRelayUpgradeFailure(ipKey);
      return refuse(c.json({ error: "Node credential required." }, 401));
    }

    const identity = await authenticateNodeCredential(secret);
    if (!identity) {
      await chargeRelayUpgradeFailure(ipKey);
      return refuse(c.json({ error: "Invalid or revoked node credential." }, 401));
    }
    const nodeRateLimit = createRateLimiterMiddleware(relayUpgradeNodeLimiter, {
      resolveKey: () => `node:${identity.nodeId}`,
    });
    const nodeLimited = await nodeRateLimit(c, async () => undefined);
    if (nodeLimited instanceof Response) return refuse(nodeLimited);
    c.set("relayIdentity", identity);
    await next();
  };
}

type RelayWsContext = WSContext<WebSocketLike>;

const relaySockets = new WeakMap<RelayWsContext, RelaySocket>();

function relaySocketFor(ws: RelayWsContext): RelaySocket {
  const existing = relaySockets.get(ws);
  if (existing) return existing;

  const socket: RelaySocket = {
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      const raw = ws.raw;
      return typeof raw === "object" && raw && "bufferedAmount" in raw
        ? Number(raw.bufferedAmount)
        : 0;
    },
    send(data: string | ArrayBuffer | Uint8Array) {
      if (data instanceof Uint8Array) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        ws.send(copy.buffer);
        return;
      }
      ws.send(data);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
  };
  relaySockets.set(ws, socket);
  return socket;
}

/**
 * The socket events of one upgraded node relay connection, for the identity the
 * middleware authenticated. Exported for the wiring tests. `onOpen` runs after
 * the awaited authentication, so it is where a socket that authenticated
 * during shutdown is refused ({@link RelaySessionManager.acceptAuthenticatedSocket}).
 */
export function relaySocketEvents(identity: NodeIdentity): WSEvents<WebSocketLike> {
  return {
    onOpen(_event, ws) {
      const socket = relaySocketFor(ws);
      if (!relaySessionManager.acceptAuthenticatedSocket({ socket, identity })) {
        relaySockets.delete(ws);
      }
    },
    onMessage(event, ws) {
      const socket = relaySocketFor(ws);
      if (typeof event.data === "string") {
        settleSocketHandler("node text", relaySessionManager.handleTextFrame(socket, event.data));
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        relaySessionManager.handleBinaryFrame(socket, event.data);
      }
    },
    onClose(_event, ws) {
      const socket = relaySocketFor(ws);
      settleSocketHandler(
        "node close",
        relaySessionManager.removeSession(socket).finally(() => {
          relaySockets.delete(ws);
        }),
      );
    },
    onError(_event, ws) {
      const socket = relaySocketFor(ws);
      settleSocketHandler(
        "node error",
        relaySessionManager.removeSession(socket).finally(() => {
          relaySockets.delete(ws);
        }),
      );
    },
  };
}

export function relayUpgradeHandler() {
  return upgradeWebSocket((c: Context<{ Variables: RelayVariables }>) =>
    relaySocketEvents(c.get("relayIdentity")),
  );
}

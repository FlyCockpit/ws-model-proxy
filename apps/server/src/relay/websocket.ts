import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { authLimiter, createRateLimiterMiddleware } from "../rate-limit.js";
import { authenticateNodeCredential, type NodeIdentity } from "./node-credential-auth.js";
import {
  parseRelaySubprotocolHeader,
  protocolErrorMessage,
  RELAY_SUBPROTOCOL,
} from "./protocol.js";
import { type RelaySocket, relaySessionManager } from "./session-manager.js";
import { settleSocketHandler } from "./socket-handler.js";

type RelayVariables = {
  relayIdentity: NodeIdentity;
};

function bearerSecret(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createRelayWebsocketMiddleware(): MiddlewareHandler<{ Variables: RelayVariables }> {
  const rateLimit = createRateLimiterMiddleware(authLimiter);

  return async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "WebSocket upgrade required." }, 426);
    }
    if (relaySessionManager.isDraining()) {
      return c.json({ error: "Server is shutting down." }, 503);
    }

    const limited = await rateLimit(c, async () => undefined);
    if (limited instanceof Response) return limited;

    const requestedProtocol = parseRelaySubprotocolHeader(c.req.header("sec-websocket-protocol"));
    if (!requestedProtocol.supported) {
      return c.json(
        {
          ...protocolErrorMessage({
            code: "upgrade_cli",
            message: "Unsupported relay websocket subprotocol.",
          }),
          supportedSubprotocol: RELAY_SUBPROTOCOL,
        },
        426,
      );
    }

    const secret = bearerSecret(c.req.header("authorization"));
    if (!secret) {
      return c.json({ error: "Node credential required." }, 401);
    }

    const identity = await authenticateNodeCredential(secret);
    if (!identity) {
      return c.json({ error: "Invalid or revoked node credential." }, 401);
    }
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

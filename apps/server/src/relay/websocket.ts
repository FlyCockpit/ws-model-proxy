import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import {
  authenticateCliWebsocketSecret,
  type CliWebsocketIdentity,
} from "@ws-model-proxy/api/lib/cli-credential-access";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import { authLimiter, createRateLimiterMiddleware } from "../rate-limit.js";
import { parseRelaySubprotocolHeader, RELAY_SUBPROTOCOL } from "./protocol.js";
import { type RelaySocket, relaySessionManager } from "./session-manager.js";

type RelayVariables = {
  relayIdentity: CliWebsocketIdentity;
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

    await rateLimit(c, async () => undefined);
    if (c.res.status === 429) return c.res;

    const requestedProtocol = parseRelaySubprotocolHeader(c.req.header("sec-websocket-protocol"));
    if (!requestedProtocol.supported) {
      return c.json(
        {
          type: "protocol.error",
          failure: "protocol_error",
          message: "Unsupported relay websocket subprotocol.",
          supportedSubprotocol: RELAY_SUBPROTOCOL,
        },
        426,
      );
    }

    const secret = bearerSecret(c.req.header("authorization"));
    if (!secret) {
      return c.json({ error: "CLI websocket authentication required." }, 401);
    }

    const identity = await authenticateCliWebsocketSecret(secret);
    if (!identity) {
      return c.json({ error: "Invalid or revoked CLI websocket credential." }, 401);
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

export function relayUpgradeHandler() {
  return upgradeWebSocket((c: Context<{ Variables: RelayVariables }>) => {
    const identity = c.get("relayIdentity");
    return {
      onOpen(_event, ws) {
        relaySessionManager.acceptAuthenticatedSocket({
          socket: relaySocketFor(ws),
          identity,
        });
      },
      onMessage(event, ws) {
        const socket = relaySocketFor(ws);
        if (typeof event.data === "string") {
          void relaySessionManager.handleTextFrame(socket, event.data);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          relaySessionManager.handleBinaryFrame(socket, event.data);
        }
      },
      onClose(_event, ws) {
        const socket = relaySocketFor(ws);
        void relaySessionManager.removeSession(socket).finally(() => {
          relaySockets.delete(ws);
        });
      },
      onError(_event, ws) {
        const socket = relaySocketFor(ws);
        void relaySessionManager.removeSession(socket).finally(() => {
          relaySockets.delete(ws);
        });
      },
    };
  });
}

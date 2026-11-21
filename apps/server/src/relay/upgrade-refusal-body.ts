import { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";

const refusalBodies = new WeakMap<IncomingMessage, string>();

/** Keep the exact response text without consuming the Response returned to Hono. */
export async function retainUpgradeRefusalBody(
  bindings: unknown,
  response: Response,
): Promise<Response> {
  const incoming =
    bindings && typeof bindings === "object" && "incoming" in bindings
      ? bindings.incoming
      : undefined;
  if (
    incoming instanceof IncomingMessage &&
    incoming.headers.upgrade?.toLowerCase() === "websocket" &&
    response.status !== 101
  ) {
    refusalBodies.set(incoming, await response.clone().text());
  }
  return response;
}

/** Install after node-server has registered its WebSocket upgrade listener. */
export function installUpgradeRefusalBodies(server: ServerType): void {
  const listeners = server.rawListeners("upgrade");
  if (listeners.length === 0) return;
  for (const listener of listeners) server.removeListener("upgrade", listener);

  // node-server 2.1.6's rejectUpgradeRequest discards Response bodies and sends
  // Content-Length: 0 in one socket.end(string), only with one upgrade listener:
  // https://github.com/honojs/node-server/blob/v2.1.6/src/websocket.ts
  // Wrap that listener, rather than adding another. Send headers and body in the
  // same end() so released tungstenite clients receive the JSON with the headers.
  server.on(
    "upgrade",
    function (this: ServerType, request: IncomingMessage, socket: Duplex, head: Buffer) {
      const originalEnd = socket.end;
      socket.end = function (this: Duplex, ...args: unknown[]): typeof socket {
        socket.end = originalEnd;
        const body = refusalBodies.get(request);
        refusalBodies.delete(request);
        const headers = args[0];
        if (
          body !== undefined &&
          typeof headers === "string" &&
          /^HTTP\/1\.1 (?!101 )\d{3} /.test(headers) &&
          headers.includes("\r\nContent-Length: 0\r\n") &&
          headers.endsWith("\r\n\r\n")
        ) {
          args[0] =
            headers.replace(
              "\r\nContent-Length: 0\r\n",
              `\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`,
            ) + body;
        }
        return Reflect.apply(originalEnd, this, args);
      };
      for (const listener of listeners) Reflect.apply(listener, this, [request, socket, head]);
    },
  );
}

/**
 * Node's default keep-alive timeout is shorter than that used by many reverse
 * proxies. A proxy can therefore reuse a socket which Node has already closed,
 * producing an avoidable connection reset. Keep the server's timeout one
 * second beyond the proxy-facing 65-second contract; headersTimeout must stay
 * greater than keepAliveTimeout.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;

export interface HttpServerTimeouts {
  keepAliveTimeout: number;
  headersTimeout: number;
}

export function configureHttpServerTimeouts(server: HttpServerTimeouts): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
}

/**
 * Returns the headers Better Auth may use to resolve a browser session.
 *
 * Product API credentials are deliberately scoped to their bearer-only
 * surfaces (`/v1/*` and the CLI websocket). Cookie-authenticated routes must
 * never start accepting those credentials if Better Auth's plugin set changes.
 */
export function cookieSessionHeaders(headers: Headers): Headers {
  const cookieOnlyHeaders = new Headers(headers);
  cookieOnlyHeaders.delete("authorization");
  return cookieOnlyHeaders;
}

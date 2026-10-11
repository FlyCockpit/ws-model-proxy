import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { env } from "@ws-model-proxy/env/server";
import type { Context } from "hono";

/**
 * Resolve the real client IP for an anonymous request. This is the rate-limit
 * key for traffic that isn't tied to a user id, so a client must never be able
 * to choose it.
 *
 * The topology is explicit: `TRUST_PROXY_HOPS` is the number of reverse
 * proxies between the internet and the app (required in production; 0 in
 * development and test). There is deliberately no auto-detection: guessing
 * which hops are "our infra" from private address ranges let any client whose
 * socket peer was private (a LAN client, or internet traffic rewritten to the
 * Docker bridge gateway by Docker's userland proxy) pick a fresh key per
 * request by sending a random public `X-Forwarded-For`.
 *
 * The hop chain, client first, is `[...X-Forwarded-For, socketPeer]`. Each
 * proxy APPENDS the address it received the request from, so the last
 * `TRUST_PROXY_HOPS` entries were written by our own proxies and the entry just
 * left of them is the client. Everything further left is whatever the client
 * sent and is ignored.
 *
 * - hops = 0: the socket peer; `X-Forwarded-For` is ignored entirely.
 * - hops = N: the entry N from the right of the chain.
 * - Short chain (fewer than N + 1 entries): the request did not pass through
 *   the configured proxies (a proxy was bypassed or does not append), so no
 *   header entry is trustworthy — any of them could be client-written. Fall
 *   back to the socket peer, the one address a client cannot forge. Behind a
 *   correctly configured proxy this never happens; when it does, the failure
 *   mode is a shared bucket (visible) rather than a per-request bypass.
 * - A selected entry that is not an IP literal (after stripping a `:port`
 *   suffix some proxies add) also falls back to the socket peer, so a garbage
 *   header can never become an unbounded set of keys.
 */
export function resolveClientIp(c: Context): string {
  const socket = getConnInfo(c).remote.address || "unknown";
  const hops = env.TRUST_PROXY_HOPS;
  if (hops === 0) return socket;

  const forwarded = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // The socket peer is the rightmost hop, so the client is entry `hops - 1`
  // counted from the right end of X-Forwarded-For.
  const candidate = forwarded[forwarded.length - hops];
  if (candidate === undefined) return socket;
  return ipLiteral(candidate) ?? socket;
}

/**
 * The IP literal in a forwarded entry, or null. Accepts a bare address and the
 * `1.2.3.4:port` / `[v6]:port` forms some load balancers write.
 */
function ipLiteral(entry: string): string | null {
  if (isIP(entry) !== 0) return entry;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed?.[1] && isIP(bracketed[1]) === 6) return bracketed[1];
  const v4WithPort = /^([\d.]+):\d+$/.exec(entry);
  if (v4WithPort?.[1] && isIP(v4WithPort[1]) === 4) return v4WithPort[1];
  return null;
}

/**
 * Clone `request` so the Better Auth handler sees exactly one
 * `X-Forwarded-For` entry: the client IP {@link resolveClientIp} resolved.
 *
 * Better Auth keys its own rate limiter (and records `session.ipAddress`) from
 * `X-Forwarded-For`, trusting a single-entry header verbatim. Passing the raw
 * header through would let a directly connected client name any IP, so the
 * app, the only component that knows the proxy topology, rewrites it. When no
 * client IP is known the header is removed.
 */
export function withResolvedClientIp(request: Request, clientIp: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("forwarded");
  headers.delete("x-real-ip");
  if (clientIp === "unknown") headers.delete("x-forwarded-for");
  else headers.set("x-forwarded-for", clientIp);
  return new Request(request, { headers });
}

import { createServer, request as httpRequest } from "node:http";

/**
 * A local stand-in for a Cloudflare Tunnel (Free/Pro) in front of the server,
 * enforcing the two limits that matter to it:
 *
 * - Request bodies over 100 MB (10^8 bytes) are refused with Cloudflare's own
 *   non-JSON 413, by Content-Length up front or while a chunked body streams.
 * - An origin that sends nothing (no headers, no body bytes) for `idleMs`
 *   (100 s) gets a 524 to the client if no headers went out yet; after headers
 *   the connection is cut.
 *
 * Like Cloudflare plus cloudflared it appends the client address to
 * X-Forwarded-For and sets CF-Connecting-IP, so the server runs with
 * TRUST_PROXY_HOPS=1. No real tunnel is involved.
 */
export async function startCloudflareLikeProxy({
  target,
  maxBodyBytes = 100_000_000,
  idleMs = 100_000,
}) {
  const targetUrl = new URL(target);
  const stats = { timeouts524: 0, cutAfterHeaders: 0, refused413: 0 };
  const server = createServer((req, res) => {
    const declared = Number(req.headers["content-length"]);
    const refuse = () => {
      stats.refused413 += 1;
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "text/html", connection: "close" });
        res.end("<html><body><h1>413 Request Entity Too Large</h1></body></html>");
      }
      req.destroy();
    };
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      refuse();
      return;
    }
    const client = req.socket.remoteAddress ?? "127.0.0.1";
    const headers = { ...req.headers, host: targetUrl.host };
    headers["x-forwarded-for"] = headers["x-forwarded-for"]
      ? `${headers["x-forwarded-for"]}, ${client}`
      : client;
    headers["cf-connecting-ip"] = client;
    const upstream = httpRequest({
      host: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: req.url,
      headers,
    });
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        upstream.destroy();
        if (!res.headersSent) {
          stats.timeouts524 += 1;
          res.writeHead(524, { "content-type": "text/html" });
          res.end("<html><body><h1>524 A timeout occurred</h1></body></html>");
        } else {
          stats.cutAfterHeaders += 1;
          res.destroy();
        }
      }, idleMs);
    };
    let sent = 0;
    req.on("data", (chunk) => {
      sent += chunk.byteLength;
      if (sent > maxBodyBytes) {
        upstream.destroy();
        refuse();
      }
    });
    req.pipe(upstream);
    req.on("end", touch);
    upstream.on("response", (response) => {
      touch();
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("data", (chunk) => {
        touch();
        res.write(chunk);
      });
      response.on("end", () => {
        clearTimeout(idle);
        res.end();
      });
      response.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      clearTimeout(idle);
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    res.on("close", () => {
      clearTimeout(idle);
      upstream.destroy();
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

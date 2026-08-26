export type NativeRequestProtocol = "openai" | "anthropic";

const ALLOWED_REQUEST_HEADERS: Record<NativeRequestProtocol, ReadonlySet<string>> = {
  openai: new Set(["accept", "content-type", "idempotency-key", "openai-beta", "x-request-id"]),
  anthropic: new Set([
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "content-type",
    "request-id",
  ]),
};

const ALWAYS_DENIED = new Set([
  "authorization",
  "connection",
  "cookie",
  "cookie2",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

function connectionNominatedHeaders(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Build the client-derived portion of a provider request from a small,
 * protocol-owned allowlist. Provider account selectors are deliberately not
 * accepted here; trusted provider configuration may add them after this
 * boundary when provider-backed execution is activated.
 */
export function nativeRequestHeaders(request: Request, protocol: NativeRequestProtocol): Headers {
  const output = new Headers();
  const allowed = ALLOWED_REQUEST_HEADERS[protocol];
  const nominated = connectionNominatedHeaders(request.headers);
  for (const [rawName, value] of request.headers) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name) || ALWAYS_DENIED.has(name) || nominated.has(name)) continue;
    output.append(name, value);
  }
  if (!output.has("content-type")) output.set("content-type", "application/json");
  return output;
}

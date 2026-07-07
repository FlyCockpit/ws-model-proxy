const STRIPPED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "origin",
  "referer",
  "x-csrf-token",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "anthropic-api-key",
]);

const SAFE_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-length",
  "user-agent",
  "idempotency-key",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "openai-version",
  "x-request-id",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
]);

function isUnsafeHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    STRIPPED_HEADER_NAMES.has(normalized) ||
    normalized.startsWith("sec-") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("password")
  );
}

export function sanitizeRelayRequestHeaders(
  input: Headers | Record<string, string>,
): Record<string, string> {
  const output: Record<string, string> = {};
  const entries = input instanceof Headers ? input.entries() : Object.entries(input);

  for (const [name, value] of entries) {
    const normalized = name.trim().toLowerCase();
    if (isUnsafeHeaderName(normalized)) continue;
    if (!SAFE_HEADER_NAMES.has(normalized) && !normalized.startsWith("x-openai-")) continue;
    output[normalized] = value;
  }

  return output;
}

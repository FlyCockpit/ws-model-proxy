export const SUPPORTED_ANTHROPIC_VERSIONS = ["2023-06-01"] as const;

export type AnthropicIngress = {
  version: (typeof SUPPORTED_ANTHROPIC_VERSIONS)[number];
  betaFeatures: string[];
};

export function anthropicErrorResponse(
  status: number,
  message: string,
  type:
    | "invalid_request_error"
    | "authentication_error"
    | "not_found_error"
    | "rate_limit_error"
    | "request_too_large"
    | "api_error" = "invalid_request_error",
) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function parseAnthropicIngress(headers: Headers): AnthropicIngress | Response {
  // x-api-key is an upstream credential header, never an alternate WSMP client
  // authentication mechanism.
  if (headers.has("x-api-key")) {
    return anthropicErrorResponse(
      400,
      "x-api-key is not accepted for WSMP authentication; use Authorization: Bearer.",
    );
  }
  const rawVersion = headers.get("anthropic-version")?.trim();
  if (!rawVersion) return anthropicErrorResponse(400, "anthropic-version header is required.");
  if (!(SUPPORTED_ANTHROPIC_VERSIONS as readonly string[]).includes(rawVersion)) {
    return anthropicErrorResponse(400, `Unsupported anthropic-version: ${rawVersion}.`);
  }
  const betaFeatures: string[] = [];
  const seen = new Set<string>();
  for (const token of (headers.get("anthropic-beta") ?? "").split(",")) {
    const beta = token.trim();
    if (!beta || seen.has(beta)) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(beta)) {
      return anthropicErrorResponse(400, "anthropic-beta contains an invalid feature name.");
    }
    seen.add(beta);
    betaFeatures.push(beta);
  }
  return { version: rawVersion as AnthropicIngress["version"], betaFeatures };
}

export function anthropicRelayHeaders(request: Request, ingress: AnthropicIngress): Headers {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  else headers.set("content-type", "application/json");
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const requestId = request.headers.get("request-id");
  if (requestId) headers.set("request-id", requestId);
  headers.set("anthropic-version", ingress.version);
  if (ingress.betaFeatures.length > 0) {
    headers.set("anthropic-beta", ingress.betaFeatures.join(","));
  }
  return headers;
}

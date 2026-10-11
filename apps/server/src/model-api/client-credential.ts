/**
 * The WSMP API key a model-API caller sent, in any of the common styles client SDKs and
 * harnesses use: `Authorization: Bearer <key>` (OpenAI and most), `x-api-key: <key>`
 * (Anthropic) and `api-key: <key>` (Azure-style header; Azure path dialects are not served).
 * Several may be present only when they carry the same key: two different keys are refused, so
 * a proxy in front of the caller cannot make one key authenticate while another is logged.
 * None of these headers ever reaches an engine (native-request-headers.ts strips them; the node
 * adds its own upstream credentials from its secrets).
 */

export type ClientCredential =
  | { kind: "key"; key: string }
  | { kind: "none" }
  /** Different keys in different headers, or a malformed Authorization header. */
  | { kind: "conflict" };

function bearer(value: string): string | null {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value.trim());
  return match?.[1] ?? null;
}

export function clientCredential(headers: Headers): ClientCredential {
  const keys = new Set<string>();
  const authorization = headers.get("authorization");
  if (authorization !== null) {
    const key = bearer(authorization);
    if (!key) return { kind: "conflict" };
    keys.add(key);
  }
  for (const name of ["x-api-key", "api-key"] as const) {
    const value = headers.get(name)?.trim();
    if (value === undefined) continue;
    if (!value || /\s/.test(value)) return { kind: "conflict" };
    keys.add(value);
  }
  if (keys.size === 0) return { kind: "none" };
  if (keys.size > 1) return { kind: "conflict" };
  return { kind: "key", key: [...keys][0]! };
}

export type ProviderProtocol = "openai" | "anthropic";
export type ProviderInventoryProtocol = "openai-compatible" | "anthropic-compatible";

const PROVIDER_PROTOCOL_BY_TYPE = {
  anthropic: "anthropic",
  "anthropic-compatible": "anthropic",
  openai: "openai",
  "openai-compatible": "openai",
  // OpenRouter's Chat Completions API is OpenAI-compatible and the only
  // surface claimed (see PROVIDER_ALLOWED_SURFACES). Checked against docs, not
  // live (2026-09-26, no key used):
  // - Anthropic Messages (base https://openrouter.ai/api): authenticates with
  //   `Authorization: Bearer <key>` and `x-api-key` left blank; a non-blank
  //   `x-api-key` is treated as a direct-Anthropic credential
  //   (openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).
  //   A BEARER account could therefore serve it, but it stays unclaimed.
  // - Responses API: documented as beta and stateless (no stored responses,
  //   so no previous_response_id follow-ups, retrieve or cancel;
  //   openrouter.ai/docs/api_reference/responses/overview). Unclaimed:
  //   Responses clients are adapted to Chat Completions.
  openrouter: "openai",
} as const satisfies Record<string, ProviderProtocol>;

export type ProviderType = keyof typeof PROVIDER_PROTOCOL_BY_TYPE;

/**
 * Preset base URL for provider types with one well-known endpoint. Request
 * paths such as `/v1/chat/completions` are appended to it.
 */
export const PROVIDER_PRESET_BASE_URL = {
  openrouter: "https://openrouter.ai/api",
} as const satisfies Partial<Record<ProviderType, string>>;

/**
 * Authenticated endpoint used by "Test credential", relative to the account
 * base URL, for provider types whose API root does not tell a valid key from
 * an invalid one. OpenRouter's root answers 404 with or without a key;
 * `GET /v1/key` answers 401 for a missing or bogus key (checked live) and
 * describes the key otherwise (documented; not live-checked with a valid key).
 * Types absent here probe the base URL itself (pre-existing behavior; the
 * OpenAI and Anthropic roots have the same problem and are a known follow-up).
 */
const PROVIDER_CREDENTIAL_PROBE_PATH = {
  openrouter: "/v1/key",
} as const satisfies Partial<Record<ProviderType, string>>;

/**
 * URL "Test credential" requests. It is always on the account's own base URL
 * (same origin and path prefix), so the key goes nowhere new.
 */
export function providerCredentialProbeUrl(providerType: string, baseUrl: string): string {
  const normalized = normalizedType(providerType);
  if (!Object.hasOwn(PROVIDER_CREDENTIAL_PROBE_PATH, normalized)) return baseUrl;
  const path =
    PROVIDER_CREDENTIAL_PROBE_PATH[normalized as keyof typeof PROVIDER_CREDENTIAL_PROBE_PATH];
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // The egress layer rejects the invalid base URL itself.
    return baseUrl;
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
  return url.toString();
}

/**
 * Native inventory surfaces a provider type may declare. Types absent here
 * accept every surface their protocol allows. Restricted types must use the
 * v4 inventory, whose shape cannot claim surfaces through legacy fields.
 */
const PROVIDER_ALLOWED_SURFACES = {
  openrouter: ["openaiChatCompletions"],
} as const satisfies Partial<Record<ProviderType, readonly string[]>>;

function normalizedType(providerType: string): string {
  return providerType.trim().toLowerCase();
}

/** Resolve only explicitly supported provider types. Unknown types fail closed. */
export function providerProtocolForType(providerType: string): ProviderProtocol | null {
  const normalized = normalizedType(providerType);
  return Object.hasOwn(PROVIDER_PROTOCOL_BY_TYPE, normalized)
    ? PROVIDER_PROTOCOL_BY_TYPE[normalized as ProviderType]
    : null;
}

export function inventoryProtocolForProviderType(
  providerType: string,
): ProviderInventoryProtocol | null {
  const protocol = providerProtocolForType(providerType);
  return protocol === null ? null : `${protocol}-compatible`;
}

/**
 * Whether an inventory declares only surfaces this provider type may serve.
 * Unknown provider types fail closed; the protocol match is checked separately.
 */
export function providerInventorySurfacesAllowed(
  providerType: string,
  inventory: { version: number; surfaces?: Record<string, unknown> },
): boolean {
  const normalized = normalizedType(providerType);
  if (providerProtocolForType(normalized) === null) return false;
  if (!Object.hasOwn(PROVIDER_ALLOWED_SURFACES, normalized)) return true;
  const allowed: readonly string[] =
    PROVIDER_ALLOWED_SURFACES[normalized as keyof typeof PROVIDER_ALLOWED_SURFACES];
  if (inventory.version !== 4 || !inventory.surfaces) return false;
  return Object.entries(inventory.surfaces).every(
    ([surface, value]) => value === undefined || allowed.includes(surface),
  );
}

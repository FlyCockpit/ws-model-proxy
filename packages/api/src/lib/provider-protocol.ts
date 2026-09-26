export type ProviderProtocol = "openai" | "anthropic";
export type ProviderInventoryProtocol = "openai-compatible" | "anthropic-compatible";

const PROVIDER_PROTOCOL_BY_TYPE = {
  anthropic: "anthropic",
  "anthropic-compatible": "anthropic",
  openai: "openai",
  "openai-compatible": "openai",
  // OpenRouter's Chat Completions API is OpenAI-compatible. Its Anthropic
  // Messages surface is not claimed until its auth header is verified, and
  // its Responses API is not claimed either (see PROVIDER_ALLOWED_SURFACES).
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

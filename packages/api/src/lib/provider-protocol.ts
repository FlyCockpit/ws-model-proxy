export type ProviderProtocol = "openai" | "anthropic";
export type ProviderInventoryProtocol = "openai-compatible" | "anthropic-compatible";

const PROVIDER_PROTOCOL_BY_TYPE = {
  anthropic: "anthropic",
  "anthropic-compatible": "anthropic",
  openai: "openai",
  "openai-compatible": "openai",
} as const satisfies Record<string, ProviderProtocol>;

/** Resolve only explicitly supported provider types. Unknown types fail closed. */
export function providerProtocolForType(providerType: string): ProviderProtocol | null {
  const normalized = providerType.trim().toLowerCase();
  return Object.hasOwn(PROVIDER_PROTOCOL_BY_TYPE, normalized)
    ? PROVIDER_PROTOCOL_BY_TYPE[normalized as keyof typeof PROVIDER_PROTOCOL_BY_TYPE]
    : null;
}

export function inventoryProtocolForProviderType(
  providerType: string,
): ProviderInventoryProtocol | null {
  const protocol = providerProtocolForType(providerType);
  return protocol === null ? null : `${protocol}-compatible`;
}

/**
 * Provider-type comparison shared by the API, the dispatcher and the
 * dashboard. Account writes normalize `providerType` (trim + lowercase), but
 * rows written before that normalization may still carry another spelling;
 * every OpenRouter decision (D9 privacy routing and its opt-out, the catalog)
 * compares through this helper so they can never disagree about an account.
 */

export const OPENROUTER_PROVIDER_TYPE = "openrouter";

export function normalizeProviderType(providerType: string): string {
  return providerType.trim().toLowerCase();
}

export function isOpenRouterProviderType(providerType: string): boolean {
  return normalizeProviderType(providerType) === OPENROUTER_PROVIDER_TYPE;
}

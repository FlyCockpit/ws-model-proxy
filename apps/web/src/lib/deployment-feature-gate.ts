export const PRIVATE_NETWORKS_ENV = "WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS";

/** Fail closed: missing, loading, or errored flags reject private URLs. */
export function privateNetworksAllowedFromConfig(data: unknown, isError: boolean): boolean {
  if (isError) return false;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return (data as { privateNetworksAllowed?: unknown }).privateNetworksAllowed === true;
}

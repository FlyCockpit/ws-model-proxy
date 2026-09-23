export const ANTHROPIC_MESSAGES_ENV = "MODEL_API_ANTHROPIC_ENABLED";
export const PRIVATE_NETWORKS_ENV = "WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS";

type FeatureSnapshot = {
  deploymentFeatures?: {
    MODEL_API_ANTHROPIC_ENABLED?: unknown;
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS?: unknown;
  };
};

function featureSnapshot(data: unknown): FeatureSnapshot["deploymentFeatures"] | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return (data as FeatureSnapshot).deploymentFeatures;
}

/** Fail closed: missing, loading, or errored config keeps the gate shut. */
export function anthropicMessagesEnabledFromConfig(data: unknown, isError: boolean): boolean {
  if (isError) return false;
  return featureSnapshot(data)?.MODEL_API_ANTHROPIC_ENABLED === true;
}

/** Fail closed: missing, loading, or errored config rejects private URLs. */
export function privateNetworksAllowedFromConfig(data: unknown, isError: boolean): boolean {
  if (isError) return false;
  return featureSnapshot(data)?.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS === true;
}

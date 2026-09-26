export type PublicEgressResource = {
  name: string;
  effectiveProviderEgress?: boolean;
};

/** Names pools with static external availability for this viewer. Plain names remain local. */
export function publicEgressResourceNames(resources: PublicEgressResource[]): string[] {
  return resources
    .filter((resource) => resource.effectiveProviderEgress === true)
    .map((resource) => resource.name);
}

export function egressProviderAccountLabels(
  resources: ReadonlyArray<{
    providerAccountLabels?: readonly string[];
    providerTypes?: readonly string[];
  }>,
): string[] {
  return [
    ...new Set(
      resources.flatMap((resource) =>
        (resource.providerAccountLabels?.length
          ? resource.providerAccountLabels
          : (resource.providerTypes ?? [])
        ).filter((label) => label.length > 0),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

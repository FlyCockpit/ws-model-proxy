export type PublicEgressResource = {
  name: string;
  effectiveProviderEgress?: boolean;
};

/** Names resources the server marked non-private. Does not scan member tiers. */
export function publicEgressResourceNames(resources: PublicEgressResource[]): string[] {
  return resources
    .filter((resource) => resource.effectiveProviderEgress === true)
    .map((resource) => resource.name);
}

export function egressProviderAccountLabels(
  resources: ReadonlyArray<{ providerAccountLabels?: readonly string[] }>,
): string[] {
  return [
    ...new Set(
      resources.flatMap((resource) =>
        (resource.providerAccountLabels ?? []).filter((label) => label.length > 0),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

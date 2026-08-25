export type PublicEgressResource = {
  name: string;
  publicEgressEnabled: boolean;
  effectiveProviderEgress?: boolean;
  members?: ReadonlyArray<{ providerModel?: unknown | null }>;
};

export function publicEgressResourceNames(resources: PublicEgressResource[]): string[] {
  return resources
    .filter(
      (resource) =>
        resource.effectiveProviderEgress === true ||
        resource.publicEgressEnabled ||
        resource.members?.some((member) => member.providerModel),
    )
    .map((resource) => resource.name);
}

export type PublicEgressResource = {
  name: string;
  publicEgressEnabled: boolean;
};

export function publicEgressResourceNames(resources: PublicEgressResource[]): string[] {
  return resources
    .filter((resource) => resource.publicEgressEnabled)
    .map((resource) => resource.name);
}

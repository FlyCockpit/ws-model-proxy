export type ModelApiTokenAllowlistEntryPayload =
  | { target: "DIRECT_MODEL"; discoveredModelId: string }
  | { target: "MODEL_POOL"; modelPoolId: string };

/**
 * Builds unchecked nested-create rows. Direct entries intentionally use the
 * legacy discovered-model scalar: database hardening canonicalizes it to the
 * execution target and verifies ownership on insert.
 */
export function buildModelApiTokenAllowlistEntries(targets: {
  directModels: Array<{ id: string }>;
  modelPools: Array<{ id: string }>;
}): ModelApiTokenAllowlistEntryPayload[] {
  return [
    ...targets.directModels.map((model) => ({
      target: "DIRECT_MODEL" as const,
      discoveredModelId: model.id,
    })),
    ...targets.modelPools.map((pool) => ({
      target: "MODEL_POOL" as const,
      modelPoolId: pool.id,
    })),
  ];
}

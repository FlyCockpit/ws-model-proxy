import prisma from "@ws-model-proxy/db";
import type { VisibleModelTargets } from "./model-api-token-access";
import {
  effectiveTransformModalities,
  resolveEffectiveCapabilityMetadata,
  transformerSupportedModalities,
} from "./openai-compatible-capabilities";

export type VisibleModelAttachmentModalities = {
  image: boolean;
  audio: boolean;
  video: boolean;
};

const noAttachmentModalities: VisibleModelAttachmentModalities = {
  image: false,
  audio: false,
  video: false,
};

function modalitiesFromCapabilities({
  capabilityOverrideMode,
  capabilityOverrideMetadata,
  endpointCapabilityMetadata,
}: {
  capabilityOverrideMode: string;
  capabilityOverrideMetadata: unknown | null;
  endpointCapabilityMetadata: unknown | null;
}): VisibleModelAttachmentModalities {
  const supported = transformerSupportedModalities(
    resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode,
      capabilityOverrideMetadata,
      endpointCapabilityMetadata,
    }),
  );
  return { image: supported.images, audio: supported.audio, video: supported.video };
}

function unionModalities(
  modalities: readonly VisibleModelAttachmentModalities[],
): VisibleModelAttachmentModalities {
  return modalities.reduce(
    (result, next) => ({
      image: result.image || next.image,
      audio: result.audio || next.audio,
      video: result.video || next.video,
    }),
    noAttachmentModalities,
  );
}

/**
 * Resolve the same effective media capabilities advertised by the model API.
 * Pool capabilities are intentionally optimistic: a capable member or enabled
 * transformer makes that input attachable, matching GET /v1/models.
 */
export async function visibleModelAttachmentModalities(targets: VisibleModelTargets): Promise<{
  directById: Map<string, VisibleModelAttachmentModalities>;
  poolById: Map<string, VisibleModelAttachmentModalities>;
}> {
  const directIds = targets.directModels.map((model) => model.id);
  const poolIds = targets.modelPools.map((pool) => pool.id);
  const [directRows, poolMemberRows, poolTransformerRows] = await Promise.all([
    directIds.length === 0
      ? []
      : prisma.discoveredModel.findMany({
          where: { id: { in: directIds } },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrideMetadata: true,
            Endpoint: { select: { capabilityMetadata: true } },
          },
        }),
    poolIds.length === 0
      ? []
      : prisma.poolMember.findMany({
          where: { poolId: { in: poolIds } },
          select: {
            poolId: true,
            ExecutionTarget: {
              select: {
                DiscoveredModel: {
                  select: {
                    capabilityOverrideMode: true,
                    capabilityOverrideMetadata: true,
                    Endpoint: { select: { capabilityMetadata: true } },
                  },
                },
              },
            },
            DiscoveredModel: {
              select: {
                capabilityOverrideMode: true,
                capabilityOverrideMetadata: true,
                Endpoint: { select: { capabilityMetadata: true } },
              },
            },
          },
        }),
    poolIds.length === 0
      ? []
      : prisma.modelPool.findMany({
          where: { id: { in: poolIds } },
          select: {
            id: true,
            transformerDiscoveredModelId: true,
            transformerImages: true,
            transformerAudio: true,
            transformerVideo: true,
            TransformerDiscoveredModel: {
              select: {
                published: true,
                capabilityOverrideMode: true,
                capabilityOverrideMetadata: true,
                Endpoint: { select: { published: true, capabilityMetadata: true } },
              },
            },
          },
        }),
  ]);

  const directById = new Map(
    directRows.map((row) => [
      row.id,
      modalitiesFromCapabilities({
        capabilityOverrideMode: row.capabilityOverrideMode,
        capabilityOverrideMetadata: row.capabilityOverrideMetadata,
        endpointCapabilityMetadata: row.Endpoint.capabilityMetadata,
      }),
    ]),
  );
  const membersByPoolId = new Map<string, VisibleModelAttachmentModalities[]>();
  for (const row of poolMemberRows) {
    const discoveredModel = row.ExecutionTarget?.DiscoveredModel ?? row.DiscoveredModel;
    if (!discoveredModel) continue;
    const current = membersByPoolId.get(row.poolId) ?? [];
    current.push(
      modalitiesFromCapabilities({
        capabilityOverrideMode: discoveredModel.capabilityOverrideMode,
        capabilityOverrideMetadata: discoveredModel.capabilityOverrideMetadata,
        endpointCapabilityMetadata: discoveredModel.Endpoint.capabilityMetadata,
      }),
    );
    membersByPoolId.set(row.poolId, current);
  }
  const poolById = new Map<string, VisibleModelAttachmentModalities>();
  for (const pool of poolTransformerRows) {
    const memberModalities = unionModalities(membersByPoolId.get(pool.id) ?? []);
    const transformer = pool.TransformerDiscoveredModel;
    if (
      !pool.transformerDiscoveredModelId ||
      !transformer?.published ||
      !transformer.Endpoint.published
    ) {
      poolById.set(pool.id, memberModalities);
      continue;
    }
    const transformerCaps = transformerSupportedModalities(
      resolveEffectiveCapabilityMetadata({
        capabilityOverrideMode: transformer.capabilityOverrideMode,
        capabilityOverrideMetadata: transformer.capabilityOverrideMetadata,
        endpointCapabilityMetadata: transformer.Endpoint.capabilityMetadata,
      }),
    );
    const transformed = effectiveTransformModalities({
      pool: {
        images: pool.transformerImages,
        audio: pool.transformerAudio,
        video: pool.transformerVideo,
      },
      transformerCaps,
    });
    poolById.set(
      pool.id,
      unionModalities([
        memberModalities,
        { image: transformed.images, audio: transformed.audio, video: transformed.video },
      ]),
    );
  }
  return { directById, poolById };
}

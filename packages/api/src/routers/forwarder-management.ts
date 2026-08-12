import { ORPCError } from "@orpc/server";
import {
  directModelId,
  poolModelId,
  validateForwarderPoolSlug,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  listVisibleModelTargetsForUser,
  type VisibleModelTargets,
} from "../lib/model-api-token-access";
import { poolMemberRoutingStatuses } from "../lib/model-pool-routing";
import {
  openAiCapabilitiesFromCoarse,
  resolveEffectiveCapabilityMetadata,
  supportsChatCompletions,
  transformerModalityMismatchErrors,
  transformerSupportedModalities,
} from "../lib/openai-compatible-capabilities";
import { visibleModelAttachmentModalities } from "../lib/visible-model-modalities";

const CLI_HEARTBEAT_STALE_AFTER_MS = 60_000;

const slugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: `forwarderSlug.${result.reason}` });
    }
  });

const poolSlugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderPoolSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: "forwarderSlug." + result.reason });
    }
  });

const poolNameSchema = z.string().trim().min(1).max(120);
const poolDescriptionSchema = z.string().trim().max(1000).nullable().optional();
const idSchema = z.string().min(1);
const routingStatusSchema = z.enum(poolMemberRoutingStatuses);

type UserSlugRow = {
  id: string;
  slug: string;
};

type SlugPreviewDirectModelRow = {
  id: string;
  upstreamModelId: string;
  Endpoint: {
    slug: string;
    CliDevice: { slug: string };
  };
};

type SlugPreviewPoolRow = {
  id: string;
  slug: string;
  name: string;
};

type CliDeviceRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  label: string;
  status: string;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastHeartbeatAt: Date | null;
  connectionCount: number;
  inventorySeq: number;
  inventoryDigest: string | null;
  inventoryAcknowledgedAt: Date | null;
  inventoryConfirmed: boolean;
  endpointTargeting: boolean;
  User: { slug: string };
  Endpoints: EndpointRow[];
};

type EndpointRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  label: string;
  kind: string;
  status: string;
  defaultCapabilities: string[];
  capabilityMetadata: unknown | null;
  probeSuggestions: unknown | null;
  lastSeenAt: Date | null;
  lastHealthCheckAt: Date | null;
  statusChangedAt: Date | null;
  failureReasonCode: string | null;
  published: boolean;
  unpublishedAt: Date | null;
  DiscoveredModels: DiscoveredModelRow[];
};

type DiscoveredModelRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string | null;
  upstreamModelId: string;
  encodedModelId: string;
  capabilityOverrideMode: string;
  capabilityOverrides: string[];
  capabilityOverrideMetadata: unknown | null;
  probeSuggestions: unknown | null;
  lastSeenAt: Date | null;
  published: boolean;
  unpublishedAt: Date | null;
};

type ModelPoolRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  name: string;
  description: string | null;
  transformerDiscoveredModelId: string | null;
  transformerSystemPrompt: string | null;
  transformerImages: boolean;
  transformerAudio: boolean;
  transformerVideo: boolean;
  transformerCacheMode: string;
  transformerIncludePrimaryTools: boolean;
  transformerMaxTools: number;
  transformerMaxToolChars: number;
  transformerTimeoutMs: number | null;
  transformerMaxAssets: number | null;
  User: { slug: string };
  TransformerDiscoveredModel: {
    id: string;
    upstreamModelId: string;
    User: { slug: string };
    Endpoint: {
      id: string;
      slug: string;
      CliDevice: { slug: string };
    };
  } | null;
  PoolMembers: PoolMemberRow[];
  PoolGrants: PoolGrantRow[];
};

type PoolMemberRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  discoveredModelId: string;
  weight: number;
  healthStatus: string;
  routingStatus: string;
  lastFailureClass: string | null;
  consecutiveRetryableFailures: number;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
  DiscoveredModel: {
    id: string;
    upstreamModelId: string;
    capabilityOverrideMode: string;
    capabilityOverrides: string[];
    capabilityOverrideMetadata: unknown | null;
    User: { slug: string };
    Endpoint: {
      id: string;
      slug: string;
      capabilityMetadata: unknown | null;
      defaultCapabilities: string[];
      CliDevice: { slug: string };
    };
  };
};

type PoolGrantRow = {
  id: string;
  createdAt: Date;
  granteeUserId: string;
  Grantee: {
    email: string;
    name: string;
  };
};

function slugValidationError(slug: string) {
  const result = validateForwarderSlug(slug);
  if (result.ok) return null;
  return new ORPCError("BAD_REQUEST", { message: `forwarderSlug.${result.reason}` });
}

async function currentUserSlug(userId: string): Promise<UserSlugRow> {
  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, slug: true },
  })) as UserSlugRow | null;
  if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found." });
  return user;
}

async function assertUserSlugAvailable(slug: string, currentUserId: string) {
  const validationError = slugValidationError(slug);
  if (validationError) throw validationError;

  const existing = await prisma.user.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existing && existing.id !== currentUserId) {
    throw new ORPCError("CONFLICT", { message: "forwarderSlug.taken" });
  }
}

async function userSlugChangePreview({ userId, nextSlug }: { userId: string; nextSlug: string }) {
  const user = await currentUserSlug(userId);
  await assertUserSlugAvailable(nextSlug, userId);

  const [directRows, poolRows] = await Promise.all([
    prisma.discoveredModel.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        upstreamModelId: true,
        Endpoint: {
          select: {
            slug: true,
            CliDevice: { select: { slug: true } },
          },
        },
      },
    }),
    prisma.modelPool.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
      },
    }),
  ]);

  const directModels = (directRows as SlugPreviewDirectModelRow[]).map((model) => ({
    kind: "DIRECT_MODEL" as const,
    id: model.id,
    upstreamModelId: model.upstreamModelId,
    currentModelId: directModelId({
      userSlug: user.slug,
      cliSlug: model.Endpoint.CliDevice.slug,
      endpointSlug: model.Endpoint.slug,
      upstreamModelId: model.upstreamModelId,
    }),
    nextModelId: directModelId({
      userSlug: nextSlug,
      cliSlug: model.Endpoint.CliDevice.slug,
      endpointSlug: model.Endpoint.slug,
      upstreamModelId: model.upstreamModelId,
    }),
  }));

  const modelPools = (poolRows as SlugPreviewPoolRow[]).map((pool) => ({
    kind: "MODEL_POOL" as const,
    id: pool.id,
    name: pool.name,
    currentModelId: poolModelId({ userSlug: user.slug, poolSlug: pool.slug }),
    nextModelId: poolModelId({ userSlug: nextSlug, poolSlug: pool.slug }),
  }));

  return {
    currentSlug: user.slug,
    nextSlug,
    willChange: user.slug !== nextSlug,
    affectedModels: [...directModels, ...modelPools],
  };
}

async function serializeVisibleTargets(targets: VisibleModelTargets) {
  const modalities = await visibleModelAttachmentModalities(targets);
  return {
    directModels: targets.directModels.map((model) => ({
      target: model.target,
      id: model.id,
      modelId: model.modelId,
      upstreamModelId: model.upstreamModelId,
      ownerUserId: model.ownerUserId,
      ownerUserSlug: model.ownerUserSlug,
      endpointId: model.endpointId,
      endpointSlug: model.endpointSlug,
      cliDeviceSlug: model.cliDeviceSlug,
      attachmentModalities: modalities.directById.get(model.id) ?? {
        image: false,
        audio: false,
        video: false,
      },
    })),
    modelPools: targets.modelPools.map((pool) => ({
      target: pool.target,
      id: pool.id,
      modelId: pool.modelId,
      name: pool.name,
      description: pool.description,
      ownerUserId: pool.ownerUserId,
      ownerUserSlug: pool.ownerUserSlug,
      poolSlug: pool.poolSlug,
      attachmentModalities: modalities.poolById.get(pool.id) ?? {
        image: false,
        audio: false,
        video: false,
      },
    })),
  };
}

function effectiveCapabilities(endpoint: EndpointRow, model: DiscoveredModelRow) {
  if (model.capabilityOverrideMode === "OVERRIDE") {
    return {
      coarse: model.capabilityOverrides,
      metadata: model.capabilityOverrideMetadata,
      source: "MODEL_OVERRIDE" as const,
    };
  }
  return {
    coarse: endpoint.defaultCapabilities,
    metadata: endpoint.capabilityMetadata,
    source: "ENDPOINT_DEFAULT" as const,
  };
}

function serializeCliDevice(row: CliDeviceRow, now: Date) {
  const staleAt = row.lastHeartbeatAt
    ? new Date(row.lastHeartbeatAt.getTime() + CLI_HEARTBEAT_STALE_AFTER_MS)
    : null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    slug: row.slug,
    label: row.label,
    status: row.status,
    lastConnectedAt: row.lastConnectedAt,
    lastDisconnectedAt: row.lastDisconnectedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    staleAt,
    isStale: Boolean(staleAt && staleAt <= now),
    connectionCount: row.connectionCount,
    inventorySeq: row.inventorySeq,
    inventoryDigest: row.inventoryDigest,
    inventoryAcknowledgedAt: row.inventoryAcknowledgedAt,
    inventoryConfirmed: row.inventoryConfirmed,
    endpointTargeting: row.endpointTargeting,
    endpoints: row.Endpoints.map((endpoint) => ({
      id: endpoint.id,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      slug: endpoint.slug,
      label: endpoint.label,
      kind: endpoint.kind,
      status: endpoint.status,
      defaultCapabilities: endpoint.defaultCapabilities,
      capabilityMetadata: endpoint.capabilityMetadata,
      probeSuggestions: endpoint.probeSuggestions,
      lastSeenAt: endpoint.lastSeenAt,
      lastHealthCheckAt: endpoint.lastHealthCheckAt,
      statusChangedAt: endpoint.statusChangedAt,
      failureReasonCode: endpoint.failureReasonCode,
      published: endpoint.published,
      unpublishedAt: endpoint.unpublishedAt,
      models: endpoint.DiscoveredModels.map((model) => ({
        id: model.id,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
        slug: model.slug,
        upstreamModelId: model.upstreamModelId,
        canonicalModelId: directModelId({
          userSlug: row.User.slug,
          cliSlug: row.slug,
          endpointSlug: endpoint.slug,
          upstreamModelId: model.upstreamModelId,
        }),
        capabilityOverrideMode: model.capabilityOverrideMode,
        capabilityOverrides: model.capabilityOverrides,
        capabilityOverrideMetadata: model.capabilityOverrideMetadata,
        probeSuggestions: model.probeSuggestions,
        effectiveCapabilities: effectiveCapabilities(endpoint, model),
        lastSeenAt: model.lastSeenAt,
        published: model.published,
        unpublishedAt: model.unpublishedAt,
      })),
    })),
  };
}

function serializePool(row: ModelPoolRow) {
  const transformerModel = row.TransformerDiscoveredModel
    ? {
        id: row.TransformerDiscoveredModel.id,
        upstreamModelId: row.TransformerDiscoveredModel.upstreamModelId,
        canonicalModelId: directModelId({
          userSlug: row.TransformerDiscoveredModel.User.slug,
          cliSlug: row.TransformerDiscoveredModel.Endpoint.CliDevice.slug,
          endpointSlug: row.TransformerDiscoveredModel.Endpoint.slug,
          upstreamModelId: row.TransformerDiscoveredModel.upstreamModelId,
        }),
        endpointId: row.TransformerDiscoveredModel.Endpoint.id,
        endpointSlug: row.TransformerDiscoveredModel.Endpoint.slug,
        cliDeviceSlug: row.TransformerDiscoveredModel.Endpoint.CliDevice.slug,
      }
    : null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    slug: row.slug,
    name: row.name,
    description: row.description,
    canonicalModelId: poolModelId({ userSlug: row.User.slug, poolSlug: row.slug }),
    transformer: {
      discoveredModelId: row.transformerDiscoveredModelId,
      systemPrompt: row.transformerSystemPrompt,
      images: row.transformerImages,
      audio: row.transformerAudio,
      video: row.transformerVideo,
      cacheMode: row.transformerCacheMode,
      includePrimaryTools: row.transformerIncludePrimaryTools,
      maxTools: row.transformerMaxTools,
      maxToolChars: row.transformerMaxToolChars,
      timeoutMs: row.transformerTimeoutMs,
      maxAssets: row.transformerMaxAssets,
      model: transformerModel,
    },
    members: row.PoolMembers.map((member) => ({
      id: member.id,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
      discoveredModelId: member.discoveredModelId,
      weight: member.weight,
      healthStatus: member.healthStatus,
      routingStatus: member.routingStatus,
      lastFailureClass: member.lastFailureClass,
      consecutiveRetryableFailures: member.consecutiveRetryableFailures,
      lastFailureAt: member.lastFailureAt,
      nextRetryAt: member.nextRetryAt,
      halfOpenTrialStartedAt: member.halfOpenTrialStartedAt,
      model: {
        id: member.DiscoveredModel.id,
        upstreamModelId: member.DiscoveredModel.upstreamModelId,
        canonicalModelId: directModelId({
          userSlug: member.DiscoveredModel.User.slug,
          cliSlug: member.DiscoveredModel.Endpoint.CliDevice.slug,
          endpointSlug: member.DiscoveredModel.Endpoint.slug,
          upstreamModelId: member.DiscoveredModel.upstreamModelId,
        }),
        endpointId: member.DiscoveredModel.Endpoint.id,
        endpointSlug: member.DiscoveredModel.Endpoint.slug,
        cliDeviceSlug: member.DiscoveredModel.Endpoint.CliDevice.slug,
        supportsChat: supportsChatCompletions({
          capabilities: resolveEffectiveCapabilityMetadata({
            capabilityOverrideMode: member.DiscoveredModel.capabilityOverrideMode,
            capabilityOverrideMetadata: member.DiscoveredModel.capabilityOverrideMetadata,
            endpointCapabilityMetadata: member.DiscoveredModel.Endpoint.capabilityMetadata,
          }),
          coarse:
            member.DiscoveredModel.capabilityOverrideMode === "OVERRIDE"
              ? member.DiscoveredModel.capabilityOverrides
              : member.DiscoveredModel.Endpoint.defaultCapabilities,
        }),
      },
    })),
    grants: row.PoolGrants.map((grant) => ({
      id: grant.id,
      createdAt: grant.createdAt,
      granteeUserId: grant.granteeUserId,
      granteeEmail: grant.Grantee.email,
      granteeName: grant.Grantee.name,
    })),
  };
}

async function ownedPool(poolId: string, userId: string) {
  const pool = await prisma.modelPool.findUnique({
    where: { id: poolId },
    select: { id: true, userId: true },
  });
  if (!pool || pool.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
  }
  return pool;
}

async function ownedDiscoveredModel(discoveredModelId: string, userId: string) {
  const model = await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: { id: true, userId: true },
  });
  if (!model || model.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
  }
  return model;
}

async function transformerCapabilitiesForOwnedModel(
  discoveredModelId: string,
  userId: string,
): Promise<ReturnType<typeof transformerSupportedModalities>> {
  const model = (await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: {
      id: true,
      userId: true,
      published: true,
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      Endpoint: { select: { published: true, capabilityMetadata: true } },
    },
  })) as {
    id: string;
    userId: string;
    published: boolean;
    capabilityOverrideMode: string;
    capabilityOverrideMetadata: unknown | null;
    Endpoint: { published: boolean; capabilityMetadata: unknown | null };
  } | null;
  if (!model || model.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
  }
  if (!model.published || !model.Endpoint.published) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Transformer model must be published (model and endpoint).",
    });
  }
  const caps = resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: model.capabilityOverrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
  });
  return transformerSupportedModalities(caps);
}

function assertTransformerMatchesModalities({
  caps,
  images,
  audio,
  video,
}: {
  caps: ReturnType<typeof transformerSupportedModalities>;
  images: boolean;
  audio: boolean;
  video: boolean;
}) {
  const errors = transformerModalityMismatchErrors({
    pool: { images, audio, video },
    transformerCaps: caps,
  });
  if (errors.length > 0) {
    throw new ORPCError("BAD_REQUEST", { message: errors.join(" ") });
  }
}

async function assertPoolSlugAvailable(slug: string, userId: string, currentPoolId?: string) {
  const validation = validateForwarderPoolSlug(slug);
  if (!validation.ok) {
    throw new ORPCError("BAD_REQUEST", { message: "forwarderSlug." + validation.reason });
  }

  const existing = await prisma.modelPool.findUnique({
    where: { userId_slug: { userId, slug } },
    select: { id: true },
  });
  if (existing && existing.id !== currentPoolId) {
    throw new ORPCError("CONFLICT", { message: "Model pool slug already exists." });
  }
}

async function removeOwnedRow({
  kind,
  id,
  userId,
  staleBefore,
}: {
  kind: "cliDevice" | "endpoint" | "discoveredModel";
  id: string;
  userId: string;
  staleBefore?: Date;
}) {
  if (kind === "cliDevice") {
    const row = await prisma.cliDevice.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, lastHeartbeatAt: true },
    });
    if (!row || row.userId !== userId) {
      throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
    }
    if (staleBefore && row.lastHeartbeatAt && row.lastHeartbeatAt >= staleBefore) {
      throw new ORPCError("CONFLICT", { message: "CLI device is not stale." });
    }
    await prisma.cliDevice.delete({ where: { id } });
    return { deleted: true };
  }

  if (kind === "endpoint") {
    const row = await prisma.endpoint.findUnique({
      where: { id },
      select: { id: true, userId: true, lastSeenAt: true },
    });
    if (!row || row.userId !== userId) {
      throw new ORPCError("NOT_FOUND", { message: "Endpoint not found." });
    }
    if (staleBefore && row.lastSeenAt && row.lastSeenAt >= staleBefore) {
      throw new ORPCError("CONFLICT", { message: "Endpoint is not stale." });
    }
    await prisma.endpoint.delete({ where: { id } });
    return { deleted: true };
  }

  const row = await prisma.discoveredModel.findUnique({
    where: { id },
    select: { id: true, userId: true, lastSeenAt: true },
  });
  if (!row || row.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
  }
  if (staleBefore && row.lastSeenAt && row.lastSeenAt >= staleBefore) {
    throw new ORPCError("CONFLICT", { message: "Discovered model is not stale." });
  }
  await prisma.discoveredModel.delete({ where: { id } });
  return { deleted: true };
}

const poolSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  slug: true,
  name: true,
  description: true,
  transformerDiscoveredModelId: true,
  transformerSystemPrompt: true,
  transformerImages: true,
  transformerAudio: true,
  transformerVideo: true,
  transformerCacheMode: true,
  transformerIncludePrimaryTools: true,
  transformerMaxTools: true,
  transformerMaxToolChars: true,
  transformerTimeoutMs: true,
  transformerMaxAssets: true,
  User: { select: { slug: true } },
  TransformerDiscoveredModel: {
    select: {
      id: true,
      upstreamModelId: true,
      User: { select: { slug: true } },
      Endpoint: {
        select: {
          id: true,
          slug: true,
          CliDevice: { select: { slug: true } },
        },
      },
    },
  },
  PoolMembers: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      discoveredModelId: true,
      weight: true,
      healthStatus: true,
      routingStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
      DiscoveredModel: {
        select: {
          id: true,
          upstreamModelId: true,
          capabilityOverrideMode: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
          User: { select: { slug: true } },
          Endpoint: {
            select: {
              id: true,
              slug: true,
              capabilityMetadata: true,
              defaultCapabilities: true,
              CliDevice: { select: { slug: true } },
            },
          },
        },
      },
    },
  },
  PoolGrants: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      createdAt: true,
      granteeUserId: true,
      Grantee: { select: { email: true, name: true } },
    },
  },
} as const;

export const forwarderManagementRouter = {
  getProfileSlug: protectedProcedure.handler(async ({ context }) => {
    const user = await currentUserSlug(context.session.user.id);
    return { slug: user.slug };
  }),

  previewProfileSlugChange: protectedProcedure
    .input(z.object({ slug: slugSchema }))
    .handler(async ({ input, context }) =>
      userSlugChangePreview({ userId: context.session.user.id, nextSlug: input.slug }),
    ),

  updateProfileSlug: protectedProcedure
    .input(z.object({ slug: slugSchema }))
    .handler(async ({ input, context }) => {
      const preview = await userSlugChangePreview({
        userId: context.session.user.id,
        nextSlug: input.slug,
      });
      const updated = await prisma.user.update({
        where: { id: context.session.user.id },
        data: { slug: input.slug },
        select: { id: true, slug: true },
      });
      return { slug: updated.slug, preview };
    }),

  listCliDevices: protectedProcedure
    .input(z.object({ includeModels: z.boolean().default(true) }).optional())
    .handler(async ({ context }) => {
      const rows = (await prisma.cliDevice.findMany({
        where: { userId: context.session.user.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          slug: true,
          label: true,
          status: true,
          lastConnectedAt: true,
          lastDisconnectedAt: true,
          lastHeartbeatAt: true,
          connectionCount: true,
          inventorySeq: true,
          inventoryDigest: true,
          inventoryAcknowledgedAt: true,
          inventoryConfirmed: true,
          endpointTargeting: true,
          User: { select: { slug: true } },
          Endpoints: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              createdAt: true,
              updatedAt: true,
              slug: true,
              label: true,
              kind: true,
              status: true,
              defaultCapabilities: true,
              capabilityMetadata: true,
              probeSuggestions: true,
              lastSeenAt: true,
              lastHealthCheckAt: true,
              statusChangedAt: true,
              failureReasonCode: true,
              published: true,
              unpublishedAt: true,
              DiscoveredModels: {
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  createdAt: true,
                  updatedAt: true,
                  slug: true,
                  upstreamModelId: true,
                  encodedModelId: true,
                  capabilityOverrideMode: true,
                  capabilityOverrides: true,
                  capabilityOverrideMetadata: true,
                  probeSuggestions: true,
                  lastSeenAt: true,
                  published: true,
                  unpublishedAt: true,
                },
              },
            },
          },
        },
      })) as CliDeviceRow[];

      const now = new Date();
      return rows.map((row) => serializeCliDevice(row, now));
    }),

  removeCliDeviceMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "cliDevice",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  removeEndpointMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "endpoint",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  removeDiscoveredModelMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "discoveredModel",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  listModelPools: protectedProcedure.handler(async ({ context }) => {
    const rows = (await prisma.modelPool.findMany({
      where: { userId: context.session.user.id },
      orderBy: { createdAt: "desc" },
      select: poolSelect,
    })) as ModelPoolRow[];
    return rows.map(serializePool);
  }),

  createModelPool: protectedProcedure
    .input(
      z.object({
        slug: poolSlugSchema,
        name: poolNameSchema,
        description: poolDescriptionSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      await assertPoolSlugAvailable(input.slug, context.session.user.id);
      const row = (await prisma.modelPool.create({
        data: {
          userId: context.session.user.id,
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
        },
        select: poolSelect,
      })) as ModelPoolRow;
      return serializePool(row);
    }),

  updateModelPool: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        slug: poolSlugSchema.optional(),
        name: poolNameSchema.optional(),
        description: poolDescriptionSchema,
        /** Set to a discovered model id owned by the user, or null to clear. */
        transformerDiscoveredModelId: z.string().min(1).nullable().optional(),
        transformerSystemPrompt: z.string().max(16_000).nullable().optional(),
        transformerImages: z.boolean().optional(),
        transformerAudio: z.boolean().optional(),
        transformerVideo: z.boolean().optional(),
        transformerCacheMode: z.enum(["OFF", "MEMORY"]).optional(),
        transformerIncludePrimaryTools: z.boolean().optional(),
        transformerMaxTools: z.number().int().min(1).max(128).optional(),
        transformerMaxToolChars: z.number().int().min(256).max(32_000).optional(),
        transformerTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
        transformerMaxAssets: z.number().int().min(1).max(64).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const existing = (await prisma.modelPool.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          userId: true,
          transformerDiscoveredModelId: true,
          transformerImages: true,
          transformerAudio: true,
          transformerVideo: true,
          transformerCacheMode: true,
        },
      })) as {
        id: string;
        userId: string;
        transformerDiscoveredModelId: string | null;
        transformerImages: boolean;
        transformerAudio: boolean;
        transformerVideo: boolean;
        transformerCacheMode: string;
      } | null;
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      }
      if (input.slug) {
        await assertPoolSlugAvailable(input.slug, context.session.user.id, input.id);
      }

      const nextTransformerId =
        input.transformerDiscoveredModelId !== undefined
          ? input.transformerDiscoveredModelId
          : existing.transformerDiscoveredModelId;
      const nextImages =
        input.transformerImages !== undefined
          ? input.transformerImages
          : existing.transformerImages;
      const nextAudio =
        input.transformerAudio !== undefined ? input.transformerAudio : existing.transformerAudio;
      const nextVideo =
        input.transformerVideo !== undefined ? input.transformerVideo : existing.transformerVideo;

      if (nextTransformerId) {
        const caps = await transformerCapabilitiesForOwnedModel(
          nextTransformerId,
          context.session.user.id,
        );
        assertTransformerMatchesModalities({
          caps,
          images: nextImages,
          audio: nextAudio,
          video: nextVideo,
        });
      } else if (input.transformerDiscoveredModelId === null) {
        // clearing transformer — ok
      }

      const row = (await prisma.modelPool.update({
        where: { id: input.id },
        data: {
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.transformerDiscoveredModelId !== undefined
            ? { transformerDiscoveredModelId: input.transformerDiscoveredModelId }
            : {}),
          ...(input.transformerSystemPrompt !== undefined
            ? { transformerSystemPrompt: input.transformerSystemPrompt }
            : {}),
          ...(input.transformerImages !== undefined
            ? { transformerImages: input.transformerImages }
            : {}),
          ...(input.transformerAudio !== undefined
            ? { transformerAudio: input.transformerAudio }
            : {}),
          ...(input.transformerVideo !== undefined
            ? { transformerVideo: input.transformerVideo }
            : {}),
          ...(input.transformerCacheMode !== undefined
            ? { transformerCacheMode: input.transformerCacheMode }
            : {}),
          ...(input.transformerIncludePrimaryTools !== undefined
            ? { transformerIncludePrimaryTools: input.transformerIncludePrimaryTools }
            : {}),
          ...(input.transformerMaxTools !== undefined
            ? { transformerMaxTools: input.transformerMaxTools }
            : {}),
          ...(input.transformerMaxToolChars !== undefined
            ? { transformerMaxToolChars: input.transformerMaxToolChars }
            : {}),
          ...(input.transformerTimeoutMs !== undefined
            ? { transformerTimeoutMs: input.transformerTimeoutMs }
            : {}),
          ...(input.transformerMaxAssets !== undefined
            ? { transformerMaxAssets: input.transformerMaxAssets }
            : {}),
        },
        select: poolSelect,
      })) as ModelPoolRow;
      return serializePool(row);
    }),

  deleteModelPool: protectedProcedure
    .input(z.object({ id: idSchema }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.id, context.session.user.id);
      await prisma.modelPool.delete({ where: { id: input.id } });
      return { deleted: true };
    }),

  addPoolMember: protectedProcedure
    .input(
      z.object({
        poolId: idSchema,
        discoveredModelId: idSchema,
        weight: z.number().int().min(0).max(10_000).default(1),
        routingStatus: routingStatusSchema.default("ACTIVE"),
      }),
    )
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      await ownedDiscoveredModel(input.discoveredModelId, context.session.user.id);
      return prisma.poolMember.create({
        data: {
          poolId: input.poolId,
          discoveredModelId: input.discoveredModelId,
          weight: input.weight,
          routingStatus: input.routingStatus,
        },
        select: { id: true },
      });
    }),

  updatePoolMember: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        weight: z.number().int().min(0).max(10_000).optional(),
        routingStatus: routingStatusSchema.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const member = await prisma.poolMember.findUnique({
        where: { id: input.id },
        select: { id: true, ModelPool: { select: { userId: true } } },
      });
      if (!member || member.ModelPool.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
      }
      return prisma.poolMember.update({
        where: { id: input.id },
        data: {
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.routingStatus ? { routingStatus: input.routingStatus } : {}),
        },
        select: { id: true, weight: true, routingStatus: true },
      });
    }),

  removePoolMember: protectedProcedure
    .input(z.object({ id: idSchema }))
    .handler(async ({ input, context }) => {
      const member = await prisma.poolMember.findUnique({
        where: { id: input.id },
        select: { id: true, ModelPool: { select: { userId: true } } },
      });
      if (!member || member.ModelPool.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
      }
      await prisma.poolMember.delete({ where: { id: input.id } });
      return { deleted: true };
    }),

  updateDiscoveredModelCapabilities: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        vision: z.boolean(),
        audio: z.boolean(),
        video: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      const model = await prisma.discoveredModel.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          userId: true,
          capabilityOverrideMode: true,
          capabilityOverrideMetadata: true,
          capabilityOverrides: true,
          Endpoint: { select: { capabilityMetadata: true, defaultCapabilities: true } },
        },
      });
      if (!model || model.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
      }
      const parsed = resolveEffectiveCapabilityMetadata({
        capabilityOverrideMode: model.capabilityOverrideMode,
        capabilityOverrideMetadata: model.capabilityOverrideMetadata,
        endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
      });
      if (!parsed) {
        const existingCoarse =
          model.capabilityOverrideMode === "OVERRIDE"
            ? model.capabilityOverrides
            : model.Endpoint.defaultCapabilities;
        const nextCoarse = existingCoarse.filter(
          (capability) =>
            capability !== "VISION_INPUT" &&
            capability !== "AUDIO_INPUT" &&
            capability !== "VIDEO_INPUT",
        ) as typeof existingCoarse;
        if (input.vision) nextCoarse.push("VISION_INPUT");
        if (input.audio) nextCoarse.push("AUDIO_INPUT");
        if (input.video) nextCoarse.push("VIDEO_INPUT");
        if (
          (input.vision || input.audio || input.video) &&
          !nextCoarse.includes("TEXT_GENERATION")
        ) {
          nextCoarse.push("TEXT_GENERATION");
        }
        return prisma.discoveredModel.update({
          where: { id: input.id },
          data: {
            capabilityOverrideMode: "OVERRIDE",
            capabilityOverrideOrigin: "DASHBOARD",
            capabilityOverrides: { set: nextCoarse },
            capabilityOverrideMetadata: openAiCapabilitiesFromCoarse(nextCoarse),
          },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
          },
        });
      }
      const base = parsed;
      const chatExisted = Boolean(base.chatCompletions);
      const needsChat = chatExisted || input.vision || input.audio || input.video;
      const metadata = {
        ...base,
        chatCompletions: needsChat
          ? {
              ...base.chatCompletions,
              ...(input.vision || input.audio || input.video ? { supported: true } : {}),
              vision: input.vision,
              audio: input.audio,
              video: input.video,
            }
          : base.chatCompletions,
      };
      const coarse: Array<
        | "TEXT_GENERATION"
        | "VISION_INPUT"
        | "AUDIO_INPUT"
        | "AUDIO_OUTPUT"
        | "VIDEO_INPUT"
        | "EMBEDDING"
        | "RESPONSES_API"
      > = [];
      if (
        metadata.chatCompletions?.supported ||
        metadata.completions?.supported ||
        metadata.responses?.supported
      ) {
        coarse.push("TEXT_GENERATION");
      }
      if (input.vision) coarse.push("VISION_INPUT");
      if (input.video) coarse.push("VIDEO_INPUT");
      if (input.audio || metadata.audio?.transcriptions || metadata.audio?.translations) {
        coarse.push("AUDIO_INPUT");
      }
      if (metadata.audio?.speech) coarse.push("AUDIO_OUTPUT");
      if (metadata.embeddings?.supported) coarse.push("EMBEDDING");
      if (metadata.responses?.supported) coarse.push("RESPONSES_API");
      return prisma.discoveredModel.update({
        where: { id: input.id },
        data: {
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: { set: coarse },
          capabilityOverrideMetadata: metadata,
        },
        select: {
          id: true,
          capabilityOverrideMode: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
        },
      });
    }),

  grantPoolAccessByEmail: protectedProcedure
    .input(z.object({ poolId: idSchema, email: z.string().trim().email().max(320) }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const grantee = await prisma.user.findFirst({
        where: { email: { equals: input.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (!grantee) {
        throw new ORPCError("NOT_FOUND", { message: "User not found." });
      }
      if (grantee.id === context.session.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: "Cannot grant a pool to yourself." });
      }
      return prisma.poolGrant.upsert({
        where: {
          poolId_granteeUserId: {
            poolId: input.poolId,
            granteeUserId: grantee.id,
          },
        },
        update: {},
        create: {
          poolId: input.poolId,
          ownerUserId: context.session.user.id,
          granteeUserId: grantee.id,
        },
        select: { id: true, poolId: true, granteeUserId: true },
      });
    }),

  revokePoolAccessByEmail: protectedProcedure
    .input(z.object({ poolId: idSchema, email: z.string().trim().email().max(320) }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const grantee = await prisma.user.findFirst({
        where: { email: { equals: input.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (!grantee) {
        throw new ORPCError("NOT_FOUND", { message: "User not found." });
      }
      const result = await prisma.poolGrant.deleteMany({
        where: {
          poolId: input.poolId,
          ownerUserId: context.session.user.id,
          granteeUserId: grantee.id,
        },
      });
      return { revokedCount: result.count };
    }),

  visibleModels: protectedProcedure.handler(async ({ context }) =>
    serializeVisibleTargets(await listVisibleModelTargetsForUser(context.session.user.id)),
  ),
};

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
};

type ModelPoolRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  name: string;
  description: string | null;
  User: { slug: string };
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
    User: { slug: string };
    Endpoint: {
      id: string;
      slug: string;
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

function serializeVisibleTargets(targets: VisibleModelTargets) {
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
      })),
    })),
  };
}

function serializePool(row: ModelPoolRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    slug: row.slug,
    name: row.name,
    description: row.description,
    canonicalModelId: poolModelId({ userSlug: row.User.slug, poolSlug: row.slug }),
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
  User: { select: { slug: true } },
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
      }),
    )
    .handler(async ({ input, context }) => {
      await ownedPool(input.id, context.session.user.id);
      if (input.slug) {
        await assertPoolSlugAvailable(input.slug, context.session.user.id, input.id);
      }
      const row = (await prisma.modelPool.update({
        where: { id: input.id },
        data: {
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
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

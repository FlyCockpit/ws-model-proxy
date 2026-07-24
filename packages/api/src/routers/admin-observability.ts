import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";
import { adminProcedure } from "../index";

const CLI_HEARTBEAT_STALE_AFTER_MS = 60_000;

const cliStatusSchema = z.enum(["DISCONNECTED", "CONNECTED", "STALE", "REVOKED"]);
const endpointStatusSchema = z.enum(["UNKNOWN", "ONLINE", "DEGRADED", "OFFLINE"]);
const modelCapabilityFamilySchema = z.enum([
  "TEXT",
  "VISION",
  "VIDEO",
  "EMBEDDING",
  "AUDIO",
  "RESPONSES",
]);
const relayStatusSchema = z.enum(["PENDING", "SUCCEEDED", "FAILED", "CANCELED"]);
const poolMemberHealthSchema = z.enum(["UNKNOWN", "HEALTHY", "HALF_OPEN", "DEGRADED", "UNHEALTHY"]);

const paginationInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
};

const ownerFilterInput = {
  ownerQuery: z.string().trim().min(1).max(200).optional(),
};

const dateRangeInput = z
  .object({
    createdAfter: z.date().optional(),
    createdBefore: z.date().optional(),
  })
  .refine(
    (input) =>
      !input.createdAfter || !input.createdBefore || input.createdAfter < input.createdBefore,
    {
      message: "createdAfter must be earlier than createdBefore.",
    },
  );

type OwnerRow = {
  id: string;
  email: string;
  name: string;
  slug: string;
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
  User: OwnerRow;
  _count: {
    Endpoints: number;
    CliTokens: number;
    CliDeviceCredentials: number;
  };
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
  User: OwnerRow;
  CliDevice: {
    id: string;
    slug: string;
    label: string;
    status: string;
    lastHeartbeatAt: Date | null;
  };
  _count: { DiscoveredModels: number };
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
  User: OwnerRow;
  Endpoint: {
    id: string;
    slug: string;
    label: string;
    status: string;
    defaultCapabilities: string[];
    capabilityMetadata: unknown | null;
    CliDevice: {
      id: string;
      slug: string;
      label: string;
      status: string;
      lastHeartbeatAt: Date | null;
    };
  };
  _count: { PoolMembers: number };
};

type ModelPoolRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  name: string;
  description: string | null;
  User: OwnerRow;
  PoolMembers: PoolMemberRow[];
  _count: { PoolGrants: number; ModelApiTokenAllowlistEntries: number };
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
  lastRoutedAt: Date | null;
  DiscoveredModel: {
    id: string;
    upstreamModelId: string;
    User: { slug: string };
    Endpoint: {
      id: string;
      slug: string;
      label: string;
      status: string;
      CliDevice: {
        id: string;
        slug: string;
        label: string;
        status: string;
        lastHeartbeatAt: Date | null;
      };
    };
  };
};

type RelayRequestRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  modelApiTokenId: string | null;
  modelApiTokenLookupPrefix: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  httpStatusCode: number | null;
  upstreamStatusCode: number | null;
  errorClass: string | null;
  User: OwnerRow;
  ModelApiToken: { id: string; name: string; lookupPrefix: string } | null;
  RequestedDiscoveredModel: RelayModelRow | null;
  RequestedModelPool: { id: string; slug: string; name: string; User: { slug: string } } | null;
  SelectedDiscoveredModel: RelayModelRow | null;
};

type RelayModelRow = {
  id: string;
  upstreamModelId: string;
  User: { slug: string };
  Endpoint: { slug: string; CliDevice: { slug: string } };
};

type StatusGroupRow = { status: string; _count: { _all: number } };
type ErrorClassGroupRow = { errorClass: string | null; _count: { _all: number } };
type RelayAggregateRow = {
  _avg: { durationMs: number | null };
  _min: { durationMs: number | null };
  _max: { durationMs: number | null };
  _sum: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
};

type ModelCapabilityValue =
  | "TEXT_GENERATION"
  | "VISION_INPUT"
  | "VIDEO_INPUT"
  | "EMBEDDING"
  | "AUDIO_INPUT"
  | "AUDIO_OUTPUT"
  | "RESPONSES_API";

function capabilitiesForFamily(
  family: z.infer<typeof modelCapabilityFamilySchema> | undefined,
): ModelCapabilityValue[] {
  if (!family) return [];
  if (family === "TEXT") return ["TEXT_GENERATION"];
  if (family === "VISION") return ["VISION_INPUT"];
  if (family === "VIDEO") return ["VIDEO_INPUT"];
  if (family === "EMBEDDING") return ["EMBEDDING"];
  if (family === "RESPONSES") return ["RESPONSES_API"];
  return ["AUDIO_INPUT", "AUDIO_OUTPUT"];
}

function pagination(page: number, pageSize: number) {
  return {
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

function paginatedResult<T>({
  items,
  total,
  page,
  pageSize,
}: {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}) {
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
  };
}

function ownerWhere(ownerQuery: string | undefined) {
  return ownerQuery
    ? {
        User: {
          is: {
            OR: [
              { email: { contains: ownerQuery, mode: "insensitive" as const } },
              { name: { contains: ownerQuery, mode: "insensitive" as const } },
              { slug: { contains: ownerQuery, mode: "insensitive" as const } },
            ],
          },
        },
      }
    : {};
}

function createdAtWhere(input: { createdAfter?: Date; createdBefore?: Date }) {
  return input.createdAfter || input.createdBefore
    ? {
        createdAt: {
          ...(input.createdAfter ? { gte: input.createdAfter } : {}),
          ...(input.createdBefore ? { lt: input.createdBefore } : {}),
        },
      }
    : {};
}

function staleAt(lastHeartbeatAt: Date | null) {
  return lastHeartbeatAt
    ? new Date(lastHeartbeatAt.getTime() + CLI_HEARTBEAT_STALE_AFTER_MS)
    : null;
}

function isStale(lastHeartbeatAt: Date | null, now: Date) {
  const nextStaleAt = staleAt(lastHeartbeatAt);
  return Boolean(nextStaleAt && nextStaleAt <= now);
}

function owner(row: OwnerRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    slug: row.slug,
  };
}

function effectiveCapabilities(
  endpoint: { defaultCapabilities: string[]; capabilityMetadata: unknown | null },
  model: {
    capabilityOverrideMode: string;
    capabilityOverrides: string[];
    capabilityOverrideMetadata: unknown | null;
  },
) {
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

function serializeCli(row: CliDeviceRow, now: Date) {
  const nextStaleAt = staleAt(row.lastHeartbeatAt);
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: owner(row.User),
    slug: row.slug,
    label: row.label,
    status: String(row.status),
    lastConnectedAt: row.lastConnectedAt,
    lastDisconnectedAt: row.lastDisconnectedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    staleAt: nextStaleAt,
    isStale: Boolean(nextStaleAt && nextStaleAt <= now),
    connectionCount: row.connectionCount,
    endpointCount: row._count.Endpoints,
    cliTokenCount: row._count.CliTokens,
    credentialCount: row._count.CliDeviceCredentials,
  };
}

function serializeEndpoint(row: EndpointRow, now: Date) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: owner(row.User),
    cliDevice: {
      id: row.CliDevice.id,
      slug: row.CliDevice.slug,
      label: row.CliDevice.label,
      status: String(row.CliDevice.status),
      lastHeartbeatAt: row.CliDevice.lastHeartbeatAt,
      isStale: isStale(row.CliDevice.lastHeartbeatAt, now),
    },
    slug: row.slug,
    label: row.label,
    kind: String(row.kind),
    status: String(row.status),
    defaultCapabilities: row.defaultCapabilities,
    capabilityMetadata: row.capabilityMetadata,
    probeSuggestions: row.probeSuggestions,
    lastSeenAt: row.lastSeenAt,
    lastHealthCheckAt: row.lastHealthCheckAt,
    statusChangedAt: row.statusChangedAt,
    failureReasonCode: row.failureReasonCode,
    discoveredModelCount: row._count.DiscoveredModels,
    healthState:
      row.status === "ONLINE" && !isStale(row.CliDevice.lastHeartbeatAt, now)
        ? "HEALTHY"
        : "ATTENTION",
  };
}

function serializeModel(row: DiscoveredModelRow, now: Date) {
  const capabilities = effectiveCapabilities(row.Endpoint, row);
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: owner(row.User),
    endpoint: {
      id: row.Endpoint.id,
      slug: row.Endpoint.slug,
      label: row.Endpoint.label,
      status: String(row.Endpoint.status),
    },
    cliDevice: {
      id: row.Endpoint.CliDevice.id,
      slug: row.Endpoint.CliDevice.slug,
      label: row.Endpoint.CliDevice.label,
      status: String(row.Endpoint.CliDevice.status),
      lastHeartbeatAt: row.Endpoint.CliDevice.lastHeartbeatAt,
      isStale: isStale(row.Endpoint.CliDevice.lastHeartbeatAt, now),
    },
    slug: row.slug,
    upstreamModelId: row.upstreamModelId,
    canonicalModelId: directModelId({
      userSlug: row.User.slug,
      cliSlug: row.Endpoint.CliDevice.slug,
      endpointSlug: row.Endpoint.slug,
      upstreamModelId: row.upstreamModelId,
    }),
    capabilityOverrideMode: String(row.capabilityOverrideMode),
    capabilityOverrides: row.capabilityOverrides,
    capabilityOverrideMetadata: row.capabilityOverrideMetadata,
    probeSuggestions: row.probeSuggestions,
    effectiveCapabilities: capabilities,
    lastSeenAt: row.lastSeenAt,
    poolMemberCount: row._count.PoolMembers,
    healthState:
      row.Endpoint.status === "ONLINE" && !isStale(row.Endpoint.CliDevice.lastHeartbeatAt, now)
        ? "AVAILABLE"
        : "UNAVAILABLE",
  };
}

function relayModel(row: RelayModelRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    upstreamModelId: row.upstreamModelId,
    canonicalModelId: directModelId({
      userSlug: row.User.slug,
      cliSlug: row.Endpoint.CliDevice.slug,
      endpointSlug: row.Endpoint.slug,
      upstreamModelId: row.upstreamModelId,
    }),
  };
}

function serializePool(row: ModelPoolRow, now: Date) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: owner(row.User),
    slug: row.slug,
    name: row.name,
    description: row.description,
    canonicalModelId: poolModelId({ userSlug: row.User.slug, poolSlug: row.slug }),
    grantCount: row._count.PoolGrants,
    allowlistEntryCount: row._count.ModelApiTokenAllowlistEntries,
    members: row.PoolMembers.map((member) => ({
      id: member.id,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
      discoveredModelId: member.discoveredModelId,
      weight: member.weight,
      healthStatus: String(member.healthStatus),
      routingStatus: String(member.routingStatus),
      lastFailureClass: member.lastFailureClass,
      consecutiveRetryableFailures: member.consecutiveRetryableFailures,
      lastFailureAt: member.lastFailureAt,
      nextRetryAt: member.nextRetryAt,
      halfOpenTrialStartedAt: member.halfOpenTrialStartedAt,
      lastRoutedAt: member.lastRoutedAt,
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
        endpointLabel: member.DiscoveredModel.Endpoint.label,
        endpointStatus: String(member.DiscoveredModel.Endpoint.status),
        cliDeviceId: member.DiscoveredModel.Endpoint.CliDevice.id,
        cliDeviceSlug: member.DiscoveredModel.Endpoint.CliDevice.slug,
        cliDeviceLabel: member.DiscoveredModel.Endpoint.CliDevice.label,
        cliDeviceStatus: String(member.DiscoveredModel.Endpoint.CliDevice.status),
        cliDeviceIsStale: isStale(member.DiscoveredModel.Endpoint.CliDevice.lastHeartbeatAt, now),
      },
    })),
  };
}

function serializeRelay(row: RelayRequestRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: owner(row.User),
    modelApiToken: row.ModelApiToken
      ? {
          id: row.ModelApiToken.id,
          name: row.ModelApiToken.name,
          lookupPrefix: row.ModelApiToken.lookupPrefix,
        }
      : row.modelApiTokenLookupPrefix
        ? {
            id: row.modelApiTokenId,
            name: null,
            lookupPrefix: row.modelApiTokenLookupPrefix,
          }
        : null,
    requestedModel: relayModel(row.RequestedDiscoveredModel),
    requestedPool: row.RequestedModelPool
      ? {
          id: row.RequestedModelPool.id,
          name: row.RequestedModelPool.name,
          slug: row.RequestedModelPool.slug,
          canonicalModelId: poolModelId({
            userSlug: row.RequestedModelPool.User.slug,
            poolSlug: row.RequestedModelPool.slug,
          }),
        }
      : null,
    selectedModel: relayModel(row.SelectedDiscoveredModel),
    status: String(row.status),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    httpStatusCode: row.httpStatusCode,
    upstreamStatusCode: row.upstreamStatusCode,
    errorClass: row.errorClass,
  };
}

const ownerSelect = {
  id: true,
  email: true,
  name: true,
  slug: true,
} as const;

const poolMemberSelect = {
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
  lastRoutedAt: true,
  DiscoveredModel: {
    select: {
      id: true,
      upstreamModelId: true,
      User: { select: { slug: true } },
      Endpoint: {
        select: {
          id: true,
          slug: true,
          label: true,
          status: true,
          CliDevice: {
            select: {
              id: true,
              slug: true,
              label: true,
              status: true,
              lastHeartbeatAt: true,
            },
          },
        },
      },
    },
  },
} as const;

const relayModelSelect = {
  id: true,
  upstreamModelId: true,
  User: { select: { slug: true } },
  Endpoint: {
    select: {
      slug: true,
      CliDevice: { select: { slug: true } },
    },
  },
} as const;

export const adminObservabilityRouter = {
  listCliDevices: adminProcedure
    .input(
      z
        .object({
          ...paginationInput,
          ...ownerFilterInput,
          status: cliStatusSchema.optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 25;
      const where = {
        ...ownerWhere(input?.ownerQuery),
        ...(input?.status ? { status: input.status } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.cliDevice.count({ where }),
        prisma.cliDevice.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          ...pagination(page, pageSize),
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
            User: { select: ownerSelect },
            _count: { select: { Endpoints: true, CliTokens: true, CliDeviceCredentials: true } },
          },
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: (rows as CliDeviceRow[]).map((row) => serializeCli(row, now)),
        total,
        page,
        pageSize,
      });
    }),

  listEndpoints: adminProcedure
    .input(
      z
        .object({
          ...paginationInput,
          ...ownerFilterInput,
          status: endpointStatusSchema.optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 25;
      const where = {
        ...ownerWhere(input?.ownerQuery),
        ...(input?.status ? { status: input.status } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.endpoint.count({ where }),
        prisma.endpoint.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          ...pagination(page, pageSize),
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
            User: { select: ownerSelect },
            CliDevice: {
              select: {
                id: true,
                slug: true,
                label: true,
                status: true,
                lastHeartbeatAt: true,
              },
            },
            _count: { select: { DiscoveredModels: true } },
          },
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: (rows as EndpointRow[]).map((row) => serializeEndpoint(row, now)),
        total,
        page,
        pageSize,
      });
    }),

  listModels: adminProcedure
    .input(
      z
        .object({
          ...paginationInput,
          ...ownerFilterInput,
          capabilityFamily: modelCapabilityFamilySchema.optional(),
          endpointStatus: endpointStatusSchema.optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 25;
      const capabilities = capabilitiesForFamily(input?.capabilityFamily);
      const capabilityWhere =
        capabilities.length > 0
          ? {
              OR: capabilities.flatMap((capability) => [
                {
                  capabilityOverrideMode: "OVERRIDE" as const,
                  capabilityOverrides: { has: capability },
                },
                {
                  capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS" as const,
                  Endpoint: { is: { defaultCapabilities: { has: capability } } },
                },
              ]),
            }
          : {};
      const where = {
        ...ownerWhere(input?.ownerQuery),
        ...(input?.endpointStatus ? { Endpoint: { is: { status: input.endpointStatus } } } : {}),
        ...capabilityWhere,
      };
      const [total, rows] = await Promise.all([
        prisma.discoveredModel.count({ where }),
        prisma.discoveredModel.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          ...pagination(page, pageSize),
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
            User: { select: ownerSelect },
            Endpoint: {
              select: {
                id: true,
                slug: true,
                label: true,
                status: true,
                defaultCapabilities: true,
                capabilityMetadata: true,
                CliDevice: {
                  select: {
                    id: true,
                    slug: true,
                    label: true,
                    status: true,
                    lastHeartbeatAt: true,
                  },
                },
              },
            },
            _count: { select: { PoolMembers: true } },
          },
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: (rows as unknown as DiscoveredModelRow[]).map((row) => serializeModel(row, now)),
        total,
        page,
        pageSize,
      });
    }),

  listPools: adminProcedure
    .input(
      z
        .object({
          ...paginationInput,
          ...ownerFilterInput,
          memberHealth: poolMemberHealthSchema.optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 25;
      const where = {
        ...ownerWhere(input?.ownerQuery),
        ...(input?.memberHealth
          ? { PoolMembers: { some: { healthStatus: input.memberHealth } } }
          : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.modelPool.count({ where }),
        prisma.modelPool.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          ...pagination(page, pageSize),
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            slug: true,
            name: true,
            description: true,
            User: { select: ownerSelect },
            PoolMembers: {
              orderBy: { createdAt: "asc" },
              select: poolMemberSelect,
            },
            _count: { select: { PoolGrants: true, ModelApiTokenAllowlistEntries: true } },
          },
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: (rows as ModelPoolRow[]).map((row) => serializePool(row, now)),
        total,
        page,
        pageSize,
      });
    }),

  listRelayMetadataSummaries: adminProcedure
    .input(
      dateRangeInput
        .extend({
          ...paginationInput,
          ...ownerFilterInput,
          status: relayStatusSchema.optional(),
          errorClass: z.string().trim().min(1).max(120).optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 25;
      const where = {
        ...ownerWhere(input?.ownerQuery),
        ...createdAtWhere({
          createdAfter: input?.createdAfter,
          createdBefore: input?.createdBefore,
        }),
        ...(input?.status ? { status: input.status } : {}),
        ...(input?.errorClass ? { errorClass: input.errorClass } : {}),
      };
      const [total, rows, statusGroups, errorClassGroups, aggregate] = await Promise.all([
        prisma.relayRequest.count({ where }),
        prisma.relayRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          ...pagination(page, pageSize),
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            modelApiTokenId: true,
            modelApiTokenLookupPrefix: true,
            status: true,
            startedAt: true,
            completedAt: true,
            durationMs: true,
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
            httpStatusCode: true,
            upstreamStatusCode: true,
            errorClass: true,
            User: { select: ownerSelect },
            ModelApiToken: { select: { id: true, name: true, lookupPrefix: true } },
            RequestedDiscoveredModel: { select: relayModelSelect },
            RequestedModelPool: {
              select: {
                id: true,
                slug: true,
                name: true,
                User: { select: { slug: true } },
              },
            },
            SelectedDiscoveredModel: { select: relayModelSelect },
          },
        }),
        prisma.relayRequest.groupBy({
          by: ["status"],
          where,
          _count: { _all: true },
        }),
        prisma.relayRequest.groupBy({
          by: ["errorClass"],
          where,
          _count: { _all: true },
        }),
        prisma.relayRequest.aggregate({
          where,
          _avg: { durationMs: true },
          _min: { durationMs: true },
          _max: { durationMs: true },
          _sum: {
            promptTokens: true,
            completionTokens: true,
            totalTokens: true,
          },
        }),
      ]);

      return {
        ...paginatedResult({
          items: (rows as RelayRequestRow[]).map(serializeRelay),
          total,
          page,
          pageSize,
        }),
        summary: {
          statusCounts: (statusGroups as StatusGroupRow[]).map((row) => ({
            status: String(row.status),
            count: row._count._all,
          })),
          errorClassCounts: (errorClassGroups as ErrorClassGroupRow[]).map((row) => ({
            errorClass: row.errorClass,
            count: row._count._all,
          })),
          durationMs: {
            average: (aggregate as RelayAggregateRow)._avg.durationMs,
            minimum: (aggregate as RelayAggregateRow)._min.durationMs,
            maximum: (aggregate as RelayAggregateRow)._max.durationMs,
          },
          tokens: {
            prompt: (aggregate as RelayAggregateRow)._sum.promptTokens,
            completion: (aggregate as RelayAggregateRow)._sum.completionTokens,
            total: (aggregate as RelayAggregateRow)._sum.totalTokens,
          },
        },
      };
    }),
};

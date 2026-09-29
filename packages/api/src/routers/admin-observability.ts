import { cliDeviceDisplayName } from "@ws-model-proxy/config/cli-device-name";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma, { Prisma } from "@ws-model-proxy/db";
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

type OwnerRow = Prisma.UserGetPayload<{ select: typeof ownerSelect }>;
type CliDeviceRow = Prisma.CliDeviceGetPayload<{ select: typeof cliDeviceSelect }>;
type EndpointRow = Prisma.EndpointGetPayload<{ select: typeof endpointSelect }>;
type DiscoveredModelRow = Prisma.DiscoveredModelGetPayload<{
  select: typeof discoveredModelSelect;
}>;
type ModelPoolRow = Prisma.ModelPoolGetPayload<{ select: typeof modelPoolSelect }>;
type RelayRequestRow = Prisma.RelayRequestGetPayload<{ select: typeof relayRequestSelect }>;
type RelayPoolRow = Prisma.ModelPoolGetPayload<{ select: typeof relayPoolSelect }>;
type RelayTokenRow = Prisma.ModelApiTokenGetPayload<{ select: typeof relayTokenSelect }>;
/**
 * The graph rows a relay row names by plain id (relay_request is hot-path
 * history with no foreign key, @ws-model-proxy/db/capacity-lock-order),
 * loaded per page. A deleted row is simply absent.
 */
type RelayRelations = {
  users: Map<string, OwnerRow>;
  tokens: Map<string, RelayTokenRow>;
  models: Map<string, RelayModelRow>;
  pools: Map<string, RelayPoolRow>;
};
type RelayModelRow = Prisma.DiscoveredModelGetPayload<{ select: typeof relayModelSelect }>;

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

/**
 * The owner filter for relay rows, which name their owner by plain id (no
 * relation): the matching users' ids.
 */
async function relayOwnerWhere(ownerQuery: string | undefined) {
  if (!ownerQuery) return {};
  const users = await prisma.user.findMany({
    where: ownerWhere(ownerQuery).User?.is ?? {},
    select: { id: true },
  });
  return { userId: { in: users.map((user) => user.id) } };
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
    name: row.name,
    reportedHostname: row.reportedHostname,
    displayName: cliDeviceDisplayName(row),
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
      displayName: cliDeviceDisplayName(row.CliDevice),
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
      displayName: cliDeviceDisplayName(row.Endpoint.CliDevice),
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
    members: row.PoolMembers.map((member) => {
      const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
      return {
        id: member.id,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
        discoveredModelId: model?.id ?? member.discoveredModelId,
        weight: member.weight,
        healthStatus: String(member.healthStatus),
        routingStatus: String(member.routingStatus),
        lastFailureClass: member.lastFailureClass,
        consecutiveRetryableFailures: member.consecutiveRetryableFailures,
        lastFailureAt: member.lastFailureAt,
        nextRetryAt: member.nextRetryAt,
        halfOpenTrialStartedAt: member.halfOpenTrialStartedAt,
        lastRoutedAt: member.lastRoutedAt,
        model: model
          ? {
              id: model.id,
              upstreamModelId: model.upstreamModelId,
              canonicalModelId: directModelId({
                userSlug: model.User.slug,
                cliSlug: model.Endpoint.CliDevice.slug,
                endpointSlug: model.Endpoint.slug,
                upstreamModelId: model.upstreamModelId,
              }),
              endpointId: model.Endpoint.id,
              endpointSlug: model.Endpoint.slug,
              endpointLabel: model.Endpoint.label,
              endpointStatus: String(model.Endpoint.status),
              cliDeviceId: model.Endpoint.CliDevice.id,
              cliDeviceSlug: model.Endpoint.CliDevice.slug,
              cliDeviceDisplayName: cliDeviceDisplayName(model.Endpoint.CliDevice),
              cliDeviceStatus: String(model.Endpoint.CliDevice.status),
              cliDeviceIsStale: isStale(model.Endpoint.CliDevice.lastHeartbeatAt, now),
            }
          : null,
      };
    }),
  };
}

async function loadRelayRelations(rows: readonly RelayRequestRow[]): Promise<RelayRelations> {
  const ids = (values: Array<string | null>) => [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
  const [users, tokens, models, pools] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids(rows.map((row) => row.userId)) } },
      select: ownerSelect,
    }),
    prisma.modelApiToken.findMany({
      where: { id: { in: ids(rows.map((row) => row.modelApiTokenId)) } },
      select: relayTokenSelect,
    }),
    prisma.discoveredModel.findMany({
      where: {
        id: {
          in: ids(
            rows.flatMap((row) => [row.requestedDiscoveredModelId, row.selectedDiscoveredModelId]),
          ),
        },
      },
      select: relayModelSelect,
    }),
    prisma.modelPool.findMany({
      where: { id: { in: ids(rows.map((row) => row.requestedModelPoolId)) } },
      select: relayPoolSelect,
    }),
  ]);
  return {
    users: new Map(users.map((user) => [user.id, user])),
    tokens: new Map(tokens.map((token) => [token.id, token])),
    models: new Map(models.map((model) => [model.id, model])),
    pools: new Map(pools.map((pool) => [pool.id, pool])),
  };
}

function serializeRelay(row: RelayRequestRow, relations: RelayRelations) {
  const user = relations.users.get(row.userId);
  const token = row.modelApiTokenId ? relations.tokens.get(row.modelApiTokenId) : undefined;
  const pool = row.requestedModelPoolId ? relations.pools.get(row.requestedModelPoolId) : undefined;
  const model = (id: string | null) => (id ? (relations.models.get(id) ?? null) : null);
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // A deleted owner's history keeps its id until the purge sweeper takes it.
    owner: user ? owner(user) : { id: row.userId, email: "", name: "", slug: "" },
    modelApiToken: token
      ? {
          id: token.id,
          name: token.name,
          lookupPrefix: token.lookupPrefix,
        }
      : row.modelApiTokenLookupPrefix
        ? {
            id: row.modelApiTokenId,
            name: null,
            lookupPrefix: row.modelApiTokenLookupPrefix,
          }
        : null,
    requestedModel: relayModel(model(row.requestedDiscoveredModelId)),
    requestedPool: pool
      ? {
          id: pool.id,
          name: pool.name,
          slug: pool.slug,
          canonicalModelId: poolModelId({
            userSlug: pool.User.slug,
            poolSlug: pool.slug,
          }),
        }
      : null,
    selectedModel: relayModel(model(row.selectedDiscoveredModelId)),
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
    operation: row.operation,
    requestBytes: row.requestBytes === null ? null : Number(row.requestBytes),
    responseBytes: row.responseBytes === null ? null : Number(row.responseBytes),
    attemptCount: row.attemptCount,
    auxiliaryAttemptCount: row.auxiliaryAttemptCount,
    auxiliaryRequestBytes: Number(row.auxiliaryRequestBytes),
    auxiliaryResponseBytes: Number(row.auxiliaryResponseBytes),
    requestedSurface: row.requestedSurface,
    selectedNativeSurface: row.selectedNativeSurface,
    adapterMode: row.adapterMode,
    adapterVersion: row.adapterVersion,
    selectedPoolMemberId: row.selectedPoolMemberId,
    selectedPoolMemberTier: row.selectedPoolMemberTier,
    localAttemptId: row.localAttemptId,
    firstClientByteAt: row.firstClientByteAt,
    streamCommitted: row.streamCommitted,
  };
}

const ownerSelect = {
  id: true,
  email: true,
  name: true,
  slug: true,
} satisfies Prisma.UserSelect;

const cliDeviceSummarySelect = {
  id: true,
  slug: true,
  name: true,
  reportedHostname: true,
  status: true,
  lastHeartbeatAt: true,
} satisfies Prisma.CliDeviceSelect;

const cliDeviceSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  slug: true,
  name: true,
  reportedHostname: true,
  status: true,
  lastConnectedAt: true,
  lastDisconnectedAt: true,
  lastHeartbeatAt: true,
  connectionCount: true,
  User: { select: ownerSelect },
  _count: { select: { Endpoints: true, CliTokens: true, CliDeviceCredentials: true } },
} satisfies Prisma.CliDeviceSelect;

const endpointSelect = {
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
  CliDevice: { select: cliDeviceSummarySelect },
  _count: { select: { DiscoveredModels: true } },
} satisfies Prisma.EndpointSelect;

const discoveredModelSelect = {
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
      CliDevice: { select: cliDeviceSummarySelect },
    },
  },
  _count: { select: { PoolMembers: true } },
} satisfies Prisma.DiscoveredModelSelect;

const poolMemberModelSelect = {
  id: true,
  upstreamModelId: true,
  User: { select: { slug: true } },
  Endpoint: {
    select: {
      id: true,
      slug: true,
      label: true,
      status: true,
      CliDevice: { select: cliDeviceSummarySelect },
    },
  },
} satisfies Prisma.DiscoveredModelSelect;

const poolMemberSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  discoveredModelId: true,
  ExecutionTarget: {
    select: {
      kind: true,
      DiscoveredModel: {
        select: poolMemberModelSelect,
      },
    },
  },
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
    select: poolMemberModelSelect,
  },
} satisfies Prisma.PoolMemberSelect;

const modelPoolSelect = {
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
} satisfies Prisma.ModelPoolSelect;

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
} satisfies Prisma.DiscoveredModelSelect;

const relayRequestSelect = {
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
  operation: true,
  requestBytes: true,
  responseBytes: true,
  attemptCount: true,
  auxiliaryAttemptCount: true,
  auxiliaryRequestBytes: true,
  auxiliaryResponseBytes: true,
  requestedSurface: true,
  selectedNativeSurface: true,
  adapterMode: true,
  adapterVersion: true,
  selectedPoolMemberId: true,
  selectedPoolMemberTier: true,
  localAttemptId: true,
  firstClientByteAt: true,
  streamCommitted: true,
  userId: true,
  requestedDiscoveredModelId: true,
  selectedDiscoveredModelId: true,
  requestedModelPoolId: true,
} satisfies Prisma.RelayRequestSelect;

const relayTokenSelect = {
  id: true,
  name: true,
  lookupPrefix: true,
} satisfies Prisma.ModelApiTokenSelect;

const relayPoolSelect = {
  id: true,
  slug: true,
  name: true,
  User: { select: { slug: true } },
} satisfies Prisma.ModelPoolSelect;

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
          select: cliDeviceSelect,
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: rows.map((row) => serializeCli(row, now)),
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
          select: endpointSelect,
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: rows.map((row) => serializeEndpoint(row, now)),
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
          select: discoveredModelSelect,
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: rows.map((row) => serializeModel(row, now)),
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
          select: modelPoolSelect,
        }),
      ]);
      const now = new Date();
      return paginatedResult({
        items: rows.map((row) => serializePool(row, now)),
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
        ...(await relayOwnerWhere(input?.ownerQuery)),
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
          select: relayRequestSelect,
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
          items: await (async () => {
            const relations = await loadRelayRelations(rows);
            return rows.map((row) => serializeRelay(row, relations));
          })(),
          total,
          page,
          pageSize,
        }),
        summary: {
          statusCounts: statusGroups.map((row) => ({
            status: String(row.status),
            count: row._count._all,
          })),
          errorClassCounts: errorClassGroups.map((row) => ({
            errorClass: row.errorClass,
            count: row._count._all,
          })),
          durationMs: {
            average: aggregate._avg.durationMs,
            minimum: aggregate._min.durationMs,
            maximum: aggregate._max.durationMs,
          },
          tokens: {
            prompt: aggregate._sum.promptTokens,
            completion: aggregate._sum.completionTokens,
            total: aggregate._sum.totalTokens,
          },
        },
      };
    }),
};

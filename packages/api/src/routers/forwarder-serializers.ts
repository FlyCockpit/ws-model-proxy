import { cliDeviceDisplayName } from "@ws-model-proxy/config/cli-device-name";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { LiveCliFeatureSnapshot, LiveNodeTelemetrySnapshot } from "../context";
import { fileToolsSummary } from "../lib/cli-file-access";
import {
  cliHeartbeatIsStale,
  cliHeartbeatStaleAt,
  effectiveEndpointStatus,
} from "../lib/cli-presence";
import { declaredContextWindow } from "../lib/declared-context-window";
import { effectiveProviderEgress } from "../lib/effective-provider-egress";
import {
  lowestMcpCommandMode,
  type McpCommandModeName,
  mcpCommandModeFromDb,
  mcpCommandRefusals,
} from "../lib/mcp-command-mode";
import { parseModelApiSurface } from "../lib/model-api-surface";
import type { VisibleModelTargets } from "../lib/model-api-token-access";
import { suggestedConnectionSurface } from "../lib/model-connection-type";
import {
  buildNodeCardSnapshot,
  type NodeCardSnapshot,
  normalizeNodeLabels,
} from "../lib/node-inventory";
import {
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
} from "../lib/openai-compatible-capabilities";
import { serializePoolGrantSpendCap } from "../lib/pool-grant-spend-cap";
import {
  discoveredModelSurfaceCapabilities,
  providerModelSurfaceCapabilities,
} from "../lib/pool-recommended-surface";
import { refusedRelayProtocolReason } from "../lib/relay-protocol-version";
import {
  type ModelApiSurface,
  modelApiSurfaces,
  surfaceAvailabilityMatrix,
} from "../lib/surface-capabilities";
import { visibleModelAttachmentModalities } from "../lib/visible-model-modalities";
import { visibleModelReasoning } from "../lib/visible-model-reasoning";

export const listCliDevicesSelect = {
  allowDeployments: true,
  reportedDeployments: true,
  deploymentPortStart: true,
  deploymentPortEnd: true,
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
  inventorySeq: true,
  inventoryDigest: true,
  inventoryAcknowledgedAt: true,
  inventoryConfirmed: true,
  endpointTargeting: true,
  allowHumanTerminal: true,
  mcpCommandMode: true,
  mcpFileRead: true,
  cliVersion: true,
  relayProtocolVersion: true,
  reportedHumanTerminal: true,
  reportedMcpCommandMode: true,
  reportedMcpFileRead: true,
  reportedFileRoots: true,
  reportedTerminalApproval: true,
  reportedTerminalSupported: true,
  reportedAllowFileToolsAsRoot: true,
  rejectedRelayProtocolVersion: true,
  rejectedCliVersion: true,
  relayRejectedAt: true,
  nodeInfoAt: true,
  nodeMetricsAt: true,
  nodeInfo: true,
  nodeMetrics: true,
  labels: true,
  usableMemoryGb: true,
  usableRamGb: true,
  usableVramGb: true,
  User: { select: { slug: true } },
  // The latest identity refusal of a live device credential (a copied
  // credential presented by another machine); cleared by a successful hello.
  CliDeviceCredentials: {
    where: { revokedAt: null, lastRefusedAt: { not: null } },
    orderBy: { lastRefusedAt: "desc" as const },
    take: 1,
    select: { lastRefusedAt: true },
  },
  Endpoints: {
    orderBy: { createdAt: "asc" as const },
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
        orderBy: { createdAt: "asc" as const },
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
          optimisticBasicTranscription: true,
          probeSuggestions: true,
          lastSeenAt: true,
          published: true,
          unpublishedAt: true,
          maxAttachmentBytes: true,
          ExecutionTarget: {
            select: {
              id: true,
              inferenceCapacityId: true,
              directPriority: true,
              directConcurrencyLimit: true,
              directReservedSlots: true,
              directBorrowPolicy: true,
              directWaitBudgetMs: true,
              directContextCeiling: true,
              directContextMargin: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CliDeviceSelect;

/**
 * MCP list page. Identity, grants, and endpoint probe status only: no
 * discovered models and no capability JSON. The dashboard keeps
 * {@link listCliDevicesSelect}.
 */
export const cliDeviceSummarySelect = {
  id: true,
  createdAt: true,
  slug: true,
  name: true,
  reportedHostname: true,
  status: true,
  lastHeartbeatAt: true,
  allowHumanTerminal: true,
  mcpCommandMode: true,
  mcpFileRead: true,
  reportedHumanTerminal: true,
  reportedMcpCommandMode: true,
  reportedMcpFileRead: true,
  reportedFileRoots: true,
  reportedTerminalApproval: true,
  reportedTerminalSupported: true,
  reportedAllowFileToolsAsRoot: true,
  labels: true,
  Endpoints: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      slug: true,
      status: true,
      failureReasonCode: true,
    },
  },
} satisfies Prisma.CliDeviceSelect;

type CliDeviceRow = Prisma.CliDeviceGetPayload<{ select: typeof listCliDevicesSelect }>;
type CliDeviceSummaryRow = Prisma.CliDeviceGetPayload<{ select: typeof cliDeviceSummarySelect }>;
type EndpointRow = CliDeviceRow["Endpoints"][number];
type DiscoveredModelRow = EndpointRow["DiscoveredModels"][number];

export const poolSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  slug: true,
  name: true,
  description: true,
  maxAttachmentBytes: true,
  optimisticBasicTranscription: true,
  protocolAdaptationEnabled: true,
  fallbackEnabled: true,
  embeddingContract: true,
  paidWarmProtectionEnabled: true,
  fallbackForGrantees: true,
  externalAfterWaitMs: true,
  allowLossyDeveloperRoleCollapse: true,
  recommendedSurfaceOverride: true,
  capacityPriority: true,
  capacityConcurrencyLimit: true,
  capacityReservedSlots: true,
  capacityBorrowPolicy: true,
  capacityWaitBudgetMs: true,
  capacityContextCeiling: true,
  capacityContextMargin: true,
  affinityEnabled: true,
  affinityTtlSeconds: true,
  affinityMaxRecords: true,
  affinityPrefixWeight: true,
  affinityConversationWeight: true,
  affinityConfirmedCacheWeight: true,
  affinityLoadPenaltyWeight: true,
  affinityResidencyWeight: true,
  cacheHolderWaitMs: true,
  protectionEnabled: true,
  evictionFeedbackEnabled: true,
  protectionWindowSeconds: true,
  protectMinTokens: true,
  protectionShare: true,
  protectionFixedPercent: true,
  ownerProtectionPercent: true,
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
      tier: true,
      publicOrder: true,
      ExecutionTarget: {
        select: {
          id: true,
          kind: true,
          providerModelId: true,
          inferenceCapacityId: true,
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
          ProviderModel: {
            select: {
              id: true,
              upstreamModelId: true,
              displayName: true,
              nativeCapabilities: true,
              contextWindow: true,
              concurrencyLimit: true,
              healthStatus: true,
              enabled: true,
              PricingVersions: {
                where: { status: "ACTIVE" as const, retiredAt: null },
                orderBy: { effectiveAt: "desc" as const },
                take: 1,
                select: { version: true, currency: true },
              },
              ProviderAccount: {
                select: { id: true, label: true, providerType: true, enabled: true },
              },
            },
          },
        },
      },
      weight: true,
      capacityPriority: true,
      capacityConcurrencyMode: true,
      capacityConcurrencyLimit: true,
      capacityReservedSlots: true,
      capacityBorrowPolicy: true,
      capacityWaitBudgetMode: true,
      capacityWaitBudgetMs: true,
      capacityContextCeilingMode: true,
      capacityContextCeiling: true,
      capacityContextMargin: true,
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
      protectionOverridePercent: true,
      queuePriority: true,
      Grantee: { select: { email: true, name: true } },
    },
  },
  ProviderBudgetPolicies: {
    where: { active: true, scopeType: "POOL_GRANT" },
    select: {
      granteeUserId: true,
      Rules: {
        where: { metric: "SPEND" },
        select: { limitValue: true, currency: true, period: true },
      },
    },
  },
} satisfies Prisma.ModelPoolSelect;

/** MCP pool list. Member endpoint slugs and grant rows; no model or capability JSON. */
export const poolSummarySelect = {
  _count: { select: { PoolMembers: true, PoolGrants: true } },
  id: true,
  createdAt: true,
  slug: true,
  name: true,
  PoolMembers: {
    take: 20,
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      tier: true,
      healthStatus: true,
      routingStatus: true,
      DiscoveredModel: {
        select: {
          Endpoint: { select: { slug: true, CliDevice: { select: { slug: true } } } },
        },
      },
      ExecutionTarget: {
        select: {
          DiscoveredModel: {
            select: {
              Endpoint: { select: { slug: true, CliDevice: { select: { slug: true } } } },
            },
          },
          ProviderModel: {
            select: {
              id: true,
              upstreamModelId: true,
              displayName: true,
              ProviderAccount: { select: { label: true } },
            },
          },
        },
      },
    },
  },
  PoolGrants: {
    take: 20,
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      createdAt: true,
      granteeUserId: true,
      protectionOverridePercent: true,
      queuePriority: true,
      Grantee: { select: { email: true, name: true } },
    },
  },
} satisfies Prisma.ModelPoolSelect;

export const poolSummaryBudgetSelect = {
  poolId: true,
  granteeUserId: true,
  Rules: { where: { metric: "SPEND" }, select: { limitValue: true, currency: true, period: true } },
} satisfies Prisma.ProviderBudgetPolicySelect;
type PoolSummaryBudget = Prisma.ProviderBudgetPolicyGetPayload<{
  select: typeof poolSummaryBudgetSelect;
}>;

type ModelPoolRow = Prisma.ModelPoolGetPayload<{ select: typeof poolSelect }>;
type PoolSummaryRow = Prisma.ModelPoolGetPayload<{ select: typeof poolSummarySelect }>;
type PoolMemberModelRow = NonNullable<ModelPoolRow["PoolMembers"][number]["DiscoveredModel"]>;

export async function serializeVisibleTargets(targets: VisibleModelTargets) {
  const [modalities, reasoning, poolRows] = await Promise.all([
    visibleModelAttachmentModalities(targets),
    visibleModelReasoning(targets),
    targets.modelPools.length
      ? prisma.modelPool.findMany({
          where: { id: { in: targets.modelPools.map((pool) => pool.id) } },
          select: poolSelect,
        })
      : [],
  ]);
  const serializedPools = new Map(
    poolRows.map((row) => {
      const serialized = serializePool(row);
      return [row.id, serialized] as const;
    }),
  );
  return {
    providerEgressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
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
      maxAttachmentBytes: model.maxAttachmentBytes,
      attachmentModalities: modalities.directById.get(model.id) ?? {
        image: false,
        audio: false,
        video: false,
      },
      reasoning: reasoning.directById.get(model.id) ?? {},
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
      maxAttachmentBytes: pool.maxAttachmentBytes,
      fallbackEnabled: pool.fallbackEnabled,
      fallbackForGrantees: pool.fallbackForGrantees,
      effectiveProviderEgress: pool.effectiveProviderEgress,
      providerAccountLabels: pool.providerAccountLabels,
      providerTypes: pool.providerTypes,
      externalRoutes: pool.externalRoutes,
      compatibility: serializedPools.get(pool.id)?.compatibility ?? null,
      attachmentModalities: modalities.poolById.get(pool.id) ?? {
        image: false,
        audio: false,
        video: false,
      },
      reasoning: reasoning.poolById.get(pool.id) ?? {},
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

function liveTerminalFeature(snapshot: LiveCliFeatureSnapshot | null): boolean {
  return snapshot?.humanTerminal === true && snapshot.terminalSupported === true;
}

/** The CLI's live MCP command mode; `off` while it is offline. */
function liveCommandMode(snapshot: LiveCliFeatureSnapshot | null): McpCommandModeName {
  if (!snapshot) return "off";
  return snapshot.mcpCommandMode;
}

type CliDeviceFeatureSource = Pick<
  CliDeviceRow,
  | "allowHumanTerminal"
  | "mcpCommandMode"
  | "mcpFileRead"
  | "reportedHumanTerminal"
  | "reportedMcpCommandMode"
  | "reportedMcpFileRead"
  | "reportedFileRoots"
  | "reportedTerminalApproval"
  | "reportedTerminalSupported"
  | "reportedAllowFileToolsAsRoot"
  | "lastHeartbeatAt"
>;

/** Grant and live-feature view shared by the dashboard device and the MCP summary. */
function serializeCliDeviceFeatures(
  row: CliDeviceFeatureSource,
  now: Date,
  live: LiveCliFeatureSnapshot | null,
) {
  const terminalLive = liveTerminalFeature(live);
  const terminalDeviceAllows = row.reportedHumanTerminal ?? null;
  const terminalSupported = row.reportedTerminalSupported ?? null;
  const commandsGrant = mcpCommandModeFromDb(row.mcpCommandMode);
  const commandsDeviceMode = mcpCommandModeFromDb(row.reportedMcpCommandMode ?? null);
  const commandsLive = live !== null;
  const commandsEffective = lowestMcpCommandMode(commandsGrant, liveCommandMode(live));
  // Node file tools follow the same effective mode through the one file
  // matrix; a CLI that is offline runs none.
  const fileToolsLive = live !== null;
  const refusals = mcpCommandRefusals({
    grant: commandsGrant,
    live:
      live && commandsLive
        ? {
            mode: live.mcpCommandMode,
            supervisedCommands: live.supervisedCommands,
            terminalSupported: live.terminalSupported,
          }
        : null,
  });
  return {
    staleAt: cliHeartbeatStaleAt(row.lastHeartbeatAt),
    isStale: cliHeartbeatIsStale(row.lastHeartbeatAt, now),
    /**
     * What the MCP node file tools may do on this device right now
     * (`headless`, `supervised` = needs a person, or `off`), from the effective
     * command mode; agents read it instead of trying calls.
     */
    fileTools: fileToolsSummary(fileToolsLive && live.fileOps ? commandsEffective : "off", {
      server: row.mcpFileRead === true,
      live: fileToolsLive && live.fileOps === true && live.mcpFileRead === true,
      roots: fileToolsLive && live.fileRootsConfigured === true,
    }),
    /** `allowFileToolsAsRoot` in the CLI's config: live when connected, else the last report. */
    allowFileToolsAsRoot: live?.allowFileToolsAsRoot ?? row.reportedAllowFileToolsAsRoot ?? null,
    mcpFileRead: row.mcpFileRead === true,
    reportedMcpFileRead: row.reportedMcpFileRead ?? null,
    reportedFileRoots: row.reportedFileRoots ?? null,
    features: {
      terminal: {
        granted: row.allowHumanTerminal === true,
        deviceAllows: terminalDeviceAllows,
        supported: terminalSupported,
        live: terminalLive,
        /** The CLI requires local approval of a browser before it can attach. */
        approvalRequired: row.reportedTerminalApproval ?? null,
        available:
          row.allowHumanTerminal === true &&
          terminalDeviceAllows === true &&
          terminalLive &&
          terminalSupported === true,
      },
      commands: {
        /** Server grant. */
        mode: commandsGrant,
        /** The CLI's own config mode, from its latest hello. */
        deviceMode: commandsDeviceMode,
        /** Supervised commands need a PTY (Unix). */
        supported: terminalSupported,
        live: commandsLive,
        /** What an MCP agent can do right now: the lowest of grant and live CLI mode. */
        effectiveMode: commandsEffective,
        /**
         * Why the relay would refuse each command kind right now (its refusal
         * order), or null when it would admit it.
         */
        refusals,
        /** Some command kind would be admitted (headless or supervised). */
        available: refusals.headless === null || refusals.supervised === null,
      },
    },
    grants: {
      humanTerminal: row.allowHumanTerminal === true,
      mcpCommandMode: commandsGrant,
      fileRead: row.mcpFileRead === true,
    },
  };
}

export function serializeCliDeviceNode(
  row: {
    labels?: readonly string[] | null;
    nodeInfo?: unknown;
    nodeMetrics?: unknown;
    usableMemoryGb?: number | null;
    usableRamGb?: number | null;
    usableVramGb?: unknown;
  },
  liveMetrics: unknown | null | undefined,
): NodeCardSnapshot {
  return buildNodeCardSnapshot({
    nodeInfo: row.nodeInfo ?? null,
    nodeMetrics: liveMetrics ?? row.nodeMetrics ?? null,
    labels: row.labels ?? [],
    usableMemoryGb: row.usableMemoryGb,
    usableRamGb: row.usableRamGb,
    usableVramGb: row.usableVramGb,
  });
}

export function serializeCliDevice(
  row: CliDeviceRow,
  now: Date,
  live: LiveCliFeatureSnapshot | null,
  liveTelemetry: LiveNodeTelemetrySnapshot | null = null,
) {
  const featureView = serializeCliDeviceFeatures(row, now, live);
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    slug: row.slug,
    name: row.name,
    reportedHostname: row.reportedHostname,
    displayName: cliDeviceDisplayName(row),
    status: row.status,
    lastConnectedAt: row.lastConnectedAt,
    lastDisconnectedAt: row.lastDisconnectedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    staleAt: featureView.staleAt,
    isStale: featureView.isStale,
    connectionCount: row.connectionCount,
    inventorySeq: row.inventorySeq,
    inventoryDigest: row.inventoryDigest,
    inventoryAcknowledgedAt: row.inventoryAcknowledgedAt,
    inventoryConfirmed: row.inventoryConfirmed,
    endpointTargeting: row.endpointTargeting,
    deployment: {
      allow: row.allowDeployments,
      reported: row.reportedDeployments,
      portStart: row.deploymentPortStart,
      portEnd: row.deploymentPortEnd,
    },
    cliVersion: row.cliVersion ?? null,
    relayProtocolVersion: row.relayProtocolVersion ?? null,
    /**
     * Set when this device's last hello was refused for an old relay
     * protocol, or one newer than this server speaks (`reason`); the next
     * accepted hello clears it.
     */
    upgradeRequired: row.relayRejectedAt
      ? {
          protocolVersion: row.rejectedRelayProtocolVersion ?? null,
          cliVersion: row.rejectedCliVersion ?? null,
          rejectedAt: row.relayRejectedAt,
          reason: refusedRelayProtocolReason(row.rejectedRelayProtocolVersion),
        }
      : null,
    /** When this device's credential last refused a hello for an identity mismatch. */
    identityRefusedAt: row.CliDeviceCredentials[0]?.lastRefusedAt ?? null,
    nodeInfoAt: row.nodeInfoAt ?? null,
    nodeMetricsAt: row.nodeMetricsAt ?? null,
    labels: normalizeNodeLabels(row.labels ?? []),
    node: serializeCliDeviceNode(row, liveTelemetry?.nodeMetrics),
    fileTools: featureView.fileTools,
    countContext: live?.countContext === true,
    allowFileToolsAsRoot: featureView.allowFileToolsAsRoot,
    mcpFileRead: featureView.mcpFileRead,
    reportedMcpFileRead: featureView.reportedMcpFileRead,
    reportedFileRoots: featureView.reportedFileRoots,
    features: featureView.features,
    endpoints: row.Endpoints.map((endpoint) => ({
      id: endpoint.id,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      slug: endpoint.slug,
      label: endpoint.label,
      kind: endpoint.kind,
      status: effectiveEndpointStatus(endpoint.status, row, now),
      reportedStatus: endpoint.status,
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
        optimisticBasicTranscription: model.optimisticBasicTranscription,
        probeSuggestions: model.probeSuggestions,
        effectiveCapabilities: effectiveCapabilities(endpoint, model),
        suggestedConnectionType: (() => {
          const effective = effectiveCapabilities(endpoint, model);
          return suggestedConnectionSurface({
            // Match pool semantics: structured capability metadata takes
            // precedence, with the historical coarse inventory as a safe
            // fallback for older CLI connections.
            capabilities:
              parseOpenAiCompatibleCapabilities(effective.metadata) ??
              openAiCapabilitiesFromCoarse(effective.coarse),
          });
        })(),
        lastSeenAt: model.lastSeenAt,
        published: model.published,
        unpublishedAt: model.unpublishedAt,
        maxAttachmentBytes: model.maxAttachmentBytes,
        executionTarget: model.ExecutionTarget ?? null,
      })),
    })),
  };
}

/** MCP device list row: id, slug, status, grants, endpoint slugs and probe status. */
export function serializeCliDeviceSummary(
  row: CliDeviceSummaryRow,
  now: Date,
  live: LiveCliFeatureSnapshot | null,
) {
  const featureView = serializeCliDeviceFeatures(row, now, live);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    displayName: cliDeviceDisplayName(row),
    status: row.status,
    labels: normalizeNodeLabels(row.labels ?? []),
    grants: featureView.grants,
    fileTools: featureView.fileTools,
    allowFileToolsAsRoot: featureView.allowFileToolsAsRoot,
    mcpFileRead: featureView.mcpFileRead,
    reportedMcpFileRead: featureView.reportedMcpFileRead,
    reportedFileRoots: featureView.reportedFileRoots,
    features: featureView.features,
    endpoints: row.Endpoints.map((endpoint) => ({
      id: endpoint.id,
      slug: endpoint.slug,
      status: effectiveEndpointStatus(endpoint.status, row, now),
      reportedStatus: endpoint.status,
      failureReasonCode: endpoint.failureReasonCode,
    })),
  };
}

export function serializePool(row: ModelPoolRow) {
  const adaptationEnabled = row.protocolAdaptationEnabled;
  const recommendedSurfaceOverride = parseModelApiSurface(row.recommendedSurfaceOverride);
  const memberCapabilities = (model: PoolMemberModelRow) =>
    discoveredModelSurfaceCapabilities(model);
  const memberMatrices = row.PoolMembers.map((member) => {
    const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
    if (model)
      return {
        tier: member.tier,
        matrix: surfaceAvailabilityMatrix({
          capabilities: memberCapabilities(model),
          adaptationEnabled,
        }),
      };
    const provider = member.ExecutionTarget?.ProviderModel;
    // Single shared provider-capability resolution: structured inventories
    // parse directly, while legacy raw-surface shapes are normalized, so the
    // dashboard matrix and the selectability gates can never drift.
    const providerInventory = providerModelSurfaceCapabilities(provider?.nativeCapabilities);
    return {
      tier: member.tier,
      matrix: surfaceAvailabilityMatrix({
        capabilities: providerInventory,
        adaptationEnabled,
      }),
    };
  });
  const surfaces = Object.fromEntries(
    modelApiSurfaces.map((surface) => {
      const entries = memberMatrices.map(({ matrix }) => matrix[surface]);
      const tierCounts = (tier: "PRIMARY" | "PUBLIC_OVERFLOW") => {
        const tierEntries = memberMatrices
          .filter((entry) => entry.tier === tier)
          .map(({ matrix }) => matrix[surface]);
        return {
          native: tierEntries.filter((entry) => entry.mode === "native").length,
          adapted: tierEntries.filter((entry) => entry.mode === "adapted").length,
          unavailable: tierEntries.filter((entry) => entry.mode === "unavailable").length,
        };
      };
      return [
        surface,
        {
          native: entries.filter((entry) => entry.mode === "native").length,
          adapted: entries.filter((entry) => entry.mode === "adapted").length,
          unavailable: entries.filter((entry) => entry.mode === "unavailable").length,
          streaming: entries.some((entry) => entry.mode !== "unavailable" && entry.streaming),
          limitations: [...new Set(entries.flatMap((entry) => entry.limitations))],
          primary: tierCounts("PRIMARY"),
          publicOverflow: tierCounts("PUBLIC_OVERFLOW"),
        },
      ];
    }),
  ) as Record<
    ModelApiSurface,
    {
      native: number;
      adapted: number;
      unavailable: number;
      streaming: boolean;
      limitations: string[];
      primary: { native: number; adapted: number; unavailable: number };
      publicOverflow: { native: number; adapted: number; unavailable: number };
    }
  >;
  const suggestedSurface = suggestedConnectionSurface({
    surfaces: Object.fromEntries(
      ["OPENAI_RESPONSES", "OPENAI_CHAT_COMPLETIONS", "ANTHROPIC_MESSAGES"].map((surface) => [
        surface,
        {
          native: surfaces[surface as ModelApiSurface].primary.native,
          adapted: surfaces[surface as ModelApiSurface].primary.adapted,
        },
      ]),
    ),
  });
  const recommendedSurface = recommendedSurfaceOverride ?? suggestedSurface;
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
    maxAttachmentBytes: row.maxAttachmentBytes,
    optimisticBasicTranscription: row.optimisticBasicTranscription,
    protocolAdaptationEnabled: row.protocolAdaptationEnabled,
    fallbackEnabled: row.fallbackEnabled,
    embeddingContract: row.embeddingContract,
    paidWarmProtectionEnabled: row.paidWarmProtectionEnabled,
    fallbackForGrantees: row.fallbackForGrantees,
    externalAfterWaitMs: row.externalAfterWaitMs,
    effectiveProviderEgress:
      env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED &&
      effectiveProviderEgress({
        fallbackEnabled: row.fallbackEnabled,
        externalMemberCount: row.PoolMembers.filter(
          (member) =>
            member.tier === "PUBLIC_OVERFLOW" && member.ExecutionTarget?.providerModelId != null,
        ).length,
      }),
    allowLossyDeveloperRoleCollapse: row.allowLossyDeveloperRoleCollapse,
    recommendedSurfaceOverride,
    capacityPriority: row.capacityPriority,
    capacityConcurrencyLimit: row.capacityConcurrencyLimit,
    capacityReservedSlots: row.capacityReservedSlots,
    capacityBorrowPolicy: row.capacityBorrowPolicy,
    capacityWaitBudgetMs: row.capacityWaitBudgetMs,
    capacityContextCeiling: row.capacityContextCeiling,
    capacityContextMargin: row.capacityContextMargin,
    affinity: {
      enabled: row.affinityEnabled,
      ttlSeconds: row.affinityTtlSeconds,
      maxRecords: row.affinityMaxRecords,
      prefixWeight: row.affinityPrefixWeight,
      conversationWeight: row.affinityConversationWeight,
      confirmedCacheWeight: row.affinityConfirmedCacheWeight,
      loadPenaltyWeight: row.affinityLoadPenaltyWeight,
      residencyWeight: row.affinityResidencyWeight,
    },
    cacheHolderWaitMs: row.cacheHolderWaitMs,
    protection: {
      enabled: row.protectionEnabled,
      evictionFeedbackEnabled: row.evictionFeedbackEnabled,
      windowSeconds: row.protectionWindowSeconds,
      minTokens: row.protectMinTokens,
      share: row.protectionShare,
      fixedPercent: row.protectionFixedPercent,
      ownerPercent: row.ownerProtectionPercent,
    },
    compatibility: {
      recommendedSurface,
      suggestedConnectionType: suggestedSurface,
      surfaces,
      warnings: [
        ...(adaptationEnabled ? ["adaptation_strict_subset"] : []),
        ...(adaptationEnabled && row.allowLossyDeveloperRoleCollapse
          ? ["developer_role_collapse_lossy"]
          : []),
        ...(recommendedSurfaceOverride &&
        surfaces[recommendedSurfaceOverride].unavailable === row.PoolMembers.length
          ? ["recommended_surface_unavailable"]
          : []),
      ],
    },
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
    members: row.PoolMembers.map((member, memberIndex) => {
      const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
      return {
        id: member.id,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
        discoveredModelId: model?.id ?? member.discoveredModelId,
        tier: member.tier,
        publicOrder: member.publicOrder,
        executionTargetId: member.ExecutionTarget?.id ?? null,
        inferenceCapacityId: member.ExecutionTarget?.inferenceCapacityId ?? null,
        capacityPriority: member.capacityPriority,
        capacityConcurrencyMode: member.capacityConcurrencyMode,
        capacityConcurrencyLimit: member.capacityConcurrencyLimit,
        capacityReservedSlots: member.capacityReservedSlots,
        capacityBorrowPolicy: member.capacityBorrowPolicy,
        capacityWaitBudgetMode: member.capacityWaitBudgetMode,
        capacityWaitBudgetMs: member.capacityWaitBudgetMs,
        capacityContextCeilingMode: member.capacityContextCeilingMode,
        capacityContextCeiling: member.capacityContextCeiling,
        capacityContextMargin: member.capacityContextMargin,
        weight: member.weight,
        healthStatus: member.healthStatus,
        routingStatus: member.routingStatus,
        lastFailureClass: member.lastFailureClass,
        consecutiveRetryableFailures: member.consecutiveRetryableFailures,
        lastFailureAt: member.lastFailureAt,
        nextRetryAt: member.nextRetryAt,
        halfOpenTrialStartedAt: member.halfOpenTrialStartedAt,
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
              cliDeviceSlug: model.Endpoint.CliDevice.slug,
              declaredContextWindow: declaredContextWindow(memberCapabilities(model)),
              surfaces: surfaceAvailabilityMatrix({
                capabilities: memberCapabilities(model),
                adaptationEnabled,
              }),
            }
          : null,
        providerModel: member.ExecutionTarget?.ProviderModel
          ? {
              id: member.ExecutionTarget.ProviderModel.id,
              upstreamModelId: member.ExecutionTarget.ProviderModel.upstreamModelId,
              displayName: member.ExecutionTarget.ProviderModel.displayName,
              healthStatus: member.ExecutionTarget.ProviderModel.healthStatus,
              enabled: member.ExecutionTarget.ProviderModel.enabled,
              ProviderAccount: member.ExecutionTarget.ProviderModel.ProviderAccount,
              pricingVersion:
                member.ExecutionTarget.ProviderModel.PricingVersions[0]?.version ?? null,
              pricingCurrency:
                member.ExecutionTarget.ProviderModel.PricingVersions[0]?.currency ?? null,
              surfaces: memberMatrices[memberIndex]!.matrix,
            }
          : null,
      };
    }),
    grants: row.PoolGrants.map((grant) => ({
      id: grant.id,
      createdAt: grant.createdAt,
      granteeUserId: grant.granteeUserId,
      granteeEmail: grant.Grantee.email,
      granteeName: grant.Grantee.name,
      protectionOverridePercent: grant.protectionOverridePercent,
      queuePriority: grant.queuePriority,
      fallbackSpend: serializePoolGrantSpendCap(
        (row.ProviderBudgetPolicies ?? []).filter(
          (policy) => policy.granteeUserId === grant.granteeUserId,
        ),
      ),
    })),
  };
}

/** MCP pool-summary rows cap grants/members; full lists live on getModelPool. */
export const POOL_SUMMARY_INLINE_CAP = 20;

/** MCP pool list row: identity, grants, and member endpoint slugs. No models. */
export function serializePoolSummary(
  row: PoolSummaryRow,
  policies: readonly PoolSummaryBudget[] = [],
) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    grantCount: row._count.PoolGrants,
    memberCount: row._count.PoolMembers,
    grantsTruncated: row._count.PoolGrants > row.PoolGrants.length,
    membersTruncated: row._count.PoolMembers > row.PoolMembers.length,
    grants: row.PoolGrants.slice(0, POOL_SUMMARY_INLINE_CAP).map((grant) => ({
      id: grant.id,
      createdAt: grant.createdAt,
      granteeUserId: grant.granteeUserId,
      granteeEmail: grant.Grantee.email,
      granteeName: grant.Grantee.name,
      protectionOverridePercent: grant.protectionOverridePercent,
      queuePriority: grant.queuePriority,
      fallbackSpend: serializePoolGrantSpendCap(
        policies.filter((policy) => policy.granteeUserId === grant.granteeUserId),
      ),
    })),
    members: row.PoolMembers.slice(0, POOL_SUMMARY_INLINE_CAP).map((member) => {
      const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
      const provider = member.ExecutionTarget?.ProviderModel;
      return {
        id: member.id,
        tier: member.tier,
        routingStatus: member.routingStatus,
        healthStatus: member.healthStatus,
        kind: provider ? ("PROVIDER" as const) : ("LOCAL" as const),
        endpointSlug: model?.Endpoint.slug ?? null,
        cliDeviceSlug: model?.Endpoint.CliDevice.slug ?? null,
        providerAccountLabel: provider?.ProviderAccount.label ?? null,
        providerModel: provider ? (provider.displayName ?? provider.upstreamModelId) : null,
      };
    }),
  };
}

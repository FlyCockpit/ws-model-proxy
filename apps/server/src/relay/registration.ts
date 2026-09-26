import { createHash } from "node:crypto";
import {
  type CliWebsocketIdentity,
  checkCliCredentialForDevice,
} from "@ws-model-proxy/api/lib/cli-credential-access";
import {
  type ContextWindowSeedDependent,
  declaredContextWindow,
  isContextWindowSeedAdmissible,
} from "@ws-model-proxy/api/lib/declared-context-window";
import {
  ensureDiscoveredInferenceCapacity,
  existingDiscoveredCapacityCandidates,
  fillNullAutoDiscoveredCapacityLimit,
  isInferenceCapacityWriteRetryable,
  linkExecutionTargetCapacity,
} from "@ws-model-proxy/api/lib/discovered-inference-capacity";
import {
  type McpCommandModeDb,
  type McpCommandModeName,
  mcpCommandModeFromDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import { resetPoolMemberHealth } from "@ws-model-proxy/api/lib/model-pool-routing";
import {
  coarseCapabilitiesFromOpenAi,
  resolveEffectiveCapabilityMetadata,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { directModelId, validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import {
  lockCapacityRowsForPolicyWrite,
  lockExecutionTargetPolicies,
} from "@ws-model-proxy/db/capacity-lock-order";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { EndpointInventory, OpenAiCompatibleCapabilities } from "./protocol.js";

type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

const INVENTORY_TRANSACTION_MAX_ATTEMPTS = 3;

export type DesiredModelCapability = {
  endpointSlug: string;
  upstreamModelId: string;
  capabilityOverrideMode: "override";
  capabilities: OpenAiCompatibleCapabilities;
};

export class RelayRegistrationError extends Error {
  constructor(
    message: string,
    public readonly code: "access_denied" | "protocol_error",
  ) {
    super(message);
    this.name = "RelayRegistrationError";
  }
}

function assertSlug(value: string, field: string): string {
  const result = validateForwarderSlug(value);
  if (!result.ok) {
    throw new RelayRegistrationError(`${field} is not a valid slug.`, "protocol_error");
  }
  return result.value;
}

function endpointStatus(status: EndpointInventory["status"]) {
  if (status === "online") return "ONLINE";
  if (status === "degraded") return "DEGRADED";
  if (status === "offline") return "OFFLINE";
  return "UNKNOWN";
}

export function shouldPreserveDashboardCapabilityOverride(
  origin: string | null | undefined,
): boolean {
  return origin === "DASHBOARD";
}

function jsonOrUndefined(value: OpenAiCompatibleCapabilities | undefined): JsonValue | undefined {
  if (!value) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
      .join(",") +
    "}"
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function inventoryDigestFor(endpoints: EndpointInventory[]): string {
  const identity = endpoints
    .map((endpoint) => ({
      slug: endpoint.slug,
      label: endpoint.label,
      kind: endpoint.kind,
      defaultCapabilities: endpoint.defaultCapabilities,
      models: endpoint.models
        .map((model) => ({
          slug: model.slug ?? null,
          upstreamModelId: model.upstreamModelId,
          capabilityOverrideMode: model.capabilityOverrideMode,
          capabilities: model.capabilities ?? null,
        }))
        .sort((left, right) => compareUtf8(left.upstreamModelId, right.upstreamModelId)),
    }))
    .sort((left, right) => compareUtf8(left.slug, right.slug));
  return createHash("sha256").update(stableJson(identity)).digest("hex");
}

export type ReportedRelayFeatures = {
  cliVersion: string | null;
  relayProtocolVersion: string;
  reportedHumanTerminal: boolean | null;
  reportedMcpCommandMode: McpCommandModeDb | null;
  reportedTerminalApproval: boolean | null;
  reportedTerminalSupported: boolean | null;
  /** Already normalized (see `normalizeReportedHostname`); null when not reported. */
  reportedHostname: string | null;
  featuresReportedAt: Date | null;
};

export async function persistRelayRegistration({
  identity,
  cli,
  endpoints,
  inventoryConfirmed,
  endpointTargeting,
  connection = false,
  reported,
  now = new Date(),
}: {
  identity: CliWebsocketIdentity;
  cli: { slug: string };
  endpoints: EndpointInventory[];
  inventoryConfirmed: boolean;
  endpointTargeting: boolean;
  connection?: boolean;
  /** Hello only. inventory.update must omit this so reported columns stay put. */
  reported?: ReportedRelayFeatures;
  now?: Date;
}): Promise<{
  cliDeviceId: string;
  userId: string;
  allowHumanTerminal: boolean;
  mcpCommandMode: McpCommandModeName;
  revision: { inventorySeq: number; inventoryDigest: string; inventoryAcknowledgedAt: string };
  desiredCapabilities: DesiredModelCapability[];
}> {
  const cliSlug = assertSlug(cli.slug, "CLI slug");
  for (const endpoint of endpoints) {
    assertSlug(endpoint.slug, "Endpoint slug");
  }

  const inventoryDigest = inventoryDigestFor(endpoints);
  // Grants (allowHumanTerminal / mcpCommandMode) are server-owned and are
  // never written here. Reported columns are hello-only.
  const reportedData =
    connection && reported
      ? {
          cliVersion: reported.cliVersion,
          relayProtocolVersion: reported.relayProtocolVersion,
          reportedHumanTerminal: reported.reportedHumanTerminal,
          reportedMcpCommandMode: reported.reportedMcpCommandMode,
          reportedTerminalApproval: reported.reportedTerminalApproval,
          reportedTerminalSupported: reported.reportedTerminalSupported,
          reportedHostname: reported.reportedHostname,
          featuresReportedAt: reported.featuresReportedAt,
        }
      : {};

  for (let attempt = 1; attempt <= INVENTORY_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const persisted = await prisma.$transaction(
        async (tx) => {
          const user = await tx.user.findUnique({
            where: { id: identity.userId },
            select: {
              id: true,
              slug: true,
              banned: true,
              banExpires: true,
              deletionRequestedAt: true,
            },
          });
          if (!user) {
            throw new RelayRegistrationError("Credential owner no longer exists.", "access_denied");
          }
          if (userCredentialAccessBlocked(user, new Date())) {
            throw new RelayRegistrationError("Credential owner is not active.", "access_denied");
          }

          const cliDevice = await tx.cliDevice.upsert({
            where: { userId_slug: { userId: identity.userId, slug: cliSlug } },
            // `name` is user-owned (dashboard); registration never writes it.
            update: {
              inventoryConfirmed,
              endpointTargeting,
              ...(connection
                ? {
                    status: "CONNECTED" as const,
                    lastConnectedAt: now,
                    lastHeartbeatAt: now,
                    connectionCount: { increment: 1 },
                  }
                : {}),
              ...reportedData,
            },
            create: {
              userId: identity.userId,
              slug: cliSlug,
              inventoryConfirmed,
              endpointTargeting,
              status: "CONNECTED",
              lastConnectedAt: now,
              lastHeartbeatAt: now,
              connectionCount: 1,
              ...reportedData,
            },
            select: {
              id: true,
              userId: true,
              slug: true,
              inventorySeq: true,
              inventoryDigest: true,
              inventoryAcknowledgedAt: true,
              inventoryConfirmed: true,
              allowHumanTerminal: true,
              mcpCommandMode: true,
            },
          });

          // After the device upsert, which holds the device row lock that a
          // re-login's revoking transaction and a device delete also take. A
          // device credential only ever registers as its minted device; an
          // unbound CLI token is bound here. Any refusal rolls back the
          // upsert, including a device row it just created.
          const credentialCheck = await checkCliCredentialForDevice(
            tx,
            identity,
            cliDevice.id,
            now,
          );
          if (credentialCheck === "revoked") {
            throw new RelayRegistrationError("Credential was revoked.", "access_denied");
          }
          if (credentialCheck === "otherDevice") {
            throw new RelayRegistrationError(
              "Credential is bound to a different CLI device.",
              "access_denied",
            );
          }

          const inventoryChanged = cliDevice.inventoryDigest !== inventoryDigest;
          const refreshedDiscoveredModelIds: string[] = [];
          const declaredContextByCapacityId = new Map<string, number>();
          const upsertedTargetIds = new Set<string>();
          const publishedEndpointSlugs = endpoints.map((endpoint) => endpoint.slug);
          const capacityWork: Array<{
            targetId: string;
            inferenceCapacityId: string | null;
            discoveredModelId: string;
            upstreamModelId: string;
            reportedConcurrency: number | undefined;
            declaredContext: number | null;
          }> = [];

          // Capacity lock order (@ws-model-proxy/db/capacity-lock-order):
          // the device row above is L0. Every existing execution target this
          // inventory touches is locked here (L2, sorted) before any endpoint,
          // model, target or capacity write, and every capacity row is locked
          // (L5, sorted) before the first capacity write below. Targets created
          // in this transaction are invisible to every other transaction until
          // commit, so their L2 locks cannot be contended.
          const inventoryModelFilters = endpoints.flatMap((endpoint) =>
            endpoint.models.length > 0
              ? [
                  {
                    Endpoint: { slug: endpoint.slug },
                    upstreamModelId: { in: endpoint.models.map((model) => model.upstreamModelId) },
                  },
                ]
              : [],
          );
          const existingInventoryTargets =
            inventoryModelFilters.length > 0
              ? await tx.executionTarget.findMany({
                  where: {
                    userId: identity.userId,
                    DiscoveredModel: {
                      is: {
                        Endpoint: { cliDeviceId: cliDevice.id },
                        OR: inventoryModelFilters,
                      },
                    },
                  },
                  select: { id: true },
                })
              : [];
          const policyLockedTargetIds = new Set(
            existingInventoryTargets.map((target) => target.id),
          );
          await lockExecutionTargetPolicies(tx, [...policyLockedTargetIds]);

          for (const endpoint of endpoints) {
            const coarseCapabilities = endpoint.defaultCapabilities
              ? coarseCapabilitiesFromOpenAi(endpoint.defaultCapabilities)
              : [];
            const existingEndpoint = await tx.endpoint.findUnique({
              where: { userId_slug: { userId: identity.userId, slug: endpoint.slug } },
              select: { cliDeviceId: true, status: true },
            });
            if (existingEndpoint && existingEndpoint.cliDeviceId !== cliDevice.id) {
              throw new RelayRegistrationError(
                "Endpoint slug is owned by another CLI device.",
                "protocol_error",
              );
            }
            const persistedEndpoint = await tx.endpoint.upsert({
              where: { userId_slug: { userId: identity.userId, slug: endpoint.slug } },
              update: {
                cliDeviceId: cliDevice.id,
                label: endpoint.label,
                kind:
                  endpoint.kind === "anthropic-compatible"
                    ? "ANTHROPIC_COMPATIBLE"
                    : "OPENAI_COMPATIBLE",
                status: endpointStatus(endpoint.status),
                defaultCapabilities: { set: coarseCapabilities },
                capabilityMetadata: jsonOrUndefined(endpoint.defaultCapabilities),
                probeSuggestions: jsonOrUndefined(endpoint.probeSuggestions),
                lastSeenAt: now,
                lastHealthCheckAt: now,
                published: true,
                unpublishedAt: null,
                ...(existingEndpoint?.status === endpointStatus(endpoint.status)
                  ? {}
                  : { statusChangedAt: now }),
              },
              create: {
                userId: identity.userId,
                cliDeviceId: cliDevice.id,
                slug: endpoint.slug,
                label: endpoint.label,
                kind:
                  endpoint.kind === "anthropic-compatible"
                    ? "ANTHROPIC_COMPATIBLE"
                    : "OPENAI_COMPATIBLE",
                status: endpointStatus(endpoint.status),
                defaultCapabilities: coarseCapabilities,
                capabilityMetadata: jsonOrUndefined(endpoint.defaultCapabilities),
                probeSuggestions: jsonOrUndefined(endpoint.probeSuggestions),
                lastSeenAt: now,
                lastHealthCheckAt: now,
                published: true,
                unpublishedAt: null,
                statusChangedAt: now,
              },
              select: { id: true, slug: true },
            });

            for (const model of endpoint.models) {
              const modelSlug = model.slug ? assertSlug(model.slug, "Model slug") : null;
              const overrideCapabilities =
                model.capabilityOverrideMode === "override"
                  ? model.capabilities
                    ? coarseCapabilitiesFromOpenAi(model.capabilities)
                    : []
                  : [];
              const existingModel = await tx.discoveredModel.findUnique({
                where: {
                  endpointId_upstreamModelId: {
                    endpointId: persistedEndpoint.id,
                    upstreamModelId: model.upstreamModelId,
                  },
                },
                select: {
                  capabilityOverrideMode: true,
                  capabilityOverrideOrigin: true,
                  capabilityOverrideMetadata: true,
                },
              });
              const incomingOverride = model.capabilityOverrideMode === "override";
              // A model override explicitly present in the local CLI config is
              // authoritative. Dashboard state (including an explicit choice
              // to inherit) is retained while the CLI inherits endpoint
              // defaults. Server-owned state is never written to CLI config.
              const keepDashboardOverride =
                !incomingOverride &&
                shouldPreserveDashboardCapabilityOverride(existingModel?.capabilityOverrideOrigin);
              const discoveredModel = await tx.discoveredModel.upsert({
                where: {
                  endpointId_upstreamModelId: {
                    endpointId: persistedEndpoint.id,
                    upstreamModelId: model.upstreamModelId,
                  },
                },
                update: {
                  userId: identity.userId,
                  slug: modelSlug,
                  encodedModelId: directModelId({
                    userSlug: user.slug,
                    cliSlug: cliDevice.slug,
                    endpointSlug: persistedEndpoint.slug,
                    upstreamModelId: model.upstreamModelId,
                  }),
                  ...(keepDashboardOverride
                    ? {}
                    : {
                        capabilityOverrideMode: incomingOverride
                          ? "OVERRIDE"
                          : "INHERIT_ENDPOINT_DEFAULTS",
                        capabilityOverrides: { set: overrideCapabilities },
                        capabilityOverrideMetadata: incomingOverride
                          ? jsonOrUndefined(model.capabilities)
                          : undefined,
                        capabilityOverrideOrigin: incomingOverride ? "CLI" : null,
                      }),
                  probeSuggestions: jsonOrUndefined(model.probeSuggestions),
                  lastSeenAt: now,
                  published: true,
                  unpublishedAt: null,
                },
                create: {
                  userId: identity.userId,
                  endpointId: persistedEndpoint.id,
                  slug: modelSlug,
                  upstreamModelId: model.upstreamModelId,
                  encodedModelId: directModelId({
                    userSlug: user.slug,
                    cliSlug: cliDevice.slug,
                    endpointSlug: persistedEndpoint.slug,
                    upstreamModelId: model.upstreamModelId,
                  }),
                  capabilityOverrideMode:
                    model.capabilityOverrideMode === "override"
                      ? "OVERRIDE"
                      : "INHERIT_ENDPOINT_DEFAULTS",
                  capabilityOverrides: overrideCapabilities,
                  capabilityOverrideMetadata:
                    model.capabilityOverrideMode === "override"
                      ? jsonOrUndefined(model.capabilities)
                      : undefined,
                  capabilityOverrideOrigin: incomingOverride ? "CLI" : null,
                  probeSuggestions: jsonOrUndefined(model.probeSuggestions),
                  lastSeenAt: now,
                  published: true,
                  unpublishedAt: null,
                },
                select: { id: true },
              });
              // Execution-target identity (userId, kind, source model) is
              // immutable (schema hardening), so an existing target is only
              // read. A native upsert whose SET names the key column "userId"
              // would take FOR UPDATE on the row even for an unchanged value
              // and block admission's FK FOR KEY SHARE checks (DL-1).
              let target = await tx.executionTarget.findUnique({
                where: { discoveredModelId: discoveredModel.id },
                select: { id: true, inferenceCapacityId: true },
              });
              if (!target) {
                target = await tx.executionTarget.create({
                  data: {
                    userId: identity.userId,
                    kind: "DISCOVERED_MODEL",
                    discoveredModelId: discoveredModel.id,
                  },
                  select: { id: true, inferenceCapacityId: true },
                });
              }
              if (!policyLockedTargetIds.has(target.id)) {
                // Not in the snapshot the L2 set was read from, so this
                // transaction created it: an uncontended lock on a new row.
                await lockExecutionTargetPolicies(tx, [target.id]);
                policyLockedTargetIds.add(target.id);
              }
              upsertedTargetIds.add(target.id);
              capacityWork.push({
                targetId: target.id,
                inferenceCapacityId: target.inferenceCapacityId,
                discoveredModelId: discoveredModel.id,
                upstreamModelId: model.upstreamModelId,
                reportedConcurrency: model.concurrencyLimit,
                declaredContext: declaredContextWindow(
                  resolveEffectiveCapabilityMetadata({
                    capabilityOverrideMode: keepDashboardOverride
                      ? (existingModel?.capabilityOverrideMode ?? "INHERIT_ENDPOINT_DEFAULTS")
                      : incomingOverride
                        ? "OVERRIDE"
                        : "INHERIT_ENDPOINT_DEFAULTS",
                    capabilityOverrideMetadata: keepDashboardOverride
                      ? existingModel?.capabilityOverrideMetadata
                      : incomingOverride
                        ? model.capabilities
                        : null,
                    endpointCapabilityMetadata: endpoint.defaultCapabilities,
                  }),
                ),
              });
              refreshedDiscoveredModelIds.push(discoveredModel.id);
            }

            await tx.discoveredModel.updateMany({
              where: {
                endpointId: persistedEndpoint.id,
                upstreamModelId: { notIn: endpoint.models.map((model) => model.upstreamModelId) },
              },
              data: { published: false, unpublishedAt: now },
            });
          }

          // L5: every existing capacity row the loop below may write (the
          // attached capacity, or the auto capacity it would adopt), sorted,
          // before the first write. A capacity created below is a new row.
          const candidateCapacityIds = new Set<string>();
          for (const work of capacityWork) {
            if (work.inferenceCapacityId) candidateCapacityIds.add(work.inferenceCapacityId);
            else
              for (const id of await existingDiscoveredCapacityCandidates(tx, {
                userId: identity.userId,
                discoveredModelId: work.discoveredModelId,
                executionTargetId: work.targetId,
              }))
                candidateCapacityIds.add(id);
          }
          await lockCapacityRowsForPolicyWrite(tx, identity.userId, [...candidateCapacityIds]);
          for (const work of capacityWork) {
            // Keep a capacity that is already attached. Otherwise create one
            // and set the foreign key before this transaction commits.
            // A null limit on this target's auto key is the schema-hardening
            // trigger, which cannot see the CLI report. Fill only that null.
            let inferenceCapacityId = work.inferenceCapacityId;
            if (inferenceCapacityId === null) {
              inferenceCapacityId = await ensureDiscoveredInferenceCapacity(tx, {
                userId: identity.userId,
                discoveredModelId: work.discoveredModelId,
                upstreamModelId: work.upstreamModelId,
                executionTargetId: work.targetId,
                reportedConcurrency: work.reportedConcurrency,
              });
              await linkExecutionTargetCapacity(tx, {
                executionTargetId: work.targetId,
                userId: identity.userId,
                inferenceCapacityId,
              });
            } else {
              await fillNullAutoDiscoveredCapacityLimit(tx, {
                userId: identity.userId,
                capacityId: inferenceCapacityId,
                discoveredModelId: work.discoveredModelId,
                executionTargetId: work.targetId,
                reportedConcurrency: work.reportedConcurrency,
              });
            }
            if (work.declaredContext != null && inferenceCapacityId) {
              declaredContextByCapacityId.set(
                inferenceCapacityId,
                Math.max(
                  declaredContextByCapacityId.get(inferenceCapacityId) ?? 0,
                  work.declaredContext,
                ),
              );
            }
          }

          if (declaredContextByCapacityId.size > 0) {
            // Every inventory target already holds its L2 policy lock (above).
            // The seed fence deliberately equals that set: registration never
            // locks targets belonging to a different device or endpoint.
            const lockedExecutionTargetIds = new Set(upsertedTargetIds);
            const capacityIds = [...declaredContextByCapacityId.keys()];
            const capacities = await tx.inferenceCapacity.findMany({
              where: { userId: identity.userId, id: { in: capacityIds } },
              select: {
                id: true,
                physicalMaxContext: true,
                ExecutionTargets: {
                  select: {
                    id: true,
                    directContextCeiling: true,
                    directContextMargin: true,
                    PoolMembers: {
                      select: {
                        capacityContextCeilingMode: true,
                        capacityContextCeiling: true,
                        capacityContextMargin: true,
                        ModelPool: {
                          select: { capacityContextCeiling: true, capacityContextMargin: true },
                        },
                      },
                    },
                  },
                },
              },
            });
            for (const capacity of capacities) {
              // Dashboard flows own shared capacities. Registration may seed
              // only the 1:1 topology whose every target was upserted above.
              if (
                capacity.ExecutionTargets.some((target) => !lockedExecutionTargetIds.has(target.id))
              ) {
                continue;
              }
              const dependents: ContextWindowSeedDependent[] = capacity.ExecutionTargets.flatMap(
                (target) => [
                  {
                    kind: "direct" as const,
                    contextCeiling: target.directContextCeiling,
                    contextMargin: target.directContextMargin,
                  },
                  ...target.PoolMembers.map(
                    (member): ContextWindowSeedDependent => ({
                      kind: "member",
                      contextCeilingMode: member.capacityContextCeilingMode,
                      contextCeiling: member.capacityContextCeiling,
                      contextMargin: member.capacityContextMargin,
                      poolContextCeiling: member.ModelPool.capacityContextCeiling,
                      poolContextMargin: member.ModelPool.capacityContextMargin,
                    }),
                  ),
                ],
              );
              const declared = declaredContextByCapacityId.get(capacity.id);
              if (declared === undefined) continue;
              if (
                capacity.physicalMaxContext === null &&
                isContextWindowSeedAdmissible(declared, dependents)
              ) {
                await tx.inferenceCapacity.updateMany({
                  where: { id: capacity.id, userId: identity.userId, physicalMaxContext: null },
                  data: { physicalMaxContext: declared },
                });
              }
            }
          }

          await tx.endpoint.updateMany({
            where: { cliDeviceId: cliDevice.id, slug: { notIn: publishedEndpointSlugs } },
            data: { published: false, unpublishedAt: now },
          });
          await tx.discoveredModel.updateMany({
            where: { Endpoint: { cliDeviceId: cliDevice.id, published: false } },
            data: { published: false, unpublishedAt: now },
          });

          if (inventoryChanged && refreshedDiscoveredModelIds.length > 0) {
            await tx.poolMember.updateMany({
              where: {
                OR: [
                  {
                    executionTargetId: { not: null },
                    ExecutionTarget: {
                      discoveredModelId: { in: refreshedDiscoveredModelIds },
                    },
                  },
                  {
                    executionTargetId: null,
                    discoveredModelId: { in: refreshedDiscoveredModelIds },
                  },
                ],
                routingStatus: { not: "DISABLED" },
              },
              data: resetPoolMemberHealth(),
            });
          }

          const acknowledged =
            cliDevice.inventoryDigest === inventoryDigest
              ? await tx.cliDevice.update({
                  where: { id: cliDevice.id },
                  data: { inventoryAcknowledgedAt: now },
                  select: {
                    inventorySeq: true,
                    inventoryDigest: true,
                    inventoryAcknowledgedAt: true,
                  },
                })
              : await tx.cliDevice.update({
                  where: { id: cliDevice.id },
                  data: {
                    inventorySeq: { increment: 1 },
                    inventoryDigest,
                    inventoryAcknowledgedAt: now,
                  },
                  select: {
                    inventorySeq: true,
                    inventoryDigest: true,
                    inventoryAcknowledgedAt: true,
                  },
                });

          return {
            cliDeviceId: cliDevice.id,
            userId: cliDevice.userId,
            allowHumanTerminal: cliDevice.allowHumanTerminal === true,
            mcpCommandMode: mcpCommandModeFromDb(cliDevice.mcpCommandMode),
            revision: {
              inventorySeq: acknowledged.inventorySeq,
              inventoryDigest: acknowledged.inventoryDigest ?? inventoryDigest,
              inventoryAcknowledgedAt: (acknowledged.inventoryAcknowledgedAt ?? now).toISOString(),
            },
          };
        },
        { isolationLevel: "Serializable" },
      );
      return {
        ...persisted,
        desiredCapabilities: [],
      };
    } catch (error) {
      if (
        !isInferenceCapacityWriteRetryable(error) ||
        attempt === INVENTORY_TRANSACTION_MAX_ATTEMPTS
      ) {
        throw error;
      }
    }
  }

  throw new Error("inventory transaction retry loop exhausted");
}

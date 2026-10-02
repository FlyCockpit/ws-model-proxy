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
  AUTO_CAPACITY_RUNTIME_KEY_PREFIXES,
  discoveredHardConcurrencyLimit,
  ensureDiscoveredInferenceCapacity,
  existingDiscoveredCapacityCandidates,
  fillNullAutoDiscoveredCapacityLimit,
  isInferenceCapacityWriteRetryable,
  linkExecutionTargetCapacity,
} from "@ws-model-proxy/api/lib/discovered-inference-capacity";
import {
  applyEngineFactsToCapacity,
  engineDefaultConcurrency,
  type HardLimitRefreshDependent,
  mergeEngineFacts,
  type StoredEngineFacts,
  sameStoredEngineFacts,
  storedEngineFacts,
} from "@ws-model-proxy/api/lib/engine-facts";
import {
  applyEngineProcessCapacityPlan,
  deleteOrphanAutoCapacities,
  engineProcessRuntimeIdentityKey,
} from "@ws-model-proxy/api/lib/engine-process-capacity";
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
import { DEVICE_CREDENTIAL_IDENTITY_MISMATCH_MESSAGE } from "@ws-model-proxy/config/cli-identity-key";
import { directModelId, validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";
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
    public readonly code: "access_denied" | "protocol_error" | "machine_mismatch",
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
  reportedMcpFileRead: boolean | null;
  reportedFileRoots: boolean | null;
  reportedTerminalApproval: boolean | null;
  reportedTerminalSupported: boolean | null;
  /** 2.8: the CLI's `allowFileToolsAsRoot` config. */
  reportedAllowFileToolsAsRoot: boolean | null;
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
  identityPublicKey,
  now = new Date(),
}: {
  identity: CliWebsocketIdentity;
  cli: { slug: string };
  endpoints: EndpointInventory[];
  inventoryConfirmed: boolean;
  endpointTargeting: boolean;
  connection?: boolean;
  /**
   * Hello only: the CLI identity public key the hello presented. Required for
   * a device-credential hello (omitting it is a mismatch). Inventory updates
   * omit it; that socket was already admitted.
   */
  identityPublicKey?: string;
  /** Hello only. inventory.update must omit this so reported columns stay put. */
  reported?: ReportedRelayFeatures;
  now?: Date;
}): Promise<{
  cliDeviceId: string;
  userId: string;
  allowHumanTerminal: boolean;
  mcpCommandMode: McpCommandModeName;
  mcpFileRead: boolean;
  /** Fence for the connection this registration accepted; see the schema. */
  connectionGeneration: number;
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
          reportedMcpFileRead: reported.reportedMcpFileRead,
          reportedFileRoots: reported.reportedFileRoots,
          reportedTerminalApproval: reported.reportedTerminalApproval,
          reportedTerminalSupported: reported.reportedTerminalSupported,
          reportedAllowFileToolsAsRoot: reported.reportedAllowFileToolsAsRoot,
          reportedHostname: reported.reportedHostname,
          featuresReportedAt: reported.featuresReportedAt,
          // An accepted hello ends any "CLI upgrade required" state.
          rejectedRelayProtocolVersion: null,
          rejectedCliVersion: null,
          relayRejectedAt: null,
        }
      : {};

  for (let attempt = 1; attempt <= INVENTORY_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const persisted = await prisma.$transaction(
        async (tx) => {
          // Writer class M (@ws-model-proxy/db/capacity-lock-order): the
          // owner fence first. Every writer of this user's graph holds it, so
          // the plain reads below that plan the policy and capacity fences
          // stay true until this transaction ends.
          await fenceOwners(tx, [identity.userId]);
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
          if (userCredentialAccessBlocked(user, now)) {
            throw new RelayRegistrationError("Credential owner is not active.", "access_denied");
          }

          // Policy and capacity fences, before the first row lock or write:
          // every existing execution target this inventory touches
          // (capacity-policy) and every existing capacity row the capacity
          // work below may write (capacity: the attached one, or the auto
          // capacity it would adopt). Targets, models and capacities created
          // by this transaction are invisible to every other transaction
          // until commit, so their policy writes need no fence.
          const knownDevice = await tx.cliDevice.findUnique({
            where: { userId_slug: { userId: identity.userId, slug: cliSlug } },
            select: { id: true },
          });
          const existingInventoryTargets =
            knownDevice && endpoints.length > 0
              ? await tx.executionTarget.findMany({
                  where: {
                    userId: identity.userId,
                    DiscoveredModel: {
                      is: {
                        Endpoint: {
                          cliDeviceId: knownDevice.id,
                          slug: { in: endpoints.map((endpoint) => endpoint.slug) },
                        },
                      },
                    },
                  },
                  select: { id: true, inferenceCapacityId: true, discoveredModelId: true },
                })
              : [];
          const candidateCapacityIds = new Set<string>();
          for (const target of existingInventoryTargets) {
            if (target.inferenceCapacityId) candidateCapacityIds.add(target.inferenceCapacityId);
            if (target.discoveredModelId)
              for (const id of await existingDiscoveredCapacityCandidates(tx, {
                userId: identity.userId,
                discoveredModelId: target.discoveredModelId,
                executionTargetId: target.id,
              }))
                candidateCapacityIds.add(id);
          }
          // Shared destinations may have no targets and must be found by key,
          // independently of the bounded orphan batch.
          const knownEndpoints = knownDevice
            ? await tx.endpoint.findMany({
                where: {
                  userId: identity.userId,
                  cliDeviceId: knownDevice.id,
                  slug: { in: endpoints.map((endpoint) => endpoint.slug) },
                },
                select: { id: true },
              })
            : [];
          const sharedRows =
            knownEndpoints.length > 0
              ? await tx.inferenceCapacity.findMany({
                  where: {
                    userId: identity.userId,
                    runtimeIdentityKey: {
                      in: knownEndpoints.map((endpoint) =>
                        engineProcessRuntimeIdentityKey(endpoint.id),
                      ),
                    },
                  },
                  select: { id: true },
                })
              : [];
          const orphanRows = await tx.inferenceCapacity.findMany({
            where: {
              userId: identity.userId,
              hardConcurrencyLimitSource: "AUTO",
              ExecutionTargets: { none: {} },
              OR: AUTO_CAPACITY_RUNTIME_KEY_PREFIXES.map((prefix) => ({
                runtimeIdentityKey: { startsWith: prefix },
              })),
            },
            orderBy: { id: "asc" },
            take: 200,
            select: { id: true },
          });
          for (const row of [...sharedRows, ...orphanRows]) candidateCapacityIds.add(row.id);
          // Shared/owner assignments can attach targets from another endpoint.
          // Limit refresh validates all dependents, so fence their policy rows too.
          const attachedCapacityTargets =
            candidateCapacityIds.size > 0
              ? await tx.executionTarget.findMany({
                  where: {
                    userId: identity.userId,
                    inferenceCapacityId: { in: [...candidateCapacityIds] },
                  },
                  select: { id: true },
                })
              : [];
          await acquireFences(tx, [
            ...attachedCapacityTargets.map((target) => fences.capacityPolicy(target.id)),
            ...existingInventoryTargets.map((target) => fences.capacityPolicy(target.id)),
            ...[...candidateCapacityIds].map((capacityId) => fences.capacity(capacityId)),
          ]);

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
                    // Owns the device for this connection: a disconnect write
                    // from the connection this one replaces carries the older
                    // generation and is refused below it (see
                    // `disconnectCliDeviceAtGeneration`).
                    connectionGeneration: { increment: 1 },
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
              connectionGeneration: 1,
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
              mcpFileRead: true,
              connectionGeneration: true,
            },
          });

          // After the device upsert, which holds the device row lock that a
          // re-login's revoking transaction and a device delete also take. A
          // device credential only ever registers as its minted device; an
          // unbound CLI token is bound here (device + identity key). Any
          // refusal rolls back the upsert, including a device row it just
          // created — a mismatched identity key therefore does not take the
          // device from the session that already holds it.
          // Hello always presents the identity key. An omitted key is not a
          // match for a device credential. Inventory updates pass null: that
          // socket was already admitted.
          const presentedIdentityPublicKey = connection ? (identityPublicKey ?? "") : null;
          const credentialCheck = await checkCliCredentialForDevice(
            tx,
            identity,
            cliDevice.id,
            now,
            presentedIdentityPublicKey,
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
          if (credentialCheck === "machineMismatch") {
            throw new RelayRegistrationError(
              DEVICE_CREDENTIAL_IDENTITY_MISMATCH_MESSAGE,
              "machine_mismatch",
            );
          }

          const inventoryChanged = cliDevice.inventoryDigest !== inventoryDigest;
          const refreshedDiscoveredModelIds: string[] = [];
          const declaredContextByCapacityId = new Map<string, number>();
          const upsertedTargetIds = new Set<string>();
          const publishedEndpointSlugs = endpoints.map((endpoint) => endpoint.slug);
          const capacityWork: Array<{
            targetId: string;
            endpointId: string;
            inferenceCapacityId: string | null;
            capacityAssignmentSource: string;
            discoveredModelId: string;
            upstreamModelId: string;
            reportedConcurrency: number | undefined;
            declaredContext: number | null;
            engineFacts: StoredEngineFacts | null;
          }> = [];

          const endpointCapacityWork: Array<{
            endpointId: string;
            endpointSlug: string;
            inventory: EndpointInventory;
          }> = [];

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

            endpointCapacityWork.push({
              endpointId: persistedEndpoint.id,
              endpointSlug: persistedEndpoint.slug,
              inventory: endpoint,
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
                select: { id: true, inferenceCapacityId: true, capacityAssignmentSource: true },
              });
              if (!target) {
                target = await tx.executionTarget.create({
                  data: {
                    userId: identity.userId,
                    kind: "DISCOVERED_MODEL",
                    discoveredModelId: discoveredModel.id,
                  },
                  select: { id: true, inferenceCapacityId: true, capacityAssignmentSource: true },
                });
              }
              // A target outside the fenced set was created by this
              // transaction (the owner fence excludes every other creator).
              upsertedTargetIds.add(target.id);
              const modelEngineFacts = mergeEngineFacts(endpoint.engineFacts, model.engineFacts);
              capacityWork.push({
                targetId: target.id,
                endpointId: persistedEndpoint.id,
                inferenceCapacityId: target.inferenceCapacityId,
                capacityAssignmentSource: target.capacityAssignmentSource,
                discoveredModelId: discoveredModel.id,
                upstreamModelId: model.upstreamModelId,
                // The AUTO seed of a new capacity: the CLI's configured
                // concurrency, else engine slots, else the engine default.
                reportedConcurrency:
                  model.concurrencyLimit ??
                  modelEngineFacts?.slots?.value ??
                  engineDefaultConcurrency(modelEngineFacts?.engine?.value) ??
                  undefined,
                engineFacts: storedEngineFacts(modelEngineFacts),
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

          // All graph mutations below use the pre-write fence set. New rows
          // are transaction-private; existing destinations were read under owner.
          const orphanCapacityIds = new Set(candidateCapacityIds);
          for (const { endpointId, endpointSlug, inventory } of endpointCapacityWork) {
            // Persist each automatic member seed independently of the shared
            // aggregate so absence from a later inventory cannot erase it.
            for (const work of capacityWork.filter((work) => work.endpointId === endpointId)) {
              await tx.executionTarget.updateMany({
                where: {
                  id: work.targetId,
                  userId: identity.userId,
                  capacityAssignmentSource: "AUTO",
                },
                data: {
                  capacityAutoConcurrencyLimit: discoveredHardConcurrencyLimit(
                    work.reportedConcurrency,
                  ),
                },
              });
            }
            const result = await applyEngineProcessCapacityPlan(tx, {
              userId: identity.userId,
              endpointId,
              endpointSlug,
              engineFacts: inventory.engineFacts,
              inventoryModelIds: inventory.models.map((model) => model.upstreamModelId),
            });
            for (const id of result.capacityIds) orphanCapacityIds.add(id);
            for (const work of capacityWork) {
              const assignment = result.assignments.get(work.targetId);
              if (assignment) work.inferenceCapacityId = assignment;
            }
          }

          const engineFactsByCapacityId = new Map<string, StoredEngineFacts[]>();
          for (const work of capacityWork) {
            let inferenceCapacityId = work.inferenceCapacityId;
            if (inferenceCapacityId === null && work.capacityAssignmentSource === "OWNER") continue;
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
                endpointId: work.endpointId,
                reportedConcurrency: work.reportedConcurrency,
              });
            }
            if (work.engineFacts) {
              const facts = engineFactsByCapacityId.get(inferenceCapacityId) ?? [];
              facts.push(work.engineFacts);
              engineFactsByCapacityId.set(inferenceCapacityId, facts);
            }
            if (work.declaredContext != null) {
              declaredContextByCapacityId.set(
                inferenceCapacityId,
                Math.max(
                  declaredContextByCapacityId.get(inferenceCapacityId) ?? 0,
                  work.declaredContext,
                ),
              );
            }
          }
          await deleteOrphanAutoCapacities(tx, identity.userId, [...orphanCapacityIds]);

          if (declaredContextByCapacityId.size > 0) {
            // Every inventory target already holds its policy fence (above).
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
              // Seed only when every attached target was in this inventory.
              // This also covers the process alias group after re-pointing.
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

          if (engineFactsByCapacityId.size > 0) {
            // Same fence as the context seed: every target on the capacity
            // must be one this inventory holds the `06:capacity-policy:<target>`
            // fence for, and every capacity row already holds its
            // `08:capacity:<capacity>` fence (above).
            const capacities = await tx.inferenceCapacity.findMany({
              where: { userId: identity.userId, id: { in: [...engineFactsByCapacityId.keys()] } },
              select: {
                id: true,
                ExecutionTargets: {
                  select: {
                    id: true,
                    directConcurrencyLimit: true,
                    directReservedSlots: true,
                    PoolMembers: {
                      select: {
                        capacityConcurrencyMode: true,
                        capacityConcurrencyLimit: true,
                        capacityReservedSlots: true,
                        ModelPool: {
                          select: { capacityConcurrencyLimit: true, capacityReservedSlots: true },
                        },
                      },
                    },
                  },
                },
              },
            });
            for (const capacity of capacities) {
              if (capacity.ExecutionTargets.some((target) => !upsertedTargetIds.has(target.id))) {
                continue;
              }
              const reported = engineFactsByCapacityId.get(capacity.id) ?? [];
              const [facts, ...others] = reported;
              // One engine process reports one set of facts; disagreeing
              // reports for a shared capacity are left for the person.
              if (!facts || others.some((other) => !sameStoredEngineFacts(facts, other))) continue;
              const dependents: HardLimitRefreshDependent[] = capacity.ExecutionTargets.flatMap(
                (target) => [
                  {
                    kind: "direct" as const,
                    concurrencyLimit: target.directConcurrencyLimit,
                    reservedSlots: target.directReservedSlots,
                  },
                  ...target.PoolMembers.map(
                    (member): HardLimitRefreshDependent => ({
                      kind: "member",
                      mode: member.capacityConcurrencyMode,
                      limit: member.capacityConcurrencyLimit,
                      reserved: member.capacityReservedSlots,
                      poolLimit: member.ModelPool.capacityConcurrencyLimit,
                      poolReserved: member.ModelPool.capacityReservedSlots,
                    }),
                  ),
                ],
              );
              await applyEngineFactsToCapacity(tx, {
                userId: identity.userId,
                capacityId: capacity.id,
                facts,
                dependents,
                now,
              });
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
            mcpFileRead: cliDevice.mcpFileRead === true,
            connectionGeneration: cliDevice.connectionGeneration,
            revision: {
              inventorySeq: acknowledged.inventorySeq,
              inventoryDigest: acknowledged.inventoryDigest ?? inventoryDigest,
              inventoryAcknowledgedAt: (acknowledged.inventoryAcknowledgedAt ?? now).toISOString(),
            },
          };
        },
        // READ COMMITTED: the owner fence serializes every writer of this
        // user's graph, and each read after it sees the previous holder's
        // commit (a SERIALIZABLE snapshot would predate the fence wait).
        { isolationLevel: "ReadCommitted" },
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

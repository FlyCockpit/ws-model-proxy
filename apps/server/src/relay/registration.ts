import { createHash } from "node:crypto";
import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { resetPoolMemberHealth } from "@ws-model-proxy/api/lib/model-pool-routing";
import { directModelId, validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import type { EndpointInventory, OpenAiCompatibleCapabilities } from "./protocol.js";

type ModelCapability =
  | "TEXT_GENERATION"
  | "VISION_INPUT"
  | "VIDEO_INPUT"
  | "EMBEDDING"
  | "AUDIO_INPUT"
  | "AUDIO_OUTPUT"
  | "RESPONSES_API";

type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

const INVENTORY_TRANSACTION_MAX_ATTEMPTS = 3;

function isSerializationConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

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

function coarseModelCapabilities(
  capabilities: OpenAiCompatibleCapabilities | undefined,
): ModelCapability[] {
  if (!capabilities) return [];
  const values = new Set<ModelCapability>();
  if (
    capabilities.chatCompletions?.supported ||
    capabilities.completions?.supported ||
    capabilities.responses?.supported
  ) {
    values.add("TEXT_GENERATION");
  }
  if (capabilities.chatCompletions?.vision) values.add("VISION_INPUT");
  if (capabilities.chatCompletions?.video) values.add("VIDEO_INPUT");
  if (capabilities.embeddings?.supported) values.add("EMBEDDING");
  // Dedicated /v1/audio/* endpoints *or* chat `input_audio` content parts.
  if (
    capabilities.chatCompletions?.audio ||
    capabilities.audio?.transcriptions ||
    capabilities.audio?.translations
  ) {
    values.add("AUDIO_INPUT");
  }
  if (capabilities.audio?.speech) values.add("AUDIO_OUTPUT");
  if (capabilities.responses?.supported) values.add("RESPONSES_API");
  return [...values];
}

export function shouldPreserveDashboardCapabilityOverride(
  origin: string | null | undefined,
): boolean {
  return origin === "DASHBOARD";
}

async function loadDesiredModelCapabilities(
  cliDeviceId: string,
): Promise<DesiredModelCapability[]> {
  const rows = await prisma.discoveredModel.findMany({
    where: {
      Endpoint: { cliDeviceId },
      published: true,
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "DASHBOARD",
    },
    select: {
      upstreamModelId: true,
      capabilityOverrideMetadata: true,
      Endpoint: { select: { slug: true } },
    },
  });
  const desired: DesiredModelCapability[] = [];
  if (!Array.isArray(rows)) return desired;
  for (const row of rows) {
    if (!row.capabilityOverrideMetadata || typeof row.capabilityOverrideMetadata !== "object") {
      continue;
    }
    desired.push({
      endpointSlug: row.Endpoint.slug,
      upstreamModelId: row.upstreamModelId,
      capabilityOverrideMode: "override",
      capabilities: row.capabilityOverrideMetadata as OpenAiCompatibleCapabilities,
    });
  }
  return desired;
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

export async function persistRelayRegistration({
  identity,
  cli,
  endpoints,
  inventoryConfirmed,
  endpointTargeting,
  connection = false,
  now = new Date(),
}: {
  identity: CliWebsocketIdentity;
  cli: { slug: string; label: string };
  endpoints: EndpointInventory[];
  inventoryConfirmed: boolean;
  endpointTargeting: boolean;
  connection?: boolean;
  now?: Date;
}): Promise<{
  cliDeviceId: string;
  userId: string;
  revision: { inventorySeq: number; inventoryDigest: string; inventoryAcknowledgedAt: string };
  desiredCapabilities: DesiredModelCapability[];
}> {
  const cliSlug = assertSlug(cli.slug, "CLI slug");
  for (const endpoint of endpoints) {
    assertSlug(endpoint.slug, "Endpoint slug");
  }

  const inventoryDigest = inventoryDigestFor(endpoints);

  for (let attempt = 1; attempt <= INVENTORY_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const persisted = await prisma.$transaction(
        async (tx) => {
          const user = await tx.user.findUnique({
            where: { id: identity.userId },
            select: { id: true, slug: true },
          });
          if (!user) {
            throw new RelayRegistrationError("Credential owner no longer exists.", "access_denied");
          }

          const cliDevice = await tx.cliDevice.upsert({
            where: { userId_slug: { userId: identity.userId, slug: cliSlug } },
            update: {
              label: cli.label,
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
            },
            create: {
              userId: identity.userId,
              slug: cliSlug,
              label: cli.label,
              inventoryConfirmed,
              endpointTargeting,
              status: "CONNECTED",
              lastConnectedAt: now,
              lastHeartbeatAt: now,
              connectionCount: 1,
            },
            select: {
              id: true,
              userId: true,
              slug: true,
              inventorySeq: true,
              inventoryDigest: true,
              inventoryAcknowledgedAt: true,
              inventoryConfirmed: true,
            },
          });

          if (identity.cliDeviceId && identity.cliDeviceId !== cliDevice.id) {
            throw new RelayRegistrationError(
              "Credential is bound to a different CLI device.",
              "access_denied",
            );
          }

          if (!identity.cliDeviceId) {
            if (identity.kind === "cliToken") {
              await tx.cliToken.update({
                where: { id: identity.id },
                data: { cliDeviceId: cliDevice.id },
                select: { id: true },
              });
            } else {
              await tx.cliDeviceCredential.update({
                where: { id: identity.id },
                data: { cliDeviceId: cliDevice.id },
                select: { id: true },
              });
            }
          }

          const inventoryChanged = cliDevice.inventoryDigest !== inventoryDigest;
          const refreshedDiscoveredModelIds: string[] = [];
          const publishedEndpointSlugs = endpoints.map((endpoint) => endpoint.slug);

          for (const endpoint of endpoints) {
            const coarseCapabilities = coarseModelCapabilities(endpoint.defaultCapabilities);
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
                kind: "OPENAI_COMPATIBLE",
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
                kind: "OPENAI_COMPATIBLE",
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
                  ? coarseModelCapabilities(model.capabilities)
                  : [];
              const existingModel = await tx.discoveredModel.findUnique({
                where: {
                  endpointId_upstreamModelId: {
                    endpointId: persistedEndpoint.id,
                    upstreamModelId: model.upstreamModelId,
                  },
                },
                select: { capabilityOverrideMode: true, capabilityOverrideOrigin: true },
              });
              const incomingOverride = model.capabilityOverrideMode === "override";
              const keepDashboardOverride = shouldPreserveDashboardCapabilityOverride(
                existingModel?.capabilityOverrideOrigin,
              );
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
                discoveredModelId: { in: refreshedDiscoveredModelIds },
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
        desiredCapabilities: await loadDesiredModelCapabilities(persisted.cliDeviceId),
      };
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === INVENTORY_TRANSACTION_MAX_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw new Error("inventory transaction retry loop exhausted");
}

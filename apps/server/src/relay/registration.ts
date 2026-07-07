import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { resetPoolMemberHealthForDiscoveredModels } from "@ws-model-proxy/api/lib/model-pool-routing";
import { directModelId, validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import type { EndpointInventory, OpenAiCompatibleCapabilities } from "./protocol.js";

type ModelCapability =
  | "TEXT_GENERATION"
  | "VISION_INPUT"
  | "EMBEDDING"
  | "AUDIO_INPUT"
  | "AUDIO_OUTPUT"
  | "RESPONSES_API";

type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

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
  if (capabilities.embeddings?.supported) values.add("EMBEDDING");
  if (capabilities.audio?.transcriptions || capabilities.audio?.translations) {
    values.add("AUDIO_INPUT");
  }
  if (capabilities.audio?.speech) values.add("AUDIO_OUTPUT");
  if (capabilities.responses?.supported) values.add("RESPONSES_API");
  return [...values];
}

function jsonOrUndefined(value: OpenAiCompatibleCapabilities | undefined): JsonValue | undefined {
  if (!value) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function persistRelayRegistration({
  identity,
  cli,
  endpoints,
  now = new Date(),
}: {
  identity: CliWebsocketIdentity;
  cli: { slug: string; label: string };
  endpoints: EndpointInventory[];
  now?: Date;
}): Promise<{ cliDeviceId: string; userId: string }> {
  const cliSlug = assertSlug(cli.slug, "CLI slug");
  for (const endpoint of endpoints) {
    assertSlug(endpoint.slug, "Endpoint slug");
  }

  const user = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { id: true, slug: true },
  });
  if (!user) {
    throw new RelayRegistrationError("Credential owner no longer exists.", "access_denied");
  }

  const cliDevice = await prisma.cliDevice.upsert({
    where: { userId_slug: { userId: identity.userId, slug: cliSlug } },
    update: {
      label: cli.label,
      status: "CONNECTED",
      lastConnectedAt: now,
      lastHeartbeatAt: now,
      connectionCount: { increment: 1 },
    },
    create: {
      userId: identity.userId,
      slug: cliSlug,
      label: cli.label,
      status: "CONNECTED",
      lastConnectedAt: now,
      lastHeartbeatAt: now,
      connectionCount: 1,
    },
    select: { id: true, userId: true, slug: true },
  });

  if (identity.cliDeviceId && identity.cliDeviceId !== cliDevice.id) {
    throw new RelayRegistrationError(
      "Credential is bound to a different CLI device.",
      "access_denied",
    );
  }

  if (!identity.cliDeviceId) {
    if (identity.kind === "cliToken") {
      await prisma.cliToken.update({
        where: { id: identity.id },
        data: { cliDeviceId: cliDevice.id },
        select: { id: true },
      });
    } else {
      await prisma.cliDeviceCredential.update({
        where: { id: identity.id },
        data: { cliDeviceId: cliDevice.id },
        select: { id: true },
      });
    }
  }

  const refreshedDiscoveredModelIds: string[] = [];

  for (const endpoint of endpoints) {
    const coarseCapabilities = coarseModelCapabilities(endpoint.defaultCapabilities);
    const persistedEndpoint = await prisma.endpoint.upsert({
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
        statusChangedAt: now,
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
      const discoveredModel = await prisma.discoveredModel.upsert({
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
          capabilityOverrideMode:
            model.capabilityOverrideMode === "override" ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrides: { set: overrideCapabilities },
          capabilityOverrideMetadata:
            model.capabilityOverrideMode === "override"
              ? jsonOrUndefined(model.capabilities)
              : undefined,
          probeSuggestions: jsonOrUndefined(model.probeSuggestions),
          lastSeenAt: now,
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
            model.capabilityOverrideMode === "override" ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrides: overrideCapabilities,
          capabilityOverrideMetadata:
            model.capabilityOverrideMode === "override"
              ? jsonOrUndefined(model.capabilities)
              : undefined,
          probeSuggestions: jsonOrUndefined(model.probeSuggestions),
          lastSeenAt: now,
        },
        select: { id: true },
      });
      refreshedDiscoveredModelIds.push(discoveredModel.id);
    }
  }

  await resetPoolMemberHealthForDiscoveredModels(refreshedDiscoveredModelIds);

  return { cliDeviceId: cliDevice.id, userId: cliDevice.userId };
}

import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { persistRelayRegistration, shouldPreserveDashboardCapabilityOverride } = await import(
  "./registration.js"
);
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: { upsert: MockInstance; update: MockInstance };
  cliToken: { update: MockInstance };
  endpoint: { upsert: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: { updateMany: MockInstance };
};

const identity: CliWebsocketIdentity = {
  kind: "cliToken",
  id: "token-id",
  userId: "user-id",
  cliDeviceId: null,
  lookupPrefix: "wsmp_cli_lookup",
};

const now = new Date("2026-01-01T00:00:00.000Z");

const cliOverride = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, vision: false },
};

function inventoryEndpoints() {
  return [
    {
      slug: "local-openai",
      label: "Local OpenAI",
      kind: "openai-compatible" as const,
      status: "online" as const,
      defaultCapabilities: {
        version: 1 as const,
        protocol: "openai-compatible" as const,
        chatCompletions: { supported: true, streaming: true },
      },
      models: [
        {
          slug: "llava-local",
          upstreamModelId: "llava/local",
          capabilityOverrideMode: "override" as const,
          capabilities: cliOverride,
        },
      ],
    },
  ];
}

describe("capability override origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.user.findUnique.mockResolvedValue({ id: "user-id", slug: "owner" });
    db.cliDevice.upsert.mockResolvedValue({
      id: "cli-device-id",
      userId: "user-id",
      slug: "desktop",
    });
    db.cliToken.update.mockResolvedValue({ id: "token-id" });
    db.cliDevice.update.mockResolvedValue({
      inventorySeq: 1,
      inventoryDigest: "digest",
      inventoryAcknowledgedAt: now,
    });
    db.endpoint.findUnique.mockResolvedValue(null);
    db.endpoint.upsert.mockResolvedValue({ id: "endpoint-id", slug: "local-openai" });
    db.endpoint.updateMany.mockResolvedValue({ count: 0 });
    db.discoveredModel.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.discoveredModel.upsert.mockResolvedValue({ id: "model-id" });
    db.discoveredModel.updateMany.mockResolvedValue({ count: 0 });
    db.poolMember.updateMany.mockResolvedValue({ count: 0 });
  });

  it("treats only dashboard origin as protected", () => {
    expect(shouldPreserveDashboardCapabilityOverride("DASHBOARD")).toBe(true);
    expect(shouldPreserveDashboardCapabilityOverride("CLI")).toBe(false);
    expect(shouldPreserveDashboardCapabilityOverride(null)).toBe(false);
  });

  it("applies a CLI override when the existing row is CLI-owned or untagged", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "CLI",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "CLI",
          capabilityOverrideMetadata: expect.objectContaining({
            chatCompletions: expect.objectContaining({ vision: false }),
          }),
        }),
      }),
    );
  });

  it("does not let inventory overwrite a dashboard-authored override", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          capabilityOverrideMode: expect.anything(),
          capabilityOverrideOrigin: expect.anything(),
          capabilityOverrideMetadata: expect.anything(),
        }),
      }),
    );
  });

  it("returns only dashboard-authored overrides as desired capabilities", async () => {
    db.discoveredModel.findMany.mockResolvedValue([
      {
        upstreamModelId: "llava/local",
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, vision: true },
        },
        Endpoint: { slug: "local-openai" },
      },
    ]);
    const result = await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "DASHBOARD",
        }),
      }),
    );
    expect(result.desiredCapabilities).toEqual([
      {
        endpointSlug: "local-openai",
        upstreamModelId: "llava/local",
        capabilityOverrideMode: "override",
        capabilities: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, vision: true },
        },
      },
    ]);
  });
});

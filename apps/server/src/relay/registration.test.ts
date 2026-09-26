import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret" },
}));

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
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: { upsert: MockInstance; update: MockInstance };
  cliToken: { update: MockInstance; updateMany: MockInstance; findUnique: MockInstance };
  endpoint: { upsert: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: { updateMany: MockInstance };
  executionTarget: {
    findMany: MockInstance;
    findUnique: MockInstance;
    create: MockInstance;
    updateMany: MockInstance;
  };
  inferenceCapacity: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    upsert: MockInstance;
  };
};

type CapacityWriteArgs = {
  where?: {
    id?: string;
    userId?: string;
    hardConcurrencyLimit?: number | null;
    hardConcurrencyLimitSource?: "AUTO" | "USER";
    runtimeIdentityKey?: { in?: readonly string[] };
  };
  data?: { hardConcurrencyLimit?: number | null; hardConcurrencyLimitSource?: "AUTO" | "USER" };
};

function applyCapacityWrite(
  row: {
    id: string;
    userId: string;
    runtimeIdentityKey: string;
    hardConcurrencyLimit: number | null;
    hardConcurrencyLimitSource?: "AUTO" | "USER";
  },
  args: CapacityWriteArgs,
): { count: number } {
  const where = args.where ?? {};
  if (where.id !== undefined && where.id !== row.id) return { count: 0 };
  if (where.userId !== undefined && where.userId !== row.userId) return { count: 0 };
  if (
    where.hardConcurrencyLimit !== undefined &&
    where.hardConcurrencyLimit !== row.hardConcurrencyLimit
  ) {
    return { count: 0 };
  }
  if (
    where.hardConcurrencyLimitSource !== undefined &&
    where.hardConcurrencyLimitSource !== (row.hardConcurrencyLimitSource ?? "AUTO")
  ) {
    return { count: 0 };
  }
  const keys = where.runtimeIdentityKey?.in;
  if (keys && !keys.includes(row.runtimeIdentityKey)) return { count: 0 };
  if (args.data && "hardConcurrencyLimit" in args.data) {
    row.hardConcurrencyLimit = args.data.hardConcurrencyLimit ?? null;
  }
  if (args.data?.hardConcurrencyLimitSource !== undefined) {
    row.hardConcurrencyLimitSource = args.data.hardConcurrencyLimitSource;
  }
  return { count: 1 };
}

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

function inventoryEndpoints({ modelOverride = true }: { modelOverride?: boolean } = {}) {
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
          capabilityOverrideMode: modelOverride ? ("override" as const) : ("inherit" as const),
          ...(modelOverride ? { capabilities: cliOverride } : {}),
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
    // An unbound CLI token: every hello's conditional bind claims it.
    db.cliToken.findUnique.mockResolvedValue({
      revokedAt: null,
      expiresAt: null,
      cliDeviceId: null,
    });
    db.cliToken.updateMany.mockResolvedValue({ count: 1 });
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
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: "capacity-id",
    });
    db.executionTarget.findMany.mockResolvedValue([{ id: "execution-target-id" }]);
    db.executionTarget.updateMany.mockResolvedValue({ count: 1 });
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findUnique.mockResolvedValue(null);
    db.inferenceCapacity.updateMany.mockResolvedValue({ count: 0 });
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "ensured-capacity" });
  });

  it("stores the hello's reported hostname and never writes the user-owned name", async () => {
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [],
      inventoryConfirmed: true,
      endpointTargeting: true,
      connection: true,
      reported: {
        cliVersion: "1.0.0",
        relayProtocolVersion: "2.6",
        reportedHumanTerminal: null,
        reportedMcpCommandMode: null,
        reportedTerminalApproval: null,
        reportedTerminalSupported: null,
        reportedHostname: "desk-01.local",
        featuresReportedAt: null,
      },
      now,
    });

    const call = db.cliDevice.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(call.update.reportedHostname).toBe("desk-01.local");
    expect(call.create.reportedHostname).toBe("desk-01.local");
    for (const data of [call.update, call.create]) {
      expect(data).not.toHaveProperty("name");
      expect(data).not.toHaveProperty("label");
    }
  });

  it("refuses registration while the credential owner is marked for deletion", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "user-id",
      slug: "owner",
      banned: true,
      deletionRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(
      persistRelayRegistration({
        identity,
        cli: { slug: "desktop" },
        endpoints: [],
        inventoryConfirmed: true,
        endpointTargeting: true,
        now,
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("refuses to register a revoked or expired credential", async () => {
    const register = () =>
      persistRelayRegistration({
        identity,
        cli: { slug: "desktop" },
        endpoints: [],
        inventoryConfirmed: true,
        endpointTargeting: true,
        now,
      });
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: now,
      expiresAt: null,
      cliDeviceId: null,
    });
    await expect(register()).rejects.toMatchObject({
      name: "RelayRegistrationError",
      code: "access_denied",
    });
    db.cliToken.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      expiresAt: now,
      cliDeviceId: null,
    });
    await expect(register()).rejects.toMatchObject({ code: "access_denied" });
    // Checked inside the registration transaction, after the device upsert.
    expect(db.cliToken.findUnique).toHaveBeenCalledWith({
      where: { id: "token-id" },
      select: { revokedAt: true, expiresAt: true, cliDeviceId: true },
    });
    expect(db.cliToken.updateMany).not.toHaveBeenCalled();
  });

  it("registers a device credential only as the device it was minted for", async () => {
    const credentials = prisma as unknown as {
      cliDeviceCredential: { findUnique: MockInstance; update: MockInstance };
    };
    const deviceIdentity: CliWebsocketIdentity = {
      kind: "deviceCredential",
      id: "credential-id",
      userId: "user-id",
      cliDeviceId: "minted-device-id",
      lookupPrefix: "wsmp_device_prefix",
    };
    const register = (slug: string) =>
      persistRelayRegistration({
        identity: deviceIdentity,
        cli: { slug },
        endpoints: [],
        inventoryConfirmed: true,
        endpointTargeting: true,
        connection: true,
        now,
      });

    // The hello names another slug (or the minted device was deleted and the
    // upsert recreated a row): the device ids differ, so it is refused and the
    // transaction (with the upserted row) rolls back.
    credentials.cliDeviceCredential.findUnique.mockResolvedValueOnce({
      revokedAt: null,
      cliDeviceId: "minted-device-id",
    });
    await expect(register("someone-else")).rejects.toMatchObject({
      code: "access_denied",
      message: "Credential is bound to a different CLI device.",
    });
    // Deleted together with its device.
    credentials.cliDeviceCredential.findUnique.mockResolvedValueOnce(null);
    await expect(register("desktop")).rejects.toMatchObject({
      code: "access_denied",
      message: "Credential was revoked.",
    });
    // Never rebound to whatever device the hello names.
    expect(credentials.cliDeviceCredential.update).not.toHaveBeenCalled();
  });

  it("leaves the reported hostname alone on inventory updates", async () => {
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    const call = db.cliDevice.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(call.update).not.toHaveProperty("reportedHostname");
    expect(call.update).not.toHaveProperty("name");
  });

  it("treats only dashboard origin as protected", () => {
    expect(shouldPreserveDashboardCapabilityOverride("DASHBOARD")).toBe(true);
    expect(shouldPreserveDashboardCapabilityOverride("CLI")).toBe(false);
    expect(shouldPreserveDashboardCapabilityOverride(null)).toBe(false);
  });

  it("seeds an empty local physical context from declared v4 inventory metadata", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "execution-target-id",
            directContextCeiling: null,
            directContextMargin: 0,
            PoolMembers: [],
          },
        ],
      },
    ]);
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 1_000_000,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "large-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "capacity-id", userId: "user-id", physicalMaxContext: null },
      data: { physicalMaxContext: 1_000_000 },
    });
  });

  it("locks existing inventory targets (L2) before inventory writes and capacity rows (L5) before capacity writes", async () => {
    // DL-1 capacity lock order: the device row (L0), then every existing
    // target of this inventory, sorted, before any endpoint/model/target
    // write; then the capacity rows it may write, sorted, before the first
    // capacity write. No capacity write precedes a target lock.
    db.executionTarget.findMany.mockResolvedValue([{ id: "execution-target-id" }]);
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: "capacity-id",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: inventoryEndpoints({ modelOverride: false }),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    const sql = (index: number) =>
      ((db.$queryRaw.mock.calls[index]?.[0] as TemplateStringsArray | undefined) ?? []).join("?");
    const order = (fragment: string) => {
      const index = db.$queryRaw.mock.calls.findIndex((_, call) => sql(call).includes(fragment));
      return db.$queryRaw.mock.invocationCallOrder[index] ?? Number.NaN;
    };
    const targetLock = order("FROM execution_target WHERE id = ? FOR NO KEY UPDATE");
    const capacityLock = order("FROM inference_capacity WHERE id IN (");
    const firstOf = (mock: MockInstance) => mock.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(firstOf(db.cliDevice.upsert)).toBeLessThan(targetLock);
    expect(targetLock).toBeLessThan(firstOf(db.endpoint.upsert));
    expect(targetLock).toBeLessThan(firstOf(db.discoveredModel.upsert));
    expect(capacityLock).toBeGreaterThan(firstOf(db.discoveredModel.upsert));
    expect(capacityLock).toBeLessThan(firstOf(db.inferenceCapacity.updateMany));
    // The L2 set is the inventory's existing targets on this device only.
    expect(db.executionTarget.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        DiscoveredModel: {
          is: {
            Endpoint: { cliDeviceId: "cli-device-id" },
            OR: [{ Endpoint: { slug: "local-openai" }, upstreamModelId: { in: ["llava/local"] } }],
          },
        },
      },
      select: { id: true },
    });
  });

  it("retries a raw policy-lock deadlock and then persists the registration", async () => {
    db.$queryRaw.mockRejectedValueOnce({ code: "P2010", meta: { code: "40P01" } });
    const [endpoint] = inventoryEndpoints({ modelOverride: false });
    if (!endpoint) throw new Error("expected inventory endpoint");

    await expect(
      persistRelayRegistration({
        identity,
        cli: { slug: "desktop" },
        endpoints: [
          {
            ...endpoint,
            defaultCapabilities: {
              version: 4,
              protocol: "openai-compatible",
              surfaces: {
                openaiChatCompletions: {
                  source: "declared",
                  confidence: "exact",
                  streaming: true,
                  maxContextTokens: 8_192,
                  operations: ["create"],
                },
              },
            },
          },
        ],
        inventoryConfirmed: true,
        endpointTargeting: true,
        now,
      }),
    ).resolves.toMatchObject({ userId: "user-id" });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a non-null local physical context during registration", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: 32_768,
        ExecutionTargets: [],
      },
    ]);
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 1_000_000,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "large-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ physicalMaxContext: expect.any(Number) }),
      }),
    );
  });

  it("does not seed a capacity shared with a target outside this registration", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "execution-target-id",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
          {
            id: "other-device-target",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
        ],
      },
    ]);

    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 128_000,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "large-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ physicalMaxContext: expect.any(Number) }),
      }),
    );
  });

  it("applies a CLI override when the existing row is CLI-owned or untagged", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "CLI",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
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
    // Target identity is immutable: an existing target is read, never
    // upserted with a SET of the key column "userId" (DL-1).
    expect(db.executionTarget.findUnique).toHaveBeenCalledWith({
      where: { discoveredModelId: "model-id" },
      select: { id: true, inferenceCapacityId: true },
    });
    expect(db.executionTarget.create).not.toHaveBeenCalled();
  });

  it("preserves a dashboard-authored override when the CLI inherits", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: inventoryEndpoints({ modelOverride: false }),
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

  it("preserves a dashboard-authored inherit choice when the CLI also inherits", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: inventoryEndpoints({ modelOverride: false }),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          capabilityOverrideMode: expect.anything(),
          capabilityOverrideOrigin: expect.anything(),
        }),
      }),
    );
  });

  it("lets an explicit CLI override replace a dashboard-authored override", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: inventoryEndpoints({ modelOverride: true }),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "CLI",
          capabilityOverrideMetadata: expect.anything(),
        }),
      }),
    );
  });

  it("does not send dashboard-authored state for persistence in CLI config", async () => {
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
      cli: { slug: "desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.findMany).not.toHaveBeenCalled();
    expect(result.desiredCapabilities).toEqual([]);
  });

  it("creates one discovered capacity, stores its id, and seeds declared context", async () => {
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: null,
    });
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "new-capacity" });
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "new-capacity",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "execution-target-id",
            directContextCeiling: null,
            directContextMargin: 0,
            PoolMembers: [],
          },
        ],
      },
    ]);

    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 8_192,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "llama-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.upsert).toHaveBeenCalledTimes(1);
    expect(db.inferenceCapacity.upsert).toHaveBeenCalledWith({
      where: {
        userId_runtimeIdentityKey: {
          userId: "user-id",
          runtimeIdentityKey: "discovered-model:model-id",
        },
      },
      update: {},
      create: {
        userId: "user-id",
        label: "Discovered model model-id",
        runtimeIdentityKey: "discovered-model:model-id",
        runtimeModel: "llama-local",
        hardConcurrencyLimit: 1,
        hardConcurrencyLimitSource: "AUTO",
        countStrategy: "CONSERVATIVE_ESTIMATE",
      },
      select: { id: true },
    });
    expect(db.executionTarget.updateMany).toHaveBeenCalledWith({
      where: { id: "execution-target-id", userId: "user-id", inferenceCapacityId: null },
      data: { inferenceCapacityId: "new-capacity" },
    });
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "new-capacity", userId: "user-id", physicalMaxContext: null },
      data: { physicalMaxContext: 8_192 },
    });
  });

  it("stores the CLI-reported concurrency when the registration payload has one", async () => {
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: null,
    });
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "new-capacity" });

    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true },
          },
          models: [
            {
              upstreamModelId: "llama-local",
              capabilityOverrideMode: "inherit",
              concurrencyLimit: 4,
            },
          ],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ hardConcurrencyLimit: 4 }),
      }),
    );
  });

  it("does not create another capacity when the same model registers again", async () => {
    db.executionTarget.findUnique
      .mockResolvedValueOnce({ id: "execution-target-id", inferenceCapacityId: null })
      .mockResolvedValueOnce({ id: "execution-target-id", inferenceCapacityId: "new-capacity" });
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "new-capacity" });

    const registration = {
      identity,
      cli: { slug: "desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    };
    await persistRelayRegistration(registration);
    await persistRelayRegistration(registration);

    expect(db.inferenceCapacity.upsert).toHaveBeenCalledTimes(1);
    expect(db.executionTarget.updateMany).toHaveBeenCalledTimes(1);
  });

  it("keeps an execution target capacity that is already attached", async () => {
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: "kept-capacity",
    });
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "kept-capacity",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "execution-target-id",
            directContextCeiling: null,
            directContextMargin: 0,
            PoolMembers: [],
          },
        ],
      },
    ]);

    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 4_096,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "llama-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "kept-capacity", userId: "user-id", physicalMaxContext: null },
      data: { physicalMaxContext: 4_096 },
    });
  });

  function preAttachedRegistration(concurrencyLimit?: number) {
    return {
      identity,
      cli: { slug: "desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible" as const,
          status: "online" as const,
          defaultCapabilities: {
            version: 1 as const,
            protocol: "openai-compatible" as const,
            chatCompletions: { supported: true },
          },
          models: [
            {
              upstreamModelId: "llama-local",
              capabilityOverrideMode: "inherit" as const,
              ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
            },
          ],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    };
  }

  it("fills a null limit on a pre-attached trigger capacity with the CLI report", async () => {
    // The schema-hardening trigger was not executed. Prisma is mocked. This row
    // is the capacity that trigger would attach, with hardConcurrencyLimit omitted.
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:execution-target-id",
      hardConcurrencyLimit: null as number | null,
    };
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await persistRelayRegistration(preAttachedRegistration(4));

    expect(row.hardConcurrencyLimit).toBe(4);
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: {
        id: "trigger-capacity",
        userId: "user-id",
        hardConcurrencyLimit: null,
        hardConcurrencyLimitSource: "AUTO",
        runtimeIdentityKey: {
          in: ["execution-target:execution-target-id", "discovered-model:model-id"],
        },
      },
      data: { hardConcurrencyLimit: 4, hardConcurrencyLimitSource: "AUTO" },
    });
  });

  it("fills an omitted CLI concurrency on a pre-attached trigger capacity with 1", async () => {
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "discovered-model:model-id",
      hardConcurrencyLimit: null as number | null,
    };
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await persistRelayRegistration(preAttachedRegistration());

    expect(row.hardConcurrencyLimit).toBe(1);
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
  });

  it("does not rewrite a pre-attached capacity whose hard limit is already 4", async () => {
    const row = {
      id: "trigger-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:execution-target-id",
      hardConcurrencyLimit: 4,
    };
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await persistRelayRegistration(preAttachedRegistration());

    expect(row.hardConcurrencyLimit).toBe(4);
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
    for (const call of db.inferenceCapacity.updateMany.mock.calls) {
      const args = call[0] as CapacityWriteArgs;
      if (args.data && "hardConcurrencyLimit" in args.data) {
        expect(args.where?.hardConcurrencyLimit).toBeNull();
        expect(args.where?.hardConcurrencyLimitSource).toBe("AUTO");
      }
    }
  });

  it("never lets a CLI-reported limit overwrite a USER limit or USER unlimited", async () => {
    for (const userLimit of [null, 2]) {
      const row = {
        id: "trigger-capacity",
        userId: "user-id",
        runtimeIdentityKey: "execution-target:execution-target-id",
        hardConcurrencyLimit: userLimit as number | null,
        hardConcurrencyLimitSource: "USER" as "AUTO" | "USER",
      };
      db.executionTarget.findUnique.mockResolvedValue({
        id: "execution-target-id",
        inferenceCapacityId: row.id,
      });
      db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
        applyCapacityWrite(row, args),
      );

      await persistRelayRegistration(preAttachedRegistration(8));

      expect(row.hardConcurrencyLimit).toBe(userLimit);
      expect(row.hardConcurrencyLimitSource).toBe("USER");
    }
    expect(db.inferenceCapacity.update).not.toHaveBeenCalled();
  });

  it("does not change a pre-attached capacity with a different runtime key", async () => {
    const row = {
      id: "custom-capacity",
      userId: "user-id",
      runtimeIdentityKey: "execution-target:other-target",
      hardConcurrencyLimit: null as number | null,
    };
    db.executionTarget.findUnique.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: row.id,
    });
    db.inferenceCapacity.updateMany.mockImplementation(async (args: CapacityWriteArgs) =>
      applyCapacityWrite(row, args),
    );

    await persistRelayRegistration(preAttachedRegistration());

    expect(row.hardConcurrencyLimit).toBeNull();
    expect(db.inferenceCapacity.upsert).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).not.toHaveBeenCalled();
  });
});

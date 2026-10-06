import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_MIN_PROTOCOL_VERSION } from "../lib/relay-protocol-version";

const [currentMajor, currentMinor] = RELAY_MIN_PROTOCOL_VERSION.split(".").map(Number);
const nextRelayProtocol = `${currentMajor}.${currentMinor! + 1}`;

import {
  buildContext,
  client,
  db,
  fenceParentDelete,
  forwarderManagementRouter,
  testEnv,
} from "./forwarder-test-helpers";

describe("forwarderManagementRouter cli devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.poolMember.count.mockResolvedValue(0);
    db.poolGrant.findMany.mockResolvedValue([]);
    db.poolGrant.findFirst.mockResolvedValue(null);
    db.$queryRaw.mockResolvedValue([]);
    db.executionTarget.upsert.mockResolvedValue({ id: "target-id" });
    db.executionTarget.findUnique.mockResolvedValue(null);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.inferenceCapacity.upsert.mockResolvedValue({ id: "provider-capacity-id" });
    db.capacityAuditEvent.create.mockResolvedValue({ id: "audit-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
  });
  it("previews and updates the current user's slug without changing internal ids", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ id: "user-id", slug: "old-owner" })
      .mockResolvedValueOnce(null);
    db.discoveredModel.findMany.mockResolvedValueOnce([
      {
        id: "model-id",
        upstreamModelId: "org/model 1",
        Endpoint: {
          slug: "local",
          CliDevice: { slug: "desk" },
        },
      },
    ]);
    db.modelPool.findMany.mockResolvedValue([{ id: "pool-id", slug: "general", name: "General" }]);
    db.user.update.mockResolvedValue({ id: "user-id", slug: "new-owner" });

    const result = await client().updateProfileSlug({ slug: "new-owner" });

    expect(result.slug).toBe("new-owner");
    expect(result.preview.affectedModels).toEqual([
      {
        kind: "DIRECT_MODEL",
        id: "model-id",
        upstreamModelId: "org/model 1",
        currentModelId: "old-owner/desk/local/org%2Fmodel%201",
        nextModelId: "new-owner/desk/local/org%2Fmodel%201",
      },
      {
        kind: "MODEL_POOL",
        id: "pool-id",
        name: "General",
        currentModelId: "old-owner/general",
        nextModelId: "new-owner/general",
      },
    ]);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-id" },
      data: { slug: "new-owner" },
      select: { id: true, slug: true },
    });
  });

  it.each([
    "ab",
    "a".repeat(64),
    "api",
    "-abc",
    "abc-",
    "abc--def",
    "abc_def",
    "abc def",
    "abc.def",
    "abc/def",
    "Abc",
  ])("rejects invalid or reserved slugs: %s", async (slug) => {
    await expect(client().previewProfileSlugChange({ slug })).rejects.toThrow();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects globally colliding user slugs", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ id: "user-id", slug: "owner" })
      .mockResolvedValueOnce({ id: "other-user-id" });

    await expect(client().previewProfileSlugChange({ slug: "taken" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("CONFLICT");
        return true;
      },
    );
  });

  it("lists owned CLI metadata with effective capabilities and no endpoint secrets", async () => {
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        slug: "desk",
        name: null,
        reportedHostname: "desk-01.local",
        status: "CONNECTED",
        lastConnectedAt: new Date("2026-01-01T00:00:00Z"),
        lastDisconnectedAt: null,
        lastHeartbeatAt: new Date("2026-01-01T00:00:30Z"),
        connectionCount: 3,
        User: { slug: "renamed-owner" },
        CliDeviceCredentials: [],
        Endpoints: [
          {
            id: "endpoint-id",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-02"),
            slug: "local",
            label: "Local",
            kind: "OPENAI_COMPATIBLE",
            status: "ONLINE",
            defaultCapabilities: ["TEXT_GENERATION"],
            capabilityMetadata: { chatCompletions: { supported: true } },
            probeSuggestions: null,
            lastSeenAt: new Date("2026-01-01T00:00:30Z"),
            lastHealthCheckAt: null,
            statusChangedAt: null,
            failureReasonCode: null,
            baseUrl: "http://127.0.0.1:11434",
            secret: "endpoint-secret",
            DiscoveredModels: [
              {
                id: "model-id",
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-02"),
                slug: null,
                upstreamModelId: "llama",
                encodedModelId: "old-owner/desk/local/llama",
                capabilityOverrideMode: "OVERRIDE",
                capabilityOverrides: ["TEXT_GENERATION", "VISION_INPUT"],
                capabilityOverrideMetadata: { chatCompletions: { vision: true } },
                probeSuggestions: null,
                lastSeenAt: new Date("2026-01-01T00:00:30Z"),
                ExecutionTarget: null,
              },
            ],
          },
        ],
      },
    ]);

    const result = await client().listCliDevices();

    expect(result[0]?.endpoints[0]?.models[0]?.effectiveCapabilities).toEqual({
      coarse: ["TEXT_GENERATION", "VISION_INPUT"],
      metadata: { chatCompletions: { vision: true } },
      source: "MODEL_OVERRIDE",
    });
    expect(result[0]?.endpoints[0]?.models[0]?.canonicalModelId).toBe(
      "renamed-owner/desk/local/llama",
    );
    expect(result[0]?.endpoints[0]?.models[0]?.executionTarget).toBeNull();
    // No user-set name: the reported hostname is the display name.
    expect(result[0]).toMatchObject({
      slug: "desk",
      name: null,
      reportedHostname: "desk-01.local",
      displayName: "desk-01.local",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("endpoint-secret");

    const findManySelect = db.cliDevice.findMany.mock.calls[0]?.[0]?.select;
    expect(
      findManySelect?.Endpoints?.select?.DiscoveredModels?.select?.ExecutionTarget,
    ).toBeDefined();
    expect(findManySelect?.Endpoints?.select?.DiscoveredModels?.select).not.toHaveProperty(
      "ExecutionTargets",
    );
  });

  it("lists execution targets on discovered models when present", async () => {
    const executionTarget = {
      id: "target-id",
      inferenceCapacityId: "capacity-id",
      directPriority: 0,
      directConcurrencyLimit: 2,
      directReservedSlots: 1,
      directBorrowPolicy: "ALLOW",
      directWaitBudgetMs: 5000,
      directContextCeiling: 8192,
      directContextMargin: 256,
    };
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        slug: "desk",
        name: "Desk",
        reportedHostname: null,
        status: "CONNECTED",
        lastConnectedAt: new Date("2026-01-01T00:00:00Z"),
        lastDisconnectedAt: null,
        lastHeartbeatAt: new Date("2026-01-01T00:00:30Z"),
        connectionCount: 3,
        User: { slug: "owner" },
        CliDeviceCredentials: [],
        Endpoints: [
          {
            id: "endpoint-id",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-02"),
            slug: "local",
            label: "Local",
            kind: "OPENAI_COMPATIBLE",
            status: "ONLINE",
            defaultCapabilities: ["TEXT_GENERATION"],
            capabilityMetadata: null,
            probeSuggestions: null,
            lastSeenAt: new Date("2026-01-01T00:00:30Z"),
            lastHealthCheckAt: null,
            statusChangedAt: null,
            failureReasonCode: null,
            DiscoveredModels: [
              {
                id: "model-id",
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-02"),
                slug: null,
                upstreamModelId: "llama",
                encodedModelId: "owner/desk/local/llama",
                capabilityOverrideMode: "INHERIT",
                capabilityOverrides: [],
                capabilityOverrideMetadata: null,
                optimisticBasicTranscription: false,
                probeSuggestions: null,
                lastSeenAt: new Date("2026-01-01T00:00:30Z"),
                published: true,
                unpublishedAt: null,
                maxAttachmentBytes: null,
                ExecutionTarget: executionTarget,
              },
            ],
          },
        ],
      },
    ]);

    const result = await client().listCliDevices();

    expect(result[0]?.endpoints[0]?.models[0]?.executionTarget).toEqual(executionTarget);
  });

  it("removes metadata only when the row belongs to the current user", async () => {
    // The owner-scoped precheck finds nothing for another user's device, so
    // no fence or lock is taken.
    db.cliDevice.findFirst.mockResolvedValue(null);
    fenceParentDelete.mockClear();

    await expect(client().removeCliDeviceMetadata({ id: "cli-id" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("NOT_FOUND");
        return true;
      },
    );
    expect(db.cliDevice.findFirst).toHaveBeenCalledWith({
      where: { id: "cli-id", userId: "user-id" },
      select: { lastHeartbeatAt: true },
    });
    expect(fenceParentDelete).not.toHaveBeenCalled();
    expect(db.cliDevice.delete).not.toHaveBeenCalled();
    expect(db.cliToken.updateMany).not.toHaveBeenCalled();
  });

  it("deletes a device with its credentials and closes their live relay sessions", async () => {
    db.poolMember.findMany.mockResolvedValue([]);
    db.cliDevice.findFirst.mockResolvedValue({ lastHeartbeatAt: null });
    fenceParentDelete.mockClear();
    db.cliDevice.updateMany.mockResolvedValue({ count: 1 });
    db.cliDevice.delete.mockResolvedValue({ id: "cli-id" });
    db.cliDeviceCredential.findMany.mockResolvedValue([{ id: "device-credential-1" }]);
    db.cliToken.findMany.mockResolvedValue([{ id: "cli-token-1" }]);
    db.cliToken.updateMany.mockResolvedValue({ count: 1 });
    const onCliCredentialsRevoked = vi.fn();
    const rpc = createRouterClient(forwarderManagementRouter, {
      context: { ...buildContext(), services: { onCliCredentialsRevoked } },
    });

    await expect(rpc.removeCliDeviceMetadata({ id: "cli-id" })).resolves.toEqual({
      deleted: true,
    });

    expect(db.cliToken.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cli-token-1"] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.cliDevice.delete).toHaveBeenCalledWith({
      where: { id: "cli-id" },
      select: { id: true },
    });
    expect(onCliCredentialsRevoked.mock.calls).toEqual([
      [{ kind: "deviceCredential", ids: ["device-credential-1"] }],
      [{ kind: "cliToken", ids: ["cli-token-1"] }],
    ]);
    // The parent-delete fences come first in the delete transaction (no
    // history drain).
    expect(fenceParentDelete).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-id",
      cliDeviceIds: ["cli-id"],
    });
    expect(fenceParentDelete.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      db.cliDevice.updateMany.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(db.cliDevice.updateMany.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      db.cliDevice.delete.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    // Sessions are closed only after the delete transaction committed.
    const deleteOrder = db.cliDevice.delete.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(onCliCredentialsRevoked.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
  });
});

describe("renameCliDevice", () => {
  function renameClient(userId = "user-id") {
    return createRouterClient(forwarderManagementRouter, {
      context: buildContext({ user: { id: userId } }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets a trimmed name on an owned device and returns its display name", async () => {
    db.cliDevice.findUnique.mockResolvedValue({ id: "cli-id", userId: "user-id" });
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      slug: "desk",
      name: "Work laptop",
      reportedHostname: "desk-01.local",
    });

    const result = await renameClient().renameCliDevice({
      cliDeviceId: "cli-id",
      name: "  Work laptop  ",
    });

    expect(db.cliDevice.update).toHaveBeenCalledWith({
      where: { id: "cli-id" },
      data: { name: "Work laptop" },
      select: { id: true, slug: true, name: true, reportedHostname: true },
    });
    expect(result).toEqual({
      cliDeviceId: "cli-id",
      name: "Work laptop",
      displayName: "Work laptop",
    });
  });

  it("clears the name with null so the hostname shows again", async () => {
    db.cliDevice.findUnique.mockResolvedValue({ id: "cli-id", userId: "user-id" });
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      slug: "desk",
      name: null,
      reportedHostname: "desk-01.local",
    });

    const result = await renameClient().renameCliDevice({ cliDeviceId: "cli-id", name: null });

    expect(db.cliDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: null } }),
    );
    expect(result.displayName).toBe("desk-01.local");
  });

  it("rejects blank, over-long, and invisible-character names before touching the database", async () => {
    for (const name of ["   ", "x".repeat(121), "desk\u0000", "desk\u202Epot", "desk\u200Bpot"]) {
      const error = await renameClient()
        .renameCliDevice({ cliDeviceId: "cli-id", name })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ORPCError);
      if (error instanceof ORPCError) expect(error.code).toBe("BAD_REQUEST");
    }
    expect(db.cliDevice.findUnique).not.toHaveBeenCalled();
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });

  it("uses the same not-found error for an unknown device and another user's device", async () => {
    db.cliDevice.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "cli-id", userId: "other-user" });
    const unknown = await renameClient()
      .renameCliDevice({ cliDeviceId: "missing", name: "Desk" })
      .catch((error: unknown) => error);
    const foreign = await renameClient()
      .renameCliDevice({ cliDeviceId: "cli-id", name: "Desk" })
      .catch((error: unknown) => error);
    for (const error of [unknown, foreign]) {
      expect(error).toBeInstanceOf(ORPCError);
      if (error instanceof ORPCError) expect(error.code).toBe("NOT_FOUND");
    }
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });
});

describe("setCliDeviceLabels", () => {
  function labelsClient(userId = "user-id") {
    return createRouterClient(forwarderManagementRouter, {
      context: buildContext({ user: { id: userId } }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves unique kebab-case labels on an owned device", async () => {
    db.cliDevice.findUnique.mockResolvedValue({ id: "cli-id", userId: "user-id" });
    db.cliDevice.update.mockResolvedValue({
      labels: ["dgx-spark", "unified-memory"],
      nodeInfo: { nodeKind: "unified", unifiedMemory: true, gpus: [{ index: 0, name: "GB10" }] },
      nodeMetrics: null,
      usableMemoryGb: null,
      usableRamGb: null,
      usableVramGb: null,
    });
    const result = await labelsClient().setCliDeviceLabels({
      cliDeviceId: "cli-id",
      labels: ["dgx-spark", "unified-memory"],
    });
    expect(db.cliDevice.update).toHaveBeenCalledWith({
      where: { id: "cli-id" },
      data: { labels: ["dgx-spark", "unified-memory"] },
      select: {
        labels: true,
        nodeInfo: true,
        nodeMetrics: true,
        usableMemoryGb: true,
        usableRamGb: true,
        usableVramGb: true,
      },
    });
    expect(result.labels).toEqual(["dgx-spark", "unified-memory"]);
    expect(result.node.suggestedLabels).toEqual(["dgx-spark", "unified-memory"]);
  });

  it("rejects negation, expressions, duplicates, and foreign devices", async () => {
    await expect(
      labelsClient().setCliDeviceLabels({
        cliDeviceId: "cli-id",
        labels: ["dgx-spark", "!low-power"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      labelsClient().setCliDeviceLabels({
        cliDeviceId: "cli-id",
        labels: ["unified-memory=true"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      labelsClient().setCliDeviceLabels({
        cliDeviceId: "cli-id",
        labels: ["dgx-spark", "dgx-spark"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.cliDevice.findUnique).not.toHaveBeenCalled();
    db.cliDevice.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "cli-id", userId: "other-user" });
    await expect(
      labelsClient().setCliDeviceLabels({ cliDeviceId: "missing", labels: ["dgx-spark"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      labelsClient().setCliDeviceLabels({ cliDeviceId: "cli-id", labels: ["dgx-spark"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });
});

describe("setCliDeviceUsableBudgets", () => {
  function budgetsClient(userId = "user-id") {
    return createRouterClient(forwarderManagementRouter, {
      context: buildContext({ user: { id: userId } }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["__proto__", "constructor", "toString", "GPU-aaa", "index:0"])(
    "writes accepted GPU key %s unchanged and returns its numeric override",
    async (key) => {
      const nodeInfo = {
        nodeKind: "discrete",
        memoryTotalMiB: 32768,
        gpus: [{ index: 0, ...(key === "index:0" ? {} : { uuid: key }), vramTotalMiB: 8192 }],
      };
      db.cliDevice.findUnique.mockResolvedValue({ id: "cli-id", userId: "user-id", nodeInfo });
      db.cliDevice.update.mockImplementation(async (args: { data: { usableVramGb: unknown } }) => ({
        labels: [],
        nodeInfo,
        nodeMetrics: null,
        usableVramGb: JSON.parse(JSON.stringify(args.data.usableVramGb)),
      }));
      const result = await budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableVramGb: Object.fromEntries([[key, 6.25]]),
      });
      const stored = JSON.parse(
        JSON.stringify(db.cliDevice.update.mock.calls[0]?.[0].data.usableVramGb),
      );
      expect(Object.hasOwn(stored, key)).toBe(true);
      expect(JSON.parse(JSON.stringify(stored))[key]).toBe(6.25);
      expect(result.node.gpus[0]?.usableVramGb).toBe(6.25);
      expect(result.node.gpus[0]?.usableVramGbDefault).toBe(false);
    },
  );

  it("stores a human-edited unified budget and per-GPU VRAM map", async () => {
    db.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      nodeInfo: {
        nodeKind: "discrete",
        memoryTotalMiB: 32 * 1024,
        gpus: [{ index: 0, uuid: "GPU-aaa", vramTotalMiB: 24 * 1024 }],
      },
    });
    db.cliDevice.update.mockResolvedValue({
      labels: [],
      nodeInfo: {
        nodeKind: "discrete",
        memoryTotalMiB: 32 * 1024,
        gpus: [{ index: 0, uuid: "GPU-aaa", vramTotalMiB: 24 * 1024 }],
      },
      nodeMetrics: null,
      usableMemoryGb: null,
      usableRamGb: 28,
      usableVramGb: { "GPU-aaa": 23.5 },
    });
    const result = await budgetsClient().setCliDeviceUsableBudgets({
      cliDeviceId: "cli-id",
      usableRamGb: 28,
      usableVramGb: { "GPU-aaa": 23.5 },
    });
    expect(db.cliDevice.update).toHaveBeenCalledWith({
      where: { id: "cli-id" },
      data: {
        usableRamGb: 28,
        usableVramGb: expect.objectContaining({ toJSON: expect.any(Function) }),
      },
      select: {
        labels: true,
        nodeInfo: true,
        nodeMetrics: true,
        usableMemoryGb: true,
        usableRamGb: true,
        usableVramGb: true,
      },
    });
    expect(result.node.usableRamGb).toBe(28);
    expect(JSON.parse(JSON.stringify(db.cliDevice.update.mock.calls[0]?.[0].data))).toEqual({
      usableRamGb: 28,
      usableVramGb: { "GPU-aaa": 23.5 },
    });
    expect(result.node.usableRamGbDefault).toBe(false);
    expect(result.node.gpus[0]?.usableVramGb).toBe(23.5);
  });

  it("clears a VRAM map back to defaults with null", async () => {
    db.cliDevice.findUnique.mockResolvedValue({ id: "cli-id", userId: "user-id" });
    db.cliDevice.update.mockResolvedValue({
      labels: [],
      nodeInfo: null,
      nodeMetrics: null,
      usableMemoryGb: null,
      usableRamGb: null,
      usableVramGb: null,
    });
    await budgetsClient().setCliDeviceUsableBudgets({
      cliDeviceId: "cli-id",
      usableVramGb: null,
    });
    expect(db.cliDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { usableVramGb: { kind: "DbNull" } },
      }),
    );
  });

  it("rejects an empty patch and a malformed VRAM key", async () => {
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({ cliDeviceId: "cli-id" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableVramGb: { "index:999": 8 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.cliDevice.findUnique).not.toHaveBeenCalled();
  });

  it("reports the exact offending GPU field and preserves fractional physical bounds", async () => {
    const nodeInfo = {
      nodeKind: "discrete",
      memoryTotalMiB: 32768,
      gpus: [
        { index: 0, uuid: "GPU.uuid:0", vramTotalMiB: 24575 },
        { index: 1, vramTotalMiB: 8192 },
      ],
    };
    db.cliDevice.findUnique.mockResolvedValue({ id: "cli-id", userId: "user-id", nodeInfo });
    const exact = 24575 / 1024;
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableVramGb: { "GPU.uuid:0": exact + 0.00001, "index:1": 8 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { fields: ["usableVramGb.GPU.uuid:0"] } });
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableVramGb: { "index:9": 1 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { fields: ["usableVramGb.index:9"] } });
    expect(db.cliDevice.update).not.toHaveBeenCalled();
    db.cliDevice.update.mockResolvedValue({
      labels: [],
      nodeInfo,
      nodeMetrics: null,
      usableVramGb: { "GPU.uuid:0": exact, "index:1": 0.125 },
    });
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableVramGb: { "GPU.uuid:0": exact, "index:1": 0.125 },
      }),
    ).resolves.toMatchObject({
      node: {
        gpus: [
          expect.objectContaining({ usableVramGb: exact }),
          expect.objectContaining({ usableVramGb: 0.125 }),
        ],
      },
    });
  });

  it("rejects over-physical, unknown GPU, and nodeKind-mismatched budgets", async () => {
    db.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "user-id",
      nodeInfo: {
        nodeKind: "discrete",
        memoryTotalMiB: 32 * 1024,
        gpus: [{ index: 0, uuid: "GPU-aaa", vramTotalMiB: 24 * 1024 }],
      },
    });
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({ cliDeviceId: "cli-id", usableRamGb: 64 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableVramGb: { "index:9": 8 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      budgetsClient().setCliDeviceUsableBudgets({
        cliDeviceId: "cli-id",
        usableMemoryGb: 16,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });
});

describe("setCliDeviceFeatureGrants", () => {
  function grantsClient(userId = "user-id", hook?: (cliDeviceId: string) => void) {
    return createRouterClient(forwarderManagementRouter, {
      context: {
        ...buildContext({ user: { id: userId } }),
        services: hook ? { onCliFeatureGrantsChanged: hook } : undefined,
      },
    });
  }

  function deviceRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "cli-id",
      userId: "user-id",
      reportedHumanTerminal: true,
      reportedMcpCommandMode: "UNSUPERVISED",
      reportedTerminalSupported: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      allowHumanTerminal: true,
      mcpCommandMode: "OFF",
    });
  });

  it.each([
    { reportedMcpFileRead: false, reportedFileRoots: true },
    { reportedMcpFileRead: null, reportedFileRoots: true },
    { reportedMcpFileRead: true, reportedFileRoots: false },
    { reportedMcpFileRead: true, reportedFileRoots: null },
    {},
  ])("read grant refuses incomplete reports %j", async (reported) => {
    db.cliDevice.findUnique.mockResolvedValue(deviceRow(reported));
    await expect(
      grantsClient().setCliDeviceFeatureGrants({ cliDeviceId: "cli-id", fileRead: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });

  it("read grant is a human-only opt-in; complete reports enable it and missing reports still allow revocation", async () => {
    const hook = vi.fn();
    db.cliDevice.findUnique.mockResolvedValue(
      deviceRow({ reportedMcpFileRead: true, reportedFileRoots: true }),
    );
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      allowHumanTerminal: false,
      mcpCommandMode: "OFF",
      mcpFileRead: true,
    });
    await expect(
      grantsClient("user-id", hook).setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        fileRead: true,
      }),
    ).resolves.toMatchObject({ fileRead: true });
    expect(db.cliDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mcpFileRead: true } }),
    );
    expect(hook).toHaveBeenCalledWith("cli-id");
    db.cliDevice.findUnique.mockResolvedValue(deviceRow());
    await grantsClient().setCliDeviceFeatureGrants({ cliDeviceId: "cli-id", fileRead: false });
    expect(db.cliDevice.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { mcpFileRead: false } }),
    );
    const humanOnly = createRouterClient(forwarderManagementRouter, { context: { session: null } });
    await expect(
      humanOnly.setCliDeviceFeatureGrants({ cliDeviceId: "cli-id", fileRead: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      grantsClient().setCliDeviceFeatureGrants({ cliDeviceId: "cli-id" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("uses the same not-found error for an unknown device and another user's device", async () => {
    db.cliDevice.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(deviceRow({ userId: "other-user" }));
    const unknown = grantsClient()
      .setCliDeviceFeatureGrants({ cliDeviceId: "missing", humanTerminal: false })
      .catch((error: ORPCError) => error);
    const foreign = grantsClient()
      .setCliDeviceFeatureGrants({ cliDeviceId: "cli-id", humanTerminal: false })
      .catch((error: ORPCError) => error);
    const [unknownError, foreignError] = await Promise.all([unknown, foreign]);
    expect(unknownError).toBeInstanceOf(ORPCError);
    expect(foreignError).toBeInstanceOf(ORPCError);
    if (!(unknownError instanceof ORPCError) || !(foreignError instanceof ORPCError)) return;
    expect(unknownError.code).toBe("NOT_FOUND");
    expect(foreignError.code).toBe("NOT_FOUND");
    expect(unknownError.message).toBe(foreignError.message);
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });

  it.each([
    { reportedHumanTerminal: false, reportedTerminalSupported: true },
    { reportedHumanTerminal: null, reportedTerminalSupported: true },
    { reportedHumanTerminal: true, reportedTerminalSupported: false },
    { reportedHumanTerminal: true, reportedTerminalSupported: null },
  ])("rejects enabling the browser terminal when the CLI reports %j", async (reported) => {
    db.cliDevice.findUnique.mockResolvedValue(deviceRow(reported));
    await expect(
      grantsClient().setCliDeviceFeatureGrants({ cliDeviceId: "cli-id", humanTerminal: true }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "BAD_REQUEST");
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });

  it.each([
    ["supervised", null],
    ["supervised", "OFF"],
    ["unsupervised", null],
    ["unsupervised", "OFF"],
    ["unsupervised", "SUPERVISED"],
  ] as const)("rejects mode %s when the CLI reports %s", async (mode, reported) => {
    db.cliDevice.findUnique.mockResolvedValue(deviceRow({ reportedMcpCommandMode: reported }));
    await expect(
      grantsClient().setCliDeviceFeatureGrants({ cliDeviceId: "cli-id", mcpCommandMode: mode }),
    ).rejects.toSatisfy(
      (error: ORPCError) => error.code === "BAD_REQUEST" && error.message.includes(mode),
    );
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });

  it("rejects the removed boolean mcpCommands input", async () => {
    db.cliDevice.findUnique.mockResolvedValue(deviceRow());
    await expect(
      grantsClient().setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        // @ts-expect-error the boolean grant was replaced by mcpCommandMode
        mcpCommands: true,
      }),
    ).rejects.toSatisfy((error: ORPCError) => error.code === "BAD_REQUEST");
    expect(db.cliDevice.update).not.toHaveBeenCalled();
  });

  it("sets a mode at or below the reported one and always allows off", async () => {
    const hook = vi.fn();
    db.cliDevice.findUnique.mockResolvedValue(deviceRow({ reportedMcpCommandMode: "SUPERVISED" }));
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      allowHumanTerminal: false,
      mcpCommandMode: "SUPERVISED",
    });
    await expect(
      grantsClient("user-id", hook).setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        mcpCommandMode: "supervised",
      }),
    ).resolves.toEqual({
      cliDeviceId: "cli-id",
      humanTerminal: false,
      mcpCommandMode: "supervised",
    });
    expect(db.cliDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mcpCommandMode: "SUPERVISED" } }),
    );

    db.cliDevice.findUnique.mockResolvedValue(deviceRow({ reportedMcpCommandMode: null }));
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      allowHumanTerminal: false,
      mcpCommandMode: "OFF",
    });
    await expect(
      grantsClient("user-id", hook).setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        mcpCommandMode: "off",
      }),
    ).resolves.toMatchObject({ mcpCommandMode: "off" });
    expect(db.cliDevice.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { mcpCommandMode: "OFF" } }),
    );
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("enables a reported terminal, allows disabling without a report, and fires the hook", async () => {
    const hook = vi.fn();
    db.cliDevice.findUnique.mockResolvedValue(deviceRow());
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      allowHumanTerminal: true,
      mcpCommandMode: "OFF",
    });
    await expect(
      grantsClient("user-id", hook).setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        humanTerminal: true,
        mcpCommandMode: "off",
      }),
    ).resolves.toEqual({
      cliDeviceId: "cli-id",
      humanTerminal: true,
      mcpCommandMode: "off",
    });
    expect(db.cliDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cli-id" },
        data: { allowHumanTerminal: true, mcpCommandMode: "OFF" },
      }),
    );
    expect(hook).toHaveBeenCalledWith("cli-id");

    db.cliDevice.findUnique.mockResolvedValue(
      deviceRow({
        reportedHumanTerminal: null,
        reportedMcpCommandMode: null,
        reportedTerminalSupported: null,
      }),
    );
    db.cliDevice.update.mockResolvedValue({
      id: "cli-id",
      allowHumanTerminal: false,
      mcpCommandMode: "OFF",
    });
    await expect(
      grantsClient("user-id", hook).setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        humanTerminal: false,
      }),
    ).resolves.toMatchObject({ humanTerminal: false });
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("does not fire the hook when enabling is rejected", async () => {
    const hook = vi.fn();
    db.cliDevice.findUnique.mockResolvedValue(deviceRow({ reportedMcpCommandMode: null }));
    await expect(
      grantsClient("user-id", hook).setCliDeviceFeatureGrants({
        cliDeviceId: "cli-id",
        mcpCommandMode: "supervised",
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "only invokes refresh after a successful commit (committed=%s)",
    async (committed) => {
      db.cliDevice.findUnique.mockResolvedValue(deviceRow());
      const hook = vi.fn(() => {
        throw new Error("refresh failed");
      });
      if (committed) {
        db.cliDevice.update.mockResolvedValue({
          id: "cli-id",
          allowHumanTerminal: false,
          mcpCommandMode: "OFF",
          mcpFileRead: false,
        });
      } else {
        db.cliDevice.update.mockRejectedValueOnce(new Error("commit failed"));
      }
      await expect(
        grantsClient("user-id", hook).setCliDeviceFeatureGrants({
          cliDeviceId: "cli-id",
          fileRead: false,
        }),
      ).rejects.toThrow(committed ? "refresh failed" : "commit failed");
      expect(db.cliDevice.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { mcpFileRead: false } }),
      );
      expect(hook).toHaveBeenCalledTimes(committed ? 1 : 0);
    },
  );

  it("summarizes granted reads using live consent only, and preserves the reported fields", async () => {
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        slug: "desk",
        mcpCommandMode: "OFF",
        mcpFileRead: true,
        reportedMcpFileRead: true,
        reportedFileRoots: true,
        User: { slug: "owner" },
        CliDeviceCredentials: [],
        Endpoints: [],
      },
    ]);
    const live = {
      protocolVersion: "2.9",
      cliVersion: "0.4.0",
      humanTerminal: false,
      mcpCommandMode: "off",
      supervisedCommands: true,
      terminalSupported: true,
      terminalApproval: false,
      fileOps: true,
      countContext: true,
      mcpFileRead: true,
      fileRootsConfigured: true,
      allowFileToolsAsRoot: false,
      terminalPublicKey: null,
    } as const;
    for (const snapshot of [
      live,
      { ...live, mcpFileRead: false },
      { ...live, fileRootsConfigured: false },
      null,
    ]) {
      const client = createRouterClient(forwarderManagementRouter, {
        context: {
          ...buildContext(),
          services: { getLiveCliFeatures: () => new Map(snapshot ? [["cli-id", snapshot]] : []) },
        },
      });
      const rows = await client.listCliDevices();
      expect(rows[0]?.fileTools).toEqual({
        read: snapshot?.mcpFileRead && snapshot.fileRootsConfigured ? "headless" : "off",
        write: "off",
      });
      expect(rows[0]).toMatchObject({
        mcpFileRead: true,
        reportedMcpFileRead: true,
        reportedFileRoots: true,
      });
    }
  });

  it("shows endpoints of disconnected or stale CLIs as OFFLINE and keeps the reported status", async () => {
    const endpoint = (id: string, status: string) => ({
      id,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      slug: id,
      label: id,
      kind: "OPENAI_COMPATIBLE",
      status,
      defaultCapabilities: [],
      capabilityMetadata: null,
      probeSuggestions: null,
      lastSeenAt: new Date("2026-01-01"),
      lastHealthCheckAt: null,
      statusChangedAt: null,
      failureReasonCode: null,
      published: true,
      unpublishedAt: null,
      DiscoveredModels: [],
    });
    const device = (id: string, status: string, heartbeatAgoMs: number | null) => ({
      id,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      slug: id,
      name: id,
      reportedHostname: null,
      status,
      lastHeartbeatAt: heartbeatAgoMs === null ? null : new Date(Date.now() - heartbeatAgoMs),
      User: { slug: "owner" },
      CliDeviceCredentials: [],
      Endpoints: [endpoint(`${id}-ep`, "ONLINE")],
    });
    db.cliDevice.findMany.mockResolvedValue([
      device("live", "CONNECTED", 1_000),
      device("gone", "DISCONNECTED", 1_000),
      device("stale", "CONNECTED", 5 * 60_000),
      device("never", "CONNECTED", null),
    ]);

    const result = await client().listCliDevices();

    expect(result.map((cli) => [cli.slug, cli.endpoints[0]?.status])).toEqual([
      ["live", "ONLINE"],
      ["gone", "OFFLINE"],
      ["stale", "OFFLINE"],
      ["never", "OFFLINE"],
    ]);
    expect(result.every((cli) => cli.endpoints[0]?.reportedStatus === "ONLINE")).toBe(true);
  });

  it("reports terminal and command features from the live snapshot and stored columns", async () => {
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        slug: "desk",
        name: "Desk",
        reportedHostname: "desk-01.local",
        status: "DISCONNECTED",
        allowHumanTerminal: true,
        mcpCommandMode: "UNSUPERVISED",
        cliVersion: "0.4.0",
        relayProtocolVersion: "2.9",
        reportedHumanTerminal: true,
        reportedMcpCommandMode: "SUPERVISED",
        reportedTerminalApproval: false,
        reportedTerminalSupported: true,
        reportedAllowFileToolsAsRoot: true,
        User: { slug: "owner" },
        CliDeviceCredentials: [],
        Endpoints: [],
      },
    ]);
    const offline = await createRouterClient(forwarderManagementRouter, {
      context: buildContext(),
    }).listCliDevices();
    expect(offline[0]?.features).toEqual({
      terminal: {
        granted: true,
        deviceAllows: true,
        supported: true,
        live: false,
        approvalRequired: false,
        available: false,
      },
      commands: {
        mode: "unsupervised",
        deviceMode: "supervised",
        supported: true,
        live: false,
        effectiveMode: "off",
        refusals: { headless: "offline", supervised: "offline" },
        available: false,
      },
    });
    expect(offline[0]?.displayName).toBe("Desk");
    expect(offline[0]?.cliVersion).toBe("0.4.0");
    // Offline: no file tool runs, and the root switch is the last reported value.
    expect(offline[0]?.fileTools).toEqual({ read: "off", write: "off" });
    expect(offline[0]?.allowFileToolsAsRoot).toBe(true);

    const liveClient = (
      mcpCommandMode: "off" | "supervised" | "unsupervised",
      terminalSupported = true,
      protocolVersion = "2.9",
      allowFileToolsAsRoot = false,
    ) =>
      createRouterClient(forwarderManagementRouter, {
        context: {
          ...buildContext(),
          services: {
            getLiveCliFeatures: () =>
              new Map([
                [
                  "cli-id",
                  {
                    protocolVersion,
                    cliVersion: "0.4.0",
                    humanTerminal: true,
                    mcpCommandMode,
                    supervisedCommands: true,
                    terminalSupported,
                    terminalApproval: false,
                    fileOps: protocolVersion === "2.9",
                    countContext: protocolVersion === "2.9",
                    mcpFileRead: false,
                    fileRootsConfigured: false,
                    allowFileToolsAsRoot,
                    terminalPublicKey: "key",
                  },
                ],
              ]),
          },
        },
      });
    const live = await liveClient("supervised").listCliDevices();
    expect(live[0]?.features.terminal).toMatchObject({ live: true, available: true });
    // Grant unsupervised, live CLI supervised: the lower one applies, and only
    // headless is refused (the relay's supervised_only, attributed to the CLI config).
    expect(live[0]?.features.commands).toMatchObject({
      live: true,
      effectiveMode: "supervised",
      refusals: { headless: "cli_supervised_only", supervised: null },
      available: true,
    });
    const liveOff = await liveClient("off").listCliDevices();
    expect(liveOff[0]?.features.commands).toMatchObject({
      live: true,
      effectiveMode: "off",
      refusals: { headless: "feature_disabled", supervised: "feature_disabled" },
      available: false,
    });
    const liveFull = await liveClient("unsupervised").listCliDevices();
    expect(liveFull[0]?.features.commands).toMatchObject({
      effectiveMode: "unsupervised",
      refusals: { headless: null, supervised: null },
      available: true,
    });
    // No PTY (Windows): supervised is refused although the mode allows it, and
    // headless still works on an unsupervised device.
    const noPty = await liveClient("unsupervised", false).listCliDevices();
    expect(noPty[0]?.features.commands).toMatchObject({
      effectiveMode: "unsupervised",
      refusals: { headless: null, supervised: "unsupported" },
      available: true,
    });
    // Hello refuses older CLIs, so a 2.3 session never becomes a live
    // snapshot. The serializer treats any provided snapshot as live.
    const oldClient = createRouterClient(forwarderManagementRouter, {
      context: {
        ...buildContext(),
        services: {
          getLiveCliFeatures: () =>
            new Map([
              [
                "cli-id",
                {
                  protocolVersion: "2.3",
                  cliVersion: "0.3.0",
                  humanTerminal: true,
                  mcpCommandMode: "unsupervised" as const,
                  supervisedCommands: true,
                  terminalSupported: true,
                  terminalApproval: false,
                  fileOps: false,
                  countContext: false,
                  mcpFileRead: false,
                  fileRootsConfigured: false,
                  allowFileToolsAsRoot: false,
                  terminalPublicKey: "key",
                },
              ],
            ]),
        },
      },
    });
    const preCommands = await oldClient.listCliDevices();
    expect(preCommands[0]?.features.commands).toMatchObject({
      live: true,
      effectiveMode: "unsupervised",
      refusals: { headless: null, supervised: null },
      available: true,
    });
    const [row] = await db.cliDevice.findMany();
    db.cliDevice.findMany.mockResolvedValue([{ ...row, mcpCommandMode: "SUPERVISED" }]);
    // A supervised-only device without a PTY cannot run anything: not available.
    const nothing = await liveClient("supervised", false).listCliDevices();
    expect(nothing[0]?.features.commands).toMatchObject({
      effectiveMode: "supervised",
      refusals: { headless: "grant_supervised_only", supervised: "unsupported" },
      available: false,
    });
    // The relay checks the grant first: a supervised grant refuses headless as
    // supervised_only whatever the CLI reports (attributed to the grant).
    const grantLimited = await liveClient("unsupervised").listCliDevices();
    expect(grantLimited[0]?.features.commands).toMatchObject({
      effectiveMode: "supervised",
      refusals: { headless: "grant_supervised_only", supervised: null },
    });

    // File tools follow the effective mode (lowest of grant, CLI config, live hello).
    expect(grantLimited[0]?.fileTools).toEqual({ read: "supervised", write: "supervised" });
    expect(liveOff[0]?.fileTools).toEqual({ read: "off", write: "off" });
    db.cliDevice.findMany.mockResolvedValue([{ ...row, mcpCommandMode: "UNSUPERVISED" }]);
    const liveUnsupervised = await liveClient("unsupervised", true, "2.9", true).listCliDevices();
    expect(liveUnsupervised[0]?.fileTools).toEqual({ read: "headless", write: "headless" });
    // The live root switch wins over the stored report.
    expect(liveUnsupervised[0]?.allowFileToolsAsRoot).toBe(true);
    expect((await liveClient("unsupervised").listCliDevices())[0]?.allowFileToolsAsRoot).toBe(
      false,
    );
    // A live CLI older than 2.9 runs no file tool.
    const legacy = await liveClient("unsupervised", true, "2.7").listCliDevices();
    expect(legacy[0]?.fileTools).toEqual({ read: "off", write: "off" });
  });

  it("grants no file tools when the dashboard grant is off, whatever the CLI reports", async () => {
    const liveRow = (overrides: Record<string, unknown>) => ({
      protocolVersion: "2.9",
      cliVersion: "0.5.0",
      humanTerminal: false,
      mcpCommandMode: "unsupervised" as const,
      supervisedCommands: true,
      terminalSupported: true,
      terminalApproval: false,
      fileOps: true,
      countContext: true,
      mcpFileRead: true,
      fileRootsConfigured: true,
      allowFileToolsAsRoot: false,
      terminalPublicKey: null,
      ...overrides,
    });
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        slug: "desk",
        name: null,
        reportedHostname: null,
        status: "CONNECTED",
        allowHumanTerminal: false,
        mcpCommandMode: "OFF",
        cliVersion: "0.5.0",
        relayProtocolVersion: "2.9",
        reportedHumanTerminal: false,
        reportedMcpCommandMode: "UNSUPERVISED",
        reportedTerminalApproval: false,
        reportedTerminalSupported: true,
        reportedAllowFileToolsAsRoot: null,
        User: { slug: "owner" },
        CliDeviceCredentials: [],
        Endpoints: [],
      },
    ]);
    // Dashboard grant off: no read tool whatever the live CLI switch reports.
    const devices = await createRouterClient(forwarderManagementRouter, {
      context: {
        ...buildContext(),
        services: {
          getLiveCliFeatures: () => new Map([["cli-id", liveRow({})]]),
        },
      },
    }).listCliDevices();
    expect(devices[0]?.fileTools).toEqual({ read: "off", write: "off" });
    expect(devices[0]?.allowFileToolsAsRoot).toBe(false);
  });

  it("withdraws the file-tool claim when the live current session does not report fileOps", async () => {
    // `listCliDevices.fileTools` requires `live.fileOps` in addition to the
    // grant, the CLI's read switch and its roots; a session that reports
    // fileOps false runs no file op and must be summarized as off.
    const liveRow = (overrides: Record<string, unknown>) => ({
      protocolVersion: "2.9",
      cliVersion: "0.5.0",
      humanTerminal: false,
      mcpCommandMode: "supervised" as const,
      supervisedCommands: true,
      terminalSupported: true,
      terminalApproval: false,
      fileOps: true,
      countContext: true,
      mcpFileRead: true,
      fileRootsConfigured: true,
      allowFileToolsAsRoot: false,
      terminalPublicKey: null,
      ...overrides,
    });
    const row = (mode: string) => ({
      id: "cli-id",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      slug: "desk",
      name: null,
      reportedHostname: null,
      status: "CONNECTED",
      allowHumanTerminal: false,
      mcpCommandMode: mode,
      cliVersion: "0.5.0",
      relayProtocolVersion: "2.9",
      reportedHumanTerminal: false,
      reportedMcpCommandMode: "UNSUPERVISED",
      reportedTerminalApproval: false,
      reportedTerminalSupported: true,
      reportedAllowFileToolsAsRoot: null,
      mcpFileRead: true,
      User: { slug: "owner" },
      CliDeviceCredentials: [],
      Endpoints: [],
    });
    const summaryFor = async (mode: string, features: Record<string, unknown>) => {
      db.cliDevice.findMany.mockResolvedValue([row(mode)]);
      const liveMode = mode === "SUPERVISED" ? "supervised" : "unsupervised";
      const devices = await createRouterClient(forwarderManagementRouter, {
        context: {
          ...buildContext(),
          services: {
            getLiveCliFeatures: () =>
              new Map([["cli-id", liveRow({ mcpCommandMode: liveMode, ...features })]]),
          },
        },
      }).listCliDevices();
      return devices[0]!.fileTools;
    };
    // Everything live: headless reads, supervised writes.
    expect(await summaryFor("SUPERVISED", {})).toEqual({ read: "headless", write: "supervised" });
    // fileOps:false withdraws the whole claim, even with every switch on.
    expect(await summaryFor("SUPERVISED", { fileOps: false })).toEqual({
      read: "off",
      write: "off",
    });
    // The CLI's own read switch off, or roots unset, drops the read grant back
    // to the mode matrix (a person must confirm).
    for (const withdrawn of [{ mcpFileRead: false }, { fileRootsConfigured: false }]) {
      expect(await summaryFor("SUPERVISED", withdrawn)).toEqual({
        read: "supervised",
        write: "supervised",
      });
    }
    // An unsupervised grant needs the same fileOps term for any claim.
    expect(await summaryFor("UNSUPERVISED", {})).toEqual({ read: "headless", write: "headless" });
    expect(await summaryFor("UNSUPERVISED", { fileOps: false })).toEqual({
      read: "off",
      write: "off",
    });
  });

  it("flags a device whose last hello was refused for an unsupported (older or newer) relay protocol", async () => {
    const rejectedAt = new Date("2026-09-28T10:00:00.000Z");
    const row = {
      id: "cli-id",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      slug: "desk",
      name: null,
      reportedHostname: null,
      status: "DISCONNECTED",
      allowHumanTerminal: false,
      mcpCommandMode: "OFF",
      cliVersion: "0.4.0",
      relayProtocolVersion: "2.9",
      reportedHumanTerminal: null,
      reportedMcpCommandMode: null,
      reportedTerminalApproval: null,
      reportedTerminalSupported: null,
      User: { slug: "owner" },
      CliDeviceCredentials: [],
      Endpoints: [],
    };
    db.cliDevice.findMany.mockResolvedValue([
      {
        ...row,
        rejectedRelayProtocolVersion: "2.3",
        rejectedCliVersion: "0.3.1",
        relayRejectedAt: rejectedAt,
      },
      { ...row, id: "cli-ok", relayRejectedAt: null },
      {
        ...row,
        id: "cli-newer",
        rejectedRelayProtocolVersion: nextRelayProtocol,
        rejectedCliVersion: "0.4.0",
        relayRejectedAt: rejectedAt,
      },
    ]);
    const devices = await createRouterClient(forwarderManagementRouter, {
      context: buildContext(),
    }).listCliDevices();
    expect(devices[0]?.upgradeRequired).toEqual({
      protocolVersion: "2.3",
      cliVersion: "0.3.1",
      rejectedAt,
      reason: "cli_too_old",
    });
    expect(devices[1]?.upgradeRequired).toBeNull();
    expect(devices[2]?.upgradeRequired).toMatchObject({
      protocolVersion: nextRelayProtocol,
      reason: "cli_too_new",
    });
  });
});

describe("MCP inventory summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function summaryDevice(
    id: string,
    createdAt: string,
    status: "CONNECTED" | "DISCONNECTED" = "CONNECTED",
  ) {
    return {
      id,
      createdAt: new Date(createdAt),
      slug: id,
      name: null,
      reportedHostname: `${id}.local`,
      status,
      lastHeartbeatAt: new Date("2026-01-02T00:00:30Z"),
      allowHumanTerminal: true,
      mcpCommandMode: "SUPERVISED",
      mcpFileRead: false,
      reportedHumanTerminal: true,
      reportedMcpCommandMode: "SUPERVISED",
      reportedMcpFileRead: false,
      reportedFileRoots: false,
      reportedTerminalApproval: true,
      reportedTerminalSupported: true,
      reportedAllowFileToolsAsRoot: false,
      Endpoints: [
        {
          id: `${id}-ep`,
          slug: "local",
          status: "ONLINE",
          failureReasonCode: "probe_failed",
          defaultCapabilities: ["TEXT_GENERATION"],
          capabilityMetadata: { chatCompletions: { supported: true } },
          probeSuggestions: { responses: { supported: false } },
          DiscoveredModels: [{ id: `${id}-model`, upstreamModelId: "llama" }],
        },
      ],
    };
  }

  it("pages device summaries without models or capability JSON", async () => {
    db.cliDevice.findMany.mockResolvedValue([
      summaryDevice("cli-new", "2026-01-02T00:00:00Z"),
      summaryDevice("cli-old", "2026-01-01T00:00:00Z", "DISCONNECTED"),
    ]);

    const page = await client().listCliDeviceSummaries({ limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "cli-new",
      slug: "cli-new",
      displayName: "cli-new.local",
      status: "CONNECTED",
      grants: { humanTerminal: true, mcpCommandMode: "supervised", fileRead: false },
      endpoints: [
        {
          id: "cli-new-ep",
          slug: "local",
          status: "OFFLINE",
          reportedStatus: "ONLINE",
          failureReasonCode: "probe_failed",
        },
      ],
    });
    expect(page.items[0]).not.toHaveProperty("models");
    expect(page.items[0]?.endpoints[0]).not.toHaveProperty("models");
    expect(page.items[0]?.endpoints[0]).not.toHaveProperty("defaultCapabilities");
    expect(page.items[0]?.endpoints[0]).not.toHaveProperty("capabilityMetadata");
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("llama");
    expect(serialized).not.toContain("TEXT_GENERATION");
    expect(serialized).not.toContain("chatCompletions");
    expect(page.nextCursor).toBe(`${new Date("2026-01-02T00:00:00Z").getTime()}.cli-new`);
    const query = db.cliDevice.findMany.mock.calls[0]?.[0];
    expect(query?.take).toBe(2);
    expect(query?.select?.Endpoints?.select).not.toHaveProperty("DiscoveredModels");
    expect(query?.select?.Endpoints?.select).not.toHaveProperty("defaultCapabilities");
    expect(query?.select?.Endpoints?.select).not.toHaveProperty("capabilityMetadata");
    expect(query?.select?.Endpoints?.select).not.toHaveProperty("probeSuggestions");
  });

  it("rejects an invalid summary cursor before querying", async () => {
    await expect(client().listCliDeviceSummaries({ cursor: "not-a-cursor" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("BAD_REQUEST");
        return true;
      },
    );
    expect(db.cliDevice.findMany).not.toHaveBeenCalled();
    expect(db.modelPool.findMany).not.toHaveBeenCalled();
  });

  it("returns one full CLI device and hides devices owned by someone else", async () => {
    const owned = {
      ...summaryDevice("cli-id", "2026-01-01T00:00:00Z"),
      userId: "user-id",
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      connectionCount: 1,
      User: { slug: "owner" },
      CliDeviceCredentials: [],
      Endpoints: [
        {
          id: "endpoint-id",
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-02"),
          slug: "local",
          label: "Local",
          kind: "OPENAI_COMPATIBLE",
          status: "ONLINE",
          defaultCapabilities: ["TEXT_GENERATION"],
          capabilityMetadata: null,
          probeSuggestions: null,
          lastSeenAt: null,
          lastHealthCheckAt: null,
          statusChangedAt: null,
          failureReasonCode: null,
          published: true,
          unpublishedAt: null,
          DiscoveredModels: [
            {
              id: "model-id",
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-02"),
              slug: null,
              upstreamModelId: "llama",
              encodedModelId: "owner/cli-id/local/llama",
              capabilityOverrideMode: "INHERIT",
              capabilityOverrides: [],
              capabilityOverrideMetadata: null,
              optimisticBasicTranscription: false,
              probeSuggestions: null,
              lastSeenAt: null,
              published: true,
              unpublishedAt: null,
              maxAttachmentBytes: null,
              ExecutionTarget: null,
            },
          ],
        },
      ],
    };
    db.cliDevice.findUnique.mockResolvedValueOnce(owned);
    const result = await client().getCliDevice({ cliDeviceId: "cli-id" });
    expect(result.endpoints[0]?.models[0]?.upstreamModelId).toBe("llama");
    expect(result.endpoints[0]?.models[0]?.canonicalModelId).toBe("owner/cli-id/local/llama");

    db.cliDevice.findUnique.mockResolvedValueOnce({ ...owned, userId: "other-user" });
    await expect(client().getCliDevice({ cliDeviceId: "cli-id" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("NOT_FOUND");
        return true;
      },
    );
  });
});

describe("getCliDeviceMetrics", () => {
  const storedMetrics = { ts: "2026-09-28T11:00:00.000Z", cpu: { usagePercent: 5 } };
  const deviceMetricsRow = {
    id: "cli-id",
    userId: "user-id",
    slug: "desk",
    status: "CONNECTED",
    nodeInfo: { nodeKind: "unified" },
    nodeInfoAt: new Date("2026-09-28T10:00:00.000Z"),
    nodeMetrics: storedMetrics,
    nodeMetricsAt: new Date("2026-09-28T11:00:00.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.$queryRaw.mockResolvedValue([]);
  });

  function metricsClient(services?: Record<string, unknown>) {
    return createRouterClient(forwarderManagementRouter, {
      context: { ...buildContext(), ...(services ? { services } : {}) },
    });
  }

  it("prefers the live relay sample and lists live endpoint load", async () => {
    db.cliDevice.findUnique.mockResolvedValue(deviceMetricsRow);
    const receivedAt = new Date("2026-09-28T11:00:30.000Z");
    const load = {
      endpointSlug: "vllm",
      modelSlug: null,
      running: 3,
      waiting: 1,
      source: "vllm-metrics" as const,
      ts: "2026-09-28T11:00:29.000Z",
      receivedAt,
    };
    const result = await metricsClient({
      getLiveNodeTelemetry: (ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              nodeMetrics: { ts: "2026-09-28T11:00:30.000Z" },
              nodeMetricsReceivedAt: receivedAt,
              endpointLoad: [load],
            },
          ]),
        ),
    }).getCliDeviceMetrics({ cliDeviceId: "cli-id" });
    expect(result).toMatchObject({
      live: true,
      nodeInfo: { nodeKind: "unified" },
      nodeMetrics: { ts: "2026-09-28T11:00:30.000Z" },
      nodeMetricsAt: receivedAt,
      nodeMetricsSource: "live",
      endpointLoad: [load],
    });
  });

  it("falls back to the stored snapshot while the CLI is offline", async () => {
    db.cliDevice.findUnique.mockResolvedValue(deviceMetricsRow);
    const result = await metricsClient().getCliDeviceMetrics({ cliDeviceId: "cli-id" });
    expect(result).toMatchObject({
      live: false,
      nodeMetrics: storedMetrics,
      nodeMetricsSource: "stored",
      endpointLoad: [],
    });
  });

  it("hides another user's device", async () => {
    db.cliDevice.findUnique.mockResolvedValue({ ...deviceMetricsRow, userId: "someone-else" });
    await expect(
      metricsClient().getCliDeviceMetrics({ cliDeviceId: "cli-id" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("propagates history DB failures rather than claiming an empty history", async () => {
    db.cliDevice.findUnique.mockResolvedValue(deviceMetricsRow);
    db.$queryRaw.mockRejectedValueOnce(new Error("history DB unavailable"));
    await expect(metricsClient().getCliDeviceMetrics({ cliDeviceId: "cli-id" })).rejects.toThrow(
      "history DB unavailable",
    );
  });

  it("includes a node snapshot, labels, and last-hour minute history", async () => {
    db.cliDevice.findUnique.mockResolvedValue({
      ...deviceMetricsRow,
      labels: ["dgx-spark"],
      usableMemoryGb: 120,
      nodeInfo: {
        nodeKind: "unified",
        unifiedMemory: true,
        memoryTotalMiB: 128 * 1024,
        gpus: [{ index: 0, name: "NVIDIA GB10", uuid: "GPU-1" }],
      },
    });
    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    db.$queryRaw.mockResolvedValue([
      {
        bucketStart,
        samples: 2,
        cpuSamples: 2,
        minCpuPercent: 10,
        sumCpuPercent: 30,
        maxCpuPercent: 20,
        memorySamples: 2,
        minMemoryAvailableMiB: 1000,
        sumMemoryAvailableMiB: 4000,
        maxMemoryAvailableMiB: 3000,
        minMemoryUsedPercent: 40,
        sumMemoryUsedPercent: 100,
        maxMemoryUsedPercent: 60,
        maxGpuTemperatureC: 55,
        maxGpuUtilizationPercent: 20,
      },
    ]);
    const result = await metricsClient().getCliDeviceMetrics({ cliDeviceId: "cli-id" });
    expect(result.labels).toEqual(["dgx-spark"]);
    expect(result.node.kind).toBe("unified");
    expect(result.node.usableMemoryGb).toBe(120);
    expect(result.node.usableMemoryGbDefault).toBe(false);
    expect(result.node.suggestedLabels).toEqual(["dgx-spark", "unified-memory"]);
    expect(result.minuteHistory).toEqual([
      expect.objectContaining({
        start: bucketStart.toISOString(),
        avgCpuPercent: 15,
        avgMemoryAvailableMiB: 2000,
        gap: false,
      }),
    ]);
    expect(result.history24h).toHaveLength(96);
    expect(result.history7d).toHaveLength(168);
    expect(result.history24h.some((point) => !point.gap && point.avgCpuPercent === 15)).toBe(true);
    expect(result.history7d.some((point) => !point.gap && point.avgCpuPercent === 15)).toBe(true);
  });
});

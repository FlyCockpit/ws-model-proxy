import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));

import prisma from "@ws-model-proxy/db";
import {
  applyDeploymentPlan,
  createDeploymentPlan,
  deploymentExecutionAllowed,
} from "./deployment-service";
import { deploymentSpecSchema } from "./deployment-spec";

const db = vi.mocked(prisma);
const person = { userId: "owner", id: "owner", kind: "USER" as const };
const spec = deploymentSpecSchema.parse({
  variants: [
    {
      key: "one",
      labels: [],
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 100 }],
      commands: [
        {
          management: "ownedProcess",
          start: "serve --port {{port}}",
          stop: "stop --port {{port}}",
        },
      ],
      readiness: {},
      models: ["model"],
      attachment: { type: "llm", poolId: "pool" },
      hardConcurrencyLimit: 1,
    },
  ],
});
const rawNode = {
  id: "node",
  userId: "owner",
  status: "CONNECTED",
  relayProtocolVersion: "2.10",
  allowDeployments: true,
  reportedDeployments: true,
  mcpCommandMode: "UNSUPERVISED",
  reportedMcpCommandMode: "UNSUPERVISED",
  nodeInfo: {
    nodeKind: "unified",
    memoryTotalMiB: 128 * 1024,
    executionMechanism: "systemd+linger",
  },
  labels: [],
  usableMemoryGb: 124,
  usableRamGb: null,
  usableVramGb: null,
  deploymentPortStart: 30000,
  deploymentPortEnd: 30999,
};
function resolveMock<T>(method: unknown, value: T) {
  (method as ReturnType<typeof vi.fn>).mockResolvedValue(value);
}
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (work) => {
    if (typeof work !== "function") throw new Error("Interactive transaction required");
    return work(db);
  });
  resolveMock(db.cliDevice.findMany, [rawNode]);
  resolveMock(db.user.findUnique, { banned: false, banExpires: null, deletionRequestedAt: null });
  resolveMock(db.deploymentInstance.findMany, []);
  resolveMock(db.executionTarget.findMany, []);
  resolveMock(db.deploymentConfigRevision.findFirst, {
    id: "revision",
    configId: "config",
    revision: 2,
    editorKind: "USER",
    spec,
    Config: { slug: "recipe", poolId: "pool" },
  });
  // No earlier revision was saved by an agent.
  resolveMock(db.deploymentConfigRevision.findMany, []);
  // Fence acquisition and the pool's FOR KEY SHARE row lock.
  db.$queryRaw.mockResolvedValue([{ id: "pool" }] as never);
  resolveMock(db.deploymentPlan.create, { id: "plan" });
  resolveMock(db.deploymentRun.create, { id: "run" });
  db.deploymentInstance.create.mockImplementation(
    async (args) => ({ ...args.data, id: args.data.id }) as never,
  );
});
describe("deployment durable API boundary", () => {
  it("asks a person to review a start whose commands an agent saved in an earlier revision", async () => {
    resolveMock(db.deploymentConfigRevision.findMany, [{ spec }]);
    await createDeploymentPlan(person, {
      start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
    });
    const created = db.deploymentPlan.create.mock.calls.at(-1)?.[0];
    expect(created?.data).toMatchObject({
      state: "AWAITING_CONFIRMATION",
      contents: { requiresConfirmation: true, warnings: ["agent_edited_revision"] },
    });
    expect(db.deploymentConfigRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { configId: "config", editorKind: "AGENT", revision: { lt: 2 } },
      }),
    );
  });
  it.each(["2.9", "2.11", "3.0", "2.10.0"])(
    "refuses execution on incompatible protocol %s",
    async (version) => {
      resolveMock(db.deploymentPlan.findFirst, {
        contents: { affectedNodeIds: ["node"] },
        requesterKind: "USER",
      });
      resolveMock(db.cliDevice.findMany, [{ ...rawNode, relayProtocolVersion: version }]);
      expect(await deploymentExecutionAllowed(db, "owner", "instance", "run")).toBe(false);
      expect(db.deploymentInstanceNode.findMany).not.toHaveBeenCalled();
    },
  );
  it("permits exact current-version execution without weakening owner and hardware checks", async () => {
    resolveMock(db.deploymentPlan.findFirst, {
      contents: { affectedNodeIds: ["node"] },
      requesterKind: "USER",
    });
    resolveMock(db.deploymentInstanceNode.findMany, [
      {
        cliDeviceId: "node",
        resources: { kind: "unified", memoryGb: 100, ramGb: 0, gpus: [] },
        port: 30000,
        distPort: null,
      },
    ]);
    expect(await deploymentExecutionAllowed(db, "owner", "instance", "run")).toBe(true);
    resolveMock(db.user.findUnique, { banned: true, banExpires: null, deletionRequestedAt: null });
    expect(await deploymentExecutionAllowed(db, "owner", "instance", "run")).toBe(false);
  });
  it("refuses banned or deletion-marked owners before planning or reserving resources", async () => {
    resolveMock(db.user.findUnique, { banned: true, banExpires: null, deletionRequestedAt: null });
    await expect(
      createDeploymentPlan(person, {
        start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(applyDeploymentPlan(person, "plan", false)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.deploymentRun.create).not.toHaveBeenCalled();
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();
  });
  it("scopes revision reads and fleet queries to owner before creating a plan", async () => {
    await createDeploymentPlan(person, {
      start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
    });
    expect(db.deploymentConfigRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "revision", Config: { userId: "owner" } } }),
    );
    expect(db.cliDevice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner" } }),
    );
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.deploymentPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "owner", state: "PENDING" }),
      }),
    );
  });
  it("refuses a revision outside the owner account", async () => {
    resolveMock(db.deploymentConfigRevision.findFirst, null);
    await expect(
      createDeploymentPlan(person, {
        start: { revisionId: "foreign", variantKey: "one", groupCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();
  });
  it("persists claims and idempotent job intents before application completes", async () => {
    const plan = await createDeploymentPlan(person, {
      start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
    });
    const recorded = db.deploymentPlan.create.mock.calls[0]?.[0].data;
    if (!recorded) throw new Error("Expected a persisted plan");
    resolveMock(db.deploymentPlan.findFirst, {
      id: "plan",
      userId: "owner",
      requesterId: "owner",
      requesterKind: "USER",
      state: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
      fingerprint: recorded.fingerprint,
      contents: plan.contents,
    });
    await applyDeploymentPlan(person, "plan", false);
    expect(db.deploymentInstanceNode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cliDeviceId: "node", port: 30000, blockedBy: [] }),
      }),
    );
    const intents = db.deploymentStep.create.mock.calls.map((c) => c[0].data);
    expect(intents).toHaveLength(2);
    expect(intents[0]).toMatchObject({
      phase: "start",
      sequence: 0,
      intent: { command: "serve --port 30000", stopCommand: "stop --port 30000" },
    });
    expect(intents[1]).toMatchObject({ phase: "readiness", sequence: 3 });
    expect(db.deploymentPlan.update).toHaveBeenCalledWith({
      where: { id: "plan" },
      data: { state: "APPLIED" },
    });
  });
  it.each([
    ["the recipe's pool was deleted", { slug: "recipe", poolId: null }, [{ id: "pool" }]],
    ["the revision targets another pool", { slug: "recipe", poolId: "other" }, [{ id: "other" }]],
    ["the pool row is gone under its lock", { slug: "recipe", poolId: "pool" }, []],
  ])("refuses to plan when %s", async (_case, config, poolRows) => {
    resolveMock(db.deploymentConfigRevision.findFirst, {
      id: "revision",
      configId: "config",
      spec,
      Config: config,
    });
    db.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) =>
      sql.join("?").includes("FOR KEY SHARE") ? poolRows : []) as never);
    await expect(
      createDeploymentPlan(person, {
        start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();
  });
  it("refuses an undeliverable rendered job while planning and again at admission", async () => {
    // Every command fits the CLI's byte limit, but JSON escaping makes the job frame too large.
    const quoted = '"'.repeat(4096);
    const huge = deploymentSpecSchema.parse({
      variants: [
        {
          ...spec.variants[0],
          commands: [
            {
              management: "ownedProcess",
              start: quoted,
              stop: quoted,
              status: quoted,
              health: quoted,
            },
          ],
          models: Array.from({ length: 64 }, (_, i) => `${i}${'"'.repeat(250)}`),
        },
      ],
    });
    const revision = (value: typeof spec) =>
      resolveMock(db.deploymentConfigRevision.findFirst, {
        id: "revision",
        configId: "config",
        spec: value,
        Config: { slug: "recipe", poolId: "pool" },
      });
    revision(huge);
    await expect(
      createDeploymentPlan(person, {
        start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();

    // Admission re-renders and refuses before any instance, claim or step write.
    revision(spec);
    const plan = await createDeploymentPlan(person, {
      start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
    });
    const recorded = db.deploymentPlan.create.mock.calls[0]?.[0].data;
    if (!recorded) throw new Error("Expected a persisted plan");
    resolveMock(db.deploymentPlan.findFirst, {
      id: "plan",
      userId: "owner",
      requesterId: "owner",
      requesterKind: "USER",
      state: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
      fingerprint: recorded.fingerprint,
      contents: plan.contents,
    });
    revision(huge);
    await expect(applyDeploymentPlan(person, "plan", false)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.deploymentInstance.create).not.toHaveBeenCalled();
    expect(db.deploymentInstanceNode.create).not.toHaveBeenCalled();
    expect(db.deploymentStep.create).not.toHaveBeenCalled();
    expect(db.deploymentPlan.update).not.toHaveBeenCalled();
  });
  it("stale fingerprint refuses claims and jobs", async () => {
    resolveMock(db.deploymentPlan.findFirst, {
      id: "plan",
      requesterId: "owner",
      requesterKind: "USER",
      state: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
      fingerprint: "stale",
      contents: {
        action: "stop",
        stopInstanceId: "old",
        affectedNodeIds: ["node"],
        stopIds: ["old"],
        placements: [],
        effectiveMode: "UNSUPERVISED",
        requiresConfirmation: true,
        headAddr: "",
        warnings: [],
      },
    });
    await expect(applyDeploymentPlan(person, "plan", true)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.deploymentInstanceNode.create).not.toHaveBeenCalled();
    expect(db.deploymentStep.create).not.toHaveBeenCalled();
  });
  it("agent cannot confirm its own plan", async () => {
    resolveMock(db.deploymentPlan.findFirst, {
      id: "plan",
      requesterId: "token",
      requesterKind: "AGENT",
      state: "AWAITING_CONFIRMATION",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      applyDeploymentPlan({ ...person, id: "token", kind: "AGENT" }, "plan", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.deploymentRun.create).not.toHaveBeenCalled();
  });
});

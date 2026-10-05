import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
// The real check by default; one test lifts the "not supported yet" refusal to inspect intents.
vi.mock("./deployment-spec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deployment-spec")>();
  return {
    ...actual,
    variantHasInteractiveCommands: vi.fn(actual.variantHasInteractiveCommands),
  };
});

import prisma from "@ws-model-proxy/db";
import {
  applyDeploymentPlan,
  createDeploymentPlan,
  deploymentExecutionAllowed,
} from "./deployment-service";
import {
  deploymentSpecSchema,
  storedDeploymentSpecSchema,
  variantHasInteractiveCommands,
} from "./deployment-spec";

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
  relayProtocolVersion: "2.11",
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
  it.each(["2.9", "2.10", "2.12", "3.0", "2.11.0"])(
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
  it("refuses to plan a stored recipe whose slug renders an endpoint the node refuses", async () => {
    // Saved before the slug rule: `inst-qwen--…` fails the CLI's forwarder-slug check.
    for (const slug of ["qwen-", "qw--en"]) {
      resolveMock(db.deploymentConfigRevision.findFirst, {
        id: "revision",
        configId: "config",
        revision: 2,
        editorKind: "USER",
        spec,
        Config: { slug, poolId: "pool" },
      });
      await expect(
        createDeploymentPlan(person, {
          start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Rename the recipe while none of its deployments"),
        data: { reason: "invalid_recipe_slug" },
      });
    }
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();
  });
  it.each([
    ["a readiness fragment", { readiness: { path: "/health#ready" } }],
    ["a protocol-relative readiness path", { readiness: { path: "//health" } }],
    ["a readiness path over 2048 bytes", { readiness: { path: `/${"é".repeat(1024)}` } }],
    ["a model id over 256 bytes", { models: [`${"é".repeat(128)}a`] }],
  ])("refuses to start a stored revision with %s, which still loads", async (_case, change) => {
    const stored = { variants: [{ ...spec.variants[0], ...change }] };
    // Readable for existing instances and authorship checks, never startable.
    expect(storedDeploymentSpecSchema.safeParse(stored).success).toBe(true);
    expect(deploymentSpecSchema.safeParse(stored).success).toBe(false);
    resolveMock(db.deploymentConfigRevision.findFirst, {
      id: "revision",
      configId: "config",
      revision: 2,
      editorKind: "USER",
      spec: stored,
      Config: { slug: "recipe", poolId: "pool" },
    });
    await expect(
      createDeploymentPlan(person, {
        start: { revisionId: "revision", variantKey: "one", groupCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();
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

describe("interactive recipe commands before operator terminals exist", () => {
  const interactiveCommands = {
    management: "externalService",
    start: "start --port {{port}}",
    stop: "stop --port {{port}}",
    status: "status --port {{port}}",
    interactive: { start: true, stop: true },
  } as const;
  const interactiveSpec = (commands: Record<string, unknown>[], extra = {}) =>
    deploymentSpecSchema.parse({
      variants: [{ ...spec.variants[0], ...extra, commands }],
    });
  const revision = (value: unknown, editorKind = "USER") =>
    resolveMock(db.deploymentConfigRevision.findFirst, {
      id: "revision",
      configId: "config",
      revision: 2,
      editorKind,
      spec: value,
      Config: { slug: "recipe", poolId: "pool" },
    });
  const start = { start: { revisionId: "revision", variantKey: "one", groupCount: 1 } };
  async function applyPlan() {
    const plan = await createDeploymentPlan(person, start);
    const recorded = db.deploymentPlan.create.mock.calls.at(-1)?.[0].data;
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
    return db.deploymentStep.create.mock.calls.map((c) => c[0].data);
  }

  it.each([
    ["start", { start: true }],
    ["stop", { stop: true }],
  ])("refuses to plan a start whose %s is interactive", async (_field, interactive) => {
    revision(interactiveSpec([{ ...interactiveCommands, interactive }]));
    await expect(createDeploymentPlan(person, start)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Interactive recipe commands are not supported yet",
    });
    expect(db.deploymentPlan.create).not.toHaveBeenCalled();
  });
  it("refuses at admission too, if a plan reaches it for an interactive revision", async () => {
    const plan = await createDeploymentPlan(person, start);
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
    revision(interactiveSpec([interactiveCommands]));
    await expect(applyDeploymentPlan(person, "plan", false)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.deploymentInstance.create).not.toHaveBeenCalled();
    expect(db.deploymentStep.create).not.toHaveBeenCalled();
  });
  it("persists automatic intents without any interactive field", async () => {
    for (const intent of (await applyPlan()).map((step) => step.intent)) {
      expect(intent).not.toHaveProperty("interactive");
      expect(intent).not.toHaveProperty("stopInteractive");
    }
  });
  it("sets the flags from the rank's interactive commands per phase", async () => {
    vi.mocked(variantHasInteractiveCommands).mockReturnValue(false);
    revision(interactiveSpec([interactiveCommands]));
    const steps = await applyPlan();
    expect(steps.map((step) => [step.phase, step.intent])).toEqual([
      ["start", expect.objectContaining({ interactive: true, stopInteractive: true })],
      ["readiness", expect.objectContaining({ stopInteractive: true })],
    ]);
    expect(steps[1]?.intent).not.toHaveProperty("interactive");
  });
  it("marks a multi-node head's prepare and afterJoin phases from their own flags", async () => {
    vi.mocked(variantHasInteractiveCommands).mockReturnValue(false);
    const node = (id: string, address: string) => ({
      ...rawNode,
      id,
      nodeInfo: {
        ...rawNode.nodeInfo,
        interfaces: [{ name: "eth0", addresses: [address] }],
      },
    });
    resolveMock(db.cliDevice.findMany, [node("head", "10.0.0.1"), node("worker", "10.0.0.2")]);
    revision(
      interactiveSpec(
        [
          {
            ...interactiveCommands,
            prepare: "prepare",
            afterJoin: "after-join",
            // `start` is flagged too: the head's start phase must still follow afterJoin.
            interactive: { prepare: true, start: true },
          },
          { ...interactiveCommands, interactive: { start: true } },
        ],
        {
          groupSize: 2,
          iface: "eth0",
          resources: [{ kind: "unified", memoryGb: 100 }],
        },
      ),
    );
    const steps = await applyPlan();
    const byPhase = Object.fromEntries(
      steps.map((step) => [`${step.rank}:${step.phase}`, step.intent]),
    );
    expect(byPhase["0:prepare"]).toMatchObject({ interactive: true });
    // The head's start phase runs afterJoin, which is automatic here although `start` is not.
    expect(byPhase["0:start"]).toMatchObject({ command: "after-join" });
    expect(byPhase["0:start"]).not.toHaveProperty("interactive");
    expect(byPhase["1:start"]).toMatchObject({ interactive: true });
    for (const intent of Object.values(byPhase))
      expect(intent).not.toHaveProperty("stopInteractive");
  });
  it("marks a multi-node head's start phase interactive when its afterJoin is", async () => {
    vi.mocked(variantHasInteractiveCommands).mockReturnValue(false);
    const node = (id: string, address: string) => ({
      ...rawNode,
      id,
      nodeInfo: {
        ...rawNode.nodeInfo,
        interfaces: [{ name: "eth0", addresses: [address] }],
      },
    });
    resolveMock(db.cliDevice.findMany, [node("head", "10.0.0.1"), node("worker", "10.0.0.2")]);
    revision(
      interactiveSpec(
        [
          { ...interactiveCommands, afterJoin: "after-join", interactive: { afterJoin: true } },
          interactiveCommands,
        ],
        { groupSize: 2, iface: "eth0", resources: [{ kind: "unified", memoryGb: 100 }] },
      ),
    );
    const steps = await applyPlan();
    const headStart = steps.find((step) => step.rank === 0 && step.phase === "start")?.intent;
    expect(headStart).toMatchObject({ command: "after-join", interactive: true });
  });
  it("saving is not refused: the strict recipe schema accepts interactive commands", () => {
    expect(() => interactiveSpec([interactiveCommands])).not.toThrow();
  });
  it.each([
    [
      "an agent flipped a person's interactive stop to automatic, then the person saved",
      false,
      false,
    ],
    ["a person flipped an agent's interactive stop to automatic", true, false],
    ["a person flipped an agent's automatic stop to interactive", false, true],
  ])("flags agent authorship when %s", async (_case, agentInteractive, currentInteractive) => {
    vi.mocked(variantHasInteractiveCommands).mockReturnValue(false);
    const commands = (interactive: boolean) => [
      { ...interactiveCommands, interactive: interactive ? { stop: true } : {} },
    ];
    // The current revision is the person's; the agent's earlier one holds the same text.
    revision(interactiveSpec(commands(currentInteractive)));
    resolveMock(db.deploymentConfigRevision.findMany, [
      { spec: interactiveSpec(commands(agentInteractive)) },
    ]);
    await createDeploymentPlan(person, start);
    expect(db.deploymentPlan.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      state: "AWAITING_CONFIRMATION",
      contents: { warnings: ["agent_edited_revision"] },
    });
  });
  it("flags the agent's own flip when it is the revision being started", async () => {
    vi.mocked(variantHasInteractiveCommands).mockReturnValue(false);
    revision(interactiveSpec([{ ...interactiveCommands, interactive: {} }]), "AGENT");
    await createDeploymentPlan(person, start);
    expect(db.deploymentPlan.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      contents: { warnings: ["agent_edited_revision"] },
    });
  });
  it("a person's revision no agent touched needs no review", async () => {
    vi.mocked(variantHasInteractiveCommands).mockReturnValue(false);
    revision(interactiveSpec([interactiveCommands]));
    await createDeploymentPlan(person, start);
    expect(db.deploymentPlan.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      contents: { warnings: [] },
    });
  });
});

import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContext, db as forwarderDb } from "./forwarder-test-helpers";

const { deploymentsRouter } = await import("./deployments");

type Mocked = Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};
const db = forwarderDb as unknown as Mocked;
const spec = {
  variants: [
    {
      key: "one",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 10 }],
      commands: [{ management: "ownedProcess", start: "serve", stop: "stop" }],
      readiness: {},
      models: ["model"],
      attachment: { type: "llm", poolId: "pool" },
      hardConcurrencyLimit: 1,
    },
  ],
};
const client = () => createRouterClient(deploymentsRouter, { context: buildContext() });
const update = (slug?: string) =>
  client().updateConfig({
    id: "config",
    expectedRevision: 1,
    ...(slug !== undefined ? { slug } : {}),
    spec: spec as never,
  });

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
  // Owner lock and the recipe row lock.
  db.$queryRaw.mockResolvedValue([{ id: "config" }]);
  db.deploymentConfig.findUniqueOrThrow.mockResolvedValue({
    id: "config",
    userId: "user-id",
    poolId: "pool",
    slug: "qwen-",
    Revisions: [{ revision: 1 }],
  });
  db.deploymentConfig.findFirst.mockResolvedValue(null);
  db.deploymentInstance.count.mockResolvedValue(0);
  db.deploymentConfigRevision.create.mockResolvedValue({ revision: 2 });
  // No recipe history unless a test sets one (operator step authorship reads it).
  db.deploymentConfigRevision.findMany.mockResolvedValue([]);
});

describe("renaming a recipe", () => {
  it("renames a stopped recipe, fixing a slug saved before the slug rule", async () => {
    await update("qwen");
    expect(db.deploymentConfig.update).toHaveBeenCalledWith({
      where: { id: "config" },
      data: { slug: "qwen" },
    });
  });

  it("leaves the slug alone when it is omitted or unchanged", async () => {
    await update();
    await update("qwen-x");
    expect(db.deploymentConfig.update).toHaveBeenCalledTimes(1);
    db.deploymentConfig.update.mockClear();
    db.deploymentConfig.findUniqueOrThrow.mockResolvedValue({
      id: "config",
      userId: "user-id",
      poolId: "pool",
      slug: "qwen-x",
      Revisions: [{ revision: 1 }],
    });
    await update("qwen-x");
    expect(db.deploymentConfig.update).not.toHaveBeenCalled();
  });

  it("refuses while a deployment runs, and a slug another recipe uses", async () => {
    db.deploymentInstance.count.mockResolvedValue(1);
    await expect(update("qwen")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "deployments_running" },
    });
    db.deploymentInstance.count.mockResolvedValue(0);
    db.deploymentConfig.findFirst.mockResolvedValue({ id: "other" });
    await expect(update("qwen")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "slug_taken" },
    });
    expect(db.deploymentConfig.update).not.toHaveBeenCalled();
    expect(db.deploymentConfigRevision.create).not.toHaveBeenCalled();
  });

  it("takes only slugs nodes accept", async () => {
    for (const slug of ["qwen-", "qw--en", "Qwen"])
      await expect(update(slug)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("interactive recipe commands", () => {
  const interactiveSpec = (variant: Record<string, unknown>) => ({
    variants: [
      {
        ...spec.variants[0],
        commands: [
          {
            management: "externalService",
            start: "serve",
            stop: "stop",
            status: "status",
            prepare: "prepare",
            interactive: { start: true, prepare: true },
          },
        ],
        ...variant,
      },
    ],
  });

  it("warns on save about interactive flags that never take effect (IC1-3)", async () => {
    const saved = await client().updateConfig({
      id: "config",
      expectedRevision: 1,
      spec: interactiveSpec({}) as never,
    });
    expect(saved.interactiveWarnings).toEqual([
      { variant: "one", rank: null, command: "prepare", reason: "single_node" },
    ]);
  });

  it("keeps restart and reopen for a person: an agent session is refused", async () => {
    const agent = createRouterClient(deploymentsRouter, {
      context: { ...buildContext(), services: { deploymentActor: { kind: "AGENT", id: "token" } } },
    });
    await expect(agent.restartInstance({ instanceId: "instance" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(agent.reopenOperatorStep({ stepId: "step" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("never returns terminal ids: instance list and detail, plan status", async () => {
    const step = {
      id: "step",
      cliDeviceId: "node",
      rank: 0,
      phase: "start",
      sequence: 0,
      state: "AWAITING_OPERATOR",
      intent: { action: "start", command: "sudo systemctl start model" },
      errorCode: null,
      operatorTerminalId: "AAECAwQFBgcICQoLDA0ODw",
      operatorSince: new Date(),
      operatorAcceptedAt: null,
      operatorLastExit: 3,
      deadline: null,
    };
    db.deploymentInstance.findMany.mockResolvedValue([
      { id: "instance", needsOperator: "STEP", Nodes: [], Steps: [step] },
    ]);
    const page = await client().listInstances({ limit: 10 });
    expect(page.items[0]).toMatchObject({
      needsOperator: "STEP",
      operatorSteps: [
        {
          stepId: "step",
          nodeId: "node",
          action: "start",
          command: "sudo systemctl start model",
          terminalOpen: true,
          lastExit: 3,
          heldResourceCheck: false,
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("AAECAwQFBgcICQoLDA0ODw");
    db.deploymentInstance.findFirst.mockResolvedValue({
      id: "instance",
      Nodes: [],
      Steps: [step],
      _count: { Steps: 1 },
      Revision: {},
    });
    db.deploymentStep.findMany.mockResolvedValue([step]);
    const detail = await client().getInstance({ id: "instance" });
    expect(detail.Steps[0]).toMatchObject({ id: "step", terminalOpen: true });
    expect(JSON.stringify(detail)).not.toContain("AAECAwQFBgcICQoLDA0ODw");
    db.deploymentPlan.findFirst.mockResolvedValue({
      id: "plan",
      userId: "user-id",
      contents: {
        action: "stop",
        stopInstanceId: "instance",
        affectedNodeIds: ["node"],
        stopIds: [],
        placements: [],
        effectiveMode: "OFF",
        requiresConfirmation: true,
        headAddr: "",
        warnings: [],
      },
      Run: { id: "run", Instances: [], Steps: [step], _count: { Steps: 1 } },
    });
    const status = await client().planStatus({ id: "plan" });
    expect(status.Run?.Steps[0]).toMatchObject({ id: "step", terminalOpen: true });
    expect(JSON.stringify(status)).not.toContain("AAECAwQFBgcICQoLDA0ODw");
  });
});

describe("operator step authorship and holds", () => {
  const commandsSpec = (start: string) => ({
    variants: [
      {
        ...spec.variants[0],
        commands: [{ management: "ownedProcess", start, stop: "sudo stop" }],
      },
    ],
  });
  const heldStep = (id: string, action = "stop", command = "sudo stop") => ({
    id,
    cliDeviceId: "node",
    rank: 0,
    phase: action,
    sequence: 100,
    state: "PENDING",
    intent: { action, command },
    errorCode: "node_offline",
    operatorTerminalId: null,
    operatorSince: null,
    operatorAcceptedAt: null,
    operatorLastExit: null,
    operatorHold: "operator_capability_missing",
    deadline: null,
  });
  /** Revision lookups by id, and the recipe's history (newest first) by config. */
  function revisions(
    byId: Record<string, { configId: string; revision: number }>,
    history: Array<{ revision: number; editorKind: string; spec: unknown }>,
  ) {
    db.deploymentConfigRevision.findMany.mockImplementation(
      async (args: {
        where: { id?: { in: string[] }; configId?: string; revision?: { lte: number } };
      }) => {
        if (args.where.id)
          return args.where.id.in.flatMap((id) => (byId[id] ? [{ id, ...byId[id] }] : []));
        return history.filter((row) => row.revision <= (args.where.revision?.lte ?? Infinity));
      },
    );
  }

  it("shows who wrote each waiting command and why a step is held", async () => {
    db.deploymentInstance.findMany.mockResolvedValue([
      {
        id: "instance",
        revisionId: "rev-2",
        variantKey: "one",
        needsOperator: "STEP",
        Nodes: [],
        Steps: [heldStep("held")],
      },
    ]);
    // An agent's revision holds the same stop text: the command counts as the agent's.
    revisions({ "rev-2": { configId: "config", revision: 2 } }, [
      { revision: 2, editorKind: "USER", spec: commandsSpec("sudo start") },
      { revision: 1, editorKind: "AGENT", spec: commandsSpec("sudo start") },
    ]);
    const page = await client().listInstances({ limit: 10 });
    expect(page.items[0]?.operatorSteps[0]).toMatchObject({
      stepId: "held",
      hold: "operator_capability_missing",
      errorCode: "node_offline",
      author: "agent",
    });
  });

  it("reads each recipe's history once per call, shared by its instances (N1)", async () => {
    db.deploymentInstance.findMany.mockResolvedValue(
      [
        ["a", "rev-2", "start", "sudo start-v2"],
        ["b", "rev-3", "start", "sudo start-v3"],
        ["c", "rev-3", "stop", "sudo stop"],
      ].map(([id, revisionId, action, command]) => ({
        id,
        revisionId,
        variantKey: "one",
        needsOperator: "STEP",
        Nodes: [],
        Steps: [heldStep(`${id}-step`, action, command)],
      })),
    );
    revisions(
      {
        "rev-2": { configId: "config", revision: 2 },
        "rev-3": { configId: "config", revision: 3 },
      },
      [
        // An agent wrote revision 3's start; a person wrote revision 2's and the stop.
        { revision: 3, editorKind: "AGENT", spec: commandsSpec("sudo start-v3") },
        { revision: 2, editorKind: "USER", spec: commandsSpec("sudo start-v2") },
        { revision: 1, editorKind: "USER", spec: commandsSpec("sudo start-v1") },
      ],
    );
    const page = await client().listInstances({ limit: 10 });
    expect(page.items.map((item) => item.operatorSteps[0]?.author)).toEqual([
      "user",
      "agent",
      // The stop text is in the agent's revision 3 too: it counts as the agent's.
      "agent",
    ]);
    // One revision lookup for the page, one history fetch for the recipe; no per-step scan.
    const calls = db.deploymentConfigRevision.findMany.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      where: { configId: "config", revision: { lte: 3 } },
      take: 1024 + 1,
    });
    expect(db.deploymentConfigRevision.findUnique).not.toHaveBeenCalled();
  });
});

describe("the needs-you feed", () => {
  it("counts and lists only this owner's waiting deployments", async () => {
    db.deploymentInstance.count.mockResolvedValue(3);
    db.deploymentInstance.findMany.mockResolvedValue([
      {
        id: "i1",
        endpointSlug: "inst-a",
        needsOperator: "RESTART",
        needsOperatorSince: new Date(),
      },
    ]);
    const feed = await client().operatorNeeds();
    expect(feed).toMatchObject({ count: 3, items: [{ id: "i1", needsOperator: "RESTART" }] });
    expect(db.deploymentInstance.count).toHaveBeenCalledWith({
      where: { userId: "user-id", needsOperator: { not: null } },
    });
    expect(db.deploymentInstance.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-id", needsOperator: { not: null } },
      take: 20,
    });
  });
});

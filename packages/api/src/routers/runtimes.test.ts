import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: { DbNull: "DbNull" },
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  },
}));
const mailer = vi.hoisted(() => ({
  isEmailConfigured: vi.fn(() => false),
  sendEmail: vi.fn(async () => undefined),
  renderShareInvite: vi.fn(() => ({ subject: "s", html: "h" })),
}));
vi.mock("@ws-model-proxy/mailer", () => mailer);
const fenceLog = vi.hoisted(() => ({ held: [] as string[], deletes: [] as unknown[] }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async (_tx: unknown, requested: Iterable<string>) => {
      fenceLog.held.push(...requested);
      return true;
    }),
    fenceOwners: vi.fn(async (_tx: unknown, userIds: Iterable<string>) => {
      fenceLog.held.push(...[...new Set(userIds)].sort().map((userId) => `00:owner:${userId}`));
    }),
    fenceParentDelete: vi.fn(async (_tx: unknown, scope: unknown) => {
      fenceLog.deletes.push(scope);
      return [];
    }),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import { credentialDigest } from "@ws-model-proxy/db/node-security";
import type { DeepMockProxy } from "vitest-mock-extended";
import { RUNTIME_PRESETS } from "../contracts/runtimes";
import { runtimeLaunchHash } from "../lib/runtime-launch-hash";
import { RUNTIME_PRESET_LIST } from "../lib/runtime-presets";
import { type RuntimeSpec, runtimeSpecSchema } from "../lib/runtime-spec";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";
import { runtimesRouter } from "./runtimes";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const SPEC: RuntimeSpec = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "qwen" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 16 }],
    labels: [],
    commands: [{ start: "vllm serve qwen --host 127.0.0.1 --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver-1",
    runtimeId: "rt-1",
    version: 1,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    editor: "USER" as const,
    editorUserId: OWNER,
    agentTokenId: null,
    note: null,
    launchHash: runtimeLaunchHash(SPEC),
    contentHash: "0".repeat(64),
    spec: SPEC,
    modelType: "LLM" as const,
    concurrencyLimit: null,
    contextLimit: null,
    kvBudgetTokens: null,
    kvFullThreshold: null,
    engineLoadGate: "AUTO" as const,
    advanced: {},
    ...overrides,
  };
}

function runtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rt-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: OWNER,
    slug: "qwen",
    name: "Qwen",
    kind: "STARTABLE" as const,
    origin: "SERVER" as const,
    nodeId: null,
    currentVersionId: "ver-1",
    forkedFromVersionId: null,
    CurrentVersion: versionRow(),
    Models: [{ upstreamModelId: "qwen" }],
    Node: null,
    Instances: [],
    ...overrides,
  };
}

function nodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    slug: "box",
    trust: "FULL" as const,
    trustLowerRequestedAt: null,
    connection: "ONLINE" as const,
    holdAt: null,
    labels: [],
    portStart: 30000,
    portEnd: 30010,
    trustChangedAt: null,
    heldDefinitions: [],
    declaredResources: { kind: "unified", memoryGb: 66 },
    nodeInfo: null,
    nodeMetrics: null,
    nodeMetricsAt: null,
    ...overrides,
  };
}

/** A running instance (as `loadPlacementInstances` reads it) holding these claims. */
function claimant(
  id: string,
  ranks: Array<{ nodeId?: string; port: number; memoryGb?: number }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    userId: OWNER,
    runtimeId: `rt-${id}`,
    desiredState: "RUNNING" as const,
    Runtime: { kind: "STARTABLE" as const, Models: [] },
    LaunchVersion: { spec: SPEC },
    Ranks: ranks.map((rank) => ({
      nodeId: rank.nodeId ?? "node-1",
      port: rank.port,
      distPort: null,
      resources:
        rank.memoryGb === undefined
          ? { kind: "none" }
          : { kind: "unified", memoryGb: rank.memoryGb },
    })),
    ...overrides,
  };
}

/** A rank's claim as `retakeInstanceClaims` reads it (rank 0 of inst-1 on node-1). */
function rankClaim(resources: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "rank-1",
    rank: 0,
    claim: "HELD",
    resources,
    port: 30004,
    distPort: null,
    plannedGeneration: 0,
    prevResources: null,
    prevPort: null,
    prevDistPort: null,
    prevGeneration: null,
    ...overrides,
  };
}

function client(auth = CALLERS.person()) {
  return createRouterClient(runtimesRouter, { context: contextFor(auth) });
}

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError)
      return (error.data as { reason?: string } | undefined)?.reason ?? error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  mockReset(db);
  fenceLog.held.length = 0;
  fenceLog.deletes.length = 0;
  db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) => work(db)) as never);
  // The definitions nodes require (`requiredDefinitionsByNode`): none unless a test says so.
  db.instanceRank.findMany.mockResolvedValue([]);
  db.instanceStep.findMany.mockResolvedValue([]);
  // The batched physical launches (`physicalLaunchIntents`: an agent's placement reads the nodes
  // they name): none unless a test says so.
  db.$queryRaw.mockResolvedValue([] as never);
  // An update's version is still the runtime's current one under the owner fence.
  db.runtime.count.mockResolvedValue(1);
  // A fork's source is still shared under the fences.
  db.runtimeShare.count.mockResolvedValue(1);
  db.runtimeVersion.count.mockResolvedValue(1);
});

describe("runtimes.presets", () => {
  it("every preset is a valid spec of its kind", () => {
    for (const preset of RUNTIME_PRESET_LIST) {
      expect(runtimeSpecSchema.safeParse(preset.spec).success, preset.id).toBe(true);
      expect(preset.kind === "STARTABLE", preset.id).toBe(preset.spec.launch !== undefined);
    }
  });

  it("lists every preset id once, in the contract's order", () => {
    expect(RUNTIME_PRESET_LIST.map((preset) => preset.id)).toEqual([...RUNTIME_PRESETS]);
  });

  const byId = (id: (typeof RUNTIME_PRESETS)[number]) => {
    const preset = RUNTIME_PRESET_LIST.find((entry) => entry.id === id);
    if (!preset) throw new Error(`no preset ${id}`);
    return { ...preset, parsed: runtimeSpecSchema.parse(preset.spec) };
  };

  it("vllm_transcription serves Whisper with a segmented live profile", () => {
    const { kind, parsed } = byId("vllm_transcription");
    expect(kind).toBe("STARTABLE");
    expect(parsed.engine).toBe("vllm");
    expect(parsed.modelType).toBe("transcription");
    const model = parsed.models?.[0];
    expect(model?.id).toBe("openai/whisper-large-v3-turbo");
    expect(model?.transcription?.realtime?.adapter).toBe("segmented");
    expect(model?.transcription?.responseFormats).toContain("verbose_json");
    expect(model?.transcription?.languages).toContain("en");
    const start = parsed.launch?.commands[0]?.start ?? "";
    expect(start).toContain("vllm serve openai/whisper-large-v3-turbo");
    expect(start).toContain("--host 127.0.0.1 --port {{port}}");
    expect(start).toContain("--gpu-memory-utilization {{memory_fraction}}");
    expect(parsed.launch?.readiness?.path).toBe("/v1/models");
    expect(parsed.launch?.resources).toEqual([{ kind: "discrete", gpuCount: 1, vramGb: 12 }]);
  });

  it("vllm_embeddings runs a pooling model and declares its embedding contract", () => {
    const { parsed } = byId("vllm_embeddings");
    expect(parsed.modelType).toBe("embeddings");
    const model = parsed.models?.[0];
    expect(model?.embeddingContract?.model).toBe(model?.id);
    expect(model?.embeddingContract?.dimensions).toBe(1024);
    expect(parsed.launch?.commands[0]?.start).toContain("--runner pooling");
    expect(parsed.launch?.commands[0]?.start).toContain("{{port}}");
    expect(parsed.launch?.readiness?.path).toBe("/v1/models");
  });

  it("docker_compose is a service with real stop and status commands", () => {
    const { parsed } = byId("docker_compose");
    expect(parsed.models).toBeUndefined();
    expect(parsed.launch?.management).toBe("service");
    const commands = parsed.launch?.commands[0];
    expect(commands?.start).toMatch(/^docker compose -f \S+ up -d$/);
    expect(commands?.stop).toMatch(/^docker compose -f \S+ down$/);
    // A status that only succeeds when a container runs, never a constant like `true`.
    // Docker failing is "unknown" (1), never "stopped" (3), which would free the claim.
    expect(commands?.status).toMatch(
      /^out=\$\(docker compose -f \S+ ps --status running -q\) \|\| exit 1; \[ -n "\$out" \] \|\| exit 3$/,
    );
  });
});

describe("launch.commands stop", () => {
  const launch = SPEC.launch as NonNullable<RuntimeSpec["launch"]>;
  const withCommands = (
    management: "process" | "service",
    commands: NonNullable<RuntimeSpec["launch"]>["commands"][number],
  ): RuntimeSpec => ({ ...SPEC, launch: { ...launch, management, commands: [commands] } });
  const issuePaths = (spec: RuntimeSpec) =>
    runtimeSpecSchema.safeParse(spec).error?.issues.map((issue) => issue.path) ?? [];

  it("may be left out of a process runtime: the node's slice kill and proof stop it", () => {
    expect(runtimeSpecSchema.safeParse(withCommands("process", { start: "run" })).success).toBe(
      true,
    );
    // The presets no longer carry a stub `stop: "true"`.
    for (const preset of RUNTIME_PRESET_LIST)
      if (preset.spec.launch?.management === "process")
        expect(preset.spec.launch.commands[0]?.stop, preset.id).toBeUndefined();
  });

  it("is required for a service runtime and for an interactive stop", () => {
    expect(issuePaths(withCommands("service", { start: "run", status: "check" }))).toContainEqual([
      "launch",
      "commands",
      0,
      "stop",
    ]);
    expect(
      issuePaths(
        withCommands("process", { start: "run", status: "check", interactive: { stop: true } }),
      ),
    ).toContainEqual(["launch", "commands", 0, "interactive", "stop"]);
    expect(
      runtimeSpecSchema.safeParse(
        withCommands("service", { start: "run", stop: "halt", status: "check" }),
      ).success,
    ).toBe(true);
  });
});

describe("launch.secrets", () => {
  const withSecrets = (secrets: string[]) => ({
    ...SPEC,
    launch: SPEC.launch && { ...SPEC.launch, secrets },
  });

  it("refuses a secret named twice, as the node does", () => {
    const result = runtimeSpecSchema.safeParse(
      withSecrets(["WSMP_SECRET_HF_TOKEN", "WSMP_SECRET_API_KEY", "WSMP_SECRET_HF_TOKEN"]),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([
      "launch",
      "secrets",
      2,
    ]);
    expect(
      runtimeSpecSchema.safeParse(withSecrets(["WSMP_SECRET_HF_TOKEN", "WSMP_SECRET_API_KEY"]))
        .success,
    ).toBe(true);
  });
});

describe("runtimes.create", () => {
  it("writes version 1 with derived columns and hashes, and the served models", async () => {
    db.runtime.create.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-1" } as never);
    db.runtime.findFirst.mockResolvedValue(runtimeRow() as never);
    const result = await client().create({
      slug: "qwen",
      name: "Qwen",
      kind: "STARTABLE",
      spec: SPEC,
    });
    const data = db.runtimeVersion.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      version: 1,
      api: "OPENAI",
      engine: "VLLM",
      modelType: "LLM",
      editor: "USER",
      launchHash: runtimeLaunchHash(SPEC),
      engineLoadGate: "AUTO",
    });
    expect(db.runtimeModel.upsert).toHaveBeenCalledTimes(1);
    // A later version replaces or clears what the definition says about each model.
    expect(db.runtimeModel.upsert.mock.calls[0]?.[0].update).toMatchObject({
      embeddingContract: "DbNull",
      transcriptionProfile: "DbNull",
    });
    expect(result.runtime.service).toBe(false);
    expect(result.version.version).toBe(1);
    expect(result.define).toEqual([]);
  });

  it("records agents as the editor", async () => {
    db.runtime.create.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-1" } as never);
    db.runtime.findFirst.mockResolvedValue(runtimeRow() as never);
    await client(CALLERS.fullAgent()).create({
      slug: "qwen",
      name: "Q",
      kind: "STARTABLE",
      spec: SPEC,
    });
    expect(db.runtimeVersion.create.mock.calls[0]?.[0].data).toMatchObject({
      editor: "AGENT",
      agentTokenId: "tok-1",
    });
  });

  it("answers slug_taken on a duplicate slug", async () => {
    db.$transaction.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(
      await reasonOf(client().create({ slug: "qwen", name: "Q", kind: "STARTABLE", spec: SPEC })),
    ).toBe("slug_taken");
  });

  it("refuses an agent an always-on runtime on a Relay-only node, but not a person", async () => {
    const spec: RuntimeSpec = {
      api: "openai",
      engine: "other",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/v1" },
    };
    db.node.findFirst.mockResolvedValue(nodeRow({ trust: "RELAY" }) as never);
    const input = { slug: "srv", name: "S", kind: "ALWAYS_ON" as const, nodeId: "node-1", spec };
    expect(await reasonOf(client(CALLERS.fullAgent()).create(input))).toBe("trust_relay");
    // Read under the owner fence (inside the write's transaction): a lowering waits for it.
    expect(db.node.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.$transaction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    // A cookie without the verified CSRF header writes nothing at all.
    expect(await reasonOf(client(CALLERS.cookieWithoutCsrf()).create(input))).toBe("FORBIDDEN");
    expect(db.runtime.create).not.toHaveBeenCalled();

    db.runtime.create.mockResolvedValue({ id: "rt-2" } as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-2" } as never);
    db.runtime.findFirst.mockResolvedValue(
      runtimeRow({
        kind: "ALWAYS_ON",
        nodeId: "node-1",
        CurrentVersion: versionRow({ spec }),
      }) as never,
    );
    await client(CALLERS.person()).create(input);
    expect(db.runtimeInstance.create.mock.calls[0]?.[0].data).toMatchObject({
      handle: "srv",
      desiredState: null,
    });
  });
});

describe("runtimes.update", () => {
  function updateRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "rt-1",
      kind: "STARTABLE" as const,
      origin: "SERVER" as const,
      Node: null,
      CurrentVersion: versionRow(),
      ...overrides,
    };
  }

  it("makes no version when nothing that is versioned changed", async () => {
    const { runtimeContentHash } = await import("../lib/runtime-launch-hash");
    const contentHash = runtimeContentHash({
      spec: SPEC,
      limits: {
        concurrencyLimit: null,
        contextLimit: null,
        kvBudgetTokens: null,
        kvFullThreshold: null,
        engineLoadGate: "AUTO",
      },
      advanced: {},
    });
    db.runtime.findFirst.mockResolvedValue(
      updateRow({ CurrentVersion: versionRow({ contentHash }) }) as never,
    );
    const result = await client().update({ runtimeId: "rt-1", name: "Renamed" });
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();
    expect(db.runtime.update).toHaveBeenCalledWith({
      where: { id: "rt-1" },
      data: { name: "Renamed" },
    });
    expect(result.version.id).toBe("ver-1");
  });

  it("forgets what was learned only for an accepted update, and saves compat in a version", async () => {
    const { runtimeContentHash } = await import("../lib/runtime-launch-hash");
    const limits = {
      concurrencyLimit: null,
      contextLimit: null,
      kvBudgetTokens: null,
      kvFullThreshold: null,
      engineLoadGate: "AUTO" as const,
    };
    const contentHash = runtimeContentHash({ spec: SPEC, limits, advanced: {} });
    // An empty compat setting keeps the content hash older versions had.
    expect(runtimeContentHash({ spec: SPEC, limits, advanced: {}, compat: {} })).toBe(contentHash);
    db.runtime.findFirst.mockResolvedValue(
      updateRow({ CurrentVersion: versionRow({ contentHash, compat: {} }) }) as never,
    );
    await client().update({ runtimeId: "rt-1", relearn: true });
    expect(db.runtimeRequestProfile.deleteMany).toHaveBeenCalledWith({
      where: { runtimeId: "rt-1", userId: OWNER },
    });
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();

    // A refused update forgets nothing.
    db.runtimeRequestProfile.deleteMany.mockClear();
    const spec: RuntimeSpec = {
      api: "openai",
      engine: "other",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/v1" },
    };
    db.runtime.findFirst.mockResolvedValue(
      updateRow({
        kind: "ALWAYS_ON",
        origin: "NODE",
        Node: { id: "node-1", trust: "FULL", trustLowerRequestedAt: null },
        CurrentVersion: versionRow({ spec, launchHash: runtimeLaunchHash(spec) }),
      }) as never,
    );
    const changed = { ...spec, address: { baseUrl: "http://127.0.0.1:9000/v1" } };
    expect(
      await reasonOf(client().update({ runtimeId: "rt-1", spec: changed, relearn: true })),
    ).toBe("launch_change_on_node_origin");
    expect(db.runtimeRequestProfile.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses invalid compat settings before writing anything", async () => {
    await expect(
      client().update({
        runtimeId: "rt-1",
        compat: { rewriteRules: [{ op: "rename", path: "model", to: "x" }] },
      }),
    ).rejects.toThrow();
    await expect(
      client().update({
        runtimeId: "rt-1",
        compat: { rewriteRules: [{ op: "default", path: "api_key", value: "x" }] },
      }),
    ).rejects.toThrow();
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();
  });

  it("refuses a launch change to an always-on runtime on a Relay-only node", async () => {
    const spec: RuntimeSpec = {
      api: "openai",
      engine: "other",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/v1" },
    };
    db.runtime.findFirst.mockResolvedValue(
      updateRow({
        kind: "ALWAYS_ON",
        // Read Full before the write; lowered by the time the owner fence is held.
        Node: { id: "node-1", trust: "FULL", trustLowerRequestedAt: null },
        CurrentVersion: versionRow({ spec, launchHash: runtimeLaunchHash(spec) }),
      }) as never,
    );
    db.node.findUnique.mockResolvedValue({ trust: "RELAY", trustLowerRequestedAt: null } as never);
    db.runtimeInstance.findMany.mockResolvedValue([] as never);
    const changed = { ...spec, address: { baseUrl: "http://127.0.0.1:9000/v1" } };
    expect(await reasonOf(client().update({ runtimeId: "rt-1", spec: changed }))).toBe(
      "launch_change_on_relay_only",
    );
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();
  });

  it("refuses a launch change to a node-origin runtime even at Full control", async () => {
    const spec: RuntimeSpec = {
      api: "openai",
      engine: "other",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/v1" },
    };
    db.runtime.findFirst.mockResolvedValue(
      updateRow({
        kind: "ALWAYS_ON",
        origin: "NODE",
        Node: { id: "node-1", trust: "FULL", trustLowerRequestedAt: null },
        CurrentVersion: versionRow({ spec, launchHash: runtimeLaunchHash(spec) }),
      }) as never,
    );
    const changed = { ...spec, address: { baseUrl: "http://127.0.0.1:9000/v1" } };
    expect(await reasonOf(client().update({ runtimeId: "rt-1", spec: changed }))).toBe(
      "launch_change_on_node_origin",
    );
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();
  });

  /** An update restart's reads: the update's own instance rows, then the planner's. */
  function setupUpdateRestart(input: {
    current: RuntimeSpec;
    /** The instances as the update reads them (its candidates). */
    instances: unknown[];
    /** The nodes and running claims as the planner reads them (`loadPlacementContext`). */
    nodes: unknown[];
    claims: unknown[];
  }) {
    db.runtime.findFirst.mockResolvedValue(
      updateRow({
        CurrentVersion: versionRow({
          spec: input.current,
          launchHash: runtimeLaunchHash(input.current),
        }),
      }) as never,
    );
    db.runtimeVersion.findFirst.mockResolvedValue(null);
    db.runtimeInstance.findMany.mockImplementation(((args: {
      select?: { LaunchVersion?: { select?: { launchHash?: boolean } }; Ranks?: unknown };
    }) =>
      Promise.resolve(
        // The update's read selects the launch hash; the capacity fences only ids.
        args.select?.LaunchVersion?.select?.launchHash || !args.select?.Ranks
          ? input.instances
          : input.claims,
      )) as never);
    db.node.findMany.mockResolvedValue(input.nodes as never);
    db.fabric.findMany.mockResolvedValue([]);
    db.runtimeInstance.findUnique.mockResolvedValue({
      runGeneration: 4,
      phase: "READY",
      operationId: "op-0",
    } as never);
    db.instanceRank.update.mockResolvedValue({} as never);
    db.instanceReservation.findMany.mockResolvedValue([] as never);
    db.instanceStep.aggregate.mockResolvedValue({ _max: { generation: null } } as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-2" } as never);
    db.runtimeOperation.create.mockResolvedValue({ id: "op-1" } as never);
    db.runtimeVersion.findUniqueOrThrow.mockResolvedValue(
      versionRow({ id: "ver-2", version: 2 }) as never,
    );
  }

  /** inst-1 as the update reads it: one rank on `nodeId` at `port`. */
  const updateInstance = (
    launched: RuntimeSpec,
    node: Record<string, unknown> = {},
    port = 30004,
    reservations: unknown[] = [],
  ) => ({
    id: "inst-1",
    desiredState: "RUNNING",
    LaunchVersion: { launchHash: runtimeLaunchHash(launched), spec: launched },
    Ranks: [
      {
        rank: 0,
        nodeId: "node-1",
        claim: "HELD",
        port,
        distPort: null,
        Node: { id: "node-1", slug: "box", trust: "FULL", trustLowerRequestedAt: null, ...node },
      },
    ],
    Reservations: reservations,
  });

  const launchOf = (spec: RuntimeSpec) => spec.launch as NonNullable<RuntimeSpec["launch"]>;
  const withLaunch = (spec: RuntimeSpec, change: Partial<NonNullable<RuntimeSpec["launch"]>>) => ({
    ...spec,
    launch: { ...launchOf(spec), ...change },
  });
  /** The same launch with another start command (its other commands kept). */
  const commandOnly = (spec: RuntimeSpec) =>
    withLaunch(spec, {
      commands: launchOf(spec).commands.map((commands) => ({
        ...commands,
        start: `${commands.start} --y`,
      })),
    });

  it("an update restart is placed by the planner: refused where its node no longer has the room", async () => {
    // A 16 GiB claim held on a node now declared 8 GiB: a command-only edit does not restart it
    // there (the restart planner refuses it, as `runtime_start` with its id would).
    setupUpdateRestart({
      current: SPEC,
      instances: [updateInstance(SPEC)],
      nodes: [nodeRow({ declaredResources: { kind: "unified", memoryGb: 8 } })],
      claims: [claimant("inst-1", [{ port: 30004, memoryGb: 16 }], { runtimeId: "rt-1" })],
    });
    const result = await client().update({
      runtimeId: "rt-1",
      spec: commandOnly(SPEC),
      restartRunning: true,
    });
    expect(result.restarted).toEqual([]);
    expect(result.needsRestart).toEqual([{ instanceId: "inst-1", reason: "not_enough_memory" }]);
    expect(db.runtimeOperation.create).not.toHaveBeenCalled();
    // The version is still saved.
    expect(db.runtimeVersion.create).toHaveBeenCalled();
  });

  it("an update restart takes the new version's claims where they fit, as a start would", async () => {
    // 16 → 48 GiB on a 66 GiB node: placed again with the new resources (not kept as held).
    const larger = withLaunch(SPEC, { resources: [{ kind: "unified", memoryGb: 48 }] });
    setupUpdateRestart({
      current: SPEC,
      instances: [updateInstance(SPEC)],
      nodes: [nodeRow()],
      claims: [claimant("inst-1", [{ port: 30004, memoryGb: 16 }], { runtimeId: "rt-1" })],
    });
    const result = await client().update({ runtimeId: "rt-1", spec: larger, restartRunning: true });
    expect(result.restarted).toEqual(["inst-1"]);
    expect(result.needsRestart).toEqual([]);
    expect(db.instanceRank.update.mock.calls[0]?.[0]).toMatchObject({
      where: { instanceId_rank: { instanceId: "inst-1", rank: 0 } },
      data: { claim: "HELD", port: 30004, resources: { kind: "unified", memoryGb: 48 } },
    });
    expect(db.runtimeInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inst-1" },
        data: expect.objectContaining({
          versionId: "ver-2",
          phase: "STARTING",
          phaseReason: "definition_changed",
        }),
      }),
    );
    // The restart begins the instance's next run in the same commit (DP-1).
    expect(db.runtimeInstance.update).toHaveBeenCalledWith({
      where: { id: "inst-1" },
      data: { runGeneration: 5 },
    });
  });

  it.each([
    // A fixed port the node has free: placed on it.
    ["another port fixed", { port: { fixed: 30005 } }, "restarted"],
    // A label the node lacks: refused by the planner.
    ["a label the node lacks", { labels: ["nvlink"] }, "label_mismatch"],
  ] as const)("an update restart is placed by the planner (%s)", async (_name, change, outcome) => {
    setupUpdateRestart({
      current: SPEC,
      instances: [updateInstance(SPEC)],
      nodes: [nodeRow()],
      claims: [claimant("inst-1", [{ port: 30004, memoryGb: 16 }], { runtimeId: "rt-1" })],
    });
    const result = await client().update({
      runtimeId: "rt-1",
      spec: withLaunch(SPEC, change),
      restartRunning: true,
    });
    if (outcome === "restarted") {
      expect(result.restarted).toEqual(["inst-1"]);
      expect(db.instanceRank.update.mock.calls[0]?.[0]).toMatchObject({
        data: { port: 30005 },
      });
    } else {
      expect(result.restarted).toEqual([]);
      expect(result.needsRestart).toEqual([{ instanceId: "inst-1", reason: outcome }]);
      expect(db.runtimeOperation.create).not.toHaveBeenCalled();
    }
  });

  it("restarts for a person but reports trust_relay for an agent on a Relay-only node", async () => {
    const setup = () =>
      setupUpdateRestart({
        current: SPEC,
        instances: [updateInstance(SPEC, { trust: "RELAY" })],
        nodes: [nodeRow({ trust: "RELAY" })],
        claims: [claimant("inst-1", [{ port: 30004, memoryGb: 16 }], { runtimeId: "rt-1" })],
      });
    setup();
    const agent = await client(CALLERS.fullAgent()).update({
      runtimeId: "rt-1",
      spec: commandOnly(SPEC),
      restartRunning: true,
    });
    expect(agent.needsRestart).toEqual([{ instanceId: "inst-1", reason: "trust_relay" }]);
    expect(agent.restarted).toEqual([]);
    expect(db.runtimeOperation.create).not.toHaveBeenCalled();

    mockReset(db);
    db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) =>
      work(db)) as never);
    db.instanceRank.findMany.mockResolvedValue([]);
    db.instanceStep.findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([] as never);
    setup();
    const person = await client().update({
      runtimeId: "rt-1",
      spec: commandOnly(SPEC),
      restartRunning: true,
    });
    expect(person.restarted).toEqual(["inst-1"]);
    expect(db.runtimeOperation.create).toHaveBeenCalled();
  });

  it("reports trust_relay for an agent when a reservation node is not at Full control", async () => {
    const reserving = withLaunch(SPEC, {
      management: "service",
      commands: [{ start: "vllm serve qwen --port {{port}}", stop: "true", status: "exit 3" }],
      reservations: [{ labels: ["worker"], resources: { kind: "unified", memoryGb: 32 } }],
    });
    const worker = (id: string, trust: "FULL" | "RELAY", pending: boolean) => ({
      id,
      slug: id,
      trust,
      trustLowerRequestedAt: pending ? new Date() : null,
    });
    const row = (index: number, node: ReturnType<typeof worker>, superseded: number | null) => ({
      index,
      nodeId: node.id,
      supersededGeneration: superseded,
      Node: node,
    });
    const cases = [
      // The current worker was lowered to Relay only after placement.
      [row(0, worker("w-relay", "RELAY", false), null)],
      // A lowering is pending: Relay only at once.
      [row(0, worker("w-pending", "FULL", true), null)],
      // A replaced run's worker still holds (superseded) and is Relay only.
      [row(0, worker("w-full", "FULL", false), null), row(0, worker("w-old", "RELAY", false), 3)],
    ];
    for (const [i, reservations] of cases.entries()) {
      mockReset(db);
      db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) =>
        work(db)) as never);
      db.instanceRank.findMany.mockResolvedValue([]);
      db.instanceStep.findMany.mockResolvedValue([]);
      db.$queryRaw.mockResolvedValue([] as never);
      setupUpdateRestart({
        current: reserving,
        instances: [updateInstance(reserving, {}, 30004, reservations)],
        nodes: [nodeRow()],
        claims: [],
      });
      const agent = await client(CALLERS.fullAgent()).update({
        runtimeId: "rt-1",
        spec: commandOnly(reserving),
        restartRunning: true,
      });
      expect([i, agent.restarted]).toEqual([i, []]);
      expect(agent.needsRestart).toEqual([{ instanceId: "inst-1", reason: "trust_relay" }]);
    }
  });

  it("lists a restart that would push a node past 128 definitions, and still saves the version", async () => {
    const at = (id: string, nodeId: string) => ({
      ...updateInstance(SPEC),
      id,
      Ranks: [
        {
          ...updateInstance(SPEC).Ranks[0],
          nodeId,
          Node: { id: nodeId, slug: nodeId, trust: "FULL", trustLowerRequestedAt: null },
        },
      ],
    });
    setupUpdateRestart({
      current: SPEC,
      // inst-1 and inst-2 run on node-full, inst-3 on node-free.
      instances: [at("inst-1", "node-full"), at("inst-2", "node-full"), at("inst-3", "node-free")],
      nodes: [
        nodeRow({ id: "node-full", slug: "full" }),
        nodeRow({ id: "node-free", slug: "free" }),
      ],
      claims: [
        claimant("inst-1", [{ nodeId: "node-full", port: 30004, memoryGb: 4 }], {
          runtimeId: "rt-1",
        }),
        claimant("inst-2", [{ nodeId: "node-full", port: 30004, memoryGb: 4 }], {
          runtimeId: "rt-1",
        }),
        claimant("inst-3", [{ nodeId: "node-free", port: 30004, memoryGb: 4 }], {
          runtimeId: "rt-1",
        }),
      ],
    });
    // node-full already requires 128 server-origin versions; node-free requires 127.
    const versions = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        nodeId: prefix,
        claim: "HELD",
        Instance: { launchVersionId: `${prefix}-v${index}` },
      }));
    db.instanceRank.findMany.mockImplementation(((args: { select?: { Instance?: unknown } }) =>
      Promise.resolve(
        args.select?.Instance ? [...versions("node-full", 128), ...versions("node-free", 127)] : [],
      )) as never);
    db.runtimeVersion.findMany.mockImplementation((async (args: {
      where: { id: { in: string[] } };
    }) => args.where.id.in.map((id) => ({ id }))) as never);
    const result = await client().update({
      runtimeId: "rt-1",
      spec: commandOnly(SPEC),
      restartRunning: true,
    });
    expect(result.needsRestart).toEqual([
      { instanceId: "inst-1", reason: "definition_slots_full" },
      { instanceId: "inst-2", reason: "definition_slots_full" },
    ]);
    // node-free has one slot: the new version takes it once, for its instance.
    expect(result.restarted).toEqual(["inst-3"]);
    expect(db.runtimeVersion.create).toHaveBeenCalled();
  });
});

describe("runtimes.delete", () => {
  it("refuses while instances run", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeInstance.count.mockResolvedValue(1);
    expect(await reasonOf(client().delete({ runtimeId: "rt-1" }))).toBe("instances_running");
    expect(db.runtime.delete).not.toHaveBeenCalled();
  });

  it("decides whether instances run under the delete's fences, not before them", async () => {
    // A start may commit between a check before the fences and the delete: the check is the
    // one taken after them.
    const order: string[] = [];
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1" } as never);
    fenceLog.deletes.length = 0;
    const { fenceParentDelete } = await import("@ws-model-proxy/db/capacity-lock-order");
    vi.mocked(fenceParentDelete).mockImplementationOnce(async () => {
      order.push("fences");
      return [];
    });
    db.runtimeInstance.count.mockImplementation((async () => {
      order.push("busy check");
      return 1;
    }) as never);
    expect(await reasonOf(client().delete({ runtimeId: "rt-1" }))).toBe("instances_running");
    expect(order).toEqual(["fences", "busy check"]);
    expect(db.runtimeInstance.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses while a profile pins it", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeInstance.count.mockResolvedValue(0);
    db.profileItem.count.mockResolvedValue(1);
    expect(await reasonOf(client().delete({ runtimeId: "rt-1" }))).toBe("pinned_by_profile");
  });
});

describe("runtimes.start / stop: the agent trust rule and the preview echo", () => {
  function setupStart(node: ReturnType<typeof nodeRow>, claims: unknown[] = []) {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      currentVersionId: "ver-1",
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue({ id: "ver-1", spec: SPEC } as never);
    db.node.findMany.mockResolvedValue([node] as never);
    db.runtimeInstance.findMany.mockResolvedValue(claims as never);
    db.fabric.findMany.mockResolvedValue([]);
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 0 });
    db.instanceRank.updateMany.mockResolvedValue({ count: 0 });
    db.runtimeOperation.create.mockResolvedValue({ id: "op-1" } as never);
    db.runtimeOperation.findUniqueOrThrow.mockResolvedValue({
      id: "op-1",
      kind: "START",
      createdAt: new Date(),
      actor: "USER",
      actorUserId: OWNER,
      agentTokenId: null,
      Instances: [],
    } as never);
  }

  it("refuses a pinned start on a node that already requires 128 definitions", async () => {
    setupStart(nodeRow());
    db.instanceRank.findMany.mockResolvedValue(
      Array.from({ length: 128 }, (_, index) => ({
        nodeId: "node-1",
        claim: "HELD",
        Instance: { launchVersionId: `other-${index}` },
      })) as never,
    );
    db.$queryRaw.mockResolvedValue([] as never);
    db.runtimeVersion.findMany.mockImplementation((async (args: {
      where: { id: { in: string[] } };
    }) => args.where.id.in.map((id) => ({ id }))) as never);
    const preview = await client().start({
      runtimeId: "rt-1",
      nodeIds: ["node-1"],
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals).toEqual([
      expect.objectContaining({ reason: "definition_slots_full", subjectId: "node-1" }),
    ]);
    const error = await client(CALLERS.fullAgent())
      .start({ runtimeId: "rt-1", nodeIds: ["node-1"] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      data: { reason: "definition_slots_full", subjectId: "node-1" },
    });
    expect(db.runtimeInstance.create).not.toHaveBeenCalled();
  });

  it("an agent's preview on a Relay-only node carries trust_relay, and applying is refused", async () => {
    setupStart(nodeRow({ trust: "RELAY" }));
    const preview = await client(CALLERS.fullAgent()).start({
      runtimeId: "rt-1",
      nodeIds: ["node-1"],
      preview: true,
    });
    expect(preview.mode).toBe("preview");
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals.map((r) => r.reason)).toEqual(["trust_relay"]);
    expect(
      await reasonOf(client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", nodeIds: ["node-1"] })),
    ).toBe("trust_relay");
    expect(db.runtimeInstance.create).not.toHaveBeenCalled();
  });

  it("a lowering in progress counts as Relay only for agents", async () => {
    setupStart(nodeRow({ trust: "FULL", trustLowerRequestedAt: new Date() }));
    expect(
      await reasonOf(
        client(CALLERS.oauthAgent()).start({ runtimeId: "rt-1", nodeIds: ["node-1"] }),
      ),
    ).toBe("trust_relay");
  });

  it("auto placement for an agent with only Relay-only nodes says trust_relay", async () => {
    setupStart(nodeRow({ trust: "RELAY" }));
    expect(await reasonOf(client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" }))).toBe(
      "trust_relay",
    );
  });

  it("refuses to start or restart an always-on runtime with always_on_runtime, preview too", async () => {
    setupStart(nodeRow());
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "ALWAYS_ON",
      currentVersionId: "ver-1",
    } as never);
    for (const input of [
      { runtimeId: "rt-1" },
      { runtimeId: "rt-1", instanceId: "inst-1" },
      { runtimeId: "rt-1", instanceId: "inst-1", preview: true },
    ]) {
      const error = await client(CALLERS.fullAgent())
        .start(input)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(ORPCError);
      expect(error).toMatchObject({
        code: "BAD_REQUEST",
        data: { reason: "always_on_runtime", subjectId: "rt-1" },
      });
      expect((error as ORPCError<string, unknown>).message).toContain("model_test");
    }
    expect(db.runtimeOperation.create).not.toHaveBeenCalled();
    expect(db.runtimeInstance.create).not.toHaveBeenCalled();
  });

  it("an agent starts on a Full-control node without a fingerprint", async () => {
    setupStart(nodeRow());
    const result = await client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" });
    expect(result.mode).toBe("applied");
    const created = db.runtimeInstance.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      desiredState: "RUNNING",
      phase: "STARTING",
      startedBy: "AGENT",
    });
    expect(String(created?.handle)).toMatch(/^i-[a-z0-9]{12}$/);
  });

  describe("interactive steps", () => {
    const interactive: RuntimeSpec = {
      ...SPEC,
      launch: {
        ...(SPEC.launch as NonNullable<RuntimeSpec["launch"]>),
        management: "service",
        commands: [
          {
            start: "sudo systemctl start qwen",
            stop: "sudo systemctl stop qwen",
            status: "systemctl is-active qwen",
            interactive: { start: true },
          },
        ],
      },
    };
    function setupInteractive(node: ReturnType<typeof nodeRow>) {
      setupStart(node);
      db.runtimeVersion.findFirst.mockResolvedValue({ id: "ver-1", spec: interactive } as never);
    }

    it("a person's preview places it and warns that a step waits for a person", async () => {
      setupInteractive(nodeRow());
      const preview = await client(CALLERS.person()).start({
        runtimeId: "rt-1",
        nodeIds: ["node-1"],
        preview: true,
      });
      if (preview.mode !== "preview") throw new Error("expected a preview");
      expect(preview.preview.refusals).toEqual([]);
      expect(preview.preview.warnings.map((w) => w.code)).toContain("interactive_needs_person");
    });

    it("an agent starts one on a Full-control node, never on a Relay-only one", async () => {
      setupInteractive(nodeRow());
      expect((await client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" })).mode).toBe("applied");
      setupInteractive(nodeRow({ trust: "RELAY" }));
      expect(
        await reasonOf(
          client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", nodeIds: ["node-1"] }),
        ),
      ).toBe("trust_relay");
    });
  });

  it("a person must echo the preview fingerprint (required, then stale)", async () => {
    setupStart(nodeRow({ trust: "RELAY" }));
    expect(await reasonOf(client().start({ runtimeId: "rt-1", nodeIds: ["node-1"] }))).toBe(
      "preview_required",
    );
    expect(
      await reasonOf(
        client().start({ runtimeId: "rt-1", nodeIds: ["node-1"], fingerprint: "a".repeat(64) }),
      ),
    ).toBe("preview_stale");
  });

  it("a person starts on a Relay-only node with the preview's fingerprint", async () => {
    setupStart(nodeRow({ trust: "RELAY" }));
    const preview = await client().start({ runtimeId: "rt-1", nodeIds: ["node-1"], preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals).toEqual([]);
    const applied = await client().start({
      runtimeId: "rt-1",
      nodeIds: ["node-1"],
      fingerprint: preview.preview.fingerprint,
    });
    expect(applied.mode).toBe("applied");
    expect(db.runtimeInstance.create.mock.calls[0]?.[0].data).toMatchObject({
      Ranks: { create: [expect.objectContaining({ nodeId: "node-1", port: 30000, rank: 0 })] },
    });
  });

  it("skips ports already claimed on the node", async () => {
    setupStart(nodeRow(), [claimant("other", [{ port: 30000 }, { port: 30001 }])]);
    const preview = await client().start({ runtimeId: "rt-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.starts[0]?.placements[0]?.port).toBe(30002);
  });

  it("preempts what must stop, shows it in the preview, and writes it fenced in one operation", async () => {
    // 66 GiB node; "victim" holds 60, the start needs 16.
    setupStart(nodeRow(), [claimant("victim", [{ port: 30000, memoryGb: 60 }])]);
    const preview = await client().start({ runtimeId: "rt-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals).toEqual([]);
    expect(preview.preview.stops).toEqual([
      { instanceId: "victim", runtimeId: "rt-victim", reason: "preempted" },
    ]);
    expect(preview.preview.starts[0]?.placements[0]).toMatchObject({ port: 30001, fabricIp: null });
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
    await client().start({ runtimeId: "rt-1", fingerprint: preview.preview.fingerprint });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`, "08:capacity:victim"]);
    expect(db.runtimeInstance.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ["victim"] }, userId: OWNER, desiredState: "RUNNING" },
      data: {
        desiredState: "STOPPED",
        phase: "STOPPING",
        phaseReason: "preempted",
        operationId: "op-1",
      },
    });
    expect(db.runtimeInstance.create.mock.calls[0]?.[0].data).toMatchObject({
      fabricId: null,
      Ranks: {
        create: [expect.objectContaining({ port: 30001, blockedBy: ["victim"], distPort: null })],
      },
    });
  });

  it.each([
    ["a current reservation on a Relay-only node", "RELAY", null, null],
    ["a current reservation whose node is being lowered", "FULL", new Date(), null],
    ["a replaced run's reservation on a Relay-only node", "RELAY", null, 3],
  ] as const)(
    "an agent's restart is refused while the instance holds %s (trust_relay)",
    async (_name, trust, lowering, superseded) => {
      setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
      db.runtimeInstance.findFirst.mockResolvedValue({
        id: "inst-1",
        Ranks: [
          {
            rank: 0,
            nodeId: "node-1",
            claim: "HELD",
            port: 30004,
            distPort: null,
            Node: { id: "node-1", slug: "n1", trust: "FULL", trustLowerRequestedAt: null },
          },
        ],
        Reservations: [
          {
            index: 0,
            nodeId: "worker",
            supersededGeneration: superseded,
            Node: { id: "worker", slug: "worker", trust, trustLowerRequestedAt: lowering },
          },
        ],
      } as never);
      const preview = await client(CALLERS.fullAgent()).start({
        runtimeId: "rt-1",
        instanceId: "inst-1",
        preview: true,
      });
      if (preview.mode !== "preview") throw new Error("preview expected");
      expect(preview.preview.refusals).toEqual([
        expect.objectContaining({ reason: "trust_relay", subjectId: "worker" }),
      ]);
      expect(
        await reasonOf(
          client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", instanceId: "inst-1" }),
        ),
      ).toBe("trust_relay");
      expect(db.runtimeOperation.create).not.toHaveBeenCalled();
    },
  );

  it("an agent's restart is refused while a node it holds was deleted", async () => {
    setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [
        {
          rank: 0,
          nodeId: "node-1",
          claim: "HELD",
          port: 30004,
          distPort: null,
          Node: { id: "node-1", slug: "n1", trust: "FULL", trustLowerRequestedAt: null },
        },
      ],
      Reservations: [{ index: 0, nodeId: null, supersededGeneration: null, Node: null }],
    } as never);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", instanceId: "inst-1" }),
      ),
    ).toBe("trust_relay");
  });

  it("an agent's restart is refused while a launch that may still run names a Relay-only node", async () => {
    // Released without proof: no reservation row holds w-old any more, but the launch that may
    // still run named it, and the restart's leading stop names that launch.
    setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [
        {
          rank: 0,
          nodeId: "node-1",
          claim: "RELEASED",
          port: 30004,
          distPort: null,
          Node: { id: "node-1", slug: "n1", trust: "FULL", trustLowerRequestedAt: null },
        },
      ],
      Reservations: [],
    } as never);
    db.instanceRank.findUnique.mockResolvedValue({
      claim: "RELEASED",
      releasedUnprovenAt: new Date(),
      stoppedThroughRun: 0,
    } as never);
    db.instanceStep.findFirst.mockResolvedValue({
      headAddr: null,
      intent: {
        operationId: "op-1",
        runtimeId: "rt-1",
        launchVersionId: "ver-1",
        launchHash: "a".repeat(64),
        rank: 0,
        nnodes: 1,
        handle: "i-inst",
        unitName: "wsmp-i-inst-r0",
        port: 30004,
        distPort: null,
        fabricId: null,
        placeholders: { port: 30004 },
        timeoutMs: 60_000,
        interactive: false,
        reservations: [{ index: 0, nodeId: "w-old", node: "w-old" }],
      },
    } as never);
    db.node.findMany.mockImplementation(((args: { where?: { id?: { in?: string[] } } }) =>
      Promise.resolve(
        args.where?.id?.in?.includes("w-old")
          ? [{ id: "w-old", slug: "w-old", trust: "RELAY", trustLowerRequestedAt: null }]
          : [nodeRow()],
      )) as never);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", instanceId: "inst-1" }),
      ),
    ).toBe("trust_relay");
  });

  it("a person may restart an instance holding a Relay-only reservation", async () => {
    setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [
        {
          rank: 0,
          nodeId: "node-1",
          claim: "HELD",
          port: 30004,
          distPort: null,
          Node: { id: "node-1", slug: "n1", trust: "FULL", trustLowerRequestedAt: null },
        },
      ],
      Reservations: [
        {
          index: 0,
          nodeId: "worker",
          supersededGeneration: 3,
          Node: { id: "worker", slug: "worker", trust: "RELAY", trustLowerRequestedAt: null },
        },
      ],
    } as never);
    const preview = await client().start({
      runtimeId: "rt-1",
      instanceId: "inst-1",
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("preview expected");
    expect(preview.preview.refusals.map((refusal) => refusal.reason)).not.toContain("trust_relay");
  });

  it("a restart writes the new version's resources onto each rank's claim", async () => {
    setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [
        {
          rank: 0,
          nodeId: "node-1",
          claim: "HELD",
          port: 30004,
          distPort: null,
          Node: { id: "node-1", slug: "n1", trust: "FULL", trustLowerRequestedAt: null },
        },
      ],
      Reservations: [],
    } as never);
    db.instanceRank.update.mockResolvedValue({} as never);
    // The running instance's claim (its reservations, if any, would be superseded).
    db.instanceRank.findMany
      // What the nodes require (`requiredDefinitionsByNode`): nothing here.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rankClaim({ kind: "unified", memoryGb: 8 })] as never)
      .mockResolvedValueOnce([rankClaim({ kind: "unified", memoryGb: 16 })] as never);
    db.instanceReservation.findMany.mockResolvedValue([] as never);
    db.instanceStep.aggregate.mockResolvedValue({ _max: { generation: null } } as never);
    await client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", instanceId: "inst-1" });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`, "08:capacity:inst-1"]);
    expect(db.instanceRank.update.mock.calls[0]?.[0]).toMatchObject({
      where: { instanceId_rank: { instanceId: "inst-1", rank: 0 } },
      data: { claim: "HELD", port: 30004, resources: { kind: "unified", memoryGb: 16 } },
    });
    // Its 8 GiB claim never ran (no start step was dispatched): nothing of it is kept.
    expect(db.instanceRank.update.mock.calls[1]?.[0]).toMatchObject({
      where: { id: "rank-1" },
      data: { prevPort: null, prevDistPort: null, prevGeneration: null, plannedGeneration: 0 },
    });
  });

  it("a restart keeps the running claim it replaces held (prev*) until the old run stopped", async () => {
    setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [
        {
          rank: 0,
          nodeId: "node-1",
          claim: "HELD",
          port: 30004,
          distPort: null,
          Node: { id: "node-1", slug: "n1", trust: "FULL", trustLowerRequestedAt: null },
        },
      ],
      Reservations: [],
    } as never);
    db.runtimeInstance.findUnique.mockResolvedValue({
      runGeneration: 4,
      phase: "READY",
      operationId: "op-0",
    } as never);
    db.instanceRank.update.mockResolvedValue({} as never);
    db.instanceRank.findMany
      // What the nodes require (`requiredDefinitionsByNode`): nothing here.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        rankClaim({ kind: "unified", memoryGb: 8 }, { plannedGeneration: 3 }),
      ] as never)
      .mockResolvedValueOnce([rankClaim({ kind: "unified", memoryGb: 16 })] as never);
    db.instanceReservation.findMany.mockResolvedValue([] as never);
    // Run 4's START was dispatched: its 8 GiB claim may be in use.
    db.instanceStep.aggregate.mockResolvedValue({ _max: { generation: 4 } } as never);
    await client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", instanceId: "inst-1" });
    expect(db.instanceRank.update.mock.calls[1]?.[0]).toEqual({
      where: { id: "rank-1" },
      data: {
        prevResources: { kind: "unified", memoryGb: 8 },
        prevPort: 30004,
        prevDistPort: null,
        prevGeneration: 4,
        plannedGeneration: 4,
      },
    });
  });

  it("refuses as stale when a preempted instance stopped meanwhile", async () => {
    setupStart(nodeRow(), [claimant("victim", [{ port: 30000, memoryGb: 60 }])]);
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 0 });
    expect(await reasonOf(client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" }))).toBe(
      "preview_stale",
    );
    expect(db.runtimeInstance.create).not.toHaveBeenCalled();
  });

  it("an agent never preempts a contributed instance or another user's", async () => {
    setupStart(nodeRow(), [
      claimant("contrib", [{ port: 30000, memoryGb: 30 }], {
        Runtime: { kind: "STARTABLE", Models: [{ id: "rm-1" }] },
      }),
      claimant("foreign", [{ port: 30001, memoryGb: 30 }], { userId: "someone-else" }),
    ]);
    expect(await reasonOf(client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" }))).toBe(
      "not_enough_memory",
    );
    // A person may stop their own contributed instance (they confirm the stop list).
    const preview = await client().start({ runtimeId: "rt-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.stops.map((stop) => stop.instanceId)).toEqual(["contrib"]);
  });

  it("a multi-node start records its fabric, head address and dist port", async () => {
    const spec: RuntimeSpec = {
      ...SPEC,
      launch: { ...(SPEC.launch as NonNullable<RuntimeSpec["launch"]>), groupSize: 2 },
    };
    setupStart(nodeRow());
    db.runtimeVersion.findFirst.mockResolvedValue({ id: "ver-1", spec } as never);
    db.node.findMany.mockResolvedValue([
      nodeRow(),
      nodeRow({ id: "node-2", slug: "box2" }),
    ] as never);
    db.fabric.findMany.mockResolvedValue([
      {
        id: "fab-1",
        name: "pair",
        Members: [
          { nodeId: "node-1", ip: "10.0.0.1" },
          { nodeId: "node-2", ip: "10.0.0.2" },
        ],
      },
    ] as never);
    await client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" });
    const created = db.runtimeInstance.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({ fabricId: "fab-1" });
    expect(created?.Ranks).toMatchObject({
      create: [
        expect.objectContaining({ nodeId: "node-1", port: 30000, distPort: 30001 }),
        expect.objectContaining({ nodeId: "node-2", port: 30000, distPort: 30001 }),
      ],
    });
    const summary = db.runtimeOperation.create.mock.calls[0]?.[0].data.summary as {
      starts: Array<{ fabric: unknown }>;
    };
    expect(summary.starts[0]?.fabric).toEqual({
      fabricId: "fab-1",
      name: "pair",
      headAddr: "10.0.0.1",
    });
  });

  it("refuses a multi-node start with no shared fabric", async () => {
    const spec: RuntimeSpec = {
      ...SPEC,
      launch: { ...(SPEC.launch as NonNullable<RuntimeSpec["launch"]>), groupSize: 2 },
    };
    setupStart(nodeRow());
    db.runtimeVersion.findFirst.mockResolvedValue({ id: "ver-1", spec } as never);
    db.node.findMany.mockResolvedValue([
      nodeRow(),
      nodeRow({ id: "node-2", slug: "box2" }),
    ] as never);
    expect(await reasonOf(client(CALLERS.fullAgent()).start({ runtimeId: "rt-1" }))).toBe(
      "no_shared_fabric",
    );
  });

  it("stop takes the capacity fence of every instance it stops", async () => {
    setupStop("FULL");
    await client().stop({ instanceId: "inst-1" });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`, "08:capacity:inst-1"]);
    expect(db.runtimeInstance.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      phaseReason: "stop_requested",
      operationId: "op-2",
    });
  });

  function setupStop(
    trust: "RELAY" | "FULL",
    reservation?: { trust: "RELAY" | "FULL"; claim?: "HELD" | "RELEASED" },
  ) {
    db.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "inst-1",
        Ranks: [
          {
            rank: 0,
            nodeId: "node-1",
            claim: reservation?.claim ?? "HELD",
            Node: { id: "node-1", slug: "node-1", trust, trustLowerRequestedAt: null },
          },
        ],
        Reservations: reservation
          ? [
              {
                index: 0,
                nodeId: "worker",
                supersededGeneration: null,
                Node: {
                  id: "worker",
                  slug: "worker",
                  trust: reservation.trust,
                  trustLowerRequestedAt: null,
                },
              },
            ]
          : [],
      },
    ] as never);
    db.runtimeOperation.create.mockResolvedValue({ id: "op-2" } as never);
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
    db.runtimeOperation.findUniqueOrThrow.mockResolvedValue({
      id: "op-2",
      kind: "STOP",
      createdAt: new Date(),
      actor: "AGENT",
      actorUserId: OWNER,
      agentTokenId: "tok-1",
      Instances: [],
    } as never);
  }

  it("stop: agents are refused on Relay-only nodes; people and cookies with CSRF are not", async () => {
    setupStop("RELAY");
    expect(await reasonOf(client(CALLERS.fullAgent()).stop({ instanceId: "inst-1" }))).toBe(
      "trust_relay",
    );
    expect(await reasonOf(client(CALLERS.cookieWithoutCsrf()).stop({ instanceId: "inst-1" }))).toBe(
      "FORBIDDEN",
    );
    expect(db.runtimeInstance.updateMany).not.toHaveBeenCalled();
    const stopped = await client(CALLERS.person()).stop({ instanceId: "inst-1" });
    expect(stopped.kind).toBe("STOP");
    expect(db.runtimeInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ desiredState: "STOPPED" }) }),
    );
  });

  it("stop: agents are refused when a held reservation is on a Relay-only node", async () => {
    setupStop("FULL", { trust: "RELAY" });
    const refused = await client(CALLERS.fullAgent())
      .stop({ instanceId: "inst-1" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ data: { reason: "trust_relay", subjectId: "worker" } });
    expect(db.runtimeInstance.updateMany).not.toHaveBeenCalled();
    // A reservation holds only while a rank does: a released instance's worker is not reached.
    setupStop("FULL", { trust: "RELAY", claim: "RELEASED" });
    await client(CALLERS.fullAgent()).stop({ instanceId: "inst-1" });
    expect(db.runtimeInstance.updateMany).toHaveBeenCalled();
  });

  it("stop by node also finds an instance whose current reservation is on that node", async () => {
    setupStop("FULL");
    await client().stop({ runtimeId: "rt-1", nodeId: "worker" });
    expect(db.runtimeInstance.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      runtimeId: "rt-1",
      OR: [
        { Ranks: { some: { nodeId: { in: ["worker"] } } } },
        { Reservations: { some: { nodeId: { in: ["worker"] }, supersededGeneration: null } } },
      ],
    });
  });

  it("stop: an agent may stop on a Full-control node, and the server hook is told", async () => {
    setupStop("FULL");
    const dispatch = vi.fn(async () => {});
    const agentClient = createRouterClient(runtimesRouter, {
      context: contextFor(CALLERS.fullAgent(), { dispatchRuntimeOperation: dispatch }),
    });
    await agentClient.stop({ runtimeId: "rt-1" });
    expect(dispatch).toHaveBeenCalledWith({ userId: OWNER, operationId: "op-2" });
  });
});

describe("review follow-ups", () => {
  const changed = (flag: string): RuntimeSpec => ({
    ...SPEC,
    launch: {
      ...(SPEC.launch as NonNullable<RuntimeSpec["launch"]>),
      commands: [
        { start: `vllm serve qwen --host 127.0.0.1 --port {{port}} ${flag}`, stop: "true" },
      ],
    },
  });

  function setupUpdate(instanceLaunch: RuntimeSpec, current: RuntimeSpec) {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      Node: null,
      CurrentVersion: versionRow({ spec: current, launchHash: runtimeLaunchHash(current) }),
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(null);
    db.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "inst-1",
        desiredState: "RUNNING",
        LaunchVersion: { launchHash: runtimeLaunchHash(instanceLaunch) },
        Ranks: [
          { claim: "HELD", Node: { id: "node-1", trust: "FULL", trustLowerRequestedAt: null } },
        ],
      },
    ] as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-3" } as never);
    db.runtimeVersion.findUniqueOrThrow.mockResolvedValue(
      versionRow({ id: "ver-3", version: 3 }) as never,
    );
  }

  it("a limits-only edit does not adopt an instance still on an older launch", async () => {
    // v2 changed the launch without a restart; the instance still runs SPEC (v1).
    setupUpdate(SPEC, changed("--v2"));
    const result = await client().update({ runtimeId: "rt-1", limits: { concurrencyLimit: 8 } });
    expect(result.adoptedLive).toEqual([]);
    expect(result.needsRestart).toEqual([{ instanceId: "inst-1", reason: "launch_changed" }]);
    expect(db.runtimeInstance.updateMany).not.toHaveBeenCalled();
  });

  it("an instance on the current launch adopts a limits-only edit live", async () => {
    setupUpdate(SPEC, SPEC);
    const result = await client().update({ runtimeId: "rt-1", limits: { concurrencyLimit: 8 } });
    expect(result.adoptedLive).toEqual(["inst-1"]);
  });

  it("OAuth agents are recorded as agents with their grant", async () => {
    db.runtime.create.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-1" } as never);
    db.runtime.findFirst.mockResolvedValue(runtimeRow() as never);
    await client(CALLERS.oauthAgent()).create({
      slug: "qwen",
      name: "Q",
      kind: "STARTABLE",
      spec: SPEC,
    });
    expect(db.runtimeVersion.create.mock.calls[0]?.[0].data).toMatchObject({
      editor: "AGENT",
      agentTokenId: null,
      mcpGrantId: "grant-1",
    });
  });

  it("stop clears a pending operator need", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "inst-1",
        Ranks: [{ Node: { id: "node-1", trust: "FULL", trustLowerRequestedAt: null } }],
      },
    ] as never);
    db.runtimeOperation.create.mockResolvedValue({ id: "op-2" } as never);
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
    db.runtimeOperation.findUniqueOrThrow.mockResolvedValue({
      id: "op-2",
      kind: "STOP",
      createdAt: new Date(),
      actor: "USER",
      actorUserId: OWNER,
      agentTokenId: null,
      Instances: [],
    } as never);
    await client().stop({ instanceId: "inst-1" });
    expect(db.runtimeInstance.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      needsOperator: null,
      needsOperatorSince: null,
    });
  });

  it("a restart whose released port another claim took gets another port", async () => {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      currentVersionId: "ver-1",
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue({ id: "ver-1", spec: SPEC } as never);
    db.node.findMany.mockResolvedValue([nodeRow()] as never);
    db.fabric.findMany.mockResolvedValue([]);
    // inst-1's claim is RELEASED (not loaded); "thief" holds its port now.
    db.runtimeInstance.findMany.mockResolvedValue([claimant("thief", [{ port: 30000 }])] as never);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [{ nodeId: "node-1", port: 30000, distPort: null }],
    } as never);
    const preview = await client().start({
      runtimeId: "rt-1",
      instanceId: "inst-1",
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals).toEqual([]);
    expect(preview.preview.starts[0]?.placements[0]?.port).toBe(30001);
  });

  it("forking an always-on runtime without a node is a bad request, not a crash", async () => {
    const spec: RuntimeSpec = {
      api: "openai",
      engine: "other",
      modelType: "llm",
      address: { baseUrl: "http://127.0.0.1:8000/v1" },
    };
    db.runtimeShare.findFirst.mockResolvedValue({
      Runtime: { id: "rt-9", kind: "ALWAYS_ON", currentVersionId: "ver-9" },
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(versionRow({ id: "ver-9", spec }) as never);
    expect(await reasonOf(client().fork({ runtimeId: "rt-9", slug: "mine", name: "Mine" }))).toBe(
      "BAD_REQUEST",
    );
    expect(db.runtime.create).not.toHaveBeenCalled();
  });

  it("another person's served model and share are not found", async () => {
    db.runtimeModel.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await reasonOf(
        client().models.setCapabilities({ runtimeModelId: "rm-x", capabilities: null }),
      ),
    ).toBe("NOT_FOUND");
    expect(db.runtimeModel.updateMany.mock.calls[0]?.[0].where).toEqual({
      id: "rm-x",
      userId: OWNER,
    });
    db.runtimeShare.findFirst.mockResolvedValue(null);
    expect(await reasonOf(client().shares.delete({ shareId: "sh-x" }))).toBe("NOT_FOUND");
    expect(db.runtimeShare.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "sh-x",
      ownerUserId: OWNER,
    });
  });
});

describe("second authz review follow-ups", () => {
  it("a Read-only agent cannot write", async () => {
    const readAgent = {
      kind: "agent_token" as const,
      userId: OWNER,
      agentTokenId: "tok-r",
      level: "READ" as const,
    };
    expect(
      await reasonOf(
        client(readAgent).create({ slug: "qwen", name: "Q", kind: "STARTABLE", spec: SPEC }),
      ),
    ).toBe("FORBIDDEN");
    expect(await reasonOf(client(readAgent).stop({ instanceId: "inst-1" }))).toBe("FORBIDDEN");
    expect(db.runtime.create).not.toHaveBeenCalled();
    expect(db.runtimeInstance.findMany).not.toHaveBeenCalled();
  });

  it("a grantee reads versions without the owner's editor ids", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1", userId: "someone-else" } as never);
    db.runtimeVersion.findMany.mockResolvedValue([
      versionRow({ editor: "AGENT", agentTokenId: "tok-owner" }),
    ] as never);
    const page = await client().versions.list({ runtimeId: "rt-1" });
    expect(page.items[0]?.editor).toEqual({
      actor: "AGENT",
      userId: null,
      agentTokenId: null,
      label: null,
    });
  });
});

describe("graph-write fences", () => {
  it("a definition update takes the owner fence, then every instance's capacity fence", async () => {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      Node: null,
      CurrentVersion: versionRow(),
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(null);
    db.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "inst-1",
        desiredState: "RUNNING",
        LaunchVersion: { launchHash: runtimeLaunchHash(SPEC) },
        Ranks: [],
      },
    ] as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-2" } as never);
    db.runtimeVersion.findUniqueOrThrow.mockResolvedValue(
      versionRow({ id: "ver-2", version: 2 }) as never,
    );
    await client().update({ runtimeId: "rt-1", limits: { concurrencyLimit: 4 } });
    expect(fenceLog.held).toEqual(["00:owner:owner-1", "08:capacity:inst-1"]);
  });

  it("a type change counts conflicting pool members again under the owner fence, and a refusal there forgets nothing", async () => {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      origin: "SERVER",
      Node: null,
      CurrentVersion: versionRow(),
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(null);
    db.runtimeInstance.findMany.mockResolvedValue([]);
    // None before the fence; a member added to an LLM pool meanwhile is counted under it.
    db.poolMember.count.mockResolvedValueOnce(0).mockImplementationOnce((async () => {
      expect(fenceLog.held).toEqual(["00:owner:owner-1"]);
      return 1;
    }) as never);
    const changed: RuntimeSpec = { ...SPEC, modelType: "embeddings" };
    expect(
      await reasonOf(client().update({ runtimeId: "rt-1", spec: changed, relearn: true })),
    ).toBe("model_type_mismatch");
    expect(db.poolMember.count).toHaveBeenCalledTimes(2);
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();
    expect(db.runtimeRequestProfile.deleteMany).not.toHaveBeenCalled();
  });

  it("an update derived from a version another update replaced meanwhile is a conflict", async () => {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      origin: "SERVER",
      Node: null,
      CurrentVersion: versionRow(),
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(null);
    db.runtimeInstance.findMany.mockResolvedValue([]);
    db.runtime.count.mockImplementation((async () => {
      expect(fenceLog.held).toContain("00:owner:owner-1");
      return 0;
    }) as never);
    // A version change, and a rename with relearn (no version change): neither writes.
    expect(
      await reasonOf(client().update({ runtimeId: "rt-1", limits: { concurrencyLimit: 4 } })),
    ).toBe("CONFLICT");
    expect(
      await reasonOf(client().update({ runtimeId: "rt-1", name: "Renamed", relearn: true })),
    ).toBe("CONFLICT");
    expect(db.runtime.count).toHaveBeenCalledWith({
      where: { id: "rt-1", userId: OWNER, currentVersionId: "ver-1" },
    });
    expect(db.runtimeVersion.create).not.toHaveBeenCalled();
    expect(db.runtime.update).not.toHaveBeenCalled();
    expect(db.runtimeRequestProfile.deleteMany).not.toHaveBeenCalled();
  });

  it("deleting a runtime goes through the parent-delete fences", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeInstance.count.mockResolvedValue(0);
    db.profileItem.count.mockResolvedValue(0);
    db.poolMember.findMany.mockResolvedValue([{ id: "mem-1" }] as never);
    const result = await client().delete({ runtimeId: "rt-1" });
    expect(fenceLog.deletes).toEqual([{ userId: OWNER, runtimeIds: ["rt-1"] }]);
    expect(result.removedMembers).toEqual(["mem-1"]);
  });

  it("deleting a runtime removes its invites, so no link opens it", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeInstance.count.mockResolvedValue(0);
    db.profileItem.count.mockResolvedValue(0);
    db.poolMember.findMany.mockResolvedValue([]);
    const order: string[] = [];
    db.shareInvite.deleteMany.mockImplementation((async () => {
      order.push("invites");
      return { count: 2 };
    }) as never);
    db.runtime.delete.mockImplementation((async () => {
      order.push("runtime");
      return { id: "rt-1" };
    }) as never);
    await client().delete({ runtimeId: "rt-1" });
    expect(db.shareInvite.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: { runtimeId: "rt-1", ownerUserId: OWNER },
    });
    expect(order).toEqual(["invites", "runtime"]);
  });
});

describe("runtimes.shares.list (shared with me)", () => {
  it("lists only definitions shared with the caller, with the kind a fork needs", async () => {
    db.runtimeShare.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rs-1",
        runtimeId: "rt-9",
        Owner: { email: "friend@example.test" },
        Runtime: { name: "Their Qwen", kind: "ALWAYS_ON", CurrentVersion: versionRow() },
      },
    ] as never);
    const result = await client().shares.list({});
    expect(db.runtimeShare.findMany.mock.calls[1]?.[0]?.where).toEqual({ granteeUserId: OWNER });
    expect(result.sharedWithMe).toMatchObject([
      { id: "rs-1", runtimeId: "rt-9", name: "Their Qwen", kind: "ALWAYS_ON" },
    ]);
  });
});

describe("runtimes.fork (create-shaped output)", () => {
  it("refuses to copy a version whose status command can never say stopped", async () => {
    const launch = SPEC.launch;
    if (!launch) throw new Error("fixture");
    const spec: RuntimeSpec = {
      ...SPEC,
      launch: { ...launch, commands: [{ ...launch.commands[0], start: "serve", status: "true" }] },
    };
    db.runtimeShare.findFirst.mockResolvedValue({
      Runtime: { id: "rt-9", kind: "STARTABLE", currentVersionId: "ver-9" },
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(versionRow({ id: "ver-9", spec }) as never);
    const refused = await client()
      .fork({ runtimeId: "rt-9", slug: "mine", name: "Mine" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ORPCError);
    expect((refused as ORPCError<string, unknown>).message).toContain(
      "spec.launch.commands.0.status",
    );
    expect(db.runtime.create).not.toHaveBeenCalled();
  });

  it("copies a shared version, applies the given limits and answers like create", async () => {
    db.runtimeShare.findFirst.mockResolvedValue({
      ownerUserId: "bob",
      Runtime: { id: "rt-9", kind: "STARTABLE", currentVersionId: "ver-9" },
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(
      versionRow({ id: "ver-9", contextLimit: 8_192 }) as never,
    );
    db.runtime.create.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeVersion.create.mockResolvedValue({ id: "ver-1" } as never);
    db.runtime.findFirst.mockResolvedValue(runtimeRow({ forkedFromVersionId: "ver-9" }) as never);
    const result = await client().fork({
      runtimeId: "rt-9",
      slug: "mine",
      name: "Mine",
      limits: { concurrencyLimit: 4 },
      note: "trying it",
    });
    expect(db.runtimeVersion.create.mock.calls[0]?.[0].data).toMatchObject({
      concurrencyLimit: 4,
      contextLimit: 8_192,
      note: "trying it",
    });
    expect(db.runtime.create.mock.calls[0]?.[0].data).toMatchObject({
      forkedFromVersionId: "ver-9",
    });
    expect(result.version.version).toBe(1);
    expect(result.runtime.forkedFromVersionId).toBe("ver-9");
    expect(fenceLog.held).toEqual(expect.arrayContaining(["00:owner:bob", "00:owner:owner-1"]));
  });

  it("does not copy a version whose share was revoked meanwhile", async () => {
    db.runtimeShare.findFirst.mockResolvedValue({
      ownerUserId: "bob",
      Runtime: { id: "rt-9", kind: "STARTABLE", currentVersionId: "ver-9" },
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue(versionRow({ id: "ver-9" }) as never);
    db.runtimeShare.count.mockImplementation((async () => {
      expect(fenceLog.held).toContain("00:owner:bob");
      return 0;
    }) as never);
    expect(await reasonOf(client().fork({ runtimeId: "rt-9", slug: "mine", name: "Mine" }))).toBe(
      "NOT_FOUND",
    );
    expect(db.runtimeShare.count).toHaveBeenCalledWith({
      where: { runtimeId: "rt-9", granteeUserId: OWNER },
    });
    expect(db.runtime.create).not.toHaveBeenCalled();
  });
});

describe("runtimes.instances.markStopped", () => {
  const stopping = (
    claims: Array<"HELD" | "HELD_UNKNOWN" | "RELEASED">,
    phase = "STOPPING",
    trust: "FULL" | "RELAY" = "FULL",
    reservations: Array<{
      nodeId: string;
      trust: "FULL" | "RELAY";
      supersededGeneration?: number;
    }> = [],
  ) => ({
    id: "inst-1",
    phase,
    Ranks: claims.map((claim, rank) => ({
      id: `rank-${rank}`,
      rank,
      nodeId: `node-${rank}`,
      claim,
      Node: { id: `node-${rank}`, slug: `node-${rank}`, trust, trustLowerRequestedAt: null },
    })),
    Reservations: reservations.map((reservation, index) => ({
      index,
      nodeId: reservation.nodeId,
      supersededGeneration: reservation.supersededGeneration ?? null,
      Node: {
        id: reservation.nodeId,
        slug: reservation.nodeId,
        trust: reservation.trust,
        trustLowerRequestedAt: null,
      },
    })),
  });

  it("refuses an agent when a reservation of the instance is on a Relay-only node", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(
      stopping(["HELD"], "STOPPING", "FULL", [{ nodeId: "worker", trust: "RELAY" }]) as never,
    );
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).instances.markStopped({
          instanceId: "inst-1",
          confirm: "MARK_STOPPED",
        }),
      ),
    ).toBe("trust_relay");
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    // A person may.
    db.runtimeInstance.findFirst.mockResolvedValueOnce(
      stopping(["HELD"], "STOPPING", "FULL", [{ nodeId: "worker", trust: "RELAY" }]) as never,
    );
    db.runtimeOperation.create.mockResolvedValueOnce({ id: "op-p" } as never);
    await reasonOf(client().instances.markStopped({ instanceId: "inst-1" }));
    expect(db.instanceRank.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ claim: "HELD_UNKNOWN" }) }),
    );
  });

  it("refuses an agent without confirm MARK_STOPPED, a cookie without CSRF, and a Relay-only node", async () => {
    for (const auth of [CALLERS.fullAgent(), CALLERS.oauthAgent(), CALLERS.cookieWithoutCsrf()])
      expect(
        await reasonOf(client(auth).instances.markStopped({ instanceId: "inst-1" })),
      ).toBeDefined();
    db.runtimeInstance.findFirst.mockResolvedValueOnce(
      stopping(["HELD"], "STOPPING", "RELAY") as never,
    );
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).instances.markStopped({
          instanceId: "inst-1",
          confirm: "MARK_STOPPED",
        }),
      ),
    ).toBe("trust_relay");
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
    expect(db.nodeAuditEvent.create).not.toHaveBeenCalled();
  });

  it("lets a Full agent mark stopped on a Full-control node, audited with its token", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(stopping(["HELD"]) as never);
    db.runtimeOperation.create.mockResolvedValueOnce({ id: "op-f" } as never);
    db.runtimeInstance.findFirst.mockResolvedValueOnce(null);
    expect(
      await reasonOf(
        client(CALLERS.fullAgent()).instances.markStopped({
          instanceId: "inst-1",
          confirm: "MARK_STOPPED",
          note: "process already gone",
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(db.runtimeOperation.create.mock.calls[0]?.[0]?.data).toMatchObject({
      kind: "MARK_STOPPED",
      actor: "AGENT",
    });
    expect(db.instanceRank.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["rank-0"] }, claim: "HELD" },
      data: expect.objectContaining({ claim: "HELD_UNKNOWN" }),
    });
    expect(db.nodeAuditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      nodeId: "node-0",
      actor: "AGENT",
      kind: "marked_stopped",
      subject: "instance:inst-1 rank:0",
      outcome: "completed",
      reason: "process already gone",
    });
  });

  it("refuses what is not the caller's, not stopping, or has no unproven stop", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(null);
    expect(await reasonOf(client().instances.markStopped({ instanceId: "inst-1" }))).toBe(
      "NOT_FOUND",
    );
    db.runtimeInstance.findFirst.mockResolvedValueOnce(stopping(["HELD"], "READY") as never);
    expect(await reasonOf(client().instances.markStopped({ instanceId: "inst-1" }))).toBe(
      "CONFLICT",
    );
    db.runtimeInstance.findFirst.mockResolvedValueOnce(stopping(["RELEASED"]) as never);
    expect(await reasonOf(client().instances.markStopped({ instanceId: "inst-1" }))).toBe(
      "CONFLICT",
    );
    db.runtimeInstance.findFirst.mockResolvedValueOnce(stopping(["HELD", "RELEASED"]) as never);
    expect(
      await reasonOf(client().instances.markStopped({ instanceId: "inst-1", nodeNumber: 2 })),
    ).toBe("CONFLICT");
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
  });

  it("points a rank already marked stopped to the automatic check and its last result", async () => {
    const marked = {
      ...stopping(["HELD_UNKNOWN", "HELD_UNKNOWN"], "STOPPED"),
      phaseChangedAt: new Date("2026-10-07T20:00:00Z"),
    };
    const ranks = [
      ...marked.Ranks.map((rank) => ({
        ...rank,
        markedStoppedAt: new Date("2026-10-07T19:59:00Z"),
      })),
      // A third rank whose node was removed: no check can run for it.
      { id: "rank-2", rank: 2, claim: "HELD_UNKNOWN", markedStoppedAt: null, Node: null },
    ];
    db.runtimeInstance.findFirst.mockResolvedValueOnce({ ...marked, Ranks: ranks } as never);
    db.instanceStep.findFirst.mockImplementation((async (args: { where: { rank: number } }) =>
      args.where.rank === 0
        ? {
            instanceId: "inst-1",
            rank: 0,
            state: "FAILED",
            errorCode: "health_failed",
            updatedAt: new Date("2026-10-07T20:05:00Z"),
          }
        : null) as never);
    const refused = client().instances.markStopped({ instanceId: "inst-1" });
    await expect(refused).rejects.toMatchObject({ code: "CONFLICT" });
    const message = await refused.catch((error: unknown) =>
      error instanceof ORPCError ? error.message : "",
    );
    expect(message).toContain("Already marked stopped");
    expect(message).toContain("every 5 minutes");
    expect(message).toContain(
      "node 1: not proven at 2026-10-07T20:05:00.000Z (health_failed); node 2: no check has finished yet; node 3: its node was removed, so no check can run",
    );
    expect(db.instanceRank.updateMany).not.toHaveBeenCalled();
  });

  it("marks the held ranks stopped under the owner and capacity fences, audited as MARK_STOPPED", async () => {
    db.runtimeInstance.findFirst.mockResolvedValueOnce(stopping(["HELD", "HELD"]) as never);
    db.runtimeOperation.create.mockResolvedValueOnce({ id: "op-f" } as never);
    db.runtimeInstance.findFirst.mockResolvedValueOnce(null);
    // The view read after the commit: gone meanwhile is NOT_FOUND, never a 500.
    expect(
      await reasonOf(client().instances.markStopped({ instanceId: "inst-1", nodeNumber: 2 })),
    ).toBe("NOT_FOUND");
    expect(fenceLog.held).toEqual(expect.arrayContaining([expect.stringContaining("inst-1")]));
    expect(db.runtimeOperation.create.mock.calls[0]?.[0]?.data).toMatchObject({
      kind: "MARK_STOPPED",
      actor: "USER",
      agentTokenId: null,
      mcpGrantId: null,
      summary: { instanceId: "inst-1", ranks: [1] },
    });
    expect(db.instanceRank.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["rank-1"] }, claim: "HELD" },
      data: expect.objectContaining({ claim: "HELD_UNKNOWN", markedStoppedBy: OWNER }),
    });
    // Only never-sent stops of the rank marked stopped are dropped.
    expect(db.instanceStep.updateMany).toHaveBeenCalledWith({
      where: {
        instanceId: "inst-1",
        rank: { in: [1] },
        phase: "STOP",
        state: "PENDING",
        attempts: 0,
      },
      data: { state: "CANCELLED", operatorHold: null },
    });
  });
});

describe("runtimes.get: instances that still hold resources", () => {
  it("lists a stopped instance while a rank of it is still reserved", async () => {
    db.runtime.findFirst.mockResolvedValue(runtimeRow() as never);
    db.runtimeInstance.findMany.mockResolvedValue([]);
    await client()
      .get({ runtimeId: "rt-1" })
      .catch(() => undefined);
    const listed = db.runtimeInstance.findMany.mock.calls.find(
      (call) => call[0]?.where?.runtimeId === "rt-1",
    );
    expect(listed?.[0]?.where).toEqual({
      runtimeId: "rt-1",
      userId: OWNER,
      OR: [
        { NOT: { desiredState: "STOPPED", phase: "STOPPED" } },
        { Ranks: { some: { claim: { in: ["HELD", "HELD_UNKNOWN"] } } } },
      ],
    });
  });
});

describe("runtimes.list: the nodes each runtime is on", () => {
  const rank = (nodeId: string, slug: string, userId = OWNER) => ({
    nodeId,
    Node: { slug, userId },
  });
  const instance = (phase: string, ranks: ReturnType<typeof rank>[]) => ({
    phase,
    needsOperator: null,
    desiredState: phase === "STOPPED" ? "STOPPED" : "RUNNING",
    Ranks: ranks,
  });

  it("names an always-on runtime's node and the nodes of live instances, each once", async () => {
    db.runtime.findMany.mockResolvedValue([
      runtimeRow({
        id: "rt-on",
        kind: "ALWAYS_ON",
        nodeId: "node-1",
        Node: { id: "node-1", slug: "box", userId: OWNER },
      }),
      runtimeRow({
        id: "rt-big",
        Instances: [
          instance("READY", [rank("node-1", "box"), rank("node-2", "spark")]),
          instance("STARTING", [rank("node-2", "spark")]),
          instance("STOPPED", [rank("node-3", "old")]),
        ],
      }),
      runtimeRow({ id: "rt-idle" }),
    ] as never);
    const { runtimes } = await client().list();
    expect(runtimes.map((runtime) => [runtime.id, runtime.nodes])).toEqual([
      ["rt-on", [{ id: "node-1", slug: "box" }]],
      [
        "rt-big",
        [
          { id: "node-1", slug: "box" },
          { id: "node-2", slug: "spark" },
        ],
      ],
      ["rt-idle", []],
    ]);
    expect(db.runtime.findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: OWNER });
  });

  it("never names another user's node", async () => {
    db.runtime.findMany.mockResolvedValue([
      runtimeRow({
        Instances: [instance("READY", [rank("node-x", "theirs", "someone-else")])],
      }),
    ] as never);
    const { runtimes } = await client().list();
    expect(runtimes[0]?.nodes).toEqual([]);
  });
});

describe("runtimes.get: live load", () => {
  it("reads the relay's load for the listed instances and shows it", async () => {
    db.runtime.findFirst.mockResolvedValue(runtimeRow() as never);
    db.runtimeVersion.findFirstOrThrow.mockResolvedValue(versionRow() as never);
    db.runtimeModel.findMany.mockResolvedValue([]);
    db.runtimeShare.findMany.mockResolvedValue([]);
    db.node.findMany.mockResolvedValue([]);
    db.runtimeRequestProfile.findFirst.mockResolvedValue(null);
    db.runtimeInstance.findMany.mockResolvedValue([
      {
        id: "inst-1",
        runtimeId: "rt-1",
        handle: "i-abcdefabcdef",
        versionId: "ver-1",
        launchVersionId: "ver-1",
        desiredState: "RUNNING",
        phase: "READY",
        phaseReason: null,
        phaseChangedAt: new Date(),
        needsOperator: null,
        startedBy: "USER",
        restartsInWindow: 0,
        nextRestartAt: null,
        engineSlots: 8,
        factsAt: null,
        Ranks: [],
        Steps: [],
        Version: { version: 1, advanced: {} },
        LaunchVersion: { spec: SPEC, editor: "USER", launchHash: runtimeLaunchHash(SPEC) },
        Fabric: null,
      },
    ] as never);
    const liveLoad = vi.fn((ids: readonly string[]) => {
      expect(ids).toEqual(["inst-1"]);
      return new Map([
        ["inst-1", { running: 3, waiting: 1, kvUsage: 0.5, at: new Date("2026-10-08T12:00:00Z") }],
      ]);
    });
    const runtime = await createRouterClient(runtimesRouter, {
      context: contextFor(CALLERS.person(), { liveLoad }),
    }).get({ runtimeId: "rt-1" });
    expect(liveLoad).toHaveBeenCalledTimes(1);
    expect(runtime.instanceList[0]?.live).toEqual({
      running: 3,
      waiting: 1,
      kvUsage: 0.5,
      slots: 8,
      at: "2026-10-08T12:00:00.000Z",
    });
  });
});

describe("runtimes.shares.create: a direct share only to a proved mailbox", () => {
  const owner = { name: "Owner", locale: "en-US" };
  const input = { runtimeId: "rt-1", email: "Friend@Example.test" };
  const later = new Date(Date.now() + 14 * 86_400_000);
  function inviteRow(email: string) {
    return {
      id: "inv-1",
      poolId: null,
      runtimeId: "rt-1",
      email,
      canUse: true,
      canContribute: false,
      priorityClass: null,
      createdAt: new Date(),
      expiresAt: later,
      emailSentAt: null,
      Pool: null,
      Runtime: { name: "Qwen" },
    };
  }
  function setupInvite() {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1", User: owner } as never);
    db.shareInvite.updateMany.mockResolvedValue({ count: 0 });
    db.shareInvite.findFirst.mockResolvedValue(null);
    db.shareInvite.count.mockResolvedValue(0);
    db.shareInvite.create.mockImplementation((async (args: { data: { email: string } }) =>
      inviteRow(args.data.email)) as never);
  }

  beforeEach(() => {
    mailer.isEmailConfigured.mockReturnValue(false);
    mailer.sendEmail.mockClear();
    mailer.renderShareInvite.mockClear();
  });

  it("shares directly with an account whose mailbox was proved, under both owners' fences", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1", User: owner } as never);
    db.user.findFirst.mockResolvedValue({
      id: "friend",
      email: "Friend@example.test",
      provedEmail: "friend@example.test",
    } as never);
    const createdAt = new Date("2026-10-07T00:00:00Z");
    db.runtimeShare.upsert.mockResolvedValue({
      id: "rsh-1",
      runtimeId: "rt-1",
      createdAt,
    } as never);
    const result = await client().shares.create(input);
    expect(result).toEqual({
      kind: "share",
      share: {
        id: "rsh-1",
        runtimeId: "rt-1",
        email: "Friend@example.test",
        createdAt: createdAt.toISOString(),
      },
    });
    expect(db.user.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      email: { equals: "friend@example.test", mode: "insensitive" },
    });
    expect(db.runtimeShare.upsert.mock.calls[0]?.[0].create).toEqual({
      runtimeId: "rt-1",
      ownerUserId: OWNER,
      granteeUserId: "friend",
    });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`, "00:owner:friend"]);
    expect(db.shareInvite.create).not.toHaveBeenCalled();
    // A pending invite to the address is withdrawn in the same transaction.
    expect(db.shareInvite.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        runtimeId: "rt-1",
        email: "friend@example.test",
        ownerUserId: OWNER,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it.each([
    [
      "never proved its mailbox",
      { id: "squatter", email: "friend@example.test", provedEmail: null },
    ],
    [
      "proved another address",
      { id: "changed", email: "friend@example.test", provedEmail: "old@example.test" },
    ],
  ])("invites an account that %s instead of sharing directly", async (_label, account) => {
    setupInvite();
    db.user.findFirst.mockResolvedValue(account as never);
    const result = await client().shares.create(input);
    expect(result.kind).toBe("invite");
    expect(db.runtimeShare.upsert).not.toHaveBeenCalled();
    expect(db.runtimeShare.create).not.toHaveBeenCalled();
  });

  it("answers an unknown e-mail exactly like an unproved account (no account oracle)", async () => {
    setupInvite();
    db.user.findFirst.mockResolvedValueOnce(null);
    const unknown = await client().shares.create(input);
    setupInvite();
    db.user.findFirst.mockResolvedValueOnce({
      id: "squatter",
      email: "friend@example.test",
      provedEmail: null,
    } as never);
    const unproved = await client().shares.create(input);
    const shape = (result: typeof unknown) => ({
      ...result,
      ...(result.kind === "invite"
        ? { link: result.link?.replace(/invite=[^&]+/, "invite=T") ?? null }
        : {}),
      invite: result.kind === "invite" ? { ...result.invite, createdAt: "" } : null,
    });
    expect(shape(unknown)).toEqual(shape(unproved));
    expect(unknown.kind).toBe("invite");
  });

  it("writes a can-use runtime invite under the owner's fence; the link is shown once", async () => {
    setupInvite();
    db.user.findFirst.mockResolvedValue(null);
    const result = await client().shares.create(input);
    if (result.kind !== "invite") throw new Error("expected an invite");
    expect(result.invite.target).toEqual({ kind: "runtime", runtimeId: "rt-1", name: "Qwen" });
    expect(result.invite.email).toBe("friend@example.test");
    expect(result.link).toMatch(
      /^https:\/\/proxy\.example\.com\/en-US\/signup\?invite=wsmp_inv_[A-Z2-7]{26}$/,
    );
    const token = new URL(result.link ?? "").searchParams.get("invite") ?? "";
    const data = db.shareInvite.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      runtimeId: "rt-1",
      ownerUserId: OWNER,
      email: "friend@example.test",
      tokenDigest: credentialDigest("shareInvite", token),
      canUse: true,
      canContribute: false,
      priorityClass: null,
    });
    expect(data).not.toHaveProperty("poolId");
    expect(JSON.stringify(data)).not.toContain(token);
    expect(db.shareInvite.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      runtimeId: "rt-1",
      email: "friend@example.test",
    });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`]);
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("e-mails the runtime invite when SMTP works and then returns no link", async () => {
    mailer.isEmailConfigured.mockReturnValue(true);
    setupInvite();
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.updateMany.mockResolvedValue({ count: 1 });
    const result = await client().shares.create(input);
    expect(result).toMatchObject({ kind: "invite", link: null });
    if (result.kind !== "invite") throw new Error("expected an invite");
    expect(result.invite.emailSentAt).not.toBeNull();
    expect(mailer.renderShareInvite).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "runtime", name: "Qwen" } }),
    );
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "friend@example.test" }),
    );
  });

  it("refuses a second pending invite to the same e-mail and runtime", async () => {
    setupInvite();
    db.user.findFirst.mockResolvedValue(null);
    db.shareInvite.findFirst.mockResolvedValue({ id: "inv-0" } as never);
    expect(await reasonOf(client().shares.create(input))).toBe("invite_pending");
    expect(db.shareInvite.create).not.toHaveBeenCalled();
  });

  it("shares only the caller's runtime, never with themselves, and only for a person", async () => {
    db.runtime.findFirst.mockResolvedValue(null);
    expect(await reasonOf(client().shares.create(input))).toBe("NOT_FOUND");
    expect(db.runtime.findFirst.mock.calls[0]?.[0]?.where).toEqual({ id: "rt-1", userId: OWNER });
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1", User: owner } as never);
    expect(
      await reasonOf(client().shares.create({ ...input, email: `${OWNER}@example.test` })),
    ).toBe("BAD_REQUEST");
    expect(await reasonOf(client(CALLERS.fullAgent()).shares.create(input))).toBe("FORBIDDEN");
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

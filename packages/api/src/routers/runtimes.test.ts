import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
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
});

describe("runtimes.presets", () => {
  it("every preset is a valid spec of its kind", () => {
    for (const preset of RUNTIME_PRESET_LIST) {
      expect(runtimeSpecSchema.safeParse(preset.spec).success, preset.id).toBe(true);
      expect(preset.kind === "STARTABLE", preset.id).toBe(preset.spec.launch !== undefined);
    }
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
        Node: { id: "node-1", trust: "RELAY", trustLowerRequestedAt: null },
        CurrentVersion: versionRow({ spec, launchHash: runtimeLaunchHash(spec) }),
      }) as never,
    );
    const changed = { ...spec, address: { baseUrl: "http://127.0.0.1:9000/v1" } };
    expect(await reasonOf(client().update({ runtimeId: "rt-1", spec: changed }))).toBe(
      "launch_change_on_relay_only",
    );
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

  it("restarts for a person but reports trust_relay for an agent on a Relay-only node", async () => {
    const changed: RuntimeSpec = {
      ...SPEC,
      launch: {
        ...(SPEC.launch as NonNullable<RuntimeSpec["launch"]>),
        commands: [{ start: "vllm serve qwen --host 127.0.0.1 --port {{port}} --x", stop: "true" }],
      },
    };
    const setup = () => {
      db.runtime.findFirst.mockResolvedValue(updateRow() as never);
      db.runtimeVersion.findFirst.mockResolvedValue(null);
      db.runtimeInstance.findMany.mockResolvedValue([
        {
          id: "inst-1",
          desiredState: "RUNNING",
          LaunchVersion: { launchHash: runtimeLaunchHash(SPEC) },
          Ranks: [
            { claim: "HELD", Node: { id: "node-1", trust: "RELAY", trustLowerRequestedAt: null } },
          ],
        },
      ] as never);
      db.runtimeVersion.create.mockResolvedValue({ id: "ver-2" } as never);
      db.runtimeOperation.create.mockResolvedValue({ id: "op-1" } as never);
      db.runtimeVersion.findUniqueOrThrow.mockResolvedValue(
        versionRow({ id: "ver-2", version: 2 }) as never,
      );
    };
    setup();
    const agent = await client(CALLERS.fullAgent()).update({
      runtimeId: "rt-1",
      spec: changed,
      restartRunning: true,
    });
    expect(agent.needsRestart).toEqual([{ instanceId: "inst-1", reason: "trust_relay" }]);
    expect(agent.restarted).toEqual([]);
    expect(db.runtimeOperation.create).not.toHaveBeenCalled();

    mockReset(db);
    db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) =>
      work(db)) as never);
    setup();
    const person = await client().update({
      runtimeId: "rt-1",
      spec: changed,
      restartRunning: true,
    });
    expect(person.restarted).toEqual(["inst-1"]);
    expect(db.runtimeOperation.create).toHaveBeenCalled();
  });
});

describe("runtimes.delete", () => {
  it("refuses while instances run", async () => {
    db.runtime.findFirst.mockResolvedValue({ id: "rt-1" } as never);
    db.runtimeInstance.count.mockResolvedValue(1);
    expect(await reasonOf(client().delete({ runtimeId: "rt-1" }))).toBe("instances_running");
    expect(db.runtime.delete).not.toHaveBeenCalled();
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

  it("a restart writes the new version's resources onto each rank's claim", async () => {
    setupStart(nodeRow(), [claimant("inst-1", [{ port: 30004, memoryGb: 8 }])]);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [{ nodeId: "node-1", port: 30004, distPort: null }],
    } as never);
    db.instanceRank.update.mockResolvedValue({} as never);
    await client(CALLERS.fullAgent()).start({ runtimeId: "rt-1", instanceId: "inst-1" });
    expect(fenceLog.held).toEqual([`00:owner:${OWNER}`, "08:capacity:inst-1"]);
    expect(db.instanceRank.update.mock.calls[0]?.[0]).toMatchObject({
      where: { instanceId_rank: { instanceId: "inst-1", rank: 0 } },
      data: { claim: "HELD", port: 30004, resources: { kind: "unified", memoryGb: 16 } },
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

  function setupStop(trust: "RELAY" | "FULL") {
    db.runtimeInstance.findMany.mockResolvedValue([
      { id: "inst-1", Ranks: [{ Node: { id: "node-1", trust, trustLowerRequestedAt: null } }] },
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

  it("a restart is refused when another claim took its released port", async () => {
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
    expect(preview.preview.refusals.map((r) => r.reason)).toEqual(["port_in_use"]);
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

describe("runtimes.fork (create-shaped output)", () => {
  it("copies a shared version, applies the given limits and answers like create", async () => {
    db.runtimeShare.findFirst.mockResolvedValue({
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
  });
});

describe("runtimes.instances.markStopped", () => {
  const stopping = (
    claims: Array<"HELD" | "HELD_UNKNOWN" | "RELEASED">,
    phase = "STOPPING",
    trust: "FULL" | "RELAY" = "FULL",
  ) => ({
    id: "inst-1",
    phase,
    Ranks: claims.map((claim, rank) => ({
      id: `rank-${rank}`,
      rank,
      claim,
      Node: { id: `node-${rank}`, trust, trustLowerRequestedAt: null },
    })),
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

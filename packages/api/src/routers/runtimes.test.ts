import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
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
    Ranks: [],
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
  function setupStart(node: ReturnType<typeof nodeRow>) {
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "STARTABLE",
      currentVersionId: "ver-1",
    } as never);
    db.runtimeVersion.findFirst.mockResolvedValue({ id: "ver-1", spec: SPEC } as never);
    db.node.findMany.mockResolvedValue([node] as never);
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
    setupStart(nodeRow({ Ranks: [{ port: 30000 }, { port: 30001 }] }));
    const preview = await client().start({ runtimeId: "rt-1", preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.starts[0]?.placements[0]?.port).toBe(30002);
  });

  function setupStop(trust: "RELAY" | "FULL") {
    db.runtimeInstance.findMany.mockResolvedValue([
      { id: "inst-1", Ranks: [{ Node: { id: "node-1", trust, trustLowerRequestedAt: null } }] },
    ] as never);
    db.runtimeOperation.create.mockResolvedValue({ id: "op-2" } as never);
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
      agentTokenId: "grant-1",
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
    db.node.findMany.mockResolvedValue([nodeRow({ Ranks: [{ port: 30000 }] })] as never);
    db.runtimeInstance.findFirst.mockResolvedValue({
      id: "inst-1",
      Ranks: [{ nodeId: "node-1", port: 30000, claim: "RELEASED" }],
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
    db.runtimeShare.deleteMany.mockResolvedValue({ count: 0 });
    expect(await reasonOf(client().shares.delete({ shareId: "sh-x" }))).toBe("NOT_FOUND");
    expect(db.runtimeShare.deleteMany.mock.calls[0]?.[0].where).toEqual({
      id: "sh-x",
      ownerUserId: OWNER,
    });
  });
});

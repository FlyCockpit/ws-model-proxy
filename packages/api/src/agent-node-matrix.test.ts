/** Exercise real procedures with Prisma mocked: access checks precede all side effects. */
import { createRouterClient, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", async () => {
  const actual = await vi.importActual<typeof import("../../db/prisma/generated/client")>(
    "../../db/prisma/generated/client",
  );
  return { default: mockDeep<PrismaClient>(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    BETTER_AUTH_SECRET: "test-secret",
    WMP_MCP_ENABLED: true,
  },
}));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: vi.fn(() => false),
  sendEmail: vi.fn(),
  renderShareInvite: vi.fn(),
  renderInviteUser: vi.fn(),
  verifyTransport: vi.fn(),
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("./lib/graph-write", async () => {
  const actual = await vi.importActual<typeof import("./lib/graph-write")>("./lib/graph-write");
  const { default: client } = await import("@ws-model-proxy/db");
  return {
    ...actual,
    graphWrite: async (
      _owners: unknown,
      work: (tx: typeof client) => Promise<unknown>,
      policy?: (tx: typeof client) => Promise<unknown>,
    ) => {
      await policy?.(client);
      return work(client);
    },
    graphDelete: async (_scope: unknown, work: (tx: typeof client) => Promise<unknown>) =>
      work(client),
  };
});

import type { Session } from "@ws-model-proxy/auth";
import prisma from "@ws-model-proxy/db";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { Context } from "./context";
import { apiContract, flattenContract } from "./contracts";
import { ALL_AGENT_SCOPES } from "./contracts/agent-scopes";
import type { CallerAuth } from "./contracts/auth-context";
import { TEST_NODE_FEATURES } from "./lib/node-features-test-fixture";
import { loadPlacementContext } from "./lib/placement-load";
import { runtimeContentHash, runtimeLaunchHash } from "./lib/runtime-launch-hash";
import { appRouter } from "./routers";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const reached = new Error("authorized path reached");
const nodeId = "node-a";
const session = {
  user: { id: "owner", role: "user", emailVerified: true, twoFactorEnabled: false },
  session: { id: "s", userId: "owner" },
} as Session;
const person: CallerAuth = {
  kind: "cookie_session",
  userId: "owner",
  sessionId: "s",
  csrfVerified: true,
};
const spec = {
  api: "openai" as const,
  engine: "vllm" as const,
  modelType: "llm" as const,
  models: [{ id: "m" }],
  address: { baseUrl: "http://127.0.0.1:8000" },
};
const launchSpec = {
  api: "openai" as const,
  engine: "vllm" as const,
  modelType: "llm" as const,
  models: [{ id: "m" }],
  launch: {
    management: "process" as const,
    groupSize: 1,
    resources: [{ kind: "unified" as const, memoryGb: 1 }],
    labels: [],
    commands: [{ start: "vllm serve m --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60000 },
    health: { intervalMs: 15000, failureThreshold: 3, successThreshold: 1 },
  },
};
const limits = {
  concurrencyLimit: null,
  contextLimit: null,
  kvBudgetTokens: null,
  kvFullThreshold: null,
  engineLoadGate: "AUTO" as const,
};
const current = {
  id: "v1",
  version: 1,
  spec: launchSpec,
  ...limits,
  advanced: {},
  compat: {},
  modelType: "LLM" as const,
  launchHash: runtimeLaunchHash(launchSpec),
  contentHash: runtimeContentHash({ spec: launchSpec, limits, advanced: {} }),
};
type Callable = (input: unknown) => Promise<unknown>;
function call(auth: CallerAuth, path: string, input: unknown) {
  const client = createRouterClient(appRouter, {
    context: {
      session,
      auth,
      services: {
        nodeOperator: {
          pollCommand: async () => {
            throw reached;
          },
          startCommand: async () => {
            throw reached;
          },
          openTerminalTicket: async () => {
            throw reached;
          },
        },
        modelTest: async () => {
          throw reached;
        },
      },
    } satisfies Context,
  });
  let target: unknown = client;
  for (const key of path.split(".")) target = (target as Record<string, unknown>)[key];
  return (target as Callable)(input);
}
function credential(
  kind: "agent_token" | "oauth_access_token",
  nodeIds: readonly string[] | null,
): CallerAuth {
  const access = { scopes: ALL_AGENT_SCOPES, nodeIds };
  return kind === "agent_token"
    ? { kind, userId: "owner", agentTokenId: "t", access }
    : { kind, userId: "owner", grantId: "g", access };
}
function node(owner = "owner") {
  return {
    id: nodeId,
    userId: owner,
    slug: "box",
    trust: "FULL" as const,
    trustLowerRequestedAt: null,
    connection: "ONLINE" as const,
    lastHeartbeatAt: new Date(),
    commandMaxMs: 60000,
    features: TEST_NODE_FEATURES,
    trustChangedAt: null,
    labels: [],
    holdAt: null,
    portStart: 30000,
    portEnd: 30010,
    heldDefinitions: [],
    declaredResources: null,
    nodeInfo: null,
    nodeMetrics: null,
    nodeMetricsAt: null,
  };
}
function instance(owner = "owner") {
  return {
    id: "i1",
    phase: "STOPPING",
    phaseChangedAt: new Date(),
    desiredState: "RUNNING",
    Ranks: [
      {
        id: "rank1",
        rank: 0,
        nodeId,
        claim: "HELD_UNKNOWN",
        markedStoppedAt: null,
        Node: node(owner),
      },
    ],
    Reservations: [],
  };
}
function setup(state: "owned" | "missing" | "other-owner", path = "") {
  mockReset(db);
  const own = state === "owned";
  db.$transaction.mockImplementation(((work: (tx: typeof db) => Promise<unknown>) =>
    work(db)) as never);
  db.node.findFirst.mockImplementation((async () => {
    if (!own) return null;
    throw reached;
  }) as never);
  db.node.findMany.mockResolvedValue((own ? [node()] : []) as never);
  db.runtime.findFirst.mockResolvedValue({
    id: "r1",
    kind: "STARTABLE",
    nodeId,
    Node: state === "missing" ? { ...node(), userId: "missing" } : node(own ? "owner" : "other"),
    CurrentVersion: current,
    Instances: [],
    currentVersionId: "v1",
  } as never);
  db.runtime.findMany.mockResolvedValue([]);
  db.runtime.count.mockRejectedValue(reached);
  db.runtimeInstance.findFirst.mockResolvedValue(instance(own ? "owner" : "other") as never);
  db.runtimeInstance.findMany.mockResolvedValue([instance(own ? "owner" : "other")] as never);
  db.runtimeInstance.count.mockRejectedValue(reached);
  db.runtimeOperation.create.mockRejectedValue(reached);
  db.profile.findFirst.mockResolvedValue({
    id: "p1",
    Nodes: [{ nodeId, hold: false, holdNote: null, Node: { userId: own ? "owner" : "other" } }],
    Items: [],
  } as never);
  db.profile.create.mockRejectedValue(reached);
  db.profile.deleteMany.mockRejectedValue(reached);
  db.profileNode.findMany.mockResolvedValue([{ nodeId, hold: false, holdNote: null }] as never);
  db.runtimeVersion.findFirst.mockResolvedValue({ id: "v1", spec: launchSpec } as never);
  db.runtimeVersion.findMany.mockResolvedValue([]);
  db.instanceRank.findMany.mockResolvedValue([]);
  db.instanceStep.findMany.mockResolvedValue([]);
  db.fabric.findMany.mockResolvedValue([]);
  db.executionTarget.findMany.mockResolvedValue([]);
  db.nodeCommand.findFirst.mockResolvedValue(
    (own
      ? {
          id: "AAAAAAAAAAAAAAAAAAAAAA",
          nodeId,
          userId: "owner",
          state: "RUNNING",
          startedAt: new Date(),
          endsBy: new Date(Date.now() + 60000),
        }
      : null) as never,
  );
  db.queuedNodeCommand.findFirst.mockResolvedValue(null);
  // The pool is shared with the caller. That never grants access to its owner's node.
  db.share.findFirst.mockResolvedValue({
    poolId: "pool-shared",
    ownerUserId: "other",
    granteeUserId: "owner",
    canUse: true,
  } as never);
  db.pool.findFirst.mockResolvedValue({
    id: "pool-shared",
    userId: "other",
    modelType: "LLM",
  } as never);
  db.modelAlias.findMany.mockResolvedValue([]);
  db.profileItem.findFirst.mockResolvedValue(null);
  db.$queryRaw.mockResolvedValue([]);
  if (path === "profiles.apply") db.runtimeInstance.findMany.mockResolvedValue([]);
  if (path === "activity.metrics.query")
    db.node.findFirst.mockResolvedValue((own ? { id: nodeId } : null) as never);
  if (path === "runtimes.instances.markStopped") {
    const row = instance(own ? "owner" : "other");
    row.Ranks[0]!.claim = "HELD";
    db.runtimeInstance.findFirst.mockResolvedValue(row as never);
  }
}
const direct: Array<[string, unknown]> = [
  ["nodes.get", { nodeId }],
  ["nodes.update", { nodeId, labels: ["x"] }],
  ["nodes.deleteOffline", { nodeId, confirm: "DELETE" }],
  ["nodes.secrets.set", { nodeId, name: "WSMP_SECRET_HF", value: "test-value" }],
  ["nodes.commands.run", { nodeId, command: "pwd", confirm: "RUN" }],
  ["nodes.commands.get", { commandId: "AAAAAAAAAAAAAAAAAAAAAA", cancel: true }],
  ["nodes.queued.enqueue", { nodeId, command: "pwd", note: "please run" }],
  ["nodes.files.read", { nodeId, path: "/tmp/a", op: "read" }],
  ["nodes.files.write", { nodeId, path: "/tmp/a", op: "write", content: "test" }],
  ["nodes.files.edit", { nodeId, path: "/tmp/a", edits: [{ old: "a", new: "b" }], ifMatch: "x" }],
  ["runtimes.create", { slug: "rt", name: "Runtime", kind: "ALWAYS_ON", nodeId, spec }],
  ["runtimes.start", { runtimeId: "r1", nodeIds: [nodeId], preview: true }],
  [
    "activity.metrics.query",
    { scope: { node: nodeId }, metrics: ["requests"], range: "1h", step: "1m" },
  ],
];
const indirect: Array<[string, unknown]> = [
  ["runtimes.update", { runtimeId: "r1", name: "Changed" }],
  ["runtimes.delete", { runtimeId: "r1" }],
  ["runtimes.stop", { instanceId: "i1" }],
  ["runtimes.instances.markStopped", { instanceId: "i1", confirm: "MARK_STOPPED" }],
  [
    "runtimes.releaseRequests.create",
    { instanceId: "i1", nodeNumber: 1, findings: "checked the process" },
  ],
  ["profiles.save", { slug: "profile", name: "Profile", nodeIds: [nodeId], items: [] }],
  ["profiles.apply", { profileId: "p1", preview: true }],
  ["profiles.delete", { profileId: "p1" }],
  [
    "activity.metrics.query",
    { scope: { instance: "i1" }, metrics: ["requests"], range: "1h", step: "1m" },
  ],
];
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (!(error instanceof ORPCError)) throw error;
    return { code: error.code, message: error.message, data: error.data };
  }
}
for (const kind of ["agent_token", "oauth_access_token"] as const)
  describe(`${kind}: node authorization matrix`, () => {
    for (const [path, input] of [...direct, ...indirect]) {
      it(`${path}: excludes disallowed nodes exactly like unknown targets`, async () => {
        setup("owned", path);
        const denied = await refusal(call(credential(kind, []), path, input));
        setup("missing", path);
        const missing = await refusal(call(credential(kind, null), path, input));
        expect(denied).not.toBeNull();
        expect(denied).toEqual(missing);
      });
      it(`${path}: shared pool access does not authorize another owner's node`, async () => {
        setup("other-owner", path);
        const result = await refusal(call(credential(kind, null), path, input));
        expect(result).not.toBeNull();
        expect(["NOT_FOUND", "BAD_REQUEST"]).toContain(result?.code);
        expect(db.runtimeOperation.create).not.toHaveBeenCalled();
        expect(db.profile.create).not.toHaveBeenCalled();
      });
      it.each([{ nodeIds: [nodeId] }, { nodeIds: null }])(
        `${path}: allowed node access (%j) reaches the operation`,
        async ({ nodeIds }) => {
          setup("owned", path);
          // A read/preview may complete; otherwise the sentinel proves it passed access and
          // ownership checks to the first subsequent DB operation or relay call.
          if (path === "runtimes.start") db.runtime.findFirst.mockRejectedValue(reached);
          if (path === "activity.metrics.query") {
            db.node.findFirst.mockResolvedValue({ id: nodeId } as never);
          }
          if (path === "profiles.apply") db.runtimeInstance.findMany.mockResolvedValue([]);
          if (path === "runtimes.releaseRequests.create")
            db.claimReleaseRequest.updateMany.mockRejectedValue(reached);
          let error: unknown;
          try {
            await call(credential(kind, nodeIds), path, input);
          } catch (caught) {
            error = caught;
          }
          expect(error === undefined || error === reached, String(error)).toBe(true);
        },
      );
    }
  });

describe("node matrix inputs and list filtering", () => {
  it("uses valid inputs so no validation failure can disguise an authorization result", () => {
    const contracts = new Map(flattenContract(apiContract));
    for (const [path, input] of [...direct, ...indirect])
      expect(contracts.get(path)?.input.safeParse(input).success, path).toBe(true);
  });
  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    for (const nodeIds of [[nodeId], [], null])
      it(`${kind} nodes.list respects ${JSON.stringify(nodeIds)}`, async () => {
        setup("owned");
        const row = {
          ...node(),
          name: null,
          cliVersion: null,
          rejectedProtocolVersion: null,
          declaredResourcesBy: null,
          trustLowerRequestedBy: null,
          User: { name: "Owner" },
          Ranks: [],
          Reservations: [],
          FabricMembers: [],
          _count: { Runtimes: 0, QueuedCommands: 0 },
          holdNote: null,
          holdProfileId: null,
          removeAfterOfflineMs: null,
          hostname: "box",
        };
        db.node.findMany.mockResolvedValue([row, { ...row, id: "node-b", slug: "box-b" }] as never);
        const out = (await call(credential(kind, nodeIds), "nodes.list", undefined)) as {
          nodes: Array<{ id: string }>;
        };
        expect(out.nodes.map((entry) => entry.id)).toEqual(
          nodeIds === null ? [nodeId, "node-b"] : nodeIds,
        );
        // An allowlisted read first resolves the caller's hidden nodes, then loads the list.
        expect(db.node.findMany.mock.calls.at(-1)?.[0]?.where).toEqual(
          nodeIds === null ? { userId: "owner" } : { userId: "owner", id: { in: nodeIds } },
        );
      });
    it(`${kind} nodes.list always restricts rows to the credential's owner`, async () => {
      setup("other-owner");
      const out = await call(credential(kind, null), "nodes.list", undefined);
      expect(out).toEqual({ nodes: [] });
      expect(db.node.findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: "owner" });
    });
  }
});

describe("placement and model-test ownership through shared resources", () => {
  it("restricts automatic placement candidates to owned allowlisted nodes", async () => {
    setup("owned");
    db.runtimeInstance.findMany.mockResolvedValue([]);
    const context = await loadPlacementContext(prisma, {
      userId: "owner",
      agent: true,
      nodeIds: [nodeId],
    });
    expect(context.nodes.map((entry) => entry.id)).toEqual([nodeId]);
    expect(db.node.findMany.mock.calls[0]?.[0]?.where).toEqual({
      userId: "owner",
      id: { in: [nodeId] },
    });
  });
  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    it(`${kind} model_test refuses a shared pool that could use another owner's node`, async () => {
      setup("other-owner");
      db.runtime.findMany.mockResolvedValue([{ Node: node("other"), Instances: [] }] as never);
      await expect(
        call(credential(kind, null), "models.test", { target: { pool: "other/chat" } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it(`${kind} model_test refuses a shared pool's disallowed placement`, async () => {
      setup("owned");
      db.runtime.findMany.mockResolvedValue([{ Node: node(), Instances: [] }] as never);
      await expect(
        call(credential(kind, []), "models.test", { target: { pool: "other/chat" } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it(`${kind} model_test may use an owned, allowed placement through a shared pool`, async () => {
      setup("owned");
      db.runtime.findMany.mockResolvedValue([{ Node: node(), Instances: [] }] as never);
      await expect(
        call(credential(kind, [nodeId]), "models.test", { target: { pool: "other/chat" } }),
      ).rejects.toBe(reached);
    });
  }
});

describe("pool routing and model capability node authority", () => {
  const mutations: Array<[string, unknown]> = [
    [
      "pools.create",
      { slug: "chat", name: "Chat", type: "LLM", members: [{ runtimeModelId: "rm1" }] },
    ],
    [
      "pools.create",
      { slug: "chat", name: "Chat", type: "LLM", members: [{ runtimeId: "r1", model: "m" }] },
    ],
    ["pools.update", { poolId: "pool1", members: { add: [{ runtimeModelId: "rm1" }] } }],
    ["pools.update", { poolId: "pool1", members: { add: [{ runtimeId: "r1", model: "m" }] } }],
    [
      "pools.update",
      { poolId: "pool1", members: { set: [{ memberId: "mem1", state: "ACTIVE" }] } },
    ],
    ["pools.members.addContributed", { poolId: "shared", runtimeModelId: "rm1" }],
    ["runtimes.models.setCapabilities", { runtimeModelId: "rm1", tools: true }],
  ];
  function prepare(placement: "bound" | "rank" | "reservation", owner = "owner") {
    setup("owned");
    const pool = { id: "pool1", userId: "owner", modelType: "LLM", slug: "chat" };
    db.pool.findFirst.mockResolvedValue(pool as never);
    db.pool.create.mockResolvedValue(pool as never);
    db.pool.count.mockResolvedValue(1);
    db.runtimeModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolMember.findFirst.mockResolvedValue({
      RuntimeModel: { runtimeId: "r1", userId: "owner" },
    } as never);
    db.share.findFirst.mockResolvedValue({
      id: "share1",
      ownerUserId: "other",
      canContribute: true,
      Pool: { modelType: "LLM", Routing: null },
    } as never);
    db.runtimeModel.findFirst.mockResolvedValue({
      id: "rm1",
      runtimeId: "r1",
      type: "LLM",
      retired: false,
    } as never);
    const running = instance(owner);
    if (placement === "reservation") {
      db.runtime.findFirst.mockResolvedValue({
        nodeId: null,
        Node: null,
        Instances: [
          {
            ...running,
            Ranks: [],
            Reservations: [{ index: 0, nodeId, supersededGeneration: null, Node: node(owner) }],
          },
        ],
      } as never);
    } else {
      db.runtime.findFirst.mockResolvedValue({
        nodeId: placement === "bound" ? nodeId : null,
        Node: placement === "bound" ? node(owner) : null,
        Instances: placement === "rank" ? [running] : [],
      } as never);
    }
    db.poolMember.upsert.mockRejectedValue(reached);
    db.poolMember.create.mockRejectedValue(reached);
    db.poolMember.updateMany.mockRejectedValue(reached);
    db.runtimeModel.updateMany.mockRejectedValue(reached);
  }
  it("uses valid mutation inputs", () => {
    const contracts = new Map(flattenContract(apiContract));
    for (const [path, input] of mutations)
      expect(contracts.get(path)?.input.safeParse(input).success, JSON.stringify(input)).toBe(true);
  });
  for (const kind of ["agent_token", "oauth_access_token"] as const)
    it(`${kind}: rechecks a contribution's placement under the graph fences`, async () => {
      prepare("bound");
      db.runtime.findFirst.mockResolvedValueOnce({
        nodeId: null,
        Node: null,
        Instances: [],
      } as never);
      await expect(
        call(credential(kind, []), "pools.members.addContributed", {
          poolId: "shared",
          runtimeModelId: "rm1",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(db.runtime.findFirst).toHaveBeenCalledTimes(2);
      expect(db.poolMember.create).not.toHaveBeenCalled();
    });
  for (const [path, input] of mutations) {
    for (const placement of ["bound", "rank", "reservation"] as const) {
      for (const kind of ["agent_token", "oauth_access_token"] as const) {
        it(`${kind} ${path} ${JSON.stringify(input)}: refuses disallowed ${placement} like an unknown runtime`, async () => {
          prepare(placement);
          const denied = await refusal(call(credential(kind, []), path, input));
          expect(denied).toMatchObject({ code: "NOT_FOUND" });
          expect(db.poolMember.upsert).not.toHaveBeenCalled();
          expect(db.poolMember.create).not.toHaveBeenCalled();
          expect(db.poolMember.updateMany).not.toHaveBeenCalled();
          expect(db.runtimeModel.updateMany).not.toHaveBeenCalled();
          prepare(placement);
          db.runtime.findFirst.mockResolvedValue(null);
          expect(await refusal(call(credential(kind, null), path, input))).toEqual(denied);
        });
        for (const nodeIds of [[nodeId], null])
          it(`${kind} ${path} ${JSON.stringify(input)}: allows ${placement} with ${JSON.stringify(nodeIds)}`, async () => {
            prepare(placement);
            await expect(call(credential(kind, nodeIds), path, input)).rejects.toBe(reached);
          });
        it(`${kind} ${path} ${JSON.stringify(input)}: refuses another owner's ${placement} even with all nodes`, async () => {
          prepare(placement, "other");
          await expect(call(credential(kind, null), path, input)).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
        });
      }
      it(`person ${path} ${JSON.stringify(input)}: keeps existing ${placement} behavior`, async () => {
        prepare(placement, "other");
        await expect(call(person, path, input)).rejects.toBe(reached);
        expect(db.runtime.findFirst).not.toHaveBeenCalled();
      });
    }
  }
});

describe("requests_list node projection", () => {
  const hiddenFilter = {
    OR: [{ selectedNodeId: null }, { selectedNodeId: { notIn: ["node-b"] } }],
  };
  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    it(`${kind}: disallowed and unknown node filters have the metrics refusal`, async () => {
      setup("owned");
      db.node.findMany.mockResolvedValue([node(), { ...node(), id: "node-b" }] as never);
      const denied = await refusal(
        call(credential(kind, [nodeId]), "activity.requests.list", { nodeId: "node-b" }),
      );
      const unknown = await refusal(
        call(credential(kind, [nodeId]), "activity.requests.list", { nodeId: "unknown" }),
      );
      const metrics = await refusal(
        call(credential(kind, [nodeId]), "activity.metrics.query", {
          scope: { node: "node-b" },
          metrics: ["requests"],
          range: "1h",
          step: "1m",
        }),
      );
      expect(denied).toMatchObject({ code: "NOT_FOUND" });
      expect(denied).toEqual(unknown);
      expect(denied).toEqual(metrics);
      expect(db.relayRequest.findMany).not.toHaveBeenCalled();
    });
    for (const filter of [{}, { nodeId }, { runtimeId: "r1" }, { versionId: "v1" }])
      it(`${kind}: excludes only disallowed own-node rows before pagination with ${JSON.stringify(filter)}`, async () => {
        setup("owned");
        db.node.findMany.mockResolvedValue([node(), { ...node(), id: "node-b" }] as never);
        db.runtimeVersion.findMany.mockResolvedValue([{ id: "v1" }] as never);
        db.relayRequest.findMany.mockResolvedValue([]);
        await call(credential(kind, [nodeId]), "activity.requests.list", { ...filter, limit: 1 });
        expect(db.relayRequest.findMany.mock.calls[0]?.[0]).toMatchObject({
          where: { AND: expect.arrayContaining([hiddenFilter]) },
          take: 2,
        });
        expect(db.node.findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: "owner" });
      });
    it(`${kind}: an empty allowlist excludes all owned nodes`, async () => {
      setup("owned");
      db.relayRequest.findMany.mockResolvedValue([]);
      await call(credential(kind, []), "activity.requests.list", {});
      expect(db.relayRequest.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
        AND: expect.arrayContaining([
          { OR: [{ selectedNodeId: null }, { selectedNodeId: { notIn: [nodeId] } }] },
        ]),
      });
    });
  }
  for (const auth of [
    person,
    credential("agent_token", null),
    credential("oauth_access_token", null),
  ])
    it(`${auth.kind}: people and all-node credentials keep existing request filters`, async () => {
      setup("owned");
      db.relayRequest.findMany.mockResolvedValue([]);
      await call(auth, "activity.requests.list", { nodeId: "node-b" });
      expect(JSON.stringify(db.relayRequest.findMany.mock.calls[0]?.[0]?.where)).not.toContain(
        "notIn",
      );
      expect(db.node.findMany).not.toHaveBeenCalled();
    });
});

describe("pool node projections", () => {
  function readPool() {
    const model = (id: string, owner: string, fallback = false) => ({
      id: `member-${id}`,
      poolId: "pool1",
      kind: "LOCAL",
      state: "ACTIVE",
      weight: 1,
      runtimeModelId: `model-${id}`,
      providerModelId: null,
      shareId: null,
      cloudOrder: null,
      Share: null,
      ProviderModel: null,
      RuntimeModel: {
        upstreamModelId: "m",
        runtimeId: `runtime-${id}`,
        retired: false,
        Targets: [],
        Runtime: {
          slug: `runtime-${id}`,
          nodeId: id,
          Node: { id, slug: id, userId: owner },
          Instances: [
            {
              id: `instance-${id}`,
              phase: "READY",
              engineSlots: null,
              Ranks: fallback ? [] : [{ nodeId: id, Node: { slug: id, userId: owner } }],
            },
          ],
        },
      },
    });
    return {
      id: "pool1",
      slug: "chat",
      name: "Chat",
      userId: "owner",
      description: null,
      modelType: "LLM",
      User: { slug: "owner" },
      Routing: null,
      Fallback: null,
      Advanced: null,
      Sidecars: [],
      RoutingRules: [],
      _count: { Shares: 0 },
      Members: [
        model(nodeId, "owner"),
        model("node-b", "owner"),
        model("node-c", "owner", true),
        model("foreign", "other"),
      ],
    };
  }
  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    for (const nodeIds of [[nodeId], [], null]) {
      for (const path of ["pools.get", "pools.list"])
        it(`${kind} ${path} filters own ranked and bound nodes with ${JSON.stringify(nodeIds)} and keeps foreign nodes`, async () => {
          setup("owned");
          db.pool.findFirst.mockResolvedValue(readPool() as never);
          db.pool.findMany.mockResolvedValue([readPool()] as never);
          db.share.findMany.mockResolvedValue([]);
          const out = await call(
            credential(kind, nodeIds),
            path,
            path === "pools.get" ? { poolId: "pool1" } : undefined,
          );
          const view = (path === "pools.list" ? (out as { pools: unknown[] }).pools[0] : out) as {
            runsOn: Array<{ nodeId: string; mine: boolean }>;
          };
          expect(view.runsOn).toEqual(
            (nodeIds === null
              ? [nodeId, "node-b", "node-c", "foreign"]
              : [...nodeIds, "foreign"]
            ).map((id) => ({
              nodeId: id,
              slug: id,
              mine: id !== "foreign",
              instances: 1,
            })),
          );
        });
    }
  }
  it("people keep all pool node entries", async () => {
    setup("owned");
    db.pool.findFirst.mockResolvedValue(readPool() as never);
    const out = (await call(person, "pools.get", { poolId: "pool1" })) as {
      runsOn: Array<{ nodeId: string }>;
    };
    expect(out.runsOn.map((entry) => entry.nodeId)).toEqual([
      nodeId,
      "node-b",
      "node-c",
      "foreign",
    ]);
  });
});

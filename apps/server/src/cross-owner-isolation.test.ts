/**
 * Cross-owner isolation on the server side: what the procedures hand off to (MCP tool dispatch,
 * the interactive-step services, the lifecycle engine's dispatch, the definition sync) never lets
 * user B act on user A's node, step or terminal, whatever B names. The MCP tool list comes from
 * MCP_TOOLS: every tool is covered or exempted, with a reason. The relay's own owner checks
 * (node-owner.ts) are tested with each sender. The procedures' own scoping is
 * proven in packages/api/src/cross-owner-isolation.test.ts; the database's in
 * packages/api/src/integration/cross-owner-isolation.postgres.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";
import { z } from "zod";
import type { PrismaClient } from "../../../packages/db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://cross-owner-test", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async () => true),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { MCP_TOOLS } = await import("@ws-model-proxy/api/contracts");
const { runMcpTool, resetMcpToolRateLimitsForTests } = await import("./mcp/tools");
const { createMcpContext } = await import("./mcp/context");
const { TEST_USER } = await import("./mcp/tools.test-helper");
const { RuntimeLifecycle, OperatorStepError } = await import("./runtimes/lifecycle.js");
const { createRuntimeStepServices } = await import("./runtimes/operator-steps.js");
const { TerminalTicketStore } = await import("./relay/terminal-tickets.js");
const { loadNodeDefinitionState } = await import("./relay/runtime-sync.js");

import type { McpToolDispatch } from "./mcp/tool-dispatch";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const VICTIM = "user-a";
const ATTACKER = "user-b";

/** Whether a Prisma `where` names `owner` as an owner anywhere (nested relations, OR, AND). */
function namesOwner(value: unknown, owner: string, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 10) return false;
  if (Array.isArray(value)) return value.some((entry) => namesOwner(entry, owner, depth + 1));
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "userId" || key === "ownerUserId") && entry === owner) return true;
    if (namesOwner(entry, owner, depth + 1)) return true;
  }
  return false;
}

/** Input fields that name a node, runtime, instance, step, profile or command of someone's. */
const TARGET_FIELDS = new Set([
  "nodeId",
  "nodeIds",
  "replaceNodeId",
  "runtimeId",
  "versionId",
  "instanceId",
  "stepId",
  "commandId",
  "queuedCommandId",
  "profileId",
  "fabricId",
  "runtimeModelId",
  "node",
  "runtime",
  "version",
  "instance",
]);

/** The id-shaped fields (a target field, `id`, `ids`, `*Id`, `*Ids`) anywhere in an input. */
function idFields(schema: z.ZodType | undefined): string[] {
  if (!schema) return ["(no schema)"];
  const found = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (value === null || typeof value !== "object" || depth > 16) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    const properties = Reflect.get(value, "properties");
    if (properties && typeof properties === "object")
      for (const key of Object.keys(properties))
        if (TARGET_FIELDS.has(key) || /^ids?$|Ids?$/.test(key)) found.add(key);
    for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }), 0);
  return [...found].sort();
}

const INTENT = {
  operationId: null,
  runtimeId: "rt-a",
  launchVersionId: "ver-a",
  launchHash: "b".repeat(64),
  rank: 0,
  nnodes: 1,
  handle: "i-abcdefabcdef",
  unitName: "wsmp-i-abcdefabcdef-r0",
  port: 30_000,
  distPort: null,
  fabricId: null,
  placeholders: {},
  timeoutMs: 60_000,
  interactive: true,
};

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation((async (work: unknown) =>
    typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[])) as never);
});

// ── MCP: the credential, never the tool input, names the caller ──

describe("MCP tools act as the credential's user only", () => {
  const credential = { kind: "agent_token" as const, tokenId: "tok-b", level: "FULL" as const };
  const dispatch = (): McpToolDispatch => ({
    orpcContext: createMcpContext({
      user: { ...TEST_USER, id: ATTACKER },
      credential: { ...credential, expiresAt: null },
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      now: new Date("2026-10-06T00:00:00Z"),
      services: undefined,
    }),
    requestId: "req-b",
    credential: { ...credential, expiresAt: null },
  });

  /**
   * Every MCP tool (generated from MCP_TOOLS: a new tool fails below until it is covered here or
   * exempted), aimed at A's ids. One or more calls per tool.
   */
  const CALLS: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {
    nodes_get: [{ nodeId: "node-a" }],
    runtimes_get: [
      { runtimeId: "rt-a" },
      { runtimeId: "rt-a", versions: true },
      { versionId: "ver-a" },
    ],
    pools_get: [{ poolId: "pool-a" }, { poolId: "pool-a", history: true }],
    profiles_get: [{ profileId: "prof-a" }],
    requests_list: [{ runtimeId: "rt-a" }, { nodeId: "node-a" }, { versionId: "ver-a" }],
    metrics_query: [
      { scope: { node: "node-a" }, metrics: ["requests"], range: "1h", step: "1m" },
      { scope: { runtime: "rt-a" }, metrics: ["requests"], range: "1h", step: "1m" },
      { scope: { instance: "inst-a" }, metrics: ["requests"], range: "1h", step: "1m" },
    ],
    model_test: [{ target: { runtimeId: "rt-a" } }],
    pool_create: [
      { slug: "mine", name: "Mine", type: "LLM", members: [{ runtimeModelId: "rm-a" }] },
      { slug: "mine", name: "Mine", type: "LLM", members: [{ runtimeId: "rt-a", model: "m" }] },
    ],
    pool_update: [
      { poolId: "pool-a", name: "mine" },
      { poolId: "pool-b", contribute: { add: ["rm-a"] } },
    ],
    pool_delete: [{ poolId: "pool-a", confirm: "DELETE" }],
    runtime_create: [
      { slug: "mine", name: "Mine", forkFrom: { runtimeId: "rt-a" } },
      { slug: "mine", name: "Mine", kind: "ALWAYS_ON", nodeId: "node-a", spec: {} },
    ],
    runtime_update: [
      { runtimeId: "rt-a", name: "mine" },
      {
        runtimeId: "rt-b",
        modelCapabilities: [{ runtimeModelId: "rm-a", capabilities: null }],
      },
    ],
    runtime_delete: [{ runtimeId: "rt-a", confirm: "DELETE" }],
    runtime_start: [
      { runtimeId: "rt-a", nodeIds: ["node-a"] },
      { runtimeId: "rt-b", instanceId: "inst-a" },
    ],
    runtime_stop: [{ instanceId: "inst-a" }, { runtimeId: "rt-a", nodeId: "node-a" }],
    profile_save: [
      { slug: "mine", name: "Mine", nodeIds: ["node-a"], items: [] },
      { profileId: "prof-a", slug: "mine", name: "Mine", nodeIds: ["node-b"], items: [] },
    ],
    profile_apply: [{ profileId: "prof-a" }],
    profile_delete: [{ profileId: "prof-a", confirm: "DELETE" }],
    node_update: [{ nodeId: "node-a", labels: ["x"] }],
    node_secret_set: [
      { nodeId: "node-a", name: "WSMP_SECRET_HF", value: "v" },
      { nodeId: "node-a", name: "WSMP_SECRET_HF", value: null },
    ],
    node_command_run: [{ nodeId: "node-a", command: "id", timeoutMs: 10_000, confirm: "RUN" }],
    node_command_get: [{ commandId: "AAAAAAAAAAAAAAAAAAAAAA", cancel: true }],
    node_command_queue_for_user: [
      { nodeId: "node-a", command: "id", note: "n", expiresInHours: 1 },
    ],
    node_file_read: [{ nodeId: "node-a", path: "/etc/hostname" }],
    node_file_write: [{ nodeId: "node-a", path: "/tmp/x", content: "x" }],
    node_file_edit: [
      { nodeId: "node-a", path: "/tmp/x", edits: [{ old: "a", new: "b" }], ifMatch: "e" },
    ],
  };

  /**
   * Tools that take no id at all, with the reason (any id-shaped input field disqualifies one).
   * The one place a tool may be left out of CALLS; checked against the tool's input below.
   */
  const MCP_EXEMPT: Readonly<Record<string, string>> = {
    providers_get: "takes no input: lists the caller's own provider accounts and models",
  };

  beforeEach(() => resetMcpToolRateLimitsForTests());

  it("covers every MCP tool, or exempts one that takes no target id", () => {
    const names = MCP_TOOLS.map((tool) => tool.name as string);
    expect(names.filter((name) => !(name in CALLS) && !(name in MCP_EXEMPT))).toEqual([]);
    // No stale or doubled entries.
    expect(Object.keys(CALLS).filter((name) => !names.includes(name))).toEqual([]);
    expect(
      Object.keys(MCP_EXEMPT).filter((name) => !names.includes(name) || name in CALLS),
    ).toEqual([]);
    for (const [name, reason] of Object.entries(MCP_EXEMPT)) {
      expect(reason.length).toBeGreaterThan(10);
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      expect({ name, fields: idFields(tool?.input) }).toEqual({ name, fields: [] });
    }
  });

  for (const tool of MCP_TOOLS) {
    const name = tool.name as string;
    if (name in MCP_EXEMPT) continue;
    const calls = CALLS[name] ?? [];
    it(`${name}: has at least one call aimed at A's ids`, () => {
      expect(calls.length).toBeGreaterThan(0);
    });
    for (const args of calls) {
      it(`${name} ${JSON.stringify(args)}: every procedure call runs as B, with no owner in its input`, async () => {
        // The call must reach a procedure: an input refusal would prove nothing.
        expect(tool.input.safeParse(args).success).toBe(true);
        const invoke = vi.fn(async () => {
          throw new Error("refused");
        });
        const result = await runMcpTool(tool, { dispatch: dispatch(), args, invoke });
        expect(result.isError).toBe(true);
        expect(invoke).toHaveBeenCalled();
        for (const [, input, context] of invoke.mock.calls as unknown as Array<
          [
            string,
            Record<string, unknown>,
            { auth: { userId: string }; session: { user: { id: string } } },
          ]
        >) {
          expect(context.auth.userId).toBe(ATTACKER);
          expect(context.session.user.id).toBe(ATTACKER);
          expect(input).not.toHaveProperty("userId");
        }
      });

      it(`${name} ${JSON.stringify(args)}: a smuggled userId is refused before any procedure runs`, async () => {
        const invoke = vi.fn();
        const result = await runMcpTool(tool, {
          dispatch: dispatch(),
          args: { ...args, userId: VICTIM },
          invoke,
        });
        expect(result.isError).toBe(true);
        expect(invoke).not.toHaveBeenCalled();
      });
    }
  }
});

// ── Interactive steps: attach, reopen, cancel ──

describe("interactive steps of another user's instance", () => {
  /** A's step, found only by a lookup that does not name B as the owner. */
  const stepOfA = {
    id: "step-a",
    instanceId: "inst-a",
    nodeId: "node-a",
    phase: "START",
    state: "AWAITING_OPERATOR",
    generation: 1,
    intent: INTENT,
    operatorTerminalId: "term-a",
    operatorAcceptedAt: null,
    attempts: 1,
    errorCode: null,
    Instance: {
      id: "inst-a",
      userId: VICTIM,
      startedBy: "USER",
      desiredState: "RUNNING",
      phase: "STARTING",
      Ranks: [],
    },
  };

  function oracle() {
    db.instanceStep.findFirst.mockImplementation((async (args: { where?: unknown }) =>
      namesOwner(args.where, ATTACKER) ? null : stepOfA) as never);
    db.instanceStep.updateMany.mockResolvedValue({ count: 1 } as never);
  }

  it("attach mints no ticket for B, even when the relay holds A's terminal", async () => {
    oracle();
    const tickets = new TerminalTicketStore();
    const relay = {
      // The worst case: the relay would hand out A's live terminal for any user.
      operatorStepTerminal: vi.fn(() => ({
        nodeId: "node-a",
        terminalId: "term-a",
        state: "awaiting" as const,
      })),
    };
    const services = createRuntimeStepServices({
      engine: { reopenStep: vi.fn(), cancelStep: vi.fn() },
      relay,
      tickets,
    });
    const result = await services.attach({
      userId: ATTACKER,
      sessionId: "sess-b",
      stepId: "step-a",
    });
    expect(result).toEqual({ ok: false, code: "not_found" });
    expect(tickets.size).toBe(0);
    expect(relay.operatorStepTerminal).not.toHaveBeenCalled();
  });

  for (const action of ["reopenStep", "cancelStep"] as const) {
    it(`${action} by B changes nothing of A's and closes no terminal`, async () => {
      oracle();
      const relay = {
        sendToNode: vi.fn(() => true),
        nodeSession: vi.fn(() => null),
        closeOperatorStep: vi.fn(() => "closed" as const),
        closeOperatorTerminal: vi.fn(),
      };
      const lifecycle = new RuntimeLifecycle(relay);
      await expect(lifecycle[action]({ userId: ATTACKER, stepId: "step-a" })).rejects.toEqual(
        new OperatorStepError("not_found"),
      );
      expect(db.instanceStep.updateMany).not.toHaveBeenCalled();
      expect(db.runtimeInstance.update).not.toHaveBeenCalled();
      expect(relay.closeOperatorStep).not.toHaveBeenCalled();
      expect(relay.sendToNode).not.toHaveBeenCalled();
    });
  }
});

// ── Lifecycle dispatch: a step goes only to a node of its instance's owner ──

describe("lifecycle dispatch", () => {
  const nonInteractive = { ...INTENT, interactive: false };

  function pendingStep(instanceOwner: string) {
    return {
      id: "step-1",
      instanceId: "inst-1",
      nodeId: "node-a",
      phase: "START",
      state: "PENDING",
      generation: 1,
      sequence: 120,
      notBefore: null,
      attempts: 0,
      errorCode: null,
      operatorHold: null,
      intent: nonInteractive,
      intentHash: "c".repeat(64),
      Instance: {
        id: "inst-1",
        userId: instanceOwner,
        startedBy: "USER",
        desiredState: "RUNNING",
        phase: "STARTING",
        Ranks: [{ rank: 0, nodeId: "node-a", claim: "HELD", blockedBy: [] }],
        LaunchVersion: { spec: {}, editor: "USER" },
      },
    };
  }

  /**
   * One dispatch pass over one pending step of `instanceOwner`'s on node-a. node-a's row is
   * `nodeOwner`'s, its live session `sessionOwner`'s (both A by default).
   */
  async function dispatchOnce(
    instanceOwner: string,
    {
      nodeOwner = VICTIM,
      sessionOwner = VICTIM,
    }: { nodeOwner?: string; sessionOwner?: string } = {},
  ) {
    db.instanceStep.findMany.mockResolvedValue([
      {
        id: "step-1",
        nodeId: "node-a",
        instanceId: "inst-1",
        Instance: { userId: instanceOwner },
      },
    ] as never);
    db.instanceStep.findUnique.mockResolvedValue(pendingStep(instanceOwner) as never);
    db.instanceStep.aggregate.mockResolvedValue({ _max: { generation: 1 } } as never);
    db.instanceStep.count.mockResolvedValue(0 as never);
    db.instanceStep.updateMany.mockResolvedValue({ count: 1 } as never);
    // The owner is active (not banned or deleting): the engine checks before any start.
    db.user.findUnique.mockResolvedValue({
      deletionRequestedAt: null,
      banned: false,
      banExpires: null,
    } as never);
    db.node.findUnique.mockResolvedValue({
      userId: nodeOwner,
      trust: "FULL",
      trustLowerRequestedAt: null,
      connectionGeneration: 1,
    } as never);
    const relay = {
      sendToNode: vi.fn(() => true),
      nodeSession: vi.fn(() => ({
        userId: sessionOwner,
        connectionGeneration: 1,
        trust: "full" as const,
        operatorTerminals: false,
      })),
      onlineNodeIds: () => ["node-a"],
    };
    const lifecycle = new RuntimeLifecycle(relay);
    await (lifecycle as unknown as { dispatchSteps(): Promise<void> }).dispatchSteps();
    return relay;
  }

  /** Runs `work` with console.warn captured; returns the warnings. */
  async function warnings(work: () => Promise<unknown>) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await work();
      return warn.mock.calls;
    } finally {
      warn.mockRestore();
    }
  }
  const REFUSED = ["[relay] refused a send to a node of another owner", "runtime_step"];

  it("never sends B's step to A's node and claims nothing", async () => {
    let relay: Awaited<ReturnType<typeof dispatchOnce>> | undefined;
    // node-a's row and live session are A's; the instance is B's.
    expect(await warnings(async () => (relay = await dispatchOnce(ATTACKER)))).toEqual([REFUSED]);
    expect(relay?.sendToNode).not.toHaveBeenCalled();
    expect(db.instanceStep.updateMany).not.toHaveBeenCalled();
  });

  it("never sends a step to a live session of another owner, even when the rows agree", async () => {
    let relay: Awaited<ReturnType<typeof dispatchOnce>> | undefined;
    // Instance and node row are A's; the session on node-a is B's (a slip elsewhere).
    expect(
      await warnings(async () => (relay = await dispatchOnce(VICTIM, { sessionOwner: ATTACKER }))),
    ).toEqual([REFUSED]);
    expect(relay?.sendToNode).not.toHaveBeenCalled();
    expect(db.instanceStep.updateMany).not.toHaveBeenCalled();
  });

  it("never claims a step whose node row is another owner's, even when the session agrees", async () => {
    let relay: Awaited<ReturnType<typeof dispatchOnce>> | undefined;
    // Instance and live session are B's; node-a's row is A's.
    expect(
      await warnings(
        async () => (relay = await dispatchOnce(ATTACKER, { sessionOwner: ATTACKER })),
      ),
    ).toEqual([REFUSED]);
    expect(relay?.sendToNode).not.toHaveBeenCalled();
    expect(db.instanceStep.updateMany).not.toHaveBeenCalled();
  });

  it("sends the same step when node and instance have one owner (control)", async () => {
    const relay = await dispatchOnce(VICTIM);
    expect(relay.sendToNode).toHaveBeenCalledWith(
      "node-a",
      expect.objectContaining({ type: "runtime.job", stepId: "step-1" }),
      // Pinned to the instance's owner at the relay too.
      { connectionGeneration: 1, userId: VICTIM, ownerCheck: "runtime_step" },
    );
  });
});

// ── Definition sync: a node receives only its own owner's definitions ──

describe("definition sync", () => {
  it("reads every version it pushes to A's node under A's ownership", async () => {
    db.node.findUnique.mockResolvedValue({
      userId: VICTIM,
      trust: "FULL",
      trustLowerRequestedAt: null,
      heldDefinitions: [],
      portStart: 30000,
      portEnd: 30010,
      metricCommands: [],
      commandMaxMs: 3_600_000,
      FabricMembers: [],
    } as never);
    db.runtimeVersion.findMany.mockResolvedValue([] as never);
    const state = await loadNodeDefinitionState("node-a");
    expect(state?.userId).toBe(VICTIM);
    const calls = db.runtimeVersion.findMany.mock.calls;
    // Running instances, always-on, profile pins and startable runtimes.
    expect(calls).toHaveLength(4);
    for (const [args] of calls) {
      expect(namesOwner(args?.where, VICTIM)).toBe(true);
      expect(namesOwner(args?.where, ATTACKER)).toBe(false);
    }
  });
});

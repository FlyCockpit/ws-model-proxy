/**
 * The STOP a forced update makes of a node's instances, through the production stop pipeline
 * (`stopInstancesOnNode` → `graphWrite` → `runCapacityOrderedTransaction`, the fences,
 * `markInstancesStopping`, the dispatch): only Prisma is a fake. The update-authority lock is
 * taken in the stop's own transaction, after its fences; a revocation that lands before it, at
 * any await of the stop (the instance read, the fence waits, the writes), records and dispatches
 * nothing (F-FA-2).
 */
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentUpdateDb, nodeRow } from "../lib/agent-update-test-fake";

const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@ws-model-proxy/db", () => ({
  get default() {
    return fake.db;
  },
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com" },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: {} }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/db/node-security", () => ({ credentialDigest: vi.fn() }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import type { Context } from "../context";
import type { AgentUpdatePort, AgentUpdateRelease } from "../lib/agent-updates";
import { nodesRouter } from "../routers/nodes";
import { OWNER, PERSON, session } from "./lane-b-test-helpers";

const TARGET = "x86_64-unknown-linux-gnu";
const RELEASE: AgentUpdateRelease = {
  kind: "release",
  version: "0.4.3",
  commit: null,
  releaseUrl: "https://r.example/v0.4.3",
  artifacts: { [TARGET]: { url: "https://r.example/v0.4.3/a.tar.xz", sha256: "a".repeat(64) } },
};
const SELF_UPDATE = { strategies: ["self-replace"], instancesSurvive: false, remote: "allowed" };

type Row = Record<string, unknown>;
type Hook = () => Promise<void> | void;

let store: ReturnType<typeof createAgentUpdateDb>;
let sent: number;
let remote: "allowed" | "off";
let generation: number;
/** Committed STOP writes (the operation, the instance marks). */
let operations: Row[];
let marks: Row[];
let dispatched: string[];
/** Called at each await of the stop's transaction (and before the dispatch), once each. */
let hooks: Partial<
  Record<"instances" | "ownerFence" | "capacityFences" | "operation" | "dispatch", Hook>
>;

async function run(stage: keyof typeof hooks) {
  const hook = hooks[stage];
  delete hooks[stage];
  await hook?.();
}

const port: AgentUpdatePort = {
  server: async () => ({
    version: "0.4.3",
    commit: null,
    sourceBuild: false,
    cargoInstall: "cargo install --git R --tag v0.4.3 --locked --force wsmp",
    windowsUpdates: false,
  }),
  release: async () => RELEASE,
  liveNode: () => ({
    userId: OWNER,
    connectionGeneration: generation,
    trust: "full",
    selfUpdate: { ...SELF_UPDATE, remote } as never,
  }),
  send: () => {
    sent += 1;
    return true;
  },
};

/**
 * The store's client, plus what the stop pipeline needs: the fence statements (taken, and a
 * hook at each), and staged `runtimeOperation` / `runtimeInstance` writes, kept only when the
 * transaction commits (as a rollback would drop them).
 */
function database() {
  const base = store.client;
  return {
    ...base,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      base.$transaction(async (inner) => {
        const tx = inner as Row & {
          $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
        };
        const stagedOperations: Row[] = [];
        const stagedMarks: Row[] = [];
        let fenceCalls = 0;
        const result = await work({
          ...tx,
          $executeRaw: async () => 0,
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (strings.join("?").includes("wsmp_acquire_fences")) {
              fenceCalls += 1;
              await run(fenceCalls === 1 ? "ownerFence" : "capacityFences");
              return [{ acquired: true }];
            }
            return tx.$queryRaw(strings, ...values);
          },
          runtimeInstance: {
            findMany: async () => {
              await run("instances");
              return [{ id: "instance-1", Ranks: [], Reservations: [] }];
            },
            findUnique: async () => null,
            findFirst: async () => null,
            updateMany: async (args: Row) => {
              stagedMarks.push(args);
              return { count: 1 };
            },
          },
          runtimeOperation: {
            create: async (args: { data: Row }) => {
              await run("operation");
              stagedOperations.push(args.data);
              return { id: `op-${operations.length + stagedOperations.length}` };
            },
          },
        });
        operations.push(...stagedOperations);
        marks.push(...stagedMarks);
        return result;
      }),
  };
}

function client() {
  const context: Context = {
    session,
    auth: PERSON,
    services: {
      agentUpdates: port,
      dispatchRuntimeOperation: async ({ operationId }) => {
        await run("dispatch");
        dispatched.push(operationId);
      },
    },
  };
  return createRouterClient(nodesRouter, { context }).agentUpdate;
}

beforeEach(() => {
  store = createAgentUpdateDb();
  fake.db = database();
  sent = 0;
  remote = "allowed";
  generation = 1;
  operations = [];
  marks = [];
  dispatched = [];
  hooks = {};
  store.tables.node.push(nodeRow({ userId: OWNER, features: { selfUpdate: { ...SELF_UPDATE } } }));
});

const turnOff = async () => {
  await client().setPolicy({ nodeId: "node-1", policy: "OFF" });
};
const optOutLive = () => {
  remote = "off";
};
const optOutStored = () => {
  Object.assign(store.tables.node[0] ?? {}, {
    features: { selfUpdate: { ...SELF_UPDATE, remote: "off" } },
  });
};
const lowerTrust = () => {
  Object.assign(store.tables.node[0] ?? {}, { trustLowerRequestedAt: new Date() });
};
const reconnect = () => {
  generation = 2;
};

/** The STOP part of the result: what was recorded, marked and dispatched. */
function stopped() {
  return { operations: operations.length, marks: marks.length, dispatched: dispatched.length };
}

describe("a forced update's STOP, through the production stop pipeline", () => {
  it("records, marks and dispatches the STOP when nothing changes (allowed control)", async () => {
    await client().start({ nodeId: "node-1", force: true });
    expect(sent).toBe(1);
    expect(stopped()).toEqual({ operations: 1, marks: 1, dispatched: 1 });
    expect(operations[0]).toMatchObject({ kind: "STOP", summary: { stops: ["instance-1"] } });
    // The lock is the stop transaction's, after both fence calls.
    const lockInStop = store.operations.filter((entry) => entry.op === "lockNode");
    expect(lockInStop.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["policy off", turnOff],
    ["a live opt-out", optOutLive],
    ["a stored opt-out", optOutStored],
    ["a trust lowering", lowerTrust],
    ["a reconnect", reconnect],
  ] as const)("records nothing when %s lands during the instance read", async (_label, change) => {
    hooks.instances = change;
    await client().start({ nodeId: "node-1", force: true });
    expect(sent).toBe(1);
    expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
  });

  it.each([
    ["policy off", turnOff],
    ["a live opt-out", optOutLive],
    ["a stored opt-out", optOutStored],
  ] as const)(
    "records nothing when %s lands during the owner fence wait",
    async (_label, change) => {
      hooks.ownerFence = change;
      await client().start({ nodeId: "node-1", force: true });
      expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
    },
  );

  it.each([
    ["policy off", turnOff],
    ["a live opt-out", optOutLive],
    ["a stored opt-out", optOutStored],
    ["a trust lowering", lowerTrust],
  ] as const)(
    "records nothing when %s lands during the capacity fence wait",
    async (_label, change) => {
      hooks.capacityFences = change;
      await client().start({ nodeId: "node-1", force: true });
      expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
    },
  );

  it.each([
    ["a live opt-out", optOutLive],
    ["a reconnect", reconnect],
  ] as const)("rolls the STOP back when %s lands during its writes", async (_label, change) => {
    hooks.operation = change;
    await client().start({ nodeId: "node-1", force: true });
    // The operation was written in the transaction, then the check before the commit refused it.
    expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
  });

  it("records nothing for an update that ended before its STOP", async () => {
    hooks.instances = () => {
      Object.assign(store.tables.nodeAgentUpdate[0] ?? {}, {
        phase: "REFUSED",
        endedAt: new Date(),
      });
    };
    await client().start({ nodeId: "node-1", force: true });
    expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
  });

  // The STOP's authorization point is its commit (owner decision, round 12): a committed STOP is
  // always dispatched, after the commit, and is never checked again or called back then, as a
  // sent agent.update is not. The node still refuses the update itself.
  for (const [label, revoke] of [
    ["browser updates off", turnOff],
    ["a live opt-out", optOutLive],
    [
      "a successor hello",
      () => {
        generation = 2;
        Object.assign(store.tables.node[0] ?? {}, { connectionGeneration: 2 });
      },
    ],
  ] as const)
    it(`always dispatches a committed STOP: ${label} after the commit does not recall it`, async () => {
      hooks.dispatch = revoke;
      await client().start({ nodeId: "node-1", force: true });
      expect(stopped()).toEqual({ operations: 1, marks: 1, dispatched: 1 });
    });

  it("records no STOP when a successor hello committed its generation while the session map still holds the old one", async () => {
    hooks.instances = () => {
      Object.assign(store.tables.node[0] ?? {}, { connectionGeneration: 2 });
    };
    await client().start({ nodeId: "node-1", force: true });
    expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
  });

  it("sends no forced frame and stops nothing when policy off commits after the claim", async () => {
    const transaction = (fake.db as { $transaction: typeof store.client.$transaction })
      .$transaction;
    let calls = 0;
    (fake.db as { $transaction: typeof store.client.$transaction }).$transaction = async (work) => {
      const result = await transaction(work);
      calls += 1;
      if (calls === 1) await turnOff();
      return result;
    };
    await expect(client().start({ nodeId: "node-1", force: true })).rejects.toMatchObject({
      data: { reason: "agent_update_off" },
    });
    expect(sent).toBe(0);
    expect(store.tables.nodeAgentUpdate).toEqual([]);
    expect(stopped()).toEqual({ operations: 0, marks: 0, dispatched: 0 });
  });
});

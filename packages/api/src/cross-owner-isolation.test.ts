/**
 * Cross-owner isolation of every procedure that can reach a node, a runtime, an instance, a step
 * or a terminal: user B's credentials (a Full agent token, a Full OAuth grant, a cookie with its
 * CSRF header) aim at user A's ids and must be refused with no side effect.
 *
 * The database mock is an owner oracle: a query that names B as an owner (`userId`,
 * `ownerUserId`, `granteeUserId`, anywhere in its `where`) sees B's world (nothing of A's); a
 * query that names no owner sees A's rows, as an unscoped lookup would in production. So a
 * procedure that looked A's row up by id alone would get it, carry on and reach a service or a
 * write, which fails the test. Writes never happen on a refusal: no create, update, upsert or
 * delete is called, and no conditional write that names no owner.
 */
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_MCP_ENABLED: true,
    WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: true,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    SIGNUP_ENABLED: true,
  },
  SIGNUP_ENABLED: true,
}));
vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async () => true),
    fenceParentDelete: vi.fn(async () => []),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});

import type { Session } from "@ws-model-proxy/auth";
import prisma from "@ws-model-proxy/db";
import type { Context, ContextServices } from "./context";
import type { CallerAuth } from "./contracts/auth-context";
import { appRouter } from "./routers/index";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const VICTIM = "user-a";
const ATTACKER = "user-b";

// ── The owner oracle ──

const OWNER_KEYS = new Set(["userId", "ownerUserId", "granteeUserId"]);

/** Whether a Prisma `where` names `owner` as an owner anywhere (nested relations, OR, AND). */
function namesOwner(value: unknown, owner: string, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 10) return false;
  if (Array.isArray(value)) return value.some((entry) => namesOwner(entry, owner, depth + 1));
  for (const [key, entry] of Object.entries(value)) {
    if (OWNER_KEYS.has(key)) {
      if (entry === owner) return true;
      if (entry && typeof entry === "object" && Reflect.get(entry, "equals") === owner) return true;
    }
    if (namesOwner(entry, owner, depth + 1)) return true;
  }
  return false;
}

const future = () => new Date(Date.now() + 3_600_000);

/** What an unscoped lookup would find: one of A's rows, shaped to satisfy any procedure. */
function victimRow(): Record<string, unknown> {
  const node = {
    id: "node-a",
    userId: VICTIM,
    slug: "a-box",
    trust: "FULL",
    trustChangedAt: new Date(0),
    trustLowerRequestedAt: null,
    connection: "ONLINE",
  };
  return {
    ...node,
    id: "row-a",
    nodeId: "node-a",
    ownerUserId: VICTIM,
    name: "A",
    commandMaxMs: 3_600_000,
    heldMetricCommandsHash: null,
    heldDefinitions: [],
    metricCommands: [],
    features: {},
    detectedServers: [{ baseUrl: "http://127.0.0.1:8000", engine: "vllm", api: "openai" }],
    FabricMembers: [],
    Members: [],
    state: "RUNNING",
    command: "id",
    note: null,
    agentTokenId: null,
    mcpGrantId: null,
    actor: "USER",
    subject: "hmac-sha256:00 id",
    exitCode: null,
    startedAt: new Date(),
    endsBy: future(),
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: future(),
    decidedAt: null,
    outcome: null,
    kind: "STARTABLE",
    origin: "SERVER",
    currentVersionId: "ver-a",
    runtimeId: "rt-a",
    phase: "STOPPING",
    desiredState: "RUNNING",
    startedBy: "USER",
    operatorTerminalId: "term-a",
    intent: {},
    Ranks: [{ id: "rank-a", rank: 0, claim: "HELD", nodeId: "node-a", Node: node }],
    Instance: { userId: VICTIM, startedBy: "USER" },
    Node: node,
    Nodes: [{ nodeId: "node-a", hold: false, holdNote: null }],
    Items: [],
    Runtime: { id: "rt-a", userId: VICTIM, kind: "STARTABLE", currentVersionId: "ver-a" },
    canContribute: true,
    canUse: true,
    retired: false,
    type: "LLM",
    upstreamModelId: "m",
    modelType: "LLM",
  };
}

/** Rows B owns, found by id whether or not the query names an owner. */
const ATTACKER_SPEC = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "m" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "none" }],
    labels: [],
    commands: [{ start: "serve --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
    health: { intervalMs: 15_000, failureThreshold: 2, successThreshold: 1 },
  },
};
const ATTACKER_ROWS: Record<string, Record<string, Record<string, unknown>>> = {
  runtime: {
    "rt-b": { id: "rt-b", userId: ATTACKER, kind: "STARTABLE", currentVersionId: "ver-b" },
  },
  runtimeVersion: {
    "ver-b": { id: "ver-b", runtimeId: "rt-b", spec: ATTACKER_SPEC },
  },
};

/** Models whose rows are the caller's own credential or account (looked up by id). */
const CALLER_MODELS = new Set(["user", "agentToken", "mcpGrant"]);

function callerRow(): Record<string, unknown> {
  return {
    id: ATTACKER,
    userId: ATTACKER,
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
    name: "tok",
    expiresAt: null,
    role: "user",
    twoFactorEnabled: false,
  };
}

const READS = ["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow"] as const;
const LISTS = ["findMany"] as const;
const WRITES = [
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "upsert",
  "delete",
  "deleteMany",
] as const;

type Log = { writes: string[]; unscopedWrites: string[]; unscopedReads: string[] };
const log: Log = { writes: [], unscopedWrites: [], unscopedReads: [] };

const MODELS = [
  "node",
  "nodeCommand",
  "queuedNodeCommand",
  "nodeAuditEvent",
  "fabric",
  "fabricMember",
  "runtime",
  "runtimeVersion",
  "runtimeInstance",
  "instanceRank",
  "instanceStep",
  "runtimeOperation",
  "runtimeModel",
  "runtimeShare",
  "profile",
  "profileItem",
  "profileNode",
  "pool",
  "poolMember",
  "share",
  "user",
  "agentToken",
  "mcpGrant",
  "executionTarget",
] as const;

function installOracle() {
  for (const model of MODELS) {
    const delegate = Reflect.get(db, model) as Record<string, ReturnType<typeof vi.fn>>;
    const scoped = (args: { where?: unknown } | undefined) => namesOwner(args?.where, ATTACKER);
    const own = (args: { where?: unknown } | undefined) => {
      const id = (args?.where as { id?: unknown } | undefined)?.id;
      return typeof id === "string" ? ATTACKER_ROWS[model]?.[id] : undefined;
    };
    for (const method of READS) {
      delegate[method]?.mockImplementation((async (args?: { where?: unknown }) => {
        if (CALLER_MODELS.has(model)) return callerRow();
        const mine = own(args);
        if (mine) return mine;
        if (scoped(args)) {
          if (method.endsWith("OrThrow")) throw new Error("not found");
          return null;
        }
        log.unscopedReads.push(`${model}.${method}`);
        return victimRow();
      }) as never);
    }
    for (const method of LISTS) {
      delegate[method]?.mockImplementation((async (args?: { where?: unknown }) => {
        if (CALLER_MODELS.has(model)) return [callerRow()];
        if (scoped(args)) return [];
        log.unscopedReads.push(`${model}.${method}`);
        return [victimRow()];
      }) as never);
    }
    delegate.count?.mockImplementation((async (args?: { where?: unknown }) => {
      if (scoped(args)) return 0;
      log.unscopedReads.push(`${model}.count`);
      return 1;
    }) as never);
    delegate.aggregate?.mockImplementation((async () => ({ _max: {}, _count: 0 })) as never);
    delegate.updateMany?.mockImplementation((async (args?: { where?: unknown }) => {
      if (scoped(args)) return { count: 0 };
      log.unscopedWrites.push(`${model}.updateMany`);
      return { count: 1 };
    }) as never);
    for (const method of WRITES) {
      delegate[method]?.mockImplementation((async () => {
        log.writes.push(`${model}.${method}`);
        return victimRow();
      }) as never);
    }
  }
  db.$transaction.mockImplementation((async (work: unknown) =>
    typeof work === "function" ? work(db) : Promise.all(work as Promise<unknown>[])) as never);
  db.$queryRaw.mockResolvedValue([] as never);
  db.$executeRaw.mockResolvedValue(0 as never);
}

// ── Services: every one is a side effect on a node, an instance or a terminal ──

function servicesSpy() {
  const nodes = {
    definitionChanged: vi.fn(async () => {}),
    writeSecrets: vi.fn(async () => [{ name: "HF_TOKEN", status: "set" as const }]),
    rescan: vi.fn(async () => {}),
    lowerTrust: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    profileApplied: vi.fn(async () => {}),
  };
  const nodeOperator = {
    openTerminalTicket: vi.fn(async () => ({
      ticket: "t".repeat(43),
      terminalId: "term-x",
      expiresAt: future(),
    })),
    startCommand: vi.fn(async () => ({ startedAt: new Date(), endsBy: future() })),
    pollCommand: vi.fn(async () => null),
  };
  const runtimeSteps = {
    // The server's step services scope by the user id they are given (tested in apps/server):
    // here they answer as they would for a step that is not the caller's.
    attach: vi.fn(async () => ({ ok: false as const, code: "not_found" as const })),
    reopen: vi.fn(async () => ({ ok: false as const, code: "not_found" as const })),
    cancel: vi.fn(async () => ({ ok: false as const, code: "not_found" as const })),
  };
  const services = {
    nodes,
    nodeOperator,
    runtimeSteps,
    dispatchRuntimeOperation: vi.fn(async () => {}),
    pushRuntimeDefinitions: vi.fn(async () => []),
    modelTest: vi.fn(async () => {
      throw new Error("a model test must not run");
    }),
    onPoolRoutingRulesChanged: vi.fn(async () => {}),
  } satisfies ContextServices;
  /** Every side-effect hook that was called, by name. */
  const sideEffects = () =>
    [
      ...Object.entries(nodes),
      ...Object.entries(nodeOperator),
      ["dispatchRuntimeOperation", services.dispatchRuntimeOperation],
      ["pushRuntimeDefinitions", services.pushRuntimeDefinitions],
      ["modelTest", services.modelTest],
    ]
      .filter(([, fn]) => (fn as ReturnType<typeof vi.fn>).mock.calls.length > 0)
      .map(([name]) => name as string);
  return { services, runtimeSteps, sideEffects };
}

// ── B's credentials ──

const session = {
  user: {
    id: ATTACKER,
    email: "b@example.test",
    name: "B",
    role: "user",
    emailVerified: true,
    twoFactorEnabled: false,
  },
  session: { id: "sess-b", userId: ATTACKER, expiresAt: future(), impersonatedBy: null },
} as unknown as Session;

const CREDENTIALS: ReadonlyArray<[string, CallerAuth]> = [
  [
    "Full agent token",
    { kind: "agent_token", userId: ATTACKER, agentTokenId: "tok-b", level: "FULL" },
  ],
  [
    "Full OAuth grant",
    { kind: "oauth_access_token", userId: ATTACKER, grantId: "grant-b", level: "FULL" },
  ],
  [
    "cookie with CSRF",
    { kind: "cookie_session", userId: ATTACKER, sessionId: "sess-b", csrfVerified: true },
  ],
];

type Callable = (input: unknown) => Promise<unknown>;
function procedureAt(client: unknown, path: string): Callable {
  let node: unknown = client;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  if (typeof node !== "function") throw new Error(`no procedure at ${path}`);
  return node as Callable;
}

/** A node command id of A's (22 base64url characters). */
const COMMAND_A = "AAAAAAAAAAAAAAAAAAAAAA";

const ADDRESS_SPEC = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  address: { baseUrl: "http://127.0.0.1:8000" },
};

/** Every procedure that reaches a node, runtime, instance, step or terminal, aimed at A's ids. */
const CASES: ReadonlyArray<[string, unknown]> = [
  ["nodes.get", { nodeId: "node-a" }],
  ["nodes.update", { nodeId: "node-a", labels: ["x"], portRange: [30000, 30010], rescan: true }],
  ["nodes.setHold", { nodeId: "node-a", hold: true }],
  ["nodes.setTemporary", { nodeId: "node-a", removeAfterOfflineMs: null }],
  ["nodes.rename", { nodeId: "node-a", name: "mine now" }],
  ["nodes.delete", { nodeId: "node-a" }],
  ["nodes.lowerTrustPreview", { nodeId: "node-a" }],
  // A replace code would move A's node to whoever enrolls with it.
  ["nodes.enrollmentCodes.create", { replaceNodeId: "node-a" }],
  ["nodes.credentials.revoke", { credentialId: "cred-a" }],
  ["nodes.lowerTrust", { nodeId: "node-a" }],
  ["nodes.secrets.set", { nodeId: "node-a", name: "WSMP_SECRET_HF", value: "stolen" }],
  ["nodes.secrets.delete", { nodeId: "node-a", name: "WSMP_SECRET_HF" }],
  ["nodes.terminals.openTicket", { nodeId: "node-a", cols: 80, rows: 24 }],
  ["nodes.queued.enqueue", { nodeId: "node-a", command: "id", note: "n", expiresInHours: 1 }],
  ["nodes.queued.run", { queuedCommandId: "q-a", cols: 80, rows: 24 }],
  ["nodes.queued.dismiss", { queuedCommandId: "q-a" }],
  ["nodes.commands.run", { nodeId: "node-a", command: "id", timeoutMs: 10_000, confirm: "RUN" }],
  ["nodes.commands.get", { commandId: COMMAND_A, cancel: true }],
  ["nodes.commands.get", { commandId: COMMAND_A, waitMs: 1_000 }],
  // Not wired to the relay in 0.4.0 (stubs): nothing reaches a node at all.
  ["nodes.files.read", { nodeId: "node-a", path: "/etc/hostname" }],
  ["nodes.files.write", { nodeId: "node-a", path: "/tmp/x", content: "x" }],
  [
    "nodes.files.edit",
    { nodeId: "node-a", path: "/tmp/x", edits: [{ old: "a", new: "b" }], ifMatch: "e" },
  ],
  ["nodes.fabrics.rename", { fabricId: "fab-a", name: "mine" }],
  ["nodes.fabrics.delete", { fabricId: "fab-a" }],
  ["runtimes.start", { runtimeId: "rt-a", preview: true }],
  ["runtimes.start", { runtimeId: "rt-a" }],
  ["runtimes.start", { runtimeId: "rt-b", nodeIds: ["node-a"] }],
  ["runtimes.start", { runtimeId: "rt-b", instanceId: "inst-a" }],
  ["runtimes.stop", { instanceId: "inst-a" }],
  ["runtimes.stop", { runtimeId: "rt-a", nodeId: "node-a" }],
  ["runtimes.instances.forget", { instanceId: "inst-a" }],
  ["runtimes.steps.attach", { stepId: "step-a", cols: 80, rows: 24 }],
  ["runtimes.steps.reopen", { stepId: "step-a" }],
  ["runtimes.steps.cancel", { stepId: "step-a" }],
  ["runtimes.detected.add", { nodeId: "node-a", baseUrl: "http://127.0.0.1:8000" }],
  [
    "runtimes.create",
    { slug: "mine", name: "Mine", kind: "ALWAYS_ON", nodeId: "node-a", spec: ADDRESS_SPEC },
  ],
  ["runtimes.update", { runtimeId: "rt-a", spec: ATTACKER_SPEC }],
  ["runtimes.delete", { runtimeId: "rt-a" }],
  ["runtimes.models.setCapabilities", { runtimeModelId: "rm-a", capabilities: null }],
  ["profiles.apply", { profileId: "prof-a" }],
  ["profiles.apply", { profileId: "prof-a", preview: true }],
  ["profiles.save", { slug: "mine", name: "Mine", nodeIds: ["node-a"], items: [] }],
  ["models.test", { target: { runtimeId: "rt-a" } }],
  ["models.test", { target: { runtimeId: "rt-a", instanceId: "inst-a" } }],
  ["pools.members.addContributed", { poolId: "pool-a", runtimeModelId: "rm-a" }],
];

/** Refusals (never a crash: an INTERNAL_SERVER_ERROR could hide a lookup that found A's row). */
const REFUSAL_CODES = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

beforeEach(() => {
  mockReset(db);
  installOracle();
  log.writes.length = 0;
  log.unscopedWrites.length = 0;
  log.unscopedReads.length = 0;
});

describe("user B cannot reach user A's nodes, runtimes, instances, steps or terminals", () => {
  for (const [label, auth] of CREDENTIALS) {
    for (const [path, input] of CASES) {
      it(`${label}: ${path} ${JSON.stringify(input)}`, async () => {
        const { services, runtimeSteps, sideEffects } = servicesSpy();
        const context: Context = { session, auth, services };
        const client = createRouterClient(appRouter, { context });
        let outcome: unknown;
        let error: unknown;
        try {
          outcome = await procedureAt(client, path)(input);
        } catch (caught) {
          error = caught;
        }
        // A start preview answers instead of throwing: it must place nothing on A's node.
        if (error === undefined) {
          expect(path).toBe("runtimes.start");
          const preview = (outcome as { preview?: { starts: unknown[]; refusals: unknown[] } })
            .preview;
          expect(preview?.starts).toEqual([]);
          expect(preview?.refusals).toEqual([
            expect.objectContaining({ reason: "unknown_node", subjectId: "node-a" }),
          ]);
        } else {
          expect(error).toBeInstanceOf(ORPCError);
          const refusal = error as ORPCError<string, unknown>;
          // The file procedures are stubs until the file relay is wired.
          const stub = path.startsWith("nodes.files.") && refusal.code === "NOT_IMPLEMENTED";
          expect(stub || REFUSAL_CODES.has(refusal.code)).toBe(true);
          // A refusal of the input itself would prove nothing about ownership.
          expect(refusal.message).not.toBe("Input validation failed");
        }
        // No side effect: no relay hook, no row written, no unscoped conditional write.
        expect(sideEffects()).toEqual([]);
        expect(log.writes).toEqual([]);
        expect(log.unscopedWrites).toEqual([]);
        // The step services were only ever asked about B's own steps.
        for (const fn of [runtimeSteps.attach, runtimeSteps.reopen, runtimeSteps.cancel])
          for (const [call] of fn.mock.calls as unknown as Array<[{ userId: string }]>)
            expect(call.userId).toBe(ATTACKER);
        // No lookup by id alone (or by A's id under no owner) ever ran.
        expect(log.unscopedReads).toEqual([]);
      });
    }
  }
});

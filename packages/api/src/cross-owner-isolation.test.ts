/**
 * Cross-owner isolation of every procedure that can reach a node, a runtime, an instance, a step
 * or a terminal: user B's credentials (a Full agent token, a Full OAuth grant, a cookie with its
 * CSRF header) aim at user A's ids and must be refused (or, for a read, answer nothing of A's)
 * with no side effect. The procedure list comes from the contract (checked against `appRouter`):
 * every procedure is covered by a case or exempted, with a reason, in EXEMPT.
 *
 * The database mock is an owner oracle: a query that names B as an owner (`userId`,
 * `ownerUserId`, `granteeUserId`, `resourceOwnerUserId`, anywhere in its `where`) sees B's world
 * (nothing of A's); a query that names no owner sees A's rows, as an unscoped lookup would in
 * production. So a procedure that looked A's row up by id alone would get it, carry on and reach
 * a service or a write, which fails the test. Writes never happen on a refusal: no update, upsert
 * or delete is called, no create of a row that is not B's own, and no conditional write that
 * names no owner.
 */
import { createRouterClient, isProcedure, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import { z } from "zod";
import { Prisma } from "../../db/prisma/generated/browser";
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
import { apiContract } from "./contracts/index";
import { flattenContract } from "./contracts/procedure";
import { appRouter } from "./routers/index";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const VICTIM = "user-a";
const ATTACKER = "user-b";

// ── The owner oracle ──

const OWNER_KEYS = new Set(["userId", "ownerUserId", "granteeUserId", "resourceOwnerUserId"]);

/**
 * Whether a Prisma `where` restricts the rows to `owner`'s: some conjunct names them as owner
 * (also through a relation filter). An `OR` scopes only when every branch does; `NOT`, `none`
 * and `every` never scope.
 */
function scopedTo(value: unknown, owner: string, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 10) return false;
  if (Array.isArray(value)) return value.some((entry) => scopedTo(entry, owner, depth + 1));
  for (const [key, entry] of Object.entries(value)) {
    if (OWNER_KEYS.has(key)) {
      if (entry === owner) return true;
      if (entry && typeof entry === "object" && Reflect.get(entry, "equals") === owner) return true;
    }
    if (key === "NOT" || key === "none" || key === "every") continue;
    if (key === "OR") {
      if (
        Array.isArray(entry) &&
        entry.length > 0 &&
        entry.every((branch) => scopedTo(branch, owner, depth + 1))
      )
        return true;
      continue;
    }
    if (scopedTo(entry, owner, depth + 1)) return true;
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
  pool: {
    "pool-b": {
      id: "pool-b",
      userId: ATTACKER,
      slug: "b",
      name: "B",
      description: null,
      modelType: "LLM",
    },
  },
};

/** B's own rows' ids as JSON strings: a query keyed by one of them is scoped to B. */
const OWN_ROW_IDS = new RegExp(
  `"(${Object.values(ATTACKER_ROWS)
    .flatMap((rows) => Object.keys(rows))
    .join("|")})"`,
);

/** A's ids as JSON strings: a row B creates must not point at any of them. */
const VICTIM_IDS =
  /"(node-a|rt-a|ver-a|inst-a|rank-a|step-a|prof-a|rm-a|pool-a|pm-a|member-a|fab-a|q-a|share-a|code-a|cred-a|rule-a|term-a|row-a)"/;

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

type Log = {
  writes: string[];
  unscopedWrites: string[];
  unscopedReads: string[];
  /** Rows B created for B (allowed: they belong to the caller). */
  ownCreates: string[];
};
const log: Log = { writes: [], unscopedWrites: [], unscopedReads: [], ownCreates: [] };

/** Every Prisma model (its client delegate name): none is left unoracled. */
const MODELS = Object.values(Prisma.ModelName).map(
  (name) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`,
);

function installOracle() {
  for (const model of MODELS) {
    const delegate = Reflect.get(db, model) as Record<string, ReturnType<typeof vi.fn>>;
    // Scoped: restricted to B as owner, or keyed by one of B's own rows (e.g. B's pool's
    // members) and naming nothing of A's.
    const scoped = (args: { where?: unknown } | undefined) => {
      if (scopedTo(args?.where, ATTACKER)) return true;
      const json = JSON.stringify(args?.where ?? null);
      return OWN_ROW_IDS.test(json) && !VICTIM_IDS.test(json);
    };
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
      delegate[method]?.mockImplementation((async (args?: { data?: unknown }) => {
        // A new row of B's own (a create that validates afterwards, in its transaction) is
        // not a write to A's data; it answers as B's row.
        const data = args?.data;
        if (method === "create" && data && typeof data === "object" && !Array.isArray(data)) {
          if (Reflect.get(data, "userId") === ATTACKER && !VICTIM_IDS.test(JSON.stringify(data))) {
            log.ownCreates.push(`${model}.create`);
            return { ...victimRow(), ...data, id: `new-${model}` };
          }
        }
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
  const nodeFiles = {
    run: vi.fn(async () => ({ ok: true as const, result: {} })),
    auditRefused: vi.fn(),
  };
  const services = {
    nodes,
    nodeOperator,
    nodeFiles,
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
      ...Object.entries(nodeFiles),
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

/**
 * Every procedure that takes a node, runtime, instance, step, profile or command id, aimed at A's
 * ids. The procedure list is generated from the contract (`apiContract`, checked against
 * `appRouter`): a new procedure fails "covers every procedure" until it has a case here or an
 * entry in EXEMPT.
 */
const CASES: ReadonlyArray<[string, unknown]> = [
  ["nodes.get", { nodeId: "node-a" }],
  ["nodes.credentials.list", { nodeId: "node-a" }],
  ["nodes.activity.list", { nodeId: "node-a" }],
  ["nodes.queued.list", { nodeId: "node-a" }],
  ["nodes.enrollmentCodes.revoke", { codeId: "code-a" }],
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
  // Node file tools: nothing reaches the relay (or the file audit) for A's node.
  ["nodes.files.read", { nodeId: "node-a", path: "/etc/hostname" }],
  ["nodes.files.write", { nodeId: "node-a", path: "/tmp/x", content: "x" }],
  [
    "nodes.files.edit",
    { nodeId: "node-a", path: "/tmp/x", edits: [{ old: "a", new: "b" }], ifMatch: "e" },
  ],
  ["nodes.fabrics.rename", { fabricId: "fab-a", name: "mine" }],
  ["nodes.fabrics.delete", { fabricId: "fab-a" }],
  ["runtimes.get", { runtimeId: "rt-a" }],
  ["runtimes.versions.list", { runtimeId: "rt-a" }],
  ["runtimes.versions.get", { versionId: "ver-a" }],
  ["runtimes.shares.list", { runtimeId: "rt-a" }],
  ["runtimes.shares.create", { runtimeId: "rt-a", email: "b@example.test" }],
  ["runtimes.shares.delete", { shareId: "share-a" }],
  ["runtimes.fork", { runtimeId: "rt-a", slug: "mine", name: "Mine" }],
  ["runtimes.fork", { runtimeId: "rt-b", slug: "mine", name: "Mine", nodeId: "node-a" }],
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
  ["profiles.get", { profileId: "prof-a" }],
  ["profiles.delete", { profileId: "prof-a", confirm: "DELETE" }],
  ["profiles.apply", { profileId: "prof-a" }],
  ["profiles.apply", { profileId: "prof-a", preview: true }],
  ["profiles.save", { slug: "mine", name: "Mine", nodeIds: ["node-a"], items: [] }],
  [
    "profiles.save",
    { profileId: "prof-a", slug: "mine", name: "Mine", nodeIds: ["node-a"], items: [] },
  ],
  ["models.test", { target: { runtimeId: "rt-a" } }],
  ["models.test", { target: { runtimeId: "rt-a", instanceId: "inst-a" } }],
  ["pools.members.addContributed", { poolId: "pool-a", runtimeModelId: "rm-a" }],
  ["pools.members.removeContributed", { memberId: "member-a" }],
  ["pools.get", { poolId: "pool-a" }],
  ["pools.history.list", { poolId: "pool-a" }],
  ["pools.delete", { poolId: "pool-a", confirm: "DELETE" }],
  ["pools.cloud.setMode", { poolId: "pool-a", mode: "OFF" }],
  ["pools.cloud.setPaidWarmProtection", { poolId: "pool-a", enabled: true }],
  ["pools.cloud.setOwnKeyEquivalent", { poolId: "pool-a", model: null }],
  ["pools.routing.setOwnHardwareOnly", { poolId: "pool-a", enabled: true }],
  ["pools.rules.delete", { ruleId: "rule-a" }],
  // B's own pool, naming A's provider model: refused, and no fence of A's target is taken.
  ["pools.update", { poolId: "pool-b", cloudMembers: [{ providerModelId: "pm-a" }] }],
  [
    "pools.create",
    { slug: "mine", name: "Mine", type: "LLM", members: [{ runtimeModelId: "rm-a" }] },
  ],
  [
    "pools.create",
    { slug: "mine", name: "Mine", type: "LLM", members: [{ runtimeId: "rt-a", model: "m" }] },
  ],
  ["pools.update", { poolId: "pool-a", members: { add: [{ runtimeModelId: "rm-a" }] } }],
  [
    "activity.metrics.query",
    { scope: { node: "node-a" }, metrics: ["requests"], range: "1h", step: "1m" },
  ],
  [
    "activity.metrics.query",
    { scope: { runtime: "rt-a" }, metrics: ["requests"], range: "1h", step: "1m" },
  ],
  [
    "activity.metrics.query",
    { scope: { version: "ver-a" }, metrics: ["requests"], range: "1h", step: "1m" },
  ],
  [
    "activity.metrics.query",
    { scope: { instance: "inst-a" }, metrics: ["requests"], range: "1h", step: "1m" },
  ],
  [
    "activity.metrics.query",
    {
      scope: { pool: "pool-a" },
      metrics: ["requests", "kv_usage_max", "cpu_pct"],
      range: "1h",
      step: "1m",
      groupBy: "node",
    },
  ],
  [
    "activity.metrics.query",
    {
      scope: { node: "node-a" },
      metrics: ["custom:gpu_power", "full_ratio"],
      range: "24h",
      step: "5m",
    },
  ],
  ["activity.requests.list", { runtimeId: "rt-a" }],
  ["activity.requests.list", { nodeId: "node-a" }],
  ["activity.requests.list", { versionId: "ver-a" }],
  ["activity.commands.list", { nodeId: "node-a" }],
];

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

/** Any id-shaped field: a target field, `id`, `ids`, or a name ending in `Id` / `Ids`. */
function isIdField(name: string): boolean {
  return TARGET_FIELDS.has(name) || /^ids?$|Ids?$/.test(name);
}

/** The id-shaped fields anywhere in a procedure's input (nested objects, unions, arrays). */
function idFields(schema: z.ZodType): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (value === null || typeof value !== "object" || depth > 16) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    const properties = Reflect.get(value, "properties");
    if (properties && typeof properties === "object")
      for (const key of Object.keys(properties)) if (isIdField(key)) found.add(key);
    for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }), 0);
  return [...found].sort();
}

type Exemption = {
  reason: string;
  /**
   * Every id-shaped input field the procedure takes, with what it names and where its owner
   * scoping is tested (none of them may name a node, runtime, instance, step, profile or
   * command: those procedures are covered in CASES instead).
   */
  ids?: Readonly<Record<string, string>>;
};

const OWN_ACCOUNT: Exemption = { reason: "the caller's own account or settings; takes no id" };
const NO_ID_LIST: Exemption = { reason: "lists the caller's own rows; takes no id" };
const ADMIN_USERS: Exemption = {
  reason: "admin user management (human_admin): names user accounts, never a node or runtime",
  ids: { userId: "a user account; admin-only (routers/users.test.ts)" },
};
const ADMIN_VIEW: Exemption = {
  reason: "admin-only server settings or cross-owner view by design; takes no id",
};
const ACCESS: Exemption = {
  reason:
    "the caller's API keys, agent tokens, OAuth grants, pool shares and invites; owner scoping " +
    "of each id is tested in routers/access.test.ts",
  ids: {
    poolIds: "pools an API key may call (the caller's own or shared to them)",
    apiKeyId: "the caller's API key",
    agentTokenId: "the caller's agent token",
    grantId: "the caller's OAuth grant",
    poolId: "a pool the caller owns (sharing it)",
    shareId: "a share of the caller's pool",
    providerModelId: "the caller's provider model (own-key equivalent)",
    inviteId: "a share invite of the caller's",
  },
};
const PROVIDER: Exemption = {
  reason:
    "the caller's cloud provider accounts, credentials, models, pricing and spend caps; owner " +
    "scoping of each id is tested in routers/providers.test.ts",
  ids: {
    accountId: "the caller's provider account",
    credentialId: "a provider credential of the caller's (not a node credential)",
    modelId: "the caller's provider model",
    versionId: "a provider pricing version of the caller's (not a runtime version)",
    upstreamModelId: "the provider's own model name (free text), not a row id",
  },
};

/** Procedures that take no node, runtime, instance, step, profile or command id. */
const EXEMPT: Readonly<Record<string, Exemption>> = {
  "app.config": OWN_ACCOUNT,
  "app.flags": OWN_ACCOUNT,
  "app.features": OWN_ACCOUNT,
  "auth.inviteInfo": OWN_ACCOUNT,
  "auth.acceptInvite": OWN_ACCOUNT,
  "auth.verifyEmailTransport": OWN_ACCOUNT,
  "auth.updateLocale": OWN_ACCOUNT,
  "auth.passwordCapabilities": OWN_ACCOUNT,
  "settings.get": OWN_ACCOUNT,
  "settings.update": OWN_ACCOUNT,
  "settings.onboarding.complete": OWN_ACCOUNT,
  "users.list": ADMIN_USERS,
  "users.invite": ADMIN_USERS,
  "users.setRole": ADMIN_USERS,
  "users.archive": ADMIN_USERS,
  "users.unarchive": ADMIN_USERS,
  "users.remove": ADMIN_USERS,
  "adminObservability.nodes": ADMIN_VIEW,
  "adminObservability.runtimes": ADMIN_VIEW,
  "adminObservability.pools": ADMIN_VIEW,
  "adminObservability.relay": ADMIN_VIEW,
  "adminSettings.get": ADMIN_VIEW,
  "adminSettings.update": ADMIN_VIEW,
  "nodes.list": NO_ID_LIST,
  "nodes.fabrics.list": NO_ID_LIST,
  "nodes.enrollmentCodes.list": NO_ID_LIST,
  "runtimes.list": NO_ID_LIST,
  "runtimes.presets.list": { reason: "the built-in presets; takes no id" },
  "profiles.list": NO_ID_LIST,
  "pools.list": NO_ID_LIST,
  "models.list": NO_ID_LIST,
  "access.apiKeys.list": ACCESS,
  "access.apiKeys.create": ACCESS,
  "access.apiKeys.revoke": ACCESS,
  "access.agentTokens.list": ACCESS,
  "access.agentTokens.create": ACCESS,
  "access.agentTokens.revoke": ACCESS,
  "access.oauthGrants.list": ACCESS,
  "access.oauthGrants.revoke": ACCESS,
  "access.oauthGrants.setLevel": ACCESS,
  "access.shares.list": ACCESS,
  "access.shares.create": ACCESS,
  "access.shares.update": ACCESS,
  "access.shares.delete": ACCESS,
  "access.shares.setOwnKey": ACCESS,
  "access.invites.resend": ACCESS,
  "access.invites.revoke": ACCESS,
  "access.contributing.pools": ACCESS,
  "providers.accounts.list": PROVIDER,
  "providers.accounts.get": PROVIDER,
  "providers.accounts.create": PROVIDER,
  "providers.accounts.update": PROVIDER,
  "providers.accounts.delete": PROVIDER,
  "providers.accounts.setEnabled": PROVIDER,
  "providers.accounts.setDataCollection": PROVIDER,
  "providers.credentials.replace": PROVIDER,
  "providers.credentials.revoke": PROVIDER,
  "providers.credentials.test": PROVIDER,
  "providers.credentials.reencrypt": PROVIDER,
  "providers.models.list": PROVIDER,
  "providers.models.create": PROVIDER,
  "providers.models.update": PROVIDER,
  "providers.models.delete": PROVIDER,
  "providers.pricing.list": PROVIDER,
  "providers.pricing.create": PROVIDER,
  "providers.pricing.activate": PROVIDER,
  "providers.pricing.retire": PROVIDER,
  "providers.pricing.delete": PROVIDER,
  "providers.catalog.search": PROVIDER,
  "providers.usage.list": PROVIDER,
  "providers.attempts.list": PROVIDER,
  "providers.spendCaps.set": PROVIDER,
  "providers.spendCaps.clear": PROVIDER,
  "activity.requests.delete": {
    reason: "deletes request log rows of the caller's own (routers/activity.test.ts)",
    ids: { ids: "request log row ids, matched under the caller's own rows" },
  },
  "activity.overview.summary": NO_ID_LIST,
  "activity.needsYou.list": NO_ID_LIST,
};

/** Every procedure path the router serves (its leaves), to check the contract list against. */
function routerPaths(tree: unknown, prefix = ""): string[] {
  if (isProcedure(tree)) return [prefix];
  if (tree === null || typeof tree !== "object") return [];
  return Object.entries(tree).flatMap(([key, value]) =>
    routerPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

const PROCEDURES = flattenContract(apiContract);

describe("the cross-owner cases cover the router", () => {
  it("lists the router's procedures exactly (the contract is the router)", () => {
    expect(routerPaths(appRouter).sort()).toEqual(PROCEDURES.map(([path]) => path).sort());
  });

  it("covers every procedure, or exempts one that takes no target id, with a reason", () => {
    const covered = new Set(CASES.map(([path]) => path));
    const paths = PROCEDURES.map(([path]) => path);
    // The node file tools reach a node's files: always covered, never exempt.
    for (const path of ["nodes.files.read", "nodes.files.write", "nodes.files.edit"]) {
      expect(covered.has(path)).toBe(true);
      expect(EXEMPT[path]).toBeUndefined();
    }
    expect(paths.filter((path) => !covered.has(path) && !(path in EXEMPT))).toEqual([]);
    // No stale entries, and nothing both covered and exempt.
    expect([...covered].filter((path) => !paths.includes(path))).toEqual([]);
    expect(
      Object.keys(EXEMPT).filter((path) => !paths.includes(path) || covered.has(path)),
    ).toEqual([]);
    for (const [path, procedure] of PROCEDURES) {
      const exemption = EXEMPT[path];
      if (!exemption) continue;
      expect(exemption.reason.length).toBeGreaterThan(10);
      // Every id it takes is explained, and none names a node, runtime, instance, step,
      // profile or command (except a pricing versionId, said so above).
      const unexplained = idFields(procedure.input).filter((field) => !exemption.ids?.[field]);
      expect({ path, unexplained }).toEqual({ path, unexplained: [] });
      const targets = Object.keys(exemption.ids ?? {}).filter(
        (field) => TARGET_FIELDS.has(field) && !(exemption === PROVIDER && field === "versionId"),
      );
      expect({ path, targets }).toEqual({ path, targets: [] });
    }
  });

  it("aims every case at a valid input (a validation refusal would prove nothing)", () => {
    const byPath = new Map(PROCEDURES);
    for (const [path, input] of CASES) {
      const procedure = byPath.get(path);
      expect({ path, valid: procedure?.input.safeParse(input).success }).toEqual({
        path,
        valid: true,
      });
    }
  });
});

/** Refusals (never a crash: an INTERNAL_SERVER_ERROR could hide a lookup that found A's row). */
const REFUSAL_CODES = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

/** Procedures that are stubs in 0.4.0 (they answer NOT_IMPLEMENTED and touch nothing). */
const STUBS = new Set<string>();
const KIND = new Map(PROCEDURES.map(([path, procedure]) => [path, procedure.kind]));
/** What any row of A's carries (`victimRow`): an answer must not contain it. */
const VICTIM_DATA = /user-a|row-a|a-box|rank-a/;

beforeEach(() => {
  mockReset(db);
  installOracle();
  log.ownCreates.length = 0;
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
        if (error === undefined && path === "runtimes.start") {
          // A start preview answers instead of throwing: it must place nothing on A's node.
          const preview = (outcome as { preview?: { starts: unknown[]; refusals: unknown[] } })
            .preview;
          expect(preview?.starts).toEqual([]);
          expect(preview?.refusals).toEqual([
            expect.objectContaining({ reason: "unknown_node", subjectId: "node-a" }),
          ]);
        } else if (error === undefined) {
          // A read may answer (an empty list filtered to B): with nothing of A's in it.
          expect(KIND.get(path)).toBe("query");
          expect(JSON.stringify(outcome)).not.toMatch(VICTIM_DATA);
        } else {
          expect(error).toBeInstanceOf(ORPCError);
          const refusal = error as ORPCError<string, unknown>;
          // Stubs answer NOT_IMPLEMENTED until they are wired (nothing reaches a node).
          const stub = STUBS.has(path) && refusal.code === "NOT_IMPLEMENTED";
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

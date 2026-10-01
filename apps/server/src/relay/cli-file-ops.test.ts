import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { notifyUserBanned, onUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  judgeCliAgentAdmission,
  openCliAgentAdmissionCountForTests,
  readCliAgentAdmission,
  revokeOpenCliAgentAdmissions,
} from "./cli-agent-admission.js";
import {
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
} from "./protocol.js";
import { cancelRelayWorkForBannedUser } from "./user-ban.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES: 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES: 4 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS: 4,
    MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES: 0,
    MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS: 30_000,
    MODEL_API_TRANSCRIPTION_STALE_SPOOL_MS: 24 * 60 * 60 * 1000,
  },
}));

const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("./cli-agent-audit.js", () => ({ recordCliAgentAction: audit.record }));

const { default: prisma } = await import("@ws-model-proxy/db");
const { relaySessionManager } = await import("./session-manager.js");
const {
  auditRefusedFileInput,
  cancelFileOpsForToken,
  cancelFileOpsForUser,
  FILE_MUTATIONS_PER_MINUTE_PER_USER,
  FILE_OP_DEADLINE_MS,
  FILE_OPS_PER_CLI,
  FILE_OPS_PER_MINUTE_PER_USER,
  FILE_OPS_PER_USER,
  resetFileOpsForTests,
  runFileOp,
  sweepExpiredFileOps,
} = await import("./cli-file-ops.js");
const { resetCliAgentAdmissionsForTests } = await import("./cli-agent-admission.js");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: {
    upsert: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    findUnique: MockInstance;
  };
  cliToken: { updateMany: MockInstance; findUnique: MockInstance };
  endpoint: { findUnique: MockInstance; findMany: MockInstance };
  discoveredModel: { findMany: MockInstance };
  poolMember: { findMany: MockInstance; updateMany: MockInstance };
  executionTarget: { findMany: MockInstance; findUnique: MockInstance };
  inferenceCapacity: { findMany: MockInstance };
  mcpPersonalToken: { findFirst: MockInstance };
};

const identity: CliWebsocketIdentity = {
  kind: "cliToken",
  id: "token-id",
  userId: "user-id",
  cliDeviceId: null,
  lookupPrefix: "wsmp_cli_lookup",
};

const now = new Date("2026-01-01T00:00:00.000Z");
const waitFor = <T>(fn: () => T) => vi.waitFor(fn, { interval: 1 });
const OP_TOKEN = { userId: "user-id", tokenId: "token", expiresAt: null } as const;

class FakeSocket {
  readyState = 1;
  sends: Array<string | ArrayBuffer> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string | ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      this.sends.push(copy.buffer);
      return;
    }
    this.sends.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }
  /** The JSON control frames sent so far, oldest first. */
  frames(type?: string): Array<Record<string, unknown>> {
    return this.sends
      .filter((send): send is string => typeof send === "string")
      .map((send) => JSON.parse(send) as Record<string, unknown>)
      .filter((frame) => type === undefined || frame.type === type);
  }
  binaries() {
    return this.sends
      .filter((send): send is ArrayBuffer => typeof send !== "string")
      .map((frame) => parseRelayBinaryFrame(frame));
  }
}

function liveToken(expiresAt: Date | null = null) {
  return {
    name: "MCP agent",
    scopes: ["mcp:read", "mcp:write"],
    allowCliCommands: true,
    expiresAt,
  };
}

function uncompressedKey(): string {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
}

type Mode = "off" | "supervised" | "unsupervised";

function hello(slug: string, mode: Mode, readSwitch = false, roots = false) {
  return JSON.stringify({
    type: "hello",
    id: `hello-${slug}`,
    protocolVersion: "2.8",
    cli: {
      slug,
      hostname: `${slug}.local`,
      version: "9.9.9",
      capabilities: {
        protocolVersion: "2.8",
        inventoryAck: true,
        inventoryReplace: true,
        endpointTargeting: true,
        binaryFrames: true,
        cancellation: true,
        maxBinaryChunkBytes: 1024 * 1024,
        requestBodyStreaming: true,
        requestBodyWindowChunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
        sharedTokenizerTps: true,
        standardizedMetrics: true,
        terminal: true,
        exec: true,
        features: {
          humanTerminal: false,
          mcpCommandMode: mode,
          terminalApproval: false,
          terminalSupported: false,
          remoteMetricSources: false,
          mcpFileRead: readSwitch,
          fileRootsConfigured: roots,
          allowFileToolsAsRoot: false,
        },
        terminalPublicKey: uncompressedKey(),
        terminalViewers: true,
        supervisedCommands: true,
        nodeTelemetry: true,
        fileOps: true,
      },
    },
    endpoints: [],
  });
}

async function connect(
  slug = "desktop",
  mode: Mode = "unsupervised",
  readSwitch = false,
  roots = false,
) {
  const socket = new FakeSocket();
  relaySessionManager.acceptAuthenticatedSocket({ socket, identity, now });
  await relaySessionManager.handleTextFrame(socket, hello(slug, mode, readSwitch, roots), now);
  socket.sends.length = 0;
  return socket;
}

async function resetRelaySessions() {
  await relaySessionManager.closeRelaySessions();
  Reflect.set(relaySessionManager, "relayDrain", false);
  Reflect.set(relaySessionManager, "latestGenerationByCliDeviceId", new Map<string, number>());
}

function deviceRow(mode: "OFF" | "SUPERVISED" | "UNSUPERVISED", extra: object = {}) {
  return (args: { where: { id: string } }) => {
    if (args.where.id === "missing") return null;
    if (args.where.id === "foreign") {
      return { id: "foreign", userId: "other-user", mcpCommandMode: mode, ...extra };
    }
    return { id: args.where.id, userId: "user-id", mcpCommandMode: mode, ...extra };
  };
}

const readArgs = { path: "~/a.txt" };
const editArgs = {
  path: "~/a.txt",
  expectedEtag: "h:AAAAAAAAAAAAAAAAAAAAAA",
  edits: [{ oldText: "a", newText: "b" }],
};

/** The frame the CLI would answer with. */
function resultFor(opId: string, op: string, result: Record<string, unknown>, extra = {}) {
  return JSON.stringify({ type: "file.result", opId, op, result, ...extra });
}

const readResult = {
  etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
  size: 3,
  mtime: "2026-01-01T00:00:00Z",
  mode: "0644",
  totalLines: 1,
  startLine: 1,
  endLine: 1,
  eol: "lf",
  text: "1|a",
  redactions: 0,
  more: null,
  secretFile: false,
};

async function answer(socket: FakeSocket, frame: string) {
  await relaySessionManager.handleTextFrame(socket, frame, now);
}

/** Start an op and wait until its frame is on the socket. */
async function start(
  _socket: FakeSocket,
  op: Parameters<typeof runFileOp>[0]["op"],
  args: unknown,
  extra: Partial<Parameters<typeof runFileOp>[0]> = {},
) {
  const outcome = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op, args, ...extra });
  // The mocked reads settle within one turn; a refused op just never sends a frame.
  await flush();
  return outcome;
}

/** Lets the mocked database reads and the dispatch run (real setImmediate; fake timers stay put). */
function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function lastOpId(socket: FakeSocket): string {
  const frames = socket.frames("file.op");
  const opId = frames[frames.length - 1]?.opId;
  if (typeof opId !== "string") throw new Error("no file.op sent");
  return opId;
}

describe("cli file ops", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    audit.record.mockClear();
    resetFileOpsForTests();
    resetCliAgentAdmissionsForTests();
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.cliToken.findUnique.mockResolvedValue({
      revokedAt: null,
      expiresAt: null,
      cliDeviceId: null,
    });
    db.cliToken.updateMany.mockResolvedValue({ count: 1 });
    db.user.findUnique.mockResolvedValue({ slug: "owner" });
    db.cliDevice.upsert.mockImplementation(async (args: { create: { slug: string } }) => ({
      id: args.create.slug,
      userId: "user-id",
      slug: args.create.slug,
      allowHumanTerminal: false,
      mcpCommandMode: "UNSUPERVISED",
      connectionGeneration: 1,
      inventorySeq: 0,
      inventoryDigest: null,
      inventoryAcknowledgedAt: null,
    }));
    db.cliDevice.update.mockResolvedValue({
      inventorySeq: 1,
      inventoryDigest: "digest",
      inventoryAcknowledgedAt: now,
      id: "desktop",
    });
    db.cliDevice.updateMany.mockResolvedValue({ count: 1 });
    db.cliDevice.findUnique.mockImplementation(deviceRow("UNSUPERVISED"));
    db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken());
    db.endpoint.findUnique.mockResolvedValue(null);
    db.endpoint.findMany.mockResolvedValue([]);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.executionTarget.findUnique.mockResolvedValue(null);
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolMember.updateMany.mockResolvedValue({ count: 0 });
    db.inferenceCapacity.findMany.mockResolvedValue([]);
  });

  const readGrantMatrix = [];
  for (const mode of ["off", "supervised", "unsupervised"] as const)
    for (const server of [false, true])
      for (const live of [false, true])
        for (const roots of [false, true])
          for (const op of ["read", "edit"] as const) {
            const code =
              mode === "unsupervised" || (op === "read" && server && live && roots)
                ? null
                : mode === "supervised"
                  ? // A supervised write never rides a headless file.op: the tool layer starts a
                    // supervised terminal request instead (P5). This fake CLI reports no terminal
                    // support, so that route answers `unsupported`.
                    op === "edit"
                    ? "unsupported"
                    : "supervised_only"
                  : // Off: the dashboard grant is what refuses without it; with it, the missing
                    // CLI switch or roots is the CLI's own config.
                    server && op === "read"
                    ? "feature_disabled"
                    : "grant_disabled";
            readGrantMatrix.push({ mode, server, live, roots, op, code });
          }
  it.each(readGrantMatrix)(
    "read grant admission $mode $op server=$server live=$live roots=$roots",
    async ({ mode, server, live, roots, op, code }) => {
      const dbMode = mode === "off" ? "OFF" : mode === "supervised" ? "SUPERVISED" : "UNSUPERVISED";
      db.cliDevice.findUnique.mockImplementation(deviceRow(dbMode, { mcpFileRead: server }));
      const socket = await connect("desktop", mode, live, roots);
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: mode,
        mcpFileRead: server,
      });
      const outcome = start(socket, op, op === "read" ? readArgs : editArgs);
      await flush();
      if (code) {
        await expect(outcome).resolves.toEqual({ ok: false, code });
        expect(socket.frames("file.op")).toEqual([]);
      } else {
        expect(socket.frames("file.op").at(-1)).toMatchObject({
          mode,
          readGrant: server && live && roots,
        });
        await answer(
          socket,
          resultFor(
            lastOpId(socket),
            op,
            op === "read"
              ? readResult
              : {
                  etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
                  previousEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
                  added: 1,
                  removed: 1,
                  applied: true,
                },
          ),
        );
        await expect(outcome).resolves.toMatchObject({ ok: true, op });
      }
    },
  );

  describe("each read-grant site decides from its own source", () => {
    const liveOf = () => {
      const real = relaySessionManager.getLiveCliFeatures(["desktop"]).get("desktop");
      if (!real) throw new Error("no live snapshot");
      return real;
    };

    it("admission reads the dashboard grant from the database, not the session copy", async () => {
      db.cliDevice.findUnique.mockImplementation(deviceRow("OFF", { mcpFileRead: false }));
      const socket = await connect("desktop", "off", true, true);
      // The session still holds a stale `true` (a revoke has not been applied yet).
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: "off",
        mcpFileRead: true,
      });
      await expect(start(socket, "read", readArgs)).resolves.toEqual({
        ok: false,
        code: "grant_disabled",
      });
      expect(socket.frames("file.op")).toEqual([]);
    });

    it("admission reads the live roots report from the connection", async () => {
      db.cliDevice.findUnique.mockImplementation(deviceRow("OFF", { mcpFileRead: true }));
      const socket = await connect("desktop", "off", true, true);
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: "off",
        mcpFileRead: true,
      });
      const live = liveOf();
      vi.spyOn(relaySessionManager, "getLiveCliFeatures").mockReturnValue(
        new Map([["desktop", { ...live, fileRootsConfigured: false }]]),
      );
      await expect(start(socket, "read", readArgs)).resolves.toEqual({
        ok: false,
        code: "feature_disabled",
      });
      expect(socket.frames("file.op")).toEqual([]);
    });

    it.each(["OFF", "SUPERVISED"] as const)(
      "a granted read on a %s device blames the CLI's absence, not the dashboard",
      async (grant) => {
        db.cliDevice.findUnique.mockImplementation(deviceRow(grant, { mcpFileRead: true }));
        await expect(
          runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
        ).resolves.toEqual({ ok: false, code: "offline" });
        db.cliDevice.findUnique.mockImplementation(
          deviceRow(grant, { mcpFileRead: true, rejectedRelayProtocolVersion: "2.7" }),
        );
        await expect(
          runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
        ).resolves.toMatchObject({
          ok: false,
          code: "upgrade_required",
        });
      },
    );

    it("the dispatch gate re-checks roots on the session even when admission passed", async () => {
      db.cliDevice.findUnique.mockImplementation(deviceRow("OFF", { mcpFileRead: true }));
      const socket = await connect("desktop", "off", true, false);
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: "off",
        mcpFileRead: true,
      });
      const live = liveOf();
      vi.spyOn(relaySessionManager, "getLiveCliFeatures").mockReturnValue(
        new Map([["desktop", { ...live, fileRootsConfigured: true }]]),
      );
      const outcome = await start(socket, "read", readArgs);
      expect(outcome).toMatchObject({ ok: false });
      expect(socket.frames("file.op")).toEqual([]);
    });
  });

  it.each(["off", "supervised", "unsupervised"] as const)(
    "grant-off sweep on %s cancels only reads that lose permission",
    async (mode) => {
      const dbMode = mode === "off" ? "OFF" : mode === "supervised" ? "SUPERVISED" : "UNSUPERVISED";
      db.cliDevice.findUnique.mockImplementation(deviceRow(dbMode, { mcpFileRead: true }));
      const socket = await connect("desktop", mode, true, true);
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: mode,
        mcpFileRead: true,
      });
      const outcome = start(socket, "read", readArgs);
      await flush();
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: mode,
        mcpFileRead: false,
      });
      if (mode === "unsupervised") {
        expect(socket.frames("file.cancel")).toEqual([]);
        await answer(socket, resultFor(lastOpId(socket), "read", readResult));
        await expect(outcome).resolves.toMatchObject({ ok: true });
      } else {
        expect(socket.frames("file.cancel")).toHaveLength(1);
        await expect(outcome).resolves.toEqual({
          ok: false,
          code: mode === "off" ? "grant_disabled" : "supervised_only",
        });
      }
    },
  );

  describe("effective mode is the lowest of the dashboard and the CLI's own", () => {
    const modes: Mode[] = ["off", "supervised", "unsupervised"];
    const rank = { off: 0, supervised: 1, unsupervised: 2 } as const;
    const cells: Array<{
      dash: Mode;
      cli: Mode;
      server: boolean;
      live: boolean;
      roots: boolean;
    }> = [];
    for (const dash of modes)
      for (const cli of modes)
        for (const server of [false, true])
          for (const live of [false, true])
            for (const roots of [false, true]) cells.push({ dash, cli, server, live, roots });
    it.each(cells)(
      "read: dashboard $dash, CLI $cli, server=$server live=$live roots=$roots",
      async ({ dash, cli, server, live, roots }) => {
        const dbMode = dash.toUpperCase() as "OFF" | "SUPERVISED" | "UNSUPERVISED";
        db.cliDevice.findUnique.mockImplementation(deviceRow(dbMode, { mcpFileRead: server }));
        const socket = await connect("desktop", cli, live, roots);
        relaySessionManager.applyFeatureGrants("desktop", {
          allowHumanTerminal: false,
          mcpCommandMode: dash,
          mcpFileRead: server,
        });
        const effective = rank[dash] < rank[cli] ? dash : cli;
        const runs = effective === "unsupervised" || (server && live && roots);
        // Admission decides on its own, not only through the dispatch gate behind it.
        const verdict = judgeCliAgentAdmission(
          await readCliAgentAdmission({ ...OP_TOKEN, cliDeviceId: "desktop" }),
          "file_read",
        );
        expect(verdict.ok).toBe(runs);
        const outcome = start(socket, "read", readArgs);
        await flush();
        if (runs) {
          expect(socket.frames("file.op").at(-1)).toMatchObject({
            mode: effective,
            readGrant: server && live && roots,
          });
          await answer(socket, resultFor(lastOpId(socket), "read", readResult));
          await expect(outcome).resolves.toMatchObject({ ok: true });
        } else {
          // Nothing reaches the CLI, whatever the CLI's own mode says.
          expect(socket.frames("file.op")).toEqual([]);
          const result = await outcome;
          expect(result).toMatchObject({ ok: false });
          if (!server && dash !== "unsupervised") {
            expect(result).toMatchObject({
              code: dash === "off" ? "grant_disabled" : "supervised_only",
            });
          }
        }
      },
    );

    it.each(["off", "supervised"] as const)(
      "narrowing the dashboard to %s cancels a read that only the dashboard mode allowed",
      async (narrowed) => {
        // The CLI is unsupervised with its read switch off: the read runs on mode alone.
        db.cliDevice.findUnique.mockImplementation(
          deviceRow("UNSUPERVISED", { mcpFileRead: true }),
        );
        const socket = await connect("desktop", "unsupervised", false, false);
        relaySessionManager.applyFeatureGrants("desktop", {
          allowHumanTerminal: false,
          mcpCommandMode: "unsupervised",
          mcpFileRead: true,
        });
        const outcome = start(socket, "read", readArgs);
        await flush();
        expect(socket.frames("file.op")).toHaveLength(1);
        relaySessionManager.applyFeatureGrants("desktop", {
          allowHumanTerminal: false,
          mcpCommandMode: narrowed,
          mcpFileRead: true,
        });
        expect(socket.frames("file.cancel")).toHaveLength(1);
        await expect(outcome).resolves.toMatchObject({ ok: false });
      },
    );
  });

  describe("post-commit device grant refresh", () => {
    const policy = (mode: Mode, mcpFileRead: boolean) => ({
      id: "desktop",
      userId: "user-id",
      allowHumanTerminal: false,
      mcpCommandMode: mode.toUpperCase(),
      mcpFileRead,
    });
    const queue = () =>
      Reflect.get(relaySessionManager, "featureGrantsRefreshByCliDeviceId") as Map<
        string,
        Promise<void>
      >;

    async function grantedRead(mode: Mode) {
      db.cliDevice.findUnique.mockResolvedValue(policy(mode, true));
      db.mcpPersonalToken.findFirst.mockResolvedValue({
        ...liveToken(),
        allowCliCommands: false,
        allowCliFileRead: true,
        scopes: ["mcp:read"],
      });
      const socket = await connect("desktop", mode, true, true);
      await relaySessionManager.onCliFeatureGrantsChanged("desktop");
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await flush();
      expect(socket.frames("file.op")).toHaveLength(1);
      return { socket, outcome, opId: lastOpId(socket) };
    }

    // Missing rows already failed closed; pin that default alongside read errors.
    it.each(
      (["off", "supervised", "unsupervised"] as const).flatMap((mode) =>
        (["throws", "missing"] as const).map((failure) => ({ mode, failure })),
      ),
    )(
      "$failure refresh on $mode withdraws authority and recovers on retry",
      async ({ mode, failure }) => {
        const { socket, outcome, opId } = await grantedRead(mode);
        const metrics = vi.spyOn(relaySessionManager, "onRemoteMetricSourcesChanged");
        // Durable revocation precedes the hook, but its policy read is unavailable.
        db.cliDevice.findUnique.mockResolvedValue(policy("off", false));
        if (failure === "throws")
          db.cliDevice.findUnique.mockRejectedValueOnce(new Error("db down"));
        else db.cliDevice.findUnique.mockResolvedValueOnce(null);
        const refresh = relaySessionManager.onCliFeatureGrantsChanged("desktop");
        if (failure === "throws") await expect(refresh).rejects.toThrow("db down");
        else await refresh;
        expect(metrics).toHaveBeenCalledTimes(1);
        expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
        await expect(outcome).resolves.toEqual({ ok: false, code: "grant_disabled" });
        expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe("grant_disabled");
        expect(queue().size).toBe(0);
        await answer(socket, resultFor(opId, "read", readResult));
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenLastCalledWith(
          expect.objectContaining({ outcome: "cancelled", reason: "grant_disabled" }),
        );

        db.cliDevice.findUnique.mockResolvedValue(policy(mode, true));
        await relaySessionManager.onCliFeatureGrantsChanged("desktop");
        const retry = runFileOp({
          ...OP_TOKEN,
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
        });
        await flush();
        expect(socket.frames("file.op")).toHaveLength(2);
        await answer(socket, resultFor(lastOpId(socket), "read", readResult));
        await expect(retry).resolves.toMatchObject({ ok: true });
        expect(metrics).toHaveBeenCalledTimes(2);
        expect(queue().size).toBe(0);
      },
    );

    // These legitimate rows pin the existing verdict-based reconciliation
    // through the refresh hook, including unchanged unsupervised permission.
    it.each([
      { mode: "off", readGrant: true, refusal: null },
      { mode: "off", readGrant: false, refusal: "grant_disabled" },
      { mode: "supervised", readGrant: false, refusal: "supervised_only" },
      { mode: "unsupervised", readGrant: false, refusal: null },
    ] as const)(
      "successful $mode refresh readGrant=$readGrant cancels only lost permission",
      async ({ mode, readGrant, refusal }) => {
        const { socket, outcome, opId } = await grantedRead(mode);
        db.cliDevice.findUnique.mockResolvedValue(policy(mode, readGrant));
        await relaySessionManager.onCliFeatureGrantsChanged("desktop");
        expect(socket.frames("file.cancel")).toHaveLength(refusal === null ? 0 : 1);
        await answer(socket, resultFor(opId, "read", readResult));
        await expect(outcome).resolves.toMatchObject(
          refusal === null ? { ok: true } : { ok: false, code: refusal },
        );
        expect(queue().size).toBe(0);
      },
    );

    it.each(
      ([false, true] as const).flatMap((latestGrant) =>
        (["A-first", "B-first"] as const).map((completionOrder) => ({
          latestGrant,
          completionOrder,
        })),
      ),
    )(
      "serializes $completionOrder reads, retaining latestGrant=$latestGrant",
      async ({ latestGrant, completionOrder }) => {
        const { socket, outcome, opId } = await grantedRead("off");
        const metrics = vi
          .spyOn(relaySessionManager, "onRemoteMetricSourcesChanged")
          .mockResolvedValue(false);
        const firstRead = deferred<ReturnType<typeof policy>>();
        const secondRead = deferred<ReturnType<typeof policy>>();
        db.cliDevice.findUnique.mockClear();
        db.cliDevice.findUnique
          .mockImplementationOnce(() => firstRead.promise)
          .mockImplementationOnce(() => secondRead.promise);
        const first = relaySessionManager.onCliFeatureGrantsChanged("desktop");
        await flush();
        const second = relaySessionManager.onCliFeatureGrantsChanged("desktop");
        await flush();
        // B must not even start its DB read while A owns the device queue.
        expect(db.cliDevice.findUnique).toHaveBeenCalledTimes(1);
        if (completionOrder === "B-first") secondRead.resolve(policy("off", latestGrant));
        firstRead.resolve(policy("off", !latestGrant));
        await first;
        if (completionOrder === "A-first") {
          // A's cleanup must not delete B's still-pending tail.
          await flush();
          expect(queue().has("desktop")).toBe(true);
          secondRead.resolve(policy("off", latestGrant));
        }
        await second;
        expect(db.cliDevice.findUnique).toHaveBeenCalledTimes(2);
        expect(metrics).toHaveBeenCalledTimes(2);
        expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe(
          latestGrant ? null : "grant_disabled",
        );
        // Either A or B withdrew the grant; an old pending result stays cancelled
        // even when the latest commit legitimately re-enables new operations.
        expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
        await answer(socket, resultFor(opId, "read", readResult));
        await expect(outcome).resolves.toEqual({ ok: false, code: "grant_disabled" });
        db.cliDevice.findUnique.mockResolvedValue(policy("off", latestGrant));
        const next = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
        await flush();
        expect(socket.frames("file.op")).toHaveLength(latestGrant ? 2 : 1);
        if (latestGrant) await answer(socket, resultFor(lastOpId(socket), "read", readResult));
        await expect(next).resolves.toMatchObject(
          latestGrant ? { ok: true } : { ok: false, code: "grant_disabled" },
        );
        expect(queue().size).toBe(0);
      },
    );

    it("a rejected tail releases the next refresh and keeps other devices independent", async () => {
      const { socket, outcome, opId } = await grantedRead("off");
      const metrics = vi
        .spyOn(relaySessionManager, "onRemoteMetricSourcesChanged")
        .mockResolvedValue(false);
      const failedRead = deferred<ReturnType<typeof policy>>();
      const retryRead = deferred<ReturnType<typeof policy>>();
      db.cliDevice.findUnique.mockImplementation((args: { where: { id: string } }) =>
        args.where.id === "desktop" ? retryRead.promise : Promise.resolve(policy("off", false)),
      );
      db.cliDevice.findUnique.mockImplementationOnce(() => failedRead.promise);
      const failed = relaySessionManager.onCliFeatureGrantsChanged("desktop");
      const rejected = expect(failed).rejects.toThrow("db down");
      await flush();
      const retry = relaySessionManager.onCliFeatureGrantsChanged("desktop");
      await relaySessionManager.onCliFeatureGrantsChanged("other-device");
      expect(queue().has("desktop")).toBe(true);
      expect(queue().has("other-device")).toBe(false);
      failedRead.reject(new Error("db down"));
      await rejected;
      await flush();
      expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
      await expect(outcome).resolves.toEqual({ ok: false, code: "grant_disabled" });
      expect(queue().has("desktop")).toBe(true);
      retryRead.resolve(policy("off", true));
      await retry;
      expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe(null);
      expect(metrics).toHaveBeenCalledTimes(3);
      expect(queue().size).toBe(0);
    });

    // C2a-1: hold a COMMITTED registration result, not its transaction's read.
    // Revocation finishes before the old hello installs; recovery must honor
    // the latest durable row and never revive admissions opened before revoke.
    it.each([
      { initialMode: "off", recovery: "revoked" },
      { initialMode: "unsupervised", recovery: "revoked" },
      { initialMode: "off", recovery: "enabled" },
      { initialMode: "unsupervised", recovery: "enabled" },
      { initialMode: "off", recovery: "throws" },
      { initialMode: "off", recovery: "missing" },
    ] as const)(
      "delayed hello $initialMode with $recovery recovery fences stale authority",
      async ({ initialMode, recovery }) => {
        const { socket, outcome, opId } = await grantedRead(initialMode);
        const metrics = vi
          .spyOn(relaySessionManager, "onRemoteMetricSourcesChanged")
          .mockResolvedValue(false);
        const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const ownerRead = deferred<{ slug: string }>();
        db.user.findUnique.mockImplementationOnce(() => ownerRead.promise);
        const paused = runFileOp({
          ...OP_TOKEN,
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
        });
        await flush();
        expect(openCliAgentAdmissionCountForTests()).toBe(1);

        db.cliDevice.upsert.mockResolvedValue({
          ...policy(initialMode, true),
          slug: "desktop",
          allowHumanTerminal: true,
          connectionGeneration: 2,
        });
        const committed = deferred<void>();
        const release = deferred<void>();
        db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
          const snapshot = await callback(db);
          committed.resolve();
          await release.promise;
          return snapshot;
        });
        const replacement = new FakeSocket();
        relaySessionManager.acceptAuthenticatedSocket({ socket: replacement, identity, now });
        const reconnect = relaySessionManager.handleTextFrame(
          replacement,
          hello("desktop", initialMode, true, true),
          now,
        );
        await committed.promise;
        db.cliDevice.findUnique.mockResolvedValue(policy("off", false));
        await relaySessionManager.onCliFeatureGrantsChanged("desktop");
        await expect(outcome).resolves.toEqual({ ok: false, code: "grant_disabled" });
        expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);

        const recoveryRead = deferred<ReturnType<typeof policy> | null>();
        db.cliDevice.findUnique.mockImplementationOnce(() => recoveryRead.promise);
        release.resolve();
        await reconnect;
        expect(replacement.frames("hello.ok")).toHaveLength(1);
        expect(socket.closes).toContainEqual({ code: 1000, reason: "replaced" });
        expect(queue().has("desktop")).toBe(true);
        const session = Reflect.get(relaySessionManager, "sessionsByCliDeviceId").get("desktop");
        expect(session).toMatchObject({
          allowHumanTerminal: false,
          mcpCommandMode: "off",
          mcpFileRead: false,
        });
        expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe("grant_disabled");
        const recoveryTail = queue().get("desktop");
        expect(recoveryTail).toBeDefined();
        const observedTail = recoveryTail?.catch(() => undefined);
        if (recovery === "throws") recoveryRead.reject(new Error("db down"));
        else if (recovery === "missing") recoveryRead.resolve(null);
        else
          recoveryRead.resolve({
            ...policy(recovery === "enabled" ? initialMode : "off", recovery === "enabled"),
            allowHumanTerminal: recovery === "enabled",
          });
        await observedTail;
        await flush();
        expect(queue().size).toBe(0);
        expect(metrics).toHaveBeenCalledTimes(2);
        expect(logger).toHaveBeenCalledTimes(recovery === "throws" ? 1 : 0);
        expect(session).toMatchObject({
          allowHumanTerminal: recovery === "enabled",
          mcpCommandMode: recovery === "enabled" ? initialMode : "off",
          mcpFileRead: recovery === "enabled",
        });
        expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe(
          recovery === "enabled" ? null : "grant_disabled",
        );
        // Resume AFTER recovery, including a newer enable: the old admission is
        // invalid, while a freshly opened request may use the restored grant.
        ownerRead.resolve({ slug: "owner" });
        await flush();
        expect(replacement.frames("file.op")).toHaveLength(0);
        await expect(paused).resolves.toEqual({ ok: false, code: "grant_disabled" });
        expect(openCliAgentAdmissionCountForTests()).toBe(0);
        db.cliDevice.findUnique.mockResolvedValue(
          policy(recovery === "enabled" ? initialMode : "off", recovery === "enabled"),
        );
        const fresh = runFileOp({
          ...OP_TOKEN,
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
        });
        await flush();
        if (recovery === "enabled") {
          expect(replacement.frames("file.op")).toHaveLength(1);
          await answer(replacement, resultFor(lastOpId(replacement), "read", readResult));
        }
        await expect(fresh).resolves.toMatchObject(
          recovery === "enabled" ? { ok: true } : { ok: false, code: "grant_disabled" },
        );
      },
    );

    it("a hello installing after the refresh applied but before the change settles stays fenced", async () => {
      const { outcome } = await grantedRead("off");
      const metricsHeld = deferred<boolean>();
      vi.spyOn(relaySessionManager, "onRemoteMetricSourcesChanged").mockImplementation(
        () => metricsHeld.promise,
      );
      db.cliDevice.upsert.mockResolvedValue({
        ...policy("off", true),
        slug: "desktop",
        allowHumanTerminal: true,
        connectionGeneration: 2,
      });
      const committed = deferred<void>();
      const release = deferred<void>();
      db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
        const snapshot = await callback(db);
        committed.resolve();
        await release.promise;
        return snapshot;
      });
      const replacement = new FakeSocket();
      relaySessionManager.acceptAuthenticatedSocket({ socket: replacement, identity, now });
      const reconnect = relaySessionManager.handleTextFrame(
        replacement,
        hello("desktop", "off", true, true),
        now,
      );
      await committed.promise;
      db.cliDevice.findUnique.mockResolvedValue(policy("off", false));
      const change = relaySessionManager.onCliFeatureGrantsChanged("desktop");
      // The refresh has applied the revoke (the pending read is cancelled) while
      // its tail still awaits the metric push.
      await expect(outcome).resolves.toEqual({ ok: false, code: "grant_disabled" });
      release.resolve();
      await reconnect;
      const afterHello = relaySessionManager.fileOpModeRefusal("desktop", "read");
      metricsHeld.resolve(false);
      await change;
      await flush();
      await flush();
      expect(afterHello).toBe("grant_disabled");
      expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe("grant_disabled");
    });

    // Inverse/default rows: only a change to THIS device after hello starts
    // forces a refresh. A hello started after notification remains ordinary.
    it.each(["none", "before-hello", "other-device"] as const)(
      "normal hello with %s change needs no policy recovery read",
      async (change) => {
        const metrics = vi
          .spyOn(relaySessionManager, "onRemoteMetricSourcesChanged")
          .mockResolvedValue(false);
        db.cliDevice.findUnique.mockResolvedValue(policy("off", true));
        db.mcpPersonalToken.findFirst.mockResolvedValue({
          ...liveToken(),
          allowCliCommands: false,
          allowCliFileRead: true,
          scopes: ["mcp:read"],
        });
        db.cliDevice.upsert.mockResolvedValue({
          ...policy("off", true),
          slug: "desktop",
          allowHumanTerminal: true,
          connectionGeneration: 1,
        });
        if (change === "before-hello")
          await relaySessionManager.onCliFeatureGrantsChanged("desktop");
        const committed = deferred<void>();
        const release = deferred<void>();
        db.$transaction.mockImplementationOnce(async (callback: (tx: typeof db) => unknown) => {
          const snapshot = await callback(db);
          committed.resolve();
          await release.promise;
          return snapshot;
        });
        const socket = new FakeSocket();
        relaySessionManager.acceptAuthenticatedSocket({ socket, identity, now });
        const registration = relaySessionManager.handleTextFrame(
          socket,
          hello("desktop", "off", true, true),
          now,
        );
        await committed.promise;
        const admission = await readCliAgentAdmission({ ...OP_TOKEN, cliDeviceId: "desktop" });
        if (change === "other-device")
          await relaySessionManager.onCliFeatureGrantsChanged("other-device");
        db.cliDevice.findUnique.mockClear();
        release.resolve();
        await registration;
        // Hello already reads remote metric sources; no additional policy read.
        expect(db.cliDevice.findUnique).toHaveBeenCalledExactlyOnceWith({
          where: { id: "desktop" },
          select: { userId: true, mcpCommandMode: true, remoteMetricSources: true },
        });
        expect(queue().size).toBe(0);
        expect(metrics).toHaveBeenCalledTimes(change === "none" ? 0 : 1);
        expect(judgeCliAgentAdmission(admission, "file_read")).toMatchObject({ ok: true });
        expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBeNull();
        const session = Reflect.get(relaySessionManager, "sessionsByCliDeviceId").get("desktop");
        expect(session).toMatchObject({
          allowHumanTerminal: true,
          mcpCommandMode: "off",
          mcpFileRead: true,
        });
        const fresh = runFileOp({
          ...OP_TOKEN,
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
        });
        await flush();
        await answer(socket, resultFor(lastOpId(socket), "read", readResult));
        await expect(fresh).resolves.toMatchObject({ ok: true });
      },
    );

    // The admission's owner read is last; policy loss while it is paused
    // must still deny dispatch despite the already-read, granted device row.
    it.each(["revoke", "read-error"] as const)(
      "%s during a paused owner read cannot dispatch",
      async (change) => {
        const { socket, outcome, opId } = await grantedRead("off");
        const ownerRead = deferred<{ slug: string }>();
        db.user.findUnique.mockImplementationOnce(() => ownerRead.promise);
        const paused = runFileOp({
          ...OP_TOKEN,
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
        });
        await flush();
        expect(openCliAgentAdmissionCountForTests()).toBe(1);
        db.cliDevice.findUnique.mockResolvedValue(policy("off", false));
        if (change === "read-error")
          db.cliDevice.findUnique.mockRejectedValueOnce(new Error("db down"));
        const refresh = relaySessionManager.onCliFeatureGrantsChanged("desktop");
        if (change === "read-error") await expect(refresh).rejects.toThrow("db down");
        else await refresh;
        await expect(outcome).resolves.toEqual({ ok: false, code: "grant_disabled" });
        ownerRead.resolve({ slug: "owner" });
        await expect(paused).resolves.toEqual({ ok: false, code: "grant_disabled" });
        expect(openCliAgentAdmissionCountForTests()).toBe(0);
        expect(socket.frames("file.op")).toHaveLength(1);
        expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
      },
    );
  });

  it("read-only token consent is reread at admission, and its cancellation ends a pending read", async () => {
    const token = {
      ...liveToken(),
      allowCliCommands: false,
      allowCliFileRead: true,
      scopes: ["mcp:read"],
    };
    const socket = await connect();
    db.mcpPersonalToken.findFirst.mockResolvedValue(token);
    const outcome = start(socket, "read", readArgs);
    await flush();
    expect(socket.frames("file.op")).toHaveLength(1);
    db.mcpPersonalToken.findFirst.mockResolvedValue({ ...token, allowCliFileRead: false });
    cancelFileOpsForToken("token");
    await expect(outcome).resolves.toEqual({ ok: false, code: "token_inactive" });
    await expect(
      runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
    ).resolves.toEqual({ ok: false, code: "token_inactive" });
    db.mcpPersonalToken.findFirst.mockResolvedValue({ ...token, scopes: [] });
    await expect(
      runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
    ).resolves.toEqual({ ok: false, code: "token_inactive" });
    db.mcpPersonalToken.findFirst.mockResolvedValue(token);
    await expect(
      runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "edit", args: editArgs }),
    ).resolves.toEqual({ ok: false, code: "token_inactive" });
    expect(socket.frames("file.op")).toHaveLength(1);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await resetRelaySessions();
    resetFileOpsForTests();
  });

  it("reports a mutation's io_error rejection as an unknown outcome, a read's as definitive; too_large stays definitive", async () => {
    const socket = await connect();
    for (const reason of ["io_error"]) {
      const write = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason }),
      );
      await expect(write).resolves.toEqual({ ok: false, code: reason, outcome: "unknown" });
      socket.sends.length = 0;
      const read = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason }),
      );
      await expect(read).resolves.toEqual({ ok: false, code: reason });
      socket.sends.length = 0;
    }
    // Other CLI refusals of a mutation stay definitive (too_large is a pre-commit size refusal).
    const tooLarge = start(socket, "write", { path: "~/big" }, { body: new Uint8Array(1) });
    await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
    await answer(
      socket,
      JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason: "too_large" }),
    );
    await expect(tooLarge).resolves.toEqual({ ok: false, code: "too_large" });
    socket.sends.length = 0;
    const conflict = start(socket, "edit", editArgs);
    await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
    await answer(
      socket,
      JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason: "no_match" }),
    );
    await expect(conflict).resolves.toEqual({ ok: false, code: "no_match" });
  });

  it("settles delete results with and without retained recovery paths", async () => {
    const socket = await connect();
    for (const result of [
      { deleted: true, type: "file" },
      {
        deleted: true,
        type: "symlink",
        recovered: ["/workspace/.wsmp-recover-a1b2c3d4e5"],
      },
    ]) {
      socket.sends.length = 0;
      const outcome = start(socket, "delete", { path: "~/a" });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "delete", result));
      await expect(outcome).resolves.toEqual({ ok: true, op: "delete", result });
      expect(socket.frames("file.cancel")).toEqual([]);
      expect(socket.closes).toEqual([]);
    }
  });

  it("keeps uncertain_outcome recovery facts and marks mutations unknown", async () => {
    const socket = await connect();
    const detail = {
      recovery: "/workspace/.wsmp-recover-a1b2c3d4e5",
      kept: ["/workspace/.wsmp-recover-a1b2c3d4e5/slot-1"],
    };
    for (const op of ["edit", "read"] as const) {
      const outcome = start(socket, op, op === "edit" ? editArgs : readArgs);
      await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "uncertain_outcome",
          detail,
        }),
      );
      await expect(outcome).resolves.toEqual({
        ok: false,
        code: "uncertain_outcome",
        detail,
        ...(op === "edit" ? { outcome: "unknown" } : {}),
      });
      socket.sends.length = 0;
    }
  });

  it("gives the rate slot back for an op that was never sent", async () => {
    const socket = await connect();
    // A send that throws leaves nothing at the CLI; the slot must not stay spent.
    const realSend = socket.send.bind(socket);
    let armed = true;
    socket.send = (data) => {
      if (armed) {
        armed = false;
        throw new Error("socket send failed");
      }
      realSend(data);
    };
    const first = await runFileOp({
      ...OP_TOKEN,
      cliDeviceId: "desktop",
      op: "delete",
      args: { path: "~/a" },
    });
    expect(first.ok).toBe(false);
    for (let index = 0; index < FILE_MUTATIONS_PER_MINUTE_PER_USER; index += 1) {
      const outcome = start(socket, "mkdir", { path: `~/d${index}` });
      await waitFor(() => expect(socket.frames("file.op").length).toBe(index + 1));
      await answer(socket, resultFor(lastOpId(socket), "mkdir", { created: true }));
      await expect(outcome).resolves.toMatchObject({ ok: true });
    }
  });

  describe("credential lifetime and abort during admission", () => {
    it("ends an in-flight op at the token's expiry, not at the minute sweep", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const socket = await connect();
      const expiresAt = new Date(Date.now() + 5_000);
      db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken(expiresAt));
      const outcome = runFileOp({
        ...OP_TOKEN,
        expiresAt,
        cliDeviceId: "desktop",
        op: "delete",
        args: { path: "~/a" },
      });
      await flush();
      const opId = lastOpId(socket);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(outcome).resolves.toEqual({
        ok: false,
        code: "token_inactive",
        outcome: "unknown",
      });
      expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
    });

    it("does not deliver an answer that lands after the token expired", async () => {
      const socket = await connect();
      const expiresAt = new Date(Date.now() + 60_000);
      db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken(expiresAt));
      const outcome = runFileOp({
        ...OP_TOKEN,
        expiresAt,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      vi.spyOn(Date, "now").mockReturnValue(expiresAt.getTime() + 1);
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(outcome).resolves.toEqual({ ok: false, code: "token_inactive" });
    });

    it("never dispatches an op whose request was aborted during admission", async () => {
      const socket = await connect();
      const controller = new AbortController();
      let release!: (row: unknown) => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      db.user.findUnique.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "delete",
        args: { path: "~/a" },
        signal: controller.signal,
      });
      await reached;
      controller.abort();
      release({ banned: false, banExpires: null, deletionRequestedAt: null });
      await expect(outcome).resolves.toEqual({ ok: false, code: "cancelled" });
      expect(socket.sends).toEqual([]);
    });

    it("sees a ban that lands while the device is being read (the owner is read last)", async () => {
      const socket = await connect();
      let releaseDevice!: (row: unknown) => void;
      let deviceEntered!: () => void;
      const reached = new Promise<void>((resolve) => {
        deviceEntered = resolve;
      });
      db.cliDevice.findUnique.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseDevice = resolve;
            deviceEntered();
          }),
      );
      db.user.findUnique.mockResolvedValue({
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
      });
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "delete",
        args: { path: "~/a" },
      });
      await reached;
      // The ban commits while the device read is still pending.
      db.user.findUnique.mockResolvedValue({
        banned: true,
        banExpires: null,
        deletionRequestedAt: null,
      });
      releaseDevice({
        id: "desktop",
        userId: "user-id",
        mcpCommandMode: "UNSUPERVISED",
        rejectedRelayProtocolVersion: null,
      });
      await expect(outcome).resolves.toEqual({ ok: false, code: "token_inactive" });
      expect(socket.frames("file.op")).toEqual([]);
    });
  });

  it("treats not_found on rename and delete as an unknown outcome (cleanup runs after the commit), but not on edit or read", async () => {
    const socket = await connect();
    const cases: Array<[Parameters<typeof runFileOp>[0]["op"], unknown, boolean]> = [
      ["rename", { from: "~/a", to: "~/b" }, true],
      ["delete", { path: "~/a" }, true],
      ["edit", editArgs, false],
      ["read", readArgs, false],
    ];
    for (const [op, args, unknown] of cases) {
      const outcome = start(socket, op, args);
      await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason: "not_found" }),
      );
      await expect(outcome).resolves.toEqual({
        ok: false,
        code: "not_found",
        ...(unknown ? { outcome: "unknown" } : {}),
      });
      socket.sends.length = 0;
    }
  });

  it("passes `gone` through as a definitive conflict and treats `replaced` as an unknown outcome", async () => {
    const socket = await connect();
    for (const word of ["replaced", "gone"]) {
      const outcome = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "conflict",
          detail: { currentEtag: word },
        }),
      );
      await expect(outcome).resolves.toEqual({
        ok: false,
        code: "conflict",
        ...(word === "replaced" ? { outcome: "unknown" } : { detail: { currentEtag: word } }),
      });
      expect(socket.closes).toEqual([]);
      socket.sends.length = 0;
    }
  });

  describe("audit (#104 part B)", () => {
    const events = () => audit.record.mock.calls.map(([event]) => event as Record<string, unknown>);

    it("records a completed read once, with the path and etag but no content", async () => {
      const socket = await connect();
      const outcome = start(socket, "read", { path: "~/secret-notes.txt", ifNoneMatch: "h:x" });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        resultFor(lastOpId(socket), "read", { ...readResult, text: "1|TOPSECRET" }),
      );
      await outcome;
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        userId: "user-id",
        cliDeviceId: "desktop",
        mcpTokenId: "token",
        kind: "file_read",
        path: "~/secret-notes.txt",
        etagAfter: readResult.etag,
        outcome: "completed",
        reason: null,
      });
      expect(JSON.stringify(events())).not.toContain("TOPSECRET");
    });

    it("records a write's byte count and both etags, never the body or diff", async () => {
      const socket = await connect();
      const body = new TextEncoder().encode("PRIVATE BODY");
      const outcome = start(
        socket,
        "write",
        { path: "~/w.txt", ifExists: "replace", expectedEtag: "h:BEFOREBEFOREBEFOREBEF" },
        { body },
      );
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        resultFor(lastOpId(socket), "write", {
          etag: "h:AFTERAFTERAFTERAFTERAF",
          size: body.byteLength,
          created: false,
          diff: "+PRIVATE DIFF",
        }),
      );
      await outcome;
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        kind: "file_write",
        path: "~/w.txt",
        etagBefore: "h:BEFOREBEFOREBEFOREBEF",
        etagAfter: "h:AFTERAFTERAFTERAFTERAF",
        bytes: body.byteLength,
        outcome: "completed",
      });
      expect(events().map((event) => event.kind)).toEqual(["file_write"]);
      const wire = JSON.stringify(events());
      expect(wire).not.toContain("PRIVATE");
    });

    it("records refusals before dispatch as refused, and an unverified device as unknown", async () => {
      await connect();
      db.cliDevice.findUnique.mockImplementation(deviceRow("OFF"));
      await runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "delete", args: { path: "~/x" } });
      await runFileOp({ ...OP_TOKEN, cliDeviceId: "missing", op: "read", args: readArgs });
      db.cliDevice.findUnique.mockImplementation(deviceRow("UNSUPERVISED"));
      await runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: { path: "" } });
      expect(events()).toHaveLength(3);
      expect(events()[0]).toMatchObject({
        kind: "file_delete",
        path: "~/x",
        outcome: "refused",
        reason: "grant_disabled",
        cliDeviceId: "desktop",
      });
      expect(events()[1]).toMatchObject({
        outcome: "refused",
        reason: "not_found",
        cliDeviceId: "unknown",
      });
      expect(events()[2]).toMatchObject({ outcome: "refused", reason: "invalid_input" });
    });

    it("records CLI rejections as failed and a lost mutation as unknown", async () => {
      const socket = await connect();
      const failed = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "conflict",
          detail: { currentEtag: "h:CCCCCCCCCCCCCCCCCCCCCC" },
        }),
      );
      await failed;
      const lost = start(socket, "delete", { path: "~/d" });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      await relaySessionManager.removeSession(socket);
      await lost;
      expect(events()).toHaveLength(2);
      expect(events()[0]).toMatchObject({
        kind: "file_edit",
        outcome: "failed",
        reason: "conflict",
        etagBefore: "h:AAAAAAAAAAAAAAAAAAAAAA",
      });
      expect(events()[1]).toMatchObject({
        kind: "file_delete",
        outcome: "unknown",
        reason: "offline",
      });
    });

    it("keeps the verified device on a file not_found and on a mid-flight revoke", async () => {
      const socket = await connect();
      const missing = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason: "not_found" }),
      );
      await missing;
      const revoked = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      cancelFileOpsForToken("token");
      await revoked;
      expect(events()).toHaveLength(2);
      expect(events()[0]).toMatchObject({
        outcome: "failed",
        reason: "not_found",
        cliDeviceId: "desktop",
      });
      expect(events()[1]).toMatchObject({
        outcome: "cancelled",
        reason: "token_inactive",
        cliDeviceId: "desktop",
      });
    });

    it("stores the unknown device when admission itself throws", async () => {
      await connect();
      db.user.findUnique.mockRejectedValue(new Error("db down"));
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "spoofed-device-text", op: "read", args: readArgs }),
      ).rejects.toThrow("db down");
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ cliDeviceId: "unknown", reason: "io_error" });
    });

    it("records a read that timed out or lost its session as cancelled", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const socket = await connect();
      const timedOut = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await flush();
      await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS);
      await timedOut;
      const lost = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      await flush();
      await relaySessionManager.removeSession(socket);
      await lost;
      expect(events()).toHaveLength(2);
      expect(events()[0]).toMatchObject({ outcome: "cancelled", reason: "timeout" });
      expect(events()[1]).toMatchObject({ outcome: "cancelled", reason: "offline" });
    });

    it("records a mutation's unknown outcome after an io_error rejection, and CLI mode refusals as refused", async () => {
      const socket = await connect();
      const big = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason: "io_error" }),
      );
      await big;
      const root = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason: "unsupported" }),
      );
      await root;
      expect(events()[0]).toMatchObject({
        kind: "file_edit",
        outcome: "unknown",
        reason: "io_error",
      });
      expect(events()[1]).toMatchObject({
        kind: "file_read",
        outcome: "refused",
        reason: "unsupported",
      });
    });

    it("audits a CLI feature_disabled answer as refused and a CLI timeout as failed", async () => {
      const socket = await connect();
      for (const reason of ["feature_disabled", "timeout"]) {
        const outcome = start(socket, "read", readArgs);
        await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
        await answer(
          socket,
          JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason }),
        );
        await outcome;
        socket.sends.length = 0;
      }
      expect(events()[0]).toMatchObject({ outcome: "refused", reason: "feature_disabled" });
      expect(events()[1]).toMatchObject({ outcome: "failed", reason: "timeout" });
    });

    it.each([
      ["edit", editArgs],
      [
        "write",
        {
          path: "~/a",
          ifExists: "replace",
          expectedEtag: "h:AAAAAAAAAAAAAAAAAAAAAA",
        },
      ],
      ["rename", { from: "~/a", to: "~/b" }],
    ] as const)("audits %s unsafe_filesystem as a definitive CLI refusal", async (op, args) => {
      const socket = await connect();
      const outcome = start(socket, op, args, op === "write" ? { body: new Uint8Array([98]) } : {});
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "unsafe_filesystem",
        }),
      );
      await expect(outcome).resolves.toEqual({ ok: false, code: "unsafe_filesystem" });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        kind: `file_${op}`,
        outcome: "refused",
        reason: "unsafe_filesystem",
      });
      expect(socket.frames("file.cancel")).toEqual([]);
      expect(socket.closes).toEqual([]);
    });

    it("writes a metadata-only refusal row for an input the MCP layer refused", () => {
      auditRefusedFileInput({
        userId: "user-id",
        tokenId: "token",
        cliDeviceId: "attacker-chosen-device",
        op: "write",
        args: { path: "~/n.txt", expectedEtag: "h:AAAAAAAAAAAAAAAAAAAAAA" },
      });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        kind: "file_write",
        path: "~/n.txt",
        etagBefore: "h:AAAAAAAAAAAAAAAAAAAAAA",
        outcome: "refused",
        reason: "invalid_input",
        cliDeviceId: "unknown",
      });
    });

    it("records the CLI's own supervised_only refusal as refused and its cancelled as cancelled", async () => {
      const socket = await connect();
      for (const reason of ["supervised_only", "grant_disabled", "cancelled"]) {
        const outcome = start(socket, "read", readArgs);
        await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
        await answer(
          socket,
          JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason }),
        );
        await outcome;
        socket.sends.length = 0;
      }
      expect(events()[0]).toMatchObject({ outcome: "refused", reason: "supervised_only" });
      expect(events()[1]).toMatchObject({ outcome: "refused", reason: "grant_disabled" });
      expect(events()[2]).toMatchObject({ outcome: "cancelled", reason: "cancelled" });
    });

    it("records an aborted op exactly once, with the CLI's final answer", async () => {
      const socket = await connect();
      const controller = new AbortController();
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "edit",
        args: editArgs,
        signal: controller.signal,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const opId = lastOpId(socket);
      controller.abort();
      await outcome;
      expect(events()).toHaveLength(0);
      await answer(socket, JSON.stringify({ type: "file.rejected", opId, reason: "cancelled" }));
      await answer(socket, JSON.stringify({ type: "file.rejected", opId, reason: "cancelled" }));
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        kind: "file_edit",
        outcome: "cancelled",
        reason: "cancelled",
      });
    });
  });

  describe("admission matrix", () => {
    const ops = [
      { op: "read", args: readArgs },
      { op: "edit", args: editArgs },
    ] as const;
    const table: Array<{
      grant: "OFF" | "SUPERVISED" | "UNSUPERVISED";
      live: Mode;
      expected: string | "run";
    }> = [
      { grant: "UNSUPERVISED", live: "unsupervised", expected: "run" },
      { grant: "UNSUPERVISED", live: "supervised", expected: "supervised_only" },
      { grant: "UNSUPERVISED", live: "off", expected: "feature_disabled" },
      { grant: "SUPERVISED", live: "unsupervised", expected: "supervised_only" },
      { grant: "SUPERVISED", live: "supervised", expected: "supervised_only" },
      { grant: "OFF", live: "unsupervised", expected: "grant_disabled" },
      { grant: "OFF", live: "off", expected: "grant_disabled" },
    ];
    for (const { grant, live, expected } of table) {
      for (const { op, args } of ops) {
        it(`${op}: grant ${grant}, CLI ${live} -> ${expected}`, async () => {
          db.cliDevice.findUnique.mockImplementation(deviceRow(grant));
          const socket = await connect("desktop", live);
          const outcome = start(socket, op, args, op === "read" ? {} : {});
          if (expected === "run") {
            await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
            expect(socket.frames("file.op")[0]).toMatchObject({ op });
            await answer(
              socket,
              resultFor(
                lastOpId(socket),
                op,
                op === "read"
                  ? readResult
                  : {
                      etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
                      previousEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
                      added: 1,
                      removed: 1,
                      applied: true,
                    },
              ),
            );
            await expect(outcome).resolves.toMatchObject({ ok: true, op });
          } else {
            await expect(outcome).resolves.toEqual({
              ok: false,
              code: op === "edit" && expected === "supervised_only" ? "unsupported" : expected,
            });
            expect(socket.frames("file.op")).toEqual([]);
          }
        });
      }
    }

    it("takes the lowest of grant and CLI mode: a dashboard downgrade after hello refuses", async () => {
      const socket = await connect("desktop", "unsupervised");
      relaySessionManager.applyFeatureGrants("desktop", {
        mcpFileRead: false,
        allowHumanTerminal: false,
        mcpCommandMode: "supervised",
      });
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toEqual({ ok: false, code: "supervised_only" });
      expect(socket.frames("file.op")).toEqual([]);
    });

    it("refuses every op offline when the live 2.8 session does not run file ops", async () => {
      // A live 2.8 session whose features lack `fileOps` (the flag is ANDed into
      // `getLiveCliFeatures().fileOps`, and the server's strict hello schema
      // pins it true today) must dispatch nothing, even with the grant and the
      // read switch on. Reached by dropping the recorded feature on the live
      // session.
      db.cliDevice.findUnique.mockImplementation(deviceRow("UNSUPERVISED", { mcpFileRead: true }));
      const socket = await connect("desktop", "unsupervised", true, true);
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: "unsupervised",
        mcpFileRead: true,
      });
      const session = (
        Reflect.get(relaySessionManager, "sessionsByCliDeviceId") as Map<
          string,
          { features: Record<string, unknown> | null }
        >
      ).get("desktop");
      expect(session?.features?.fileOps).toBe(true);
      if (session) session.features = { ...session.features, fileOps: false };
      expect(relaySessionManager.getLiveCliFeatures(["desktop"]).get("desktop")?.fileOps).toBe(
        false,
      );
      for (const [op, args] of [
        ["read", readArgs],
        ["edit", editArgs],
      ] as const) {
        await expect(runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op, args })).resolves.toEqual(
          { ok: false, code: "offline" },
        );
      }
      expect(socket.frames("file.op")).toEqual([]);
    });

    it("uses one not-found for an unknown device and another user's device", async () => {
      const unknown = await runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "missing",
        op: "read",
        args: readArgs,
      });
      const foreign = await runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "foreign",
        op: "read",
        args: readArgs,
      });
      expect(unknown).toEqual({ ok: false, code: "not_found", scope: "device" });
      expect(foreign).toEqual(unknown);
    });

    it("refuses a token that is revoked, narrowed, or expired", async () => {
      await connect();
      for (const row of [
        null,
        { ...liveToken(), allowCliCommands: false },
        { ...liveToken(), scopes: ["mcp:read"] },
        liveToken(new Date(Date.now() - 1000)),
      ]) {
        db.mcpPersonalToken.findFirst.mockResolvedValue(row);
        await expect(
          runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
        ).resolves.toEqual({ ok: false, code: "token_inactive" });
      }
      db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken());
      await expect(
        runFileOp({
          ...OP_TOKEN,
          expiresAt: new Date(Date.now() - 1000),
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
        }),
      ).resolves.toEqual({ ok: false, code: "token_inactive" });
    });

    it("refuses a banned or deleting owner", async () => {
      const socket = await connect();
      for (const owner of [
        { banned: true, banExpires: null, deletionRequestedAt: null },
        { banned: false, banExpires: null, deletionRequestedAt: new Date() },
        null,
      ]) {
        db.user.findUnique.mockResolvedValue(owner);
        await expect(
          runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
        ).resolves.toEqual({ ok: false, code: "token_inactive" });
      }
      expect(socket.frames("file.op")).toEqual([]);
    });

    it("refuses while the CLI is offline, and names an old protocol the CLI was refused for", async () => {
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toEqual({ ok: false, code: "offline" });
      db.cliDevice.findUnique.mockImplementation(
        deviceRow("UNSUPERVISED", { rejectedRelayProtocolVersion: "2.7" }),
      );
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toEqual({ ok: false, code: "upgrade_required", rejectedProtocolVersion: "2.7" });
      // Connected: the stale marker does not matter.
      const socket = await connect();
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(outcome).resolves.toMatchObject({ ok: true });
    });

    it("refuses a start whose token is revoked while the owner read is pending", async () => {
      const socket = await connect();
      let release!: (row: unknown) => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      db.user.findUnique.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const started = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "edit",
        args: editArgs,
      });
      await reached;
      cancelFileOpsForToken("token");
      release({ banned: false, banExpires: null, deletionRequestedAt: null });
      await expect(started).resolves.toEqual({ ok: false, code: "token_inactive" });
      expect(socket.frames("file.op")).toEqual([]);
    });

    it("keeps the admission open until the verdict, so a revoke between the read and the verdict refuses", async () => {
      await connect();
      const reads = await readCliAgentAdmission({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
      });
      // The caller resumes in a later microtask: a revoke landing now must count.
      revokeOpenCliAgentAdmissions("token");
      expect(judgeCliAgentAdmission(reads, "file_write")).toEqual({
        ok: false,
        error: "token_inactive",
      });
      expect(openCliAgentAdmissionCountForTests()).toBe(0);
    });

    it("leaves no admission open after a judged run, an abort during the read, or a failed read", async () => {
      const socket = await connect();
      const judged = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await judged;
      expect(openCliAgentAdmissionCountForTests()).toBe(0);

      const controller = new AbortController();
      const aborted = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
        signal: controller.signal,
      });
      controller.abort();
      await expect(aborted).resolves.toEqual({ ok: false, code: "cancelled" });
      expect(openCliAgentAdmissionCountForTests()).toBe(0);

      db.cliDevice.findUnique.mockRejectedValueOnce(new Error("db down"));
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).rejects.toThrow();
      expect(openCliAgentAdmissionCountForTests()).toBe(0);
    });

    it("does not mark another token's open admission", async () => {
      const socket = await connect();
      let release!: (row: unknown) => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      db.user.findUnique.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const started = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await reached;
      cancelFileOpsForToken("someone-else");
      release({ banned: false, banExpires: null, deletionRequestedAt: null });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(started).resolves.toMatchObject({ ok: true });
    });
  });

  describe("frames", () => {
    it("sends a strict file.op and settles on file.result", async () => {
      const socket = await connect();
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const frame = socket.frames("file.op")[0];
      expect(frame).toMatchObject({ type: "file.op", op: "read", args: readArgs });
      expect(frame).not.toHaveProperty("bodyBytes");
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(outcome).resolves.toEqual({ ok: true, op: "read", result: readResult });
    });

    it("sends a write's content as one file.body frame after the op, never inside the args", async () => {
      const socket = await connect();
      const body = new TextEncoder().encode("hello\n");
      const outcome = start(socket, "write", { path: "~/new.txt", ifExists: "fail" }, { body });
      await waitFor(() => expect(socket.sends).toHaveLength(2));
      expect(typeof socket.sends[0]).toBe("string");
      expect(socket.frames("file.op")[0]).toMatchObject({ op: "write", bodyBytes: 6 });
      expect(JSON.stringify(socket.frames("file.op")[0])).not.toContain("hello");
      const binary = socket.binaries();
      expect(binary).toHaveLength(1);
      expect(binary[0]?.metadata).toEqual({ type: "file.body", opId: lastOpId(socket) });
      expect(Buffer.from(binary[0]?.body ?? []).toString()).toBe("hello\n");
      await answer(
        socket,
        resultFor(lastOpId(socket), "write", {
          etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
          size: 6,
          created: true,
        }),
      );
      await expect(outcome).resolves.toMatchObject({ ok: true, op: "write" });
    });

    it("refuses invalid input before anything is sent or charged", async () => {
      const socket = await connect();
      const cases: Array<
        Parameters<typeof runFileOp>[0]["op"] extends infer O ? [O, unknown, Uint8Array?] : never
      > = [
        ["read", { path: "" }],
        ["read", { path: "~/a", extra: 1 }],
        ["read", { path: "~/a\u0000b" }],
        ["read", { path: "~/a\ud800" }],
        ["write", { path: "~/a" }],
        ["write", { path: "~/a" }, new Uint8Array(1024 * 1024 + 1)],
        ["read", { path: "~/a" }, new Uint8Array(1)],
        ["edit", { path: "~/a", edits: [{ oldText: "x", newText: "y".repeat(70_000) }] }],
      ];
      for (const [op, args, body] of cases) {
        await expect(
          runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op, args, ...(body ? { body } : {}) }),
        ).resolves.toEqual({ ok: false, code: "invalid_input" });
      }
      expect(socket.sends).toEqual([]);
      // None of that spent the budget.
      for (let i = 0; i < FILE_OPS_PER_CLI; i += 1) {
        void start(socket, "read", readArgs);
      }
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI));
    });

    it("reassembles a text field that travels as file.data", async () => {
      const socket = await connect();
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const opId = lastOpId(socket);
      const text = `1|${"é".repeat(40_000)}`;
      const bytes = new TextEncoder().encode(text);
      await answer(
        socket,
        resultFor(
          opId,
          "read",
          { ...readResult, text: "" },
          { dataField: "text", bodyBytes: bytes.byteLength },
        ),
      );
      // Not settled until the data arrives.
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      relaySessionManager.handleBinaryFrame(
        socket,
        encodeRelayBinaryFrame({ type: "file.data", opId }, bytes),
      );
      await expect(outcome).resolves.toMatchObject({ ok: true, result: { text } });
    });

    it("fails the op when the spilled data is the wrong length or invalid UTF-8", async () => {
      for (const body of [new Uint8Array([0xff, 0xfe, 0xfd]), new TextEncoder().encode("short")]) {
        const socket = await connect();
        const outcome = start(socket, "list", { path: "~/d" });
        await waitFor(() => expect(socket.frames("file.op").length).toBeGreaterThan(0));
        const opId = lastOpId(socket);
        await answer(
          socket,
          resultFor(
            opId,
            "list",
            { entries: "", count: 1, more: null },
            { dataField: "entries", bodyBytes: 3 },
          ),
        );
        relaySessionManager.handleBinaryFrame(
          socket,
          encodeRelayBinaryFrame({ type: "file.data", opId }, body),
        );
        await expect(outcome).resolves.toEqual({ ok: false, code: "io_error" });
        await resetRelaySessions();
      }
    });

    it("passes the CLI's rejection code and detail through, without an unknown outcome", async () => {
      const socket = await connect();
      const outcome = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "conflict",
          detail: { currentEtag: "h:CCCCCCCCCCCCCCCCCCCCCC" },
        }),
      );
      await expect(outcome).resolves.toEqual({
        ok: false,
        code: "conflict",
        detail: { currentEtag: "h:CCCCCCCCCCCCCCCCCCCCCC" },
      });
    });

    it("maps the wire-level bad_frame refusal to io_error for a read and for a mutation (no raw code leaks)", async () => {
      // `bad_frame` is a CLI-side framing refusal: the request never reached
      // the filesystem, so the caller must see the documented io_error and a
      // mutation must NOT carry an unknown outcome.
      const socket = await connect();
      const read = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "bad_frame",
        }),
      );
      await expect(read).resolves.toEqual({ ok: false, code: "io_error" });

      const edit = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      await answer(
        socket,
        JSON.stringify({
          type: "file.rejected",
          opId: lastOpId(socket),
          reason: "bad_frame",
        }),
      );
      await expect(edit).resolves.toEqual({ ok: false, code: "io_error" });
    });

    // Every reason the CLI's own dispatcher can put in `file.rejected`:
    // `grant_disabled`/`feature_disabled`/`supervised_only`/`bad_frame` from
    // `admit`/`refuse` (apps/cli/src/file_relay.rs) and the file error codes
    // (apps/cli/src/file_ops/error.rs). A reason outside the wire enum would
    // fail the schema, settle as io_error and send a pointless file.cancel.
    it.each([
      ["grant_disabled", "grant_disabled"],
      ["feature_disabled", "feature_disabled"],
      ["supervised_only", "supervised_only"],
      ["limit", "limit"],
      ["unsupported", "unsupported"],
      ["unsafe_filesystem", "unsafe_filesystem"],
      ["not_found", "not_found"],
      ["bad_frame", "io_error"],
    ])(
      "passes the CLI's %s refusal through as %s without a malformed-frame cancel",
      async (reason, code) => {
        const socket = await connect();
        const outcome = start(socket, "read", readArgs);
        await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
        await answer(
          socket,
          JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason }),
        );
        await expect(outcome).resolves.toEqual({ ok: false, code });
        expect(socket.frames("file.cancel")).toEqual([]);
        expect(socket.closes).toEqual([]);
      },
    );

    it.each([
      ["grant_disabled", "grant_disabled"],
      ["feature_disabled", "feature_disabled"],
      ["supervised_only", "supervised_only"],
      ["unsafe_filesystem", "unsafe_filesystem"],
    ])("settles a mutation refused with %s as %s, never as unknown", async (reason, code) => {
      const socket = await connect();
      const outcome = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(
        socket,
        JSON.stringify({ type: "file.rejected", opId: lastOpId(socket), reason }),
      );
      await expect(outcome).resolves.toEqual({ ok: false, code });
      expect(socket.frames("file.cancel")).toEqual([]);
    });

    it("drops answers for unknown ops and answers from another session, without closing", async () => {
      const socket = await connect("desktop");
      const other = await connect("laptop");
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const opId = lastOpId(socket);
      await answer(socket, resultFor("AAAAAAAAAAAAAAAAAAAAAA", "read", readResult));
      await answer(other, resultFor(opId, "read", readResult));
      relaySessionManager.handleBinaryFrame(
        other,
        encodeRelayBinaryFrame({ type: "file.data", opId }, new Uint8Array(3)),
      );
      expect(socket.closes).toEqual([]);
      expect(other.closes).toEqual([]);
      await answer(socket, resultFor(opId, "read", readResult));
      await expect(outcome).resolves.toMatchObject({ ok: true });
    });

    it("fails only the op for a malformed answer and keeps the session", async () => {
      const socket = await connect();
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const opId = lastOpId(socket);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await answer(socket, resultFor(opId, "read", { ...readResult, leak: "x" }));
      await expect(outcome).resolves.toEqual({ ok: false, code: "io_error" });
      expect(socket.closes).toEqual([]);
      expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
    });

    it("fails a mutating op whose answer is malformed with an unknown outcome", async () => {
      const socket = await connect();
      const outcome = start(socket, "delete", { path: "~/a" });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await answer(socket, resultFor(lastOpId(socket), "delete", { deleted: true }));
      await expect(outcome).resolves.toEqual({ ok: false, code: "io_error", outcome: "unknown" });
    });

    it("refuses an answer for a different op than was asked", async () => {
      const socket = await connect();
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "mkdir", { created: true }));
      await expect(outcome).resolves.toEqual({ ok: false, code: "io_error" });
    });
  });

  describe("limits", () => {
    it("allows 4 ops per CLI and refuses the 5th with limit and retryAfterMs", async () => {
      const socket = await connect();
      const running = Array.from({ length: FILE_OPS_PER_CLI }, () =>
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      );
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI));
      const fifth = await runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      expect(fifth).toMatchObject({ ok: false, code: "limit" });
      expect(fifth.ok === false && fifth.retryAfterMs).toBeGreaterThan(0);
      expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI);
      // Settling one frees a slot.
      const first = socket.frames("file.op")[0];
      await answer(socket, resultFor(String(first?.opId), "read", readResult));
      await expect(running[0]).resolves.toMatchObject({ ok: true });
      const again = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI + 1));
      void again;
    });

    it("allows 16 ops per user across CLIs and refuses the 17th", async () => {
      const sockets: FakeSocket[] = [];
      for (let index = 0; index < 5; index += 1) sockets.push(await connect(`cli-${index}`));
      const started: Array<Promise<unknown>> = [];
      for (let index = 0; index < FILE_OPS_PER_USER; index += 1) {
        started.push(
          runFileOp({
            ...OP_TOKEN,
            cliDeviceId: `cli-${index % 5}`,
            op: "read",
            args: readArgs,
          }),
        );
      }
      await waitFor(() =>
        expect(sockets.reduce((sum, socket) => sum + socket.frames("file.op").length, 0)).toBe(
          FILE_OPS_PER_USER,
        ),
      );
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "cli-4", op: "read", args: readArgs }),
      ).resolves.toMatchObject({ ok: false, code: "limit" });
    });

    async function settleAll(socket: FakeSocket, op: string, result: Record<string, unknown>) {
      for (const frame of socket.frames("file.op")) {
        await answer(socket, resultFor(String(frame.opId), op, result));
      }
    }

    it("refuses the 121st op in a minute with a retryAfterMs, and admits again after the window", {
      timeout: 30_000,
    }, async () => {
      const socket = await connect();
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      for (let index = 0; index < FILE_OPS_PER_MINUTE_PER_USER; index += 1) {
        const outcome = start(socket, "read", readArgs);
        await waitFor(() => expect(socket.frames("file.op").length).toBe(index + 1));
        await answer(socket, resultFor(lastOpId(socket), "read", readResult));
        await expect(outcome).resolves.toMatchObject({ ok: true });
        clock += 100;
      }
      const refused = await runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      expect(refused).toMatchObject({ ok: false, code: "limit" });
      const retry = refused.ok === false ? (refused.retryAfterMs ?? 0) : 0;
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(60_000);
      expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_MINUTE_PER_USER);
      clock += retry + 1;
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({ type: "heartbeat", id: "rate-window-heartbeat" }),
        new Date(clock),
      );
      const admitted = start(socket, "read", readArgs);
      await waitFor(() =>
        expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_MINUTE_PER_USER + 1),
      );
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(admitted).resolves.toMatchObject({ ok: true });
      void settleAll;
    });

    it("refuses the 31st mutating op in a minute while reads still run", async () => {
      const socket = await connect();
      for (let index = 0; index < FILE_MUTATIONS_PER_MINUTE_PER_USER; index += 1) {
        const outcome = start(socket, "mkdir", { path: `~/d${index}` });
        await waitFor(() => expect(socket.frames("file.op").length).toBe(index + 1));
        await answer(socket, resultFor(lastOpId(socket), "mkdir", { created: true }));
        await expect(outcome).resolves.toMatchObject({ ok: true });
      }
      const refused = await runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "mkdir",
        args: { path: "~/one-more" },
      });
      expect(refused).toMatchObject({ ok: false, code: "limit" });
      expect(refused.ok === false && refused.retryAfterMs).toBeGreaterThan(0);
      const read = start(socket, "read", readArgs);
      await waitFor(() =>
        expect(socket.frames("file.op")).toHaveLength(FILE_MUTATIONS_PER_MINUTE_PER_USER + 1),
      );
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(read).resolves.toMatchObject({ ok: true });
    });

    it("does not charge refused ops against the budget", async () => {
      db.cliDevice.findUnique.mockImplementation(deviceRow("OFF"));
      await connect();
      for (let index = 0; index < FILE_OPS_PER_MINUTE_PER_USER + 5; index += 1) {
        await expect(
          runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
        ).resolves.toEqual({ ok: false, code: "grant_disabled" });
      }
    });
  });

  describe("deadline, cancel, and session loss", () => {
    it("times out a read after 30 s, sends file.cancel, and drops the late answer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await flush();
      expect(socket.frames("file.op")).toHaveLength(1);
      const opId = lastOpId(socket);
      await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS);
      await expect(outcome).resolves.toEqual({ ok: false, code: "timeout" });
      expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId }]);
      await answer(socket, resultFor(opId, "read", readResult));
      expect(socket.closes).toEqual([]);
    });

    it("times out a mutating op with outcome unknown", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "edit",
        args: editArgs,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS);
      await expect(outcome).resolves.toEqual({ ok: false, code: "timeout", outcome: "unknown" });
    });

    it("does not time out before the deadline", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await flush();
      expect(socket.frames("file.op")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS - 1);
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(outcome).resolves.toMatchObject({ ok: true });
    });

    it("sends file.cancel on abort and returns cancelled (unknown for a mutation)", async () => {
      const socket = await connect();
      const read = new AbortController();
      const readOutcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
        signal: read.signal,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const readId = lastOpId(socket);
      read.abort();
      await expect(readOutcome).resolves.toEqual({ ok: false, code: "cancelled" });
      expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId: readId }]);

      const write = new AbortController();
      const writeOutcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "edit",
        args: editArgs,
        signal: write.signal,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      write.abort();
      await expect(writeOutcome).resolves.toEqual({
        ok: false,
        code: "cancelled",
        outcome: "unknown",
      });
      expect(socket.frames("file.cancel")).toHaveLength(2);
    });

    it("returns cancelled without sending anything when the signal is already aborted", async () => {
      const socket = await connect();
      const controller = new AbortController();
      controller.abort();
      await expect(
        runFileOp({
          ...OP_TOKEN,
          cliDeviceId: "desktop",
          op: "read",
          args: readArgs,
          signal: controller.signal,
        }),
      ).resolves.toEqual({ ok: false, code: "cancelled" });
      expect(socket.sends).toEqual([]);
    });

    it("keeps the concurrency slot of an aborted op until the CLI answers", async () => {
      const socket = await connect();
      const controller = new AbortController();
      const first = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
        signal: controller.signal,
      });
      for (let index = 1; index < FILE_OPS_PER_CLI; index += 1) {
        void runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      }
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI));
      controller.abort();
      await first;
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toMatchObject({ ok: false, code: "limit" });
      const opId = String(socket.frames("file.op")[0]?.opId);
      await answer(socket, JSON.stringify({ type: "file.rejected", opId, reason: "cancelled" }));
      const next = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI + 1));
      void next;
    });

    it("releases the slot of an aborted op after a grace period when the CLI never answers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const controller = new AbortController();
      const first = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "edit",
        args: editArgs,
        signal: controller.signal,
      });
      for (let index = 1; index < FILE_OPS_PER_CLI; index += 1) {
        void runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      }
      await flush();
      expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI);
      controller.abort();
      await first;
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toMatchObject({ ok: false, code: "limit" });
      await vi.advanceTimersByTimeAsync(5_000);
      const next = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      await flush();
      expect(socket.frames("file.op")).toHaveLength(FILE_OPS_PER_CLI + 1);
      void next;
    });

    it("fails every pending op with offline when the session closes (mutations unknown)", async () => {
      const socket = await connect();
      const read = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      const write = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "edit", args: editArgs });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      await relaySessionManager.removeSession(socket);
      await expect(read).resolves.toEqual({ ok: false, code: "offline" });
      await expect(write).resolves.toEqual({ ok: false, code: "offline", outcome: "unknown" });
    });

    it("leaves no dead record behind when the send itself throws (G5)", async () => {
      const socket = await connect();
      // Registered before the send (session-manager dispatchFileOp stores then
      // sends), so a throwing send must be forgotten by the refusal path or the
      // record would sit in filesById until teardown and hold the per-CLI slot.
      vi.spyOn(socket, "send").mockImplementation(() => {
        throw new Error("socket send failed");
      });
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toEqual({ ok: false, code: "offline" });
      const session = (
        Reflect.get(relaySessionManager, "sessionsByCliDeviceId") as Map<
          string,
          { filesById: Map<string, { markLost(cause: string): void }> }
        >
      ).get("desktop");
      const abandoned = [...(session?.filesById.values() ?? [])];
      expect(abandoned).toEqual([]);
      // No dead entry counts against the per-CLI limit or leaks into a
      // follow-up op once the socket works again.
      vi.mocked(socket.send).mockRestore();
      const next = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(next).resolves.toMatchObject({ ok: true });
    });

    it("runs settle EXACTLY once per record (no double-fire after a terminal outcome)", async () => {
      // `record.resolve` and the map deletes are idempotent, so the once-only
      // guard protects both the audit event and tracking cleanup. Drive two
      // terminal answers at one tracked record and count settle's effects.
      const socket = await connect();
      const outcome = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      const opId = lastOpId(socket);
      const session = (
        Reflect.get(relaySessionManager, "sessionsByCliDeviceId") as Map<
          string,
          { filesById: Map<string, { markLost(cause: string): void }> }
        >
      ).get("desktop");
      // Captured BEFORE the answer, because settle forgets it on success.
      const tracked = session?.filesById.get(opId);
      expect(tracked).toBeDefined();
      const forget = vi.spyOn(relaySessionManager, "forgetFileOp");
      const cancel = vi.spyOn(relaySessionManager, "dispatchFileCancel");
      await answer(socket, resultFor(opId, "read", readResult));
      await expect(outcome).resolves.toMatchObject({ ok: true });
      expect(forget).toHaveBeenCalledTimes(1);
      // A duplicate terminal answer (re-delivered frame or a later sweep)
      // must not settle it again. Reading the maps also holds the record
      // shape itself: a second settle would delete a DIFFERENT opId.
      await answer(socket, resultFor(opId, "read", readResult));
      await answer(socket, JSON.stringify({ type: "file.rejected", opId, reason: "cancelled" }));
      tracked?.markLost("offline");
      expect(forget).toHaveBeenCalledTimes(1);
      expect(forget).toHaveBeenLastCalledWith("desktop", opId);
      expect(session?.filesById.size).toBe(0);
      expect(cancel.mock.calls.length).toBe(0);
    });

    it("ends in-flight ops with the refusal the mode now gives when the grant drops", async () => {
      const socket = await connect();
      const read = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      const write = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "delete",
        args: { path: "~/a" },
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      relaySessionManager.applyFeatureGrants("desktop", {
        mcpFileRead: false,
        allowHumanTerminal: false,
        mcpCommandMode: "off",
      });
      await expect(read).resolves.toEqual({ ok: false, code: "grant_disabled" });
      await expect(write).resolves.toEqual({
        ok: false,
        code: "grant_disabled",
        outcome: "unknown",
      });
      expect(socket.frames("file.cancel")).toHaveLength(2);
    });

    it("cancels the ops of a revoked token and leaves other tokens' ops running", async () => {
      const socket = await connect();
      const mine = runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs });
      const other = runFileOp({
        ...OP_TOKEN,
        tokenId: "other",
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      const mineId = String(socket.frames("file.op")[0]?.opId);
      const otherId = String(socket.frames("file.op")[1]?.opId);
      cancelFileOpsForToken("token");
      await expect(mine).resolves.toEqual({ ok: false, code: "token_inactive" });
      expect(socket.frames("file.cancel")).toEqual([{ type: "file.cancel", opId: mineId }]);
      await answer(socket, resultFor(otherId, "read", readResult));
      await expect(other).resolves.toMatchObject({ ok: true });
    });

    it("ends the ops of an expired token in the sweep", async () => {
      const socket = await connect();
      db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken(new Date(Date.now() + 5_000)));
      const outcome = runFileOp({
        ...OP_TOKEN,
        expiresAt: new Date(Date.now() + 5_000),
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      expect(sweepExpiredFileOps(Date.now())).toBe(0);
      expect(sweepExpiredFileOps(Date.now() + 6_000)).toBe(1);
      await expect(outcome).resolves.toEqual({ ok: false, code: "token_inactive" });
    });
  });
  describe("ban fence (#159)", () => {
    let unsubscribe: () => void;
    beforeEach(() => {
      // The same subscription apps/server/src/app.ts makes.
      unsubscribe = onUserBanned(cancelRelayWorkForBannedUser);
    });
    afterEach(async () => {
      unsubscribe();
      await resetRelaySessions();
      resetFileOpsForTests();
    });

    /** A second owner with their own device, to prove the fence is per user. */
    async function connectOtherUser() {
      const other = new FakeSocket();
      relaySessionManager.acceptAuthenticatedSocket({
        socket: other,
        identity: { ...identity, id: "token-id-other", userId: "other-user" },
        now,
      });
      await relaySessionManager.handleTextFrame(other, hello("laptop", "unsupervised"), now);
      other.sends.length = 0;
      db.cliDevice.findUnique.mockImplementation((args: { where: { id: string } }) => ({
        id: args.where.id,
        userId: args.where.id === "laptop" ? "other-user" : "user-id",
        mcpCommandMode: "UNSUPERVISED",
      }));
      return other;
    }

    /** A promise's state without awaiting it: true once it has settled. */
    function tracked<T>(promise: Promise<T>) {
      const state = { settled: false };
      void promise.then(
        () => {
          state.settled = true;
        },
        () => {
          state.settled = true;
        },
      );
      return state;
    }

    it("a ban during a long read and a long mutating op cancels both, and only that user's", async () => {
      const socket = await connect();
      const other = await connectOtherUser();
      // Three ops in flight, none answered by the CLI: they would run to their 30 s deadline.
      const read = start(socket, "read", readArgs);
      const edit = start(socket, "edit", editArgs, { tokenId: "second-token" });
      const otherRead = start(other, "read", readArgs, {
        userId: "other-user",
        tokenId: "token-other",
        cliDeviceId: "laptop",
      });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      await waitFor(() => expect(other.frames("file.op")).toHaveLength(1));
      const states = [tracked(read), tracked(edit), tracked(otherRead)];
      await flush();
      expect(states.map((state) => state.settled)).toEqual([false, false, false]);

      // The ban commits; the post-commit notification runs the listener.
      await notifyUserBanned("user-id");

      // Every token of the banned user ends at once (not at the deadline). The mutation's outcome is unknown.
      await expect(read).resolves.toEqual({ ok: false, code: "token_inactive" });
      await expect(edit).resolves.toEqual({
        ok: false,
        code: "token_inactive",
        outcome: "unknown",
      });
      expect(socket.frames("file.cancel").map((frame) => frame.opId)).toEqual(
        socket.frames("file.op").map((frame) => frame.opId),
      );
      // Their socket is not closed by a ban.
      expect(socket.closes).toEqual([]);
      // The other user's op is untouched, still completes normally, and was never cancelled.
      expect(states[2]?.settled).toBe(false);
      expect(other.frames("file.cancel")).toEqual([]);
      await answer(other, resultFor(lastOpId(other), "read", readResult));
      await expect(otherRead).resolves.toMatchObject({ ok: true });
      // A cancelled op leaves no record or slot behind (the mocked owner row is unbanned here).
      const next = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(3));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(next).resolves.toMatchObject({ ok: true });
    });

    it("refuses an op whose admission is still reading when the ban lands", async () => {
      const socket = await connect();
      let release!: (row: unknown) => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // The ban has committed but the owner read already returned the pre-ban row.
      db.user.findUnique.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const started = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await reached;
      await notifyUserBanned("user-id");
      release({ banned: false, banExpires: null, deletionRequestedAt: null });
      await expect(started).resolves.toEqual({ ok: false, code: "token_inactive" });
      expect(socket.frames("file.op")).toEqual([]);
      expect(openCliAgentAdmissionCountForTests()).toBe(0);
    });

    it("cancelFileOpsForUser alone also refuses an op still in admission, and ends a registered one", async () => {
      const socket = await connect();
      let release!: (row: unknown) => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      db.user.findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const reading = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await reached;
      cancelFileOpsForUser("user-id");
      release({ banned: false, banExpires: null, deletionRequestedAt: null });
      await expect(reading).resolves.toEqual({ ok: false, code: "token_inactive" });
      expect(socket.frames("file.op")).toEqual([]);
      const running = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      cancelFileOpsForUser("user-id");
      await expect(running).resolves.toEqual({ ok: false, code: "token_inactive" });
    });

    it("does not mark another user's open admission", async () => {
      const socket = await connect();
      let release!: (row: unknown) => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      db.user.findUnique.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const started = runFileOp({
        ...OP_TOKEN,
        cliDeviceId: "desktop",
        op: "read",
        args: readArgs,
      });
      await reached;
      await notifyUserBanned("someone-else");
      release({ banned: false, banExpires: null, deletionRequestedAt: null });
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(started).resolves.toMatchObject({ ok: true });
    });

    it("an op started after the ban is refused by the owner read, and the ban sweep leaves later ops of an unbanned user alone", async () => {
      const socket = await connect();
      db.user.findUnique.mockResolvedValue({
        banned: true,
        banExpires: null,
        deletionRequestedAt: null,
      });
      await notifyUserBanned("user-id");
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toEqual({ ok: false, code: "token_inactive" });
      expect(socket.frames("file.op")).toEqual([]);
      // Unbanned again: the earlier sweep holds no state, so a new op runs.
      db.user.findUnique.mockResolvedValue({
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
      });
      const again = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await answer(socket, resultFor(lastOpId(socket), "read", readResult));
      await expect(again).resolves.toMatchObject({ ok: true });
    });

    it("revoking the CLI credential during a long read and a long mutating op ends both (the revoke half of #159)", async () => {
      const socket = await connect();
      const read = start(socket, "read", readArgs);
      const edit = start(socket, "edit", editArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(2));
      const ids = socket.frames("file.op").map((frame) => frame.opId);
      // Another credential's revoke leaves them alone.
      await relaySessionManager.closeSessionsForRevokedCredentials({
        kind: "cliToken",
        ids: ["some-other-token"],
      });
      expect(socket.closes).toEqual([]);
      // What `onCliCredentialsRevoked` runs after the revoking write committed.
      await relaySessionManager.closeSessionsForRevokedCredentials({
        kind: "cliToken",
        ids: [identity.id],
      });
      await expect(read).resolves.toEqual({ ok: false, code: "offline" });
      await expect(edit).resolves.toEqual({ ok: false, code: "offline", outcome: "unknown" });
      expect(socket.frames("file.cancel").map((frame) => frame.opId)).toEqual(ids);
      expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    });

    it("records the cancelled op in the audit as cancelled with token_inactive", async () => {
      const socket = await connect();
      const outcome = start(socket, "read", readArgs);
      await waitFor(() => expect(socket.frames("file.op")).toHaveLength(1));
      await notifyUserBanned("user-id");
      await outcome;
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "cancelled", reason: "token_inactive" }),
      );
    });
  });
});

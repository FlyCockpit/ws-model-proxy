import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
} from "./protocol.js";

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

const { default: prisma } = await import("@ws-model-proxy/db");
const { relaySessionManager } = await import("./session-manager.js");
const {
  cancelFileOpsForToken,
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
  cliDevice: { upsert: MockInstance; update: MockInstance; findUnique: MockInstance };
  cliToken: { updateMany: MockInstance; findUnique: MockInstance };
  endpoint: { findUnique: MockInstance };
  discoveredModel: { findMany: MockInstance };
  executionTarget: { findMany: MockInstance };
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
    db.cliDevice.findUnique.mockImplementation(deviceRow("UNSUPERVISED"));
    db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken());
    db.endpoint.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
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
                  ? "supervised_only"
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

  it.each(["off", "unsupervised"] as const)(
    "stale %s hello is absent at admission and dispatch",
    async (mode) => {
      db.cliDevice.findUnique.mockImplementation(
        deviceRow(mode === "off" ? "OFF" : "UNSUPERVISED", { mcpFileRead: true }),
      );
      const socket = await connect("desktop", mode, true, true);
      relaySessionManager.applyFeatureGrants("desktop", {
        allowHumanTerminal: false,
        mcpCommandMode: mode,
        mcpFileRead: true,
      });
      expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBeNull();
      vi.setSystemTime(new Date(now.getTime() + 60_001));
      expect(relaySessionManager.getLiveCliFeatures(["desktop"]).has("desktop")).toBe(false);
      expect(relaySessionManager.fileOpModeRefusal("desktop", "read")).toBe(
        mode === "off" ? "grant_disabled" : "feature_disabled",
      );
      await expect(
        runFileOp({ ...OP_TOKEN, cliDeviceId: "desktop", op: "read", args: readArgs }),
      ).resolves.toEqual({ ok: false, code: mode === "off" ? "grant_disabled" : "offline" });
      expect(socket.frames("file.op")).toEqual([]);
    },
  );

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
            await expect(outcome).resolves.toEqual({ ok: false, code: expected });
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
      // guard is observed by COUNTERS: the #132 audit hook (the TODO in
      // settle) is the next thing that depends on it, and a re-delivered
      // frame or a session sweep can reach the same record again. Drive two
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
});

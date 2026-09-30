import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import {
  type McpCommandLive,
  mcpCommandModeFromDb,
  mcpCommandRefusals,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import { notifyUserBanned, onUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cliAgentAdmission from "./cli-agent-admission.js";
import { FILE_ERROR_CODES } from "./file-protocol.js";
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
    BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!",
  },
}));

vi.mock("./cli-agent-audit.js", () => ({ recordCliAgentAction: vi.fn() }));

const { runFileOp, resetFileOpsForTests, FILE_OP_DEADLINE_MS } = await import("./cli-file-ops.js");
const { default: prisma } = await import("@ws-model-proxy/db");
const { recordCliAgentAction } = await import("./cli-agent-audit.js");
const audit = recordCliAgentAction as unknown as MockInstance;
const { relaySessionManager, registerTerminalBridge } = await import("./session-manager.js");
const {
  cancelCommandsForToken,
  listPendingSupervised,
  resetCliCommandsForTests,
  snapshotSupervisedCommand,
  startCliCommand,
  startSupervisedCommand,
  startSupervisedRequest,
  submitSupervisedOutput,
  sweepExpiredTokenCommands,
  SUPERVISED_CONFIRM_TTL_MS,
  SUPERVISED_REVIEW_TTL_MS,
  SUPERVISED_STOP_GRACE_MS,
} = await import("./cli-commands.js");

type Mode = "off" | "supervised" | "unsupervised";
type DbMode = "OFF" | "SUPERVISED" | "UNSUPERVISED";

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: { upsert: MockInstance; update: MockInstance; findUnique: MockInstance };
  cliToken: { update: MockInstance; updateMany: MockInstance; findUnique: MockInstance };
  endpoint: { findUnique: MockInstance; findMany: MockInstance };
  discoveredModel: { findMany: MockInstance };
  executionTarget: { findMany: MockInstance };
  inferenceCapacity: { findMany: MockInstance };
  poolMember: { findMany: MockInstance };
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
  json(): Array<Record<string, unknown>> {
    return this.sends
      .filter((send): send is string => typeof send === "string")
      .map((send) => JSON.parse(send) as Record<string, unknown>);
  }
}

/** The live PAT row the start path re-reads: unrevoked, CLI commands, mcp:write. */
function liveToken(name = "MCP agent", expiresAt: Date | null = null) {
  return { name, scopes: ["mcp:read", "mcp:write"], allowCliCommands: true, expiresAt };
}

function uncompressedKey(): string {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
}

function hello(slug: string, features: { mode: Mode; terminalSupported: boolean }) {
  return JSON.stringify({
    type: "hello",
    id: `hello-${slug}`,
    protocolVersion: "2.8",
    cli: {
      slug,
      hostname: `${slug}.local`,
      version: "0.4.0",
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
          mcpCommandMode: features.mode,
          terminalApproval: false,
          terminalSupported: features.terminalSupported,
          remoteMetricSources: false,
          mcpFileRead: false,
          fileRootsConfigured: false,
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

let grants: Record<string, DbMode> = {};
let sockets: FakeSocket[] = [];
let events: Array<{ type: string; userId?: string; terminalId?: string }> = [];

async function connect(
  slug = "desktop",
  features: { mode?: Mode; terminalSupported?: boolean; grant?: DbMode } = {},
) {
  grants[slug] = features.grant ?? "SUPERVISED";
  const socket = new FakeSocket();
  sockets.push(socket);
  relaySessionManager.acceptAuthenticatedSocket({ socket, identity, now });
  await relaySessionManager.handleTextFrame(
    socket,
    hello(slug, {
      mode: features.mode ?? "supervised",
      terminalSupported: features.terminalSupported ?? true,
    }),
    now,
  );
  socket.sends.length = 0;
  return socket;
}

function start(overrides: Partial<Parameters<typeof startSupervisedCommand>[0]> = {}) {
  return startSupervisedCommand({
    userId: "user-id",
    tokenId: "token-a",
    expiresAt: null,
    cliDeviceId: "desktop",
    command: "sudo apt install build-essential",
    reason: "installs build deps; needs your sudo password",
    shareOutput: true,
    ...overrides,
  });
}

async function started(
  overrides: Partial<Parameters<typeof startSupervisedCommand>[0]> = {},
): Promise<{ commandId: string; terminalId: string }> {
  const result = await start(overrides);
  if (!result.ok) throw new Error(`expected start, got ${result.error}`);
  return { commandId: result.commandId, terminalId: result.terminalId };
}

async function say(socket: FakeSocket, message: Record<string, unknown>) {
  await relaySessionManager.handleTextFrame(socket, JSON.stringify(message), now);
}

function output(socket: FakeSocket, commandId: string, part: "head" | "tail", bytes: Uint8Array) {
  relaySessionManager.handleBinaryFrame(
    socket,
    encodeRelayBinaryFrame({ type: "supervised.output", commandId, part, seq: 1 }, bytes),
  );
}

async function spawnedAndAccepted(socket: FakeSocket, overrides = {}) {
  const request = await started(overrides);
  await say(socket, { type: "term.spawned", ...request });
  await say(socket, { type: "supervised.accepted", commandId: request.commandId });
  return request;
}

function snapshot(commandId: string, tokenId = "token-a") {
  return snapshotSupervisedCommand(commandId, "user-id", tokenId);
}

function sent(socket: FakeSocket, type: string) {
  return socket.json().filter((message) => message.type === type);
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("supervised commands", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    resetCliCommandsForTests();
    resetFileOpsForTests();
    vi.clearAllMocks();
    grants = {};
    sockets = [];
    events = [];
    registerTerminalBridge({
      onTerminalEvent(event) {
        events.push(event as { type: string; userId?: string; terminalId?: string });
      },
    });
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
      mcpCommandMode: grants[args.create.slug] ?? "OFF",
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
    db.cliDevice.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === "missing") return null;
      if (args.where.id === "foreign") {
        return { id: "foreign", userId: "other-user", mcpCommandMode: "UNSUPERVISED" };
      }
      return {
        id: args.where.id,
        userId: "user-id",
        mcpCommandMode: grants[args.where.id] ?? "OFF",
      };
    });
    db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken("Build agent"));
    db.endpoint.findUnique.mockResolvedValue(null);
    db.endpoint.findMany.mockResolvedValue([]);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets) await relaySessionManager.removeSession(socket, now);
    resetCliCommandsForTests();
    resetFileOpsForTests();
  });

  describe("start checks", () => {
    it("refuses an unknown or foreign device, a grant of off, and a CLI mode of off", async () => {
      await connect("desktop", { grant: "OFF" });
      await expect(start({ cliDeviceId: "missing" })).resolves.toEqual({
        ok: false,
        error: "not_found",
      });
      await expect(start({ cliDeviceId: "foreign" })).resolves.toEqual({
        ok: false,
        error: "not_found",
      });
      await expect(start()).resolves.toEqual({ ok: false, error: "grant_disabled" });

      const cliOff = await connect("laptop", { mode: "off", grant: "UNSUPERVISED" });
      await expect(start({ cliDeviceId: "laptop" })).resolves.toEqual({
        ok: false,
        error: "feature_disabled",
      });
      expect(cliOff.sends).toEqual([]);
    });

    // The dashboard and MCP device list show `mcpCommandRefusals`. It must
    // give the relay's own answer for every device state, for both tools.
    it("mcpCommandRefusals matches what the real start functions refuse, in every state", async () => {
      const grantsDb: DbMode[] = ["OFF", "SUPERVISED", "UNSUPERVISED"];
      const modes: Mode[] = ["off", "supervised", "unsupervised"];
      const lives: Array<McpCommandLive | null> = [null];
      for (const mode of modes) {
        for (const terminalSupported of [true, false]) {
          lives.push({ mode, supervisedCommands: true, terminalSupported });
        }
      }
      let row = 0;
      let refused = 0;
      let admitted = 0;
      for (const grant of grantsDb) {
        for (const live of lives) {
          row += 1;
          const slug = `parity-${row}`;
          resetCliCommandsForTests();
          resetFileOpsForTests();
          if (live) {
            await connect(slug, {
              grant,
              mode: live.mode,
              terminalSupported: live.terminalSupported,
            });
          } else {
            grants[slug] = grant;
          }
          const want = mcpCommandRefusals({ grant: mcpCommandModeFromDb(grant), live });
          const headless = await startCliCommand({
            userId: "user-id",
            tokenId: `token-h-${row}`,
            expiresAt: null,
            cliDeviceId: slug,
            command: "pwd",
          });
          const supervised = await start({
            cliDeviceId: slug,
            tokenId: `token-s-${row}`,
            command: "pwd",
            reason: "parity",
          });
          const label = `${grant} grant, live ${JSON.stringify(live)}`;
          // The display splits the relay's supervised_only by switch; nothing else differs.
          const relayCode = (code: string | null) =>
            code === "grant_supervised_only" || code === "cli_supervised_only"
              ? "supervised_only"
              : code;
          expect(headless.ok ? null : headless.error, `headless: ${label}`).toBe(
            relayCode(want.headless),
          );
          expect(supervised.ok ? null : supervised.error, `supervised: ${label}`).toBe(
            relayCode(want.supervised),
          );
          // ...and it attributes it to the switch the relay checked first.
          if (want.headless === "grant_supervised_only") expect(grant).toBe("SUPERVISED");
          if (want.headless === "cli_supervised_only") {
            expect(grant).toBe("UNSUPERVISED");
            expect(live?.mode).toBe("supervised");
          }
          for (const result of [want.headless, want.supervised]) {
            if (result === null) admitted += 1;
            else refused += 1;
          }
        }
      }
      // The table exercises both admitted and refused outcomes for both tools.
      expect(admitted).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
      expect(row).toBe(21);
    });

    it("refuses a CLI without terminal support and an offline CLI", async () => {
      const socket = await connect("desktop", { terminalSupported: false });
      await expect(start()).resolves.toEqual({ ok: false, error: "unsupported" });
      expect(socket.sends).toEqual([]);
      grants.offline = "SUPERVISED";
      await expect(start({ cliDeviceId: "offline" })).resolves.toEqual({
        ok: false,
        error: "offline",
      });
    });

    it("validates the command, cwd, and reason", async () => {
      const socket = await connect();
      for (const command of ["", "a\0b", "x".repeat(4097)]) {
        await expect(start({ command })).resolves.toEqual({
          ok: false,
          error: "invalid_command",
        });
      }
      await expect(start({ cwd: "" })).resolves.toEqual({ ok: false, error: "invalid_command" });
      await expect(start({ reason: "r".repeat(501) })).resolves.toEqual({
        ok: false,
        error: "invalid_reason",
      });
      await expect(start({ reason: "a\0b" })).resolves.toEqual({
        ok: false,
        error: "invalid_reason",
      });
      expect(socket.sends).toEqual([]);
    });

    it("refuses text the relay cannot carry and counts the reason in characters", async () => {
      const socket = await connect();
      for (const command of ["echo \ud800", "echo \udc00 done", "\ud83d"]) {
        await expect(start({ command })).resolves.toEqual({
          ok: false,
          error: "invalid_command",
        });
      }
      await expect(start({ cwd: "/srv/\udfff" })).resolves.toEqual({
        ok: false,
        error: "invalid_command",
      });
      await expect(start({ reason: "why \ud800" })).resolves.toEqual({
        ok: false,
        error: "invalid_reason",
      });
      await expect(start({ reason: "😀".repeat(501) })).resolves.toEqual({
        ok: false,
        error: "invalid_reason",
      });
      expect(socket.sends).toEqual([]);
      // 500 astral characters are 1000 UTF-16 units but 500 characters.
      await started({ reason: "😀".repeat(500), command: "echo 😀" });
      expect(sent(socket, "term.spawn")[0]).toMatchObject({ reason: "😀".repeat(500) });
    });

    it("cuts a long token name between graphemes and never sends a lone surrogate", async () => {
      const socket = await connect("desktop");
      const laptop = await connect("laptop");
      const server = await connect("server");
      const phone = await connect("phone");
      const stacked = await connect("stacked");
      const cases: Array<[FakeSocket, string, string, string]> = [
        // The old UTF-16 slice kept the emoji's high surrogate alone.
        [socket, "desktop", `${"a".repeat(99)}😀b`, `${"a".repeat(99)}😀`],
        // A ZWJ family (5 code points) at the cut is dropped whole.
        [laptop, "laptop", `${"a".repeat(98)}👩‍👩‍👧`, "a".repeat(98)],
        [server, "server", "bad \ud800 name", "bad \ufffd name"],
        // A valid token name (101 UTF-16 units) that is one 101-code-point
        // grapheme: grapheme cutting alone left "", which the CLI refuses.
        [phone, "phone", `e${"\u0301".repeat(100)}`, `e${"\u0301".repeat(99)}`],
        // Controls are dropped before the cut; the rest is one long grapheme.
        [stacked, "stacked", `\u0007${"\u0301".repeat(119)}`, "\u0301".repeat(100)],
      ];
      for (const [cli, cliDeviceId, name, requester] of cases) {
        db.mcpPersonalToken.findFirst.mockResolvedValueOnce(liveToken(name));
        await started({ cliDeviceId });
        const raw = cli.sends.find(
          (send): send is string => typeof send === "string" && send.includes("term.spawn"),
        );
        expect(raw).toBeDefined();
        expect(raw?.isWellFormed()).toBe(true);
        expect(raw).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
        expect(sent(cli, "term.spawn")[0]).toMatchObject({ requester });
        // The CLI contract: 1..100 characters, no NUL or other control.
        expect([...requester].length).toBeGreaterThanOrEqual(1);
        expect([...requester].length).toBeLessThanOrEqual(100);
        const controls = [...requester].filter((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code < 0x20 || (code >= 0x7f && code <= 0x9f);
        });
        expect(controls).toEqual([]);
        // End it, so the per-user waiting limit does not refuse the next.
        cancelCommandsForToken("token-a");
      }
    });

    it("refuses a start whose token is revoked or narrowed while it looks things up", async () => {
      const socket = await connect();
      for (const race of ["token", "device", "owner"] as const) {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered: () => void = () => {};
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        if (race === "token") {
          db.mcpPersonalToken.findFirst.mockImplementationOnce(async () => {
            await gate;
            return liveToken("Build agent");
          });
        } else if (race === "owner") {
          // The owner's ban/deletion read is inside the admission too.
          const owner = db.user.findUnique.getMockImplementation();
          db.user.findUnique.mockImplementation(
            async (args: { select?: { deletionRequestedAt?: boolean } }) => {
              if (!args.select?.deletionRequestedAt) return owner?.(args);
              entered();
              await gate;
              db.user.findUnique.mockImplementation(owner ?? (async () => null));
              return { banned: false, banExpires: null, deletionRequestedAt: null };
            },
          );
        } else {
          const device = db.cliDevice.findUnique.getMockImplementation();
          db.cliDevice.findUnique.mockImplementationOnce(
            async (args: { where: { id: string } }) => {
              await gate;
              return device?.(args);
            },
          );
        }
        const pending = start();
        // The owner race waits until that read is actually in flight.
        await (race === "owner" ? reached : Promise.resolve());
        // Another token's revoke does not touch this start.
        cancelCommandsForToken("token-other");
        // The revoke/narrow sweep runs while the start still awaits.
        cancelCommandsForToken("token-a");
        release();
        await expect(pending).resolves.toEqual({ ok: false, error: "token_inactive" });
      }
      expect(socket.sends).toEqual([]);
      // Nothing was registered, so nothing counts against the limits.
      await started();
      expect(sent(socket, "term.spawn")).toHaveLength(1);
    });

    it("refuses a start whose token row is no longer live", async () => {
      const socket = await connect();
      const narrowed = [
        null,
        { ...liveToken(), allowCliCommands: false },
        { ...liveToken(), scopes: ["mcp:read"] },
        liveToken("Build agent", new Date(Date.now() - 1)),
      ];
      for (const row of narrowed) {
        db.mcpPersonalToken.findFirst.mockResolvedValueOnce(row);
        await expect(start()).resolves.toEqual({ ok: false, error: "token_inactive" });
      }
      // The credential's own expiry (as admitted) is honoured too.
      await expect(start({ expiresAt: new Date(Date.now() - 1) })).resolves.toEqual({
        ok: false,
        error: "token_inactive",
      });
      expect(socket.sends).toEqual([]);
    });

    it("allows one waiting request and two live PTYs per CLI, and two waiting per user", async () => {
      const desktop = await connect("desktop");
      const first = await spawnedAndAccepted(desktop);
      await started();
      await expect(start()).resolves.toEqual({ ok: false, error: "limit" });
      // The waiting one is accepted: two running, the live cap is reached.
      const waiting = listPendingSupervised("user-id").find(
        (request) => request.commandId !== first.commandId,
      );
      expect(waiting).toBeUndefined(); // not spawned yet, so not pending
      const spawn = sent(desktop, "term.spawn").at(-1) as { commandId: string; terminalId: string };
      await say(desktop, {
        type: "term.spawned",
        terminalId: spawn.terminalId,
        commandId: spawn.commandId,
      });
      await say(desktop, { type: "supervised.accepted", commandId: spawn.commandId });
      await expect(start()).resolves.toEqual({ ok: false, error: "limit" });

      await connect("laptop");
      await connect("server");
      await started({ cliDeviceId: "laptop" });
      await started({ cliDeviceId: "server" });
      await connect("spare");
      await expect(start({ cliDeviceId: "spare" })).resolves.toEqual({
        ok: false,
        error: "limit",
      });
    });
  });

  describe("lifecycle", () => {
    it("sends one term.spawn with the token name and lists the request only once spawned", async () => {
      const socket = await connect();
      const request = await started({ cwd: "/srv/app" });
      const spawns = sent(socket, "term.spawn");
      expect(spawns).toEqual([
        {
          type: "term.spawn",
          terminalId: request.terminalId,
          commandId: request.commandId,
          command: "sudo apt install build-essential",
          cwd: "/srv/app",
          reason: "installs build deps; needs your sudo password",
          requester: "Build agent",
          shareOutput: true,
        },
      ]);
      expect(listPendingSupervised("user-id")).toEqual([]);
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([]);
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");

      events = [];
      await say(socket, { type: "term.spawned", ...request });
      expect(listPendingSupervised("user-id")).toEqual([
        expect.objectContaining({
          commandId: request.commandId,
          terminalId: request.terminalId,
          status: "awaiting_user",
          requester: "Build agent",
          expiresAt: expect.any(String),
        }),
      ]);
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
        expect.objectContaining({
          terminalId: request.terminalId,
          origin: "agent",
          viewerCount: 0,
          supervised: expect.objectContaining({
            commandId: request.commandId,
            status: "awaiting_user",
            command: "sudo apt install build-essential",
            shareOutput: true,
          }),
        }),
      ]);
      expect(events).toContainEqual({ type: "list_changed", userId: "user-id" });
      expect(listPendingSupervised("other-user")).toEqual([]);
    });

    it("falls back to a generic requester name and reads only the caller's live token", async () => {
      await connect();
      db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken(" \u0007\u009b "));
      await started();
      expect(db.mcpPersonalToken.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "token-a", userId: "user-id", revokedAt: null }),
        }),
      );
      expect(sent(sockets[0] as FakeSocket, "term.spawn")[0]).toMatchObject({
        requester: "MCP token",
      });
    });

    it("moves to running on accept and to declined on decline", async () => {
      const socket = await connect();
      const accepted = await spawnedAndAccepted(socket);
      expect(snapshot(accepted.commandId)?.status).toBe("running");
      await say(socket, {
        type: "supervised.done",
        commandId: accepted.commandId,
        exitCode: 0,
        review: false,
      });
      await say(socket, { type: "term.exit", terminalId: accepted.terminalId, exitCode: 0 });

      const declined = await started();
      await say(socket, { type: "term.spawned", ...declined });
      await say(socket, { type: "supervised.declined", commandId: declined.commandId });
      expect(snapshot(declined.commandId)).toMatchObject({ status: "declined", output: null });
      await say(socket, { type: "term.exit", terminalId: declined.terminalId });
      expect(snapshot(declined.commandId)?.status).toBe("declined");
    });

    it("keeps shared head and tail output for the agent", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket);
      const head = new Uint8Array(8192).fill(0x61);
      const tail = new Uint8Array(40960).fill(0x62);
      output(socket, request.commandId, "head", head);
      output(socket, request.commandId, "tail", tail);
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 3,
        review: false,
        outputBytes: 100_000,
      });
      const done = snapshot(request.commandId);
      expect(done).toMatchObject({
        status: "exited",
        exitCode: 3,
        output: { mode: "shared", edited: false },
      });
      expect(done?.shared?.head.byteLength).toBe(8192);
      expect(done?.shared?.tail.byteLength).toBe(40960);
      expect(done?.shared?.totalBytes).toBe(100_000);
    });

    it("never keeps output a rogue CLI sends for a private request", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket, { shareOutput: false });
      output(socket, request.commandId, "head", encode("SECRET_PRIVATE_OUTPUT"));
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: false,
        outputBytes: 21,
      });
      const done = snapshot(request.commandId);
      expect(done).toMatchObject({ status: "exited", output: { mode: "private" }, shared: null });
      expect(JSON.stringify(done)).not.toContain("SECRET");
    });

    it("drops output received before done{review:true} and waits for review", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket);
      output(socket, request.commandId, "head", encode("SECRET_UNREVIEWED"));
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: true,
      });
      const held = snapshot(request.commandId);
      expect(held).toMatchObject({ status: "awaiting_output_review", output: null, shared: null });
      expect(JSON.stringify(held)).not.toContain("SECRET");
      // The terminal stays listed so a person can open the review.
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
        expect.objectContaining({
          terminalId: request.terminalId,
          supervised: expect.objectContaining({ status: "awaiting_output_review" }),
        }),
      ]);
      expect(listPendingSupervised("user-id")).toEqual([
        expect.objectContaining({ status: "awaiting_output_review" }),
      ]);
    });
  });

  describe("output review", () => {
    async function heldForReview() {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket);
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: true,
      });
      socket.sends.length = 0;
      return { socket, request };
    }

    it("accepts only the owner, cleans the text, cancels the CLI session, and first submit wins", async () => {
      const { socket, request } = await heldForReview();
      expect(
        submitSupervisedOutput({
          userId: "other-user",
          commandId: request.commandId,
          output: "hi",
          edited: false,
        }),
      ).toEqual({ ok: false, error: "not_found" });
      expect(
        submitSupervisedOutput({
          userId: "user-id",
          commandId: request.commandId,
          output: "\u001b[1mok\u001b[0m token wsmp_mcp_abcDEF123",
          edited: true,
        }),
      ).toEqual({ ok: true, outputMode: "reviewed" });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "exited",
        output: { mode: "reviewed", edited: true },
        reviewedText: "ok token [redacted]",
      });
      expect(sent(socket, "supervised.cancel")).toEqual([
        { type: "supervised.cancel", commandId: request.commandId },
      ]);
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([]);
      // Viewers hear how the command ended, not just that the session did.
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "exit",
          terminalId: request.terminalId,
          exitCode: 0,
          supervisedStatus: "exited",
        }),
      );
      expect(
        submitSupervisedOutput({
          userId: "user-id",
          commandId: request.commandId,
          output: null,
          edited: false,
        }),
      ).toEqual({ ok: false, error: "conflict" });
      // A later term.exit from the CLI changes nothing.
      await say(socket, { type: "term.exit", terminalId: request.terminalId });
      expect(snapshot(request.commandId)?.output).toEqual({ mode: "reviewed", edited: true });
    });

    it("redacts all on null and refuses a submit before the command exited", async () => {
      const socket = await connect();
      const running = await spawnedAndAccepted(socket);
      expect(
        submitSupervisedOutput({
          userId: "user-id",
          commandId: running.commandId,
          output: "early",
          edited: false,
        }),
      ).toEqual({ ok: false, error: "conflict" });
      await say(socket, {
        type: "supervised.done",
        commandId: running.commandId,
        exitCode: 1,
        review: true,
      });
      expect(
        submitSupervisedOutput({
          userId: "user-id",
          commandId: running.commandId,
          output: null,
          edited: true,
        }),
      ).toEqual({ ok: true, outputMode: "redacted" });
      expect(snapshot(running.commandId)).toMatchObject({
        status: "exited",
        exitCode: 1,
        output: { mode: "redacted", edited: false },
        reviewedText: null,
      });
    });

    it("redacts all when nobody reviews within 15 minutes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { socket, request } = await heldForReview();
      await vi.advanceTimersByTimeAsync(SUPERVISED_REVIEW_TTL_MS - 1);
      expect(snapshot(request.commandId)?.status).toBe("awaiting_output_review");
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshot(request.commandId)).toMatchObject({
        status: "exited",
        output: { mode: "redacted" },
      });
      expect(sent(socket, "supervised.cancel")).toHaveLength(1);
    });

    it("redacts all when the CLI disconnects during review", async () => {
      const { socket, request } = await heldForReview();
      await relaySessionManager.removeSession(socket, now);
      expect(snapshot(request.commandId)).toMatchObject({
        status: "exited",
        output: { mode: "redacted" },
      });
    });
  });

  describe("ending a request", () => {
    it("asks the CLI to stop an unanswered request after 15 minutes; its decline makes it expired", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS);
      // A request, not a kill: the CLI decides against an Enter it may have taken.
      expect(sent(socket, "supervised.cancel")).toEqual([
        { type: "supervised.cancel", commandId: request.commandId, reason: "expire" },
      ]);
      expect(sent(socket, "term.close")).toEqual([]);
      expect(snapshot(request.commandId)).toMatchObject({ status: "awaiting_user", started: null });
      await say(socket, { type: "supervised.declined", commandId: request.commandId });
      expect(snapshot(request.commandId)).toMatchObject({ status: "expired", started: false });
      await say(socket, { type: "term.exit", terminalId: request.terminalId });
      expect(snapshot(request.commandId)).toMatchObject({ status: "expired", started: false });
      // Model the still-connected CLI heartbeat after the long confirm wait.
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({ type: "heartbeat", id: "after-confirm-wait" }),
        new Date(),
      );
      // The slot is free again.
      await expect(start()).resolves.toMatchObject({ ok: true });
    });

    it("lists a declined request as ending within the stop grace, and keeps a Decline that met the CLI's deadline a decline", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const early = await started();
      await say(socket, { type: "term.spawned", ...early });
      expect(
        relaySessionManager.declineTerminalFromBrowser(early.terminalId, "user-id", "conn-a"),
      ).toBe("requested");
      // Not the 15-minute confirm deadline any more: the stop's own.
      expect(Date.parse(listPendingSupervised("user-id")[0]?.expiresAt ?? "")).toBe(
        Date.now() + SUPERVISED_STOP_GRACE_MS,
      );
      await say(socket, { type: "supervised.declined", commandId: early.commandId });
      await say(socket, { type: "term.exit", terminalId: early.terminalId });

      const late = await started();
      await say(socket, { type: "term.spawned", ...late });
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS - 10_000);
      expect(
        relaySessionManager.declineTerminalFromBrowser(late.terminalId, "user-id", "conn-a"),
      ).toBe("requested");
      await vi.advanceTimersByTimeAsync(20_000);
      // The CLI's own deadline closed it (a bare exit) while the Decline was out.
      await say(socket, { type: "term.exit", terminalId: late.terminalId });
      expect(snapshot(late.commandId)).toMatchObject({ status: "declined", started: false });
    });

    it("lets an Enter the CLI took before the deadline win: the command runs to its end", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS);
      expect(sent(socket, "supervised.cancel")).toHaveLength(1);
      // The CLI's answer: the accept it had already sent.
      await say(socket, { type: "supervised.accepted", commandId: request.commandId });
      expect(snapshot(request.commandId)).toMatchObject({ status: "running", started: true });
      // No stop deadline is left armed against the running command.
      await vi.advanceTimersByTimeAsync(SUPERVISED_STOP_GRACE_MS * 2);
      expect(snapshot(request.commandId)?.status).toBe("running");
      expect(sent(socket, "supervised.cancel")).toHaveLength(1);
      output(socket, request.commandId, "head", encode("done\n"));
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: false,
        outputBytes: 5,
      });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "exited",
        exitCode: 0,
        started: true,
        output: { mode: "shared" },
      });
    });

    it("ends the terminal outright when the CLI does not answer a stop, and learns later whether it ran", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS + SUPERVISED_STOP_GRACE_MS);
      expect(sent(socket, "supervised.cancel")).toEqual([
        { type: "supervised.cancel", commandId: request.commandId, reason: "expire" },
        { type: "supervised.cancel", commandId: request.commandId },
      ]);
      expect(snapshot(request.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "stop_unanswered",
        started: null,
      });
      // The CLI's late reports settle "did it start", never the output.
      await say(socket, { type: "supervised.accepted", commandId: request.commandId });
      output(socket, request.commandId, "head", encode("late"));
      await say(socket, { type: "term.exit", terminalId: request.terminalId });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "cancelled",
        started: true,
        output: null,
        shared: null,
      });
    });

    it("cancels on CLI disconnect while waiting or running", async () => {
      const socket = await connect();
      const running = await spawnedAndAccepted(socket);
      const waiting = await started();
      await relaySessionManager.removeSession(socket, now);
      expect(snapshot(running.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "cli_disconnected",
      });
      expect(snapshot(waiting.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "cli_disconnected",
      });
    });

    it("cancels on token revoke and on token expiry", async () => {
      const socket = await connect();
      const revoked = await spawnedAndAccepted(socket);
      cancelCommandsForToken("token-a");
      expect(snapshot(revoked.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "token_revoked",
      });
      expect(sent(socket, "supervised.cancel")).toHaveLength(1);

      const expiry = new Date(Date.now() + 5_000);
      db.mcpPersonalToken.findFirst.mockResolvedValueOnce(liveToken("Build agent", expiry));
      const expiring = await started({ tokenId: "token-b", expiresAt: expiry });
      expect(sweepExpiredTokenCommands(expiry.getTime() - 1)).toBe(0);
      expect(sweepExpiredTokenCommands(expiry.getTime())).toBeGreaterThanOrEqual(1);
      expect(snapshot(expiring.commandId, "token-b")).toMatchObject({
        status: "cancelled",
        rejectionReason: "token_expired",
      });
    });

    it("asks the CLI to decline a waiting request when the owner declines in the browser", async () => {
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      expect(
        relaySessionManager.declineTerminalFromBrowser(request.terminalId, "other-user", "conn-x"),
      ).toBe("not_found");
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      expect(
        relaySessionManager.declineTerminalFromBrowser(request.terminalId, "user-id", "conn-a"),
      ).toBe("requested");
      // A request the CLI decides, not a kill.
      expect(sent(socket, "supervised.cancel")).toEqual([
        { type: "supervised.cancel", commandId: request.commandId, reason: "decline" },
      ]);
      expect(sent(socket, "term.close")).toEqual([]);
      await say(socket, { type: "supervised.declined", commandId: request.commandId });
      await say(socket, { type: "term.exit", terminalId: request.terminalId });
      expect(snapshot(request.commandId)).toMatchObject({ status: "declined", started: false });
      // The declining socket hears the exit although it never viewed the terminal.
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "exit",
          terminalId: request.terminalId,
          connIds: ["conn-a"],
          supervisedStatus: "declined",
        }),
      );
    });

    it("never kills a command on Decline once its Enter came first, in either order", async () => {
      const socket = await connect();
      // Server first: the Decline reached the server while the request waited.
      const serverFirst = await started();
      await say(socket, { type: "term.spawned", ...serverFirst });
      expect(
        relaySessionManager.declineTerminalFromBrowser(serverFirst.terminalId, "user-id", "conn-a"),
      ).toBe("requested");
      await say(socket, { type: "supervised.accepted", commandId: serverFirst.commandId });
      expect(snapshot(serverFirst.commandId)).toMatchObject({ status: "running", started: true });
      expect(events).toContainEqual({
        type: "decline",
        terminalId: serverFirst.terminalId,
        connIds: ["conn-a"],
        outcome: "started",
      });
      // CLI first: the accept was processed before a (stale) Decline arrived.
      const cliFirst = await spawnedAndAccepted(socket);
      socket.sends.length = 0;
      for (const conn of ["conn-a", "conn-b"]) {
        expect(
          relaySessionManager.declineTerminalFromBrowser(cliFirst.terminalId, "user-id", conn),
        ).toBe("started");
      }
      // Nothing was asked of the CLI, and nothing was ended.
      expect(sent(socket, "term.close")).toEqual([]);
      expect(sent(socket, "supervised.cancel")).toEqual([]);
      for (const request of [serverFirst, cliFirst]) {
        expect(snapshot(request.commandId)?.status).toBe("running");
        await say(socket, {
          type: "supervised.done",
          commandId: request.commandId,
          exitCode: 0,
          review: false,
        });
        expect(snapshot(request.commandId)).toMatchObject({ status: "exited", started: true });
      }
      expect(sent(socket, "term.close")).toEqual([]);
    });

    it("keeps End session an explicit kill of a running command", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket);
      expect(relaySessionManager.closeTerminalFromBrowser(request.terminalId, "other-user")).toBe(
        false,
      );
      expect(relaySessionManager.closeTerminalFromBrowser(request.terminalId, "user-id")).toBe(
        true,
      );
      expect(sent(socket, "term.close")).toEqual([
        { type: "term.close", terminalId: request.terminalId },
      ]);
      expect(snapshot(request.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "closed_by_user",
        started: true,
      });
    });

    it("says whether a request the server ended while it waited had started", async () => {
      const socket = await connect();
      const raced = await started();
      await say(socket, { type: "term.spawned", ...raced });
      cancelCommandsForToken("token-a");
      expect(snapshot(raced.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "token_revoked",
        started: null,
      });
      // An Enter the CLI took just before the cancel reached it.
      await say(socket, { type: "supervised.accepted", commandId: raced.commandId });
      await say(socket, { type: "term.exit", terminalId: raced.terminalId });
      expect(snapshot(raced.commandId)).toMatchObject({ status: "cancelled", started: true });

      const quiet = await started();
      await say(socket, { type: "term.spawned", ...quiet });
      cancelCommandsForToken("token-a");
      await say(socket, { type: "term.exit", terminalId: quiet.terminalId });
      expect(snapshot(quiet.commandId)).toMatchObject({ status: "cancelled", started: false });
    });

    it("records a CLI-side spawn refusal as rejected and frees the slot", async () => {
      const socket = await connect();
      const request = await started();
      await say(socket, {
        type: "supervised.rejected",
        commandId: request.commandId,
        reason: "limit",
      });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "rejected",
        rejectionReason: "limit",
      });
      await expect(start()).resolves.toMatchObject({ ok: true });
    });

    it("maps an unknown CLI-side rejection reason to the fallback", async () => {
      const socket = await connect();
      // `reason` is a stable machine code, never free text: the wire accepts
      // any string, so a nonconforming CLI's free text must not
      // reach the stored rejection reason.
      const request = await started();
      await say(socket, {
        type: "supervised.rejected",
        commandId: request.commandId,
        reason: "unknown-code-9f3a",
      });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "rejected",
        rejectionReason: "rejected",
      });
      expect(JSON.stringify(snapshot(request.commandId))).not.toContain("unknown-code-9f3a");
    });
  });

  describe("ban fence (#159)", () => {
    let unsubscribe: () => void;
    beforeEach(() => {
      // The same subscription apps/server/src/app.ts makes.
      unsubscribe = onUserBanned(cancelRelayWorkForBannedUser);
    });
    afterEach(() => unsubscribe());

    it("a ban ends every waiting, running and unreleased request of the user, through any token", async () => {
      const socket = await connect();
      // Output waiting for review first: it counts toward no live limit.
      const awaitingReview = await spawnedAndAccepted(socket, { tokenId: "token-c" });
      await say(socket, {
        type: "supervised.done",
        commandId: awaitingReview.commandId,
        exitCode: 0,
        review: true,
      });
      expect(snapshot(awaitingReview.commandId, "token-c")?.status).toBe("awaiting_output_review");
      const live = await spawnedAndAccepted(socket, { tokenId: "token-d" });
      expect(snapshot(live.commandId, "token-d")?.status).toBe("running");
      const waiting = await started({ tokenId: "token-a" });
      await say(socket, { type: "term.spawned", ...waiting });
      expect(snapshot(waiting.commandId, "token-a")?.status).toBe("awaiting_user");
      socket.sends.length = 0;

      await notifyUserBanned("user-id");

      expect(snapshot(waiting.commandId, "token-a")).toMatchObject({
        status: "cancelled",
        rejectionReason: "user_banned",
      });
      expect(snapshot(live.commandId, "token-d")).toMatchObject({
        status: "cancelled",
        rejectionReason: "user_banned",
      });
      // The unreleased output is withheld for good, never handed to the agent.
      expect(snapshot(awaitingReview.commandId, "token-c")).toMatchObject({
        status: "exited",
        output: { mode: "redacted" },
        shared: null,
      });
      // The CLI is told to close every terminal; nothing else keeps running.
      expect(
        sent(socket, "supervised.cancel")
          .map((message) => message.commandId)
          .sort(),
      ).toEqual([waiting.commandId, live.commandId, awaitingReview.commandId].sort());
      expect(listPendingSupervised("user-id")).toEqual([]);
    });

    it("leaves another user's requests alone and accepts new ones after", async () => {
      const socket = await connect();
      const mine = await started({ tokenId: "token-a" });
      await say(socket, { type: "term.spawned", ...mine });
      await notifyUserBanned("someone-else");
      expect(snapshot(mine.commandId, "token-a")?.status).toBe("awaiting_user");
      // Only the banned user's own requests end; a later start (the mocks say unbanned) is admitted.
      await notifyUserBanned("user-id");
      expect(snapshot(mine.commandId, "token-a")?.status).toBe("cancelled");
      await expect(start()).resolves.toMatchObject({ ok: true });
    });

    it("refuses a start whose admission is still reading when the ban lands", async () => {
      const socket = await connect();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const owner = db.user.findUnique.getMockImplementation();
      db.user.findUnique.mockImplementation(
        async (args: { select?: { deletionRequestedAt?: boolean } }) => {
          if (!args.select?.deletionRequestedAt) return owner?.(args);
          entered();
          await gate;
          return { banned: false, banExpires: null, deletionRequestedAt: null };
        },
      );
      const pending = start();
      await reached;
      await notifyUserBanned("user-id");
      release();
      await expect(pending).resolves.toEqual({ ok: false, error: "token_inactive" });
      expect(socket.sends).toEqual([]);
    });
  });

  describe("policy", () => {
    it("closes agent terminals when the mode goes off, keeps them in supervised mode", async () => {
      const socket = await connect("desktop", { mode: "unsupervised", grant: "UNSUPERVISED" });
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      const exec = await startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      });
      expect(exec.ok).toBe(true);

      relaySessionManager.applyFeatureGrants("desktop", {
        mcpFileRead: false,
        allowHumanTerminal: false,
        mcpCommandMode: "supervised",
      });
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      expect(sent(socket, "exec.cancel")).toHaveLength(1);
      expect(sent(socket, "term.close")).toEqual([]);

      relaySessionManager.applyFeatureGrants("desktop", {
        mcpFileRead: false,
        allowHumanTerminal: true,
        mcpCommandMode: "off",
      });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "policy_disabled",
      });
      expect(sent(socket, "term.close")).toEqual([
        { type: "term.close", terminalId: request.terminalId },
      ]);
    });

    it("does not close agent terminals when the human terminal grant is off", async () => {
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      relaySessionManager.applyFeatureGrants("desktop", {
        mcpFileRead: false,
        allowHumanTerminal: false,
        mcpCommandMode: "supervised",
      });
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      expect(sent(socket, "term.close")).toEqual([]);
    });

    it("reports a grant that changed while a start looked it up as the grant, not offline", async () => {
      // The device row is read before the dashboard commit; the post-commit
      // hook then turns the grant OFF before the start resumes.
      function gateDeviceRead() {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        db.cliDevice.findUnique.mockImplementationOnce(async (args: { where: { id: string } }) => {
          const row = {
            id: args.where.id,
            userId: "user-id",
            mcpCommandMode: grants[args.where.id],
          };
          await gate;
          return row;
        });
        return () => release();
      }
      const socket = await connect("desktop", { mode: "unsupervised", grant: "UNSUPERVISED" });
      let release = gateDeviceRead();
      const request = start();
      grants.desktop = "OFF";
      await relaySessionManager.onCliFeatureGrantsChanged("desktop");
      release();
      await expect(request).resolves.toEqual({ ok: false, error: "grant_disabled" });
      expect(sent(socket, "term.spawn")).toEqual([]);

      grants.desktop = "UNSUPERVISED";
      await relaySessionManager.onCliFeatureGrantsChanged("desktop");
      release = gateDeviceRead();
      const exec = startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      });
      grants.desktop = "SUPERVISED";
      await relaySessionManager.onCliFeatureGrantsChanged("desktop");
      release();
      await expect(exec).resolves.toEqual({ ok: false, error: "supervised_only" });
      expect(sent(socket, "exec.start")).toEqual([]);
    });

    it("refuses headless exec when the grant or the CLI allows only supervised commands", async () => {
      await connect("desktop", { mode: "unsupervised", grant: "SUPERVISED" });
      const execInput = {
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      };
      await expect(startCliCommand(execInput)).resolves.toEqual({
        ok: false,
        error: "supervised_only",
      });
      const laptop = await connect("laptop", { mode: "supervised", grant: "UNSUPERVISED" });
      await expect(startCliCommand({ ...execInput, cliDeviceId: "laptop" })).resolves.toEqual({
        ok: false,
        error: "supervised_only",
      });
      expect(sent(laptop, "exec.start")).toEqual([]);
    });
  });

  describe("frames the server does not trust", () => {
    it("ignores supervised frames for an unknown command or from another CLI", async () => {
      const desktop = await connect("desktop");
      const laptop = await connect("laptop");
      const request = await started();
      await say(desktop, { type: "term.spawned", ...request });
      await say(laptop, { type: "supervised.accepted", commandId: request.commandId });
      await say(laptop, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: false,
      });
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      const unknown = Buffer.alloc(16, 1).toString("base64url");
      await say(desktop, { type: "supervised.accepted", commandId: unknown });
      await say(desktop, { type: "supervised.declined", commandId: unknown });
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      // done before accept is ignored too.
      await say(desktop, {
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: false,
      });
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      expect(desktop.closes).toEqual([]);
      expect(laptop.closes).toEqual([]);
    });

    it("closes only the named terminal on a malformed supervised frame", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const socket = await connect();
      const bad = await spawnedAndAccepted(socket);
      await say(socket, { type: "supervised.done", commandId: bad.commandId, review: "yes" });
      expect(snapshot(bad.commandId)).toMatchObject({
        status: "cancelled",
        rejectionReason: "closed",
      });
      expect(sent(socket, "term.close")).toEqual([
        { type: "term.close", terminalId: bad.terminalId },
      ]);
      expect(socket.closes).toEqual([]);
      await expect(start()).resolves.toMatchObject({ ok: true });
      errorSpy.mockRestore();
    });
  });

  describe("terminal records", () => {
    it("keeps agent terminals out of human slot counts and lets only the owner attach", async () => {
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      expect(relaySessionManager.terminalCounts("user-id", "desktop")).toEqual({ user: 0, cli: 0 });
      const attachInput = {
        terminalId: request.terminalId,
        browserPublicKey: uncompressedKey(),
        browserNonce: Buffer.alloc(16, 4).toString("base64url"),
      };
      expect(
        relaySessionManager.attachTerminal({ ...attachInput, userId: "other-user", connId: "x" }),
      ).toEqual({ ok: false, error: "not_found" });
      // allowHumanTerminal is false for this device: supervised attach does not need it.
      const attached = relaySessionManager.attachTerminal({
        ...attachInput,
        userId: "user-id",
        connId: "owner",
      });
      expect(attached.ok).toBe(true);
      expect(sent(socket, "term.attach")).toEqual([
        expect.objectContaining({ terminalId: request.terminalId, viewerId: expect.any(String) }),
      ]);
    });

    it("cannot attach before the CLI spawned the terminal", async () => {
      await connect();
      const request = await started();
      expect(
        relaySessionManager.attachTerminal({
          terminalId: request.terminalId,
          userId: "user-id",
          connId: "owner",
          browserPublicKey: uncompressedKey(),
          browserNonce: Buffer.alloc(16, 4).toString("base64url"),
        }),
      ).toEqual({ ok: false, error: "not_found" });
    });
  });

  describe("agent audit events", () => {
    function events() {
      return audit.mock.calls.map(([event]) => event as Record<string, unknown>);
    }

    it.each([
      ["bad_command", "bad_command"],
      ["invalid_input", "invalid_input"],
      ["AUDIT REJECTION TEXT", "rejected"],
      [" bad_command", "rejected"],
      ["BAD_COMMAND", "rejected"],
    ])("audits supervised command rejection %s as a machine code", async (reason, code) => {
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "supervised.rejected", commandId: request.commandId, reason });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        kind: "supervised_command",
        outcome: "refused",
        reason: code,
      });
      expect(snapshot(request.commandId)?.rejectionReason).toBe(code);
      expect(JSON.stringify(events())).not.toContain("AUDIT REJECTION TEXT");
    });

    it("records one supervised_command event per terminal outcome, without command output", async () => {
      const socket = await connect();
      // exited (with shared output)
      const ran = await spawnedAndAccepted(socket, { command: "make TOKEN_KEY=hunter2hunter2" });
      output(socket, ran.commandId, "head", encode("OUTPUT-SENTINEL-1"));
      await say(socket, {
        type: "supervised.done",
        commandId: ran.commandId,
        exitCode: 2,
        review: false,
      });
      await say(socket, { type: "term.exit", terminalId: ran.terminalId, exitCode: 2 });
      // declined
      const declined = await started();
      await say(socket, { type: "term.spawned", ...declined });
      await say(socket, { type: "supervised.declined", commandId: declined.commandId });
      await say(socket, { type: "term.exit", terminalId: declined.terminalId });
      // revoked while waiting
      await started();
      cancelCommandsForToken("token-a");

      expect(events().map((event) => [event.kind, event.outcome, event.reason])).toEqual([
        ["supervised_command", "completed", "exit:2"],
        ["supervised_command", "declined", "not_started"],
        ["supervised_command", "cancelled", "token_revoked"],
      ]);
      expect(events()[0]).toMatchObject({
        userId: "user-id",
        cliDeviceId: "desktop",
        mcpTokenId: "token-a",
      });
      expect(String(events()[0]?.path)).toMatch(/^hmac-sha256:[0-9a-f]{64} make$/);
      const serialized = JSON.stringify(events());
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("TOKEN_KEY");
      expect(serialized).not.toContain("OUTPUT-SENTINEL-1");
      // The agent's stated reason is free text: it is not stored.
      expect(serialized).not.toContain("sudo password");
    });

    it("stores ? as the program of an oversized refused command, never a cut path component", async () => {
      await connect();
      db.cliDevice.findUnique.mockResolvedValueOnce(null);
      // The cut lands right after an allowlisted word ("... git"), so only the relay's truncated flag yields "?".
      const command = `A=${"b".repeat(16_384 - 6)} gitx status`;
      await start({ command });
      expect(String(events()[0]?.path)).toMatch(/^hmac-sha256:[0-9a-f]{64} \?$/);
      expect(JSON.stringify(events())).not.toContain("bbbbbbbb");
      expect(JSON.stringify(events())).not.toContain("gitx");
    });

    it("stores an unknown device for a token_inactive refusal raised before the ownership check", async () => {
      await connect();
      await start({ expiresAt: new Date(Date.now() - 1), cliDeviceId: "NAME=AUDIT_MARKER" });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ reason: "token_inactive", cliDeviceId: "unknown" });
      expect(JSON.stringify(events())).not.toContain("AUDIT_MARKER");
    });

    it("stores an unknown device, never the request's text, when the device is not verified", async () => {
      await connect();
      db.cliDevice.findUnique.mockResolvedValueOnce(null);
      await start({ cliDeviceId: "NAME=AUDIT_MARKER" });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ reason: "not_found", cliDeviceId: "unknown" });
      expect(JSON.stringify(events())).not.toContain("AUDIT_MARKER");
    });

    it("records a failed internal_error once and rethrows when admission throws", async () => {
      await connect();
      const boom = new TypeError("admission read failed");
      db.cliDevice.findUnique.mockRejectedValueOnce(boom);
      await expect(start()).rejects.toBe(boom);
      expect(events().map((event) => [event.kind, event.outcome, event.reason])).toEqual([
        ["supervised_command", "failed", "internal_error"],
      ]);
      expect(events()[0]).toMatchObject({
        userId: "user-id",
        cliDeviceId: "unknown",
        mcpTokenId: "token-a",
      });
    });

    it("records a signalled supervised.done as signal:<name>", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket);
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        signal: "SIGKILL",
        review: false,
      });
      await say(socket, { type: "term.exit", terminalId: request.terminalId, signal: "SIGKILL" });
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["completed", "signal:SIGKILL"],
      ]);
    });

    it("stores an unknown supervised.done signal as signal:unknown", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket);
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        signal: "AUDIT_MARKER",
        review: false,
      });
      await say(socket, {
        type: "term.exit",
        terminalId: request.terminalId,
        signal: "AUDIT_MARKER",
      });
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["completed", "signal:unknown"],
      ]);
      expect(JSON.stringify(events())).not.toContain("AUDIT_MARKER");
    });

    it("never stores raw command text: a secret-bearing argument row holds only the program", async () => {
      const socket = await connect();
      const request = await spawnedAndAccepted(socket, {
        command: "curl -H 'Authorization: Bearer sk-secret-9' https://x",
      });
      await say(socket, { type: "supervised.done", commandId: request.commandId, review: false });
      await say(socket, { type: "term.exit", terminalId: request.terminalId, exitCode: 0 });
      const serialized = JSON.stringify(events());
      for (const leak of ["sk-secret-9", "https://x", "Authorization", "Bearer"])
        expect(serialized, `row leaks ${leak}`).not.toContain(leak);
      expect(String(events()[0]?.path)).toMatch(/^hmac-sha256:[0-9a-f]{64} curl$/);
    });

    it("records an unanswered confirm as expired, and each refusal", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect();
      const request = await started();
      await say(socket, { type: "term.spawned", ...request });
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS);
      expect(events()).toEqual([]);
      await say(socket, { type: "supervised.declined", commandId: request.commandId });
      await say(socket, { type: "term.exit", terminalId: request.terminalId });
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["expired", "not_started"],
      ]);
      await start({ cliDeviceId: "missing" });
      await start({ command: "\0" });
      expect(
        events()
          .slice(1)
          .map((event) => [event.outcome, event.reason]),
      ).toEqual([
        ["refused", "not_found"],
        ["refused", "invalid_command"],
      ]);
    });
  });

  describe("supervised file requests", () => {
    async function fileStart(extra: Partial<Parameters<typeof runFileOp>[0]> = {}) {
      return runFileOp({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        op: "write",
        args: { path: "~/notes.txt", reason: "review this change" },
        body: encode("new\n"),
        ...extra,
      });
    }
    async function fileStarted(extra: Partial<Parameters<typeof runFileOp>[0]> = {}) {
      const result = await fileStart(extra);
      if (!result.ok || !("commandId" in result)) throw new Error("expected file start");
      return result;
    }
    const edit = { path: "~/a", edits: [{ oldText: "a", newText: "b" }] };
    const result = {
      op: "write",
      result: { etag: "h:AAAAAAAAAAAAAAAAAAAAAA", size: 4, created: true },
    };

    const mutations = [
      { op: "edit", args: edit },
      { op: "write", args: { path: "~/a" }, body: encode("new\n") },
      { op: "rename", args: { from: "~/a", to: "~/b" } },
      { op: "mkdir", args: { path: "~/a" } },
      { op: "delete", args: { path: "~/a" } },
    ] as const;

    it.each(mutations)(
      "$op preserves rejected 2.7 diagnostics after owner/token/grant checks",
      async (mutation) => {
        for (const control of [
          "supervised",
          "headless",
          "off",
          "foreign",
          "inactive-token",
          "banned-owner",
          "connected",
        ] as const) {
          const socket = control === "connected" ? await connect() : null;
          db.cliDevice.findUnique.mockResolvedValueOnce({
            id: "desktop",
            userId: control === "foreign" ? "other-user" : "user-id",
            mcpCommandMode:
              control === "off" ? "OFF" : control === "headless" ? "UNSUPERVISED" : "SUPERVISED",
            rejectedRelayProtocolVersion: "2.7",
          });
          if (control === "inactive-token")
            db.mcpPersonalToken.findFirst.mockResolvedValueOnce(null);
          if (control === "banned-owner")
            db.user.findUnique.mockResolvedValueOnce({ banned: true });
          const outcome = await fileStart({ body: undefined, ...mutation });
          if (control === "connected") {
            expect(outcome).toMatchObject({ ok: true, kind: "supervised" });
            if (!outcome.ok || !("commandId" in outcome) || !socket)
              throw new Error("expected connected file start");
            await say(socket, { type: "supervised.declined", commandId: outcome.commandId });
            await relaySessionManager.removeSession(socket);
          } else {
            expect(outcome).toEqual({
              ok: false,
              code:
                control === "off"
                  ? "grant_disabled"
                  : control === "foreign"
                    ? "not_found"
                    : control === "inactive-token" || control === "banned-owner"
                      ? "token_inactive"
                      : "upgrade_required",
              ...(control === "foreign" ? { scope: "device" } : {}),
              ...(["supervised", "headless"].includes(control)
                ? { rejectedProtocolVersion: "2.7" }
                : {}),
            });
          }
        }
      },
    );

    it.each(
      mutations.flatMap((mutation) =>
        [
          "disconnect",
          "revoke",
          "ban",
          "grant",
          "stop-unanswered",
          "confirm-ttl",
          "token-expiry",
          "terminal-exit",
        ].map((event) => ({ mutation, event })),
      ),
    )(
      "$mutation.op dispatched $event without acceptance is unknown, audited once and immutable",
      async ({ mutation, event }) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(now);
        const socket = await connect();
        if (event === "token-expiry")
          db.mcpPersonalToken.findFirst.mockResolvedValueOnce(
            liveToken("Agent", new Date(now.getTime() + 1000)),
          );
        const dispatch = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
        const request = await fileStarted({ body: undefined, ...mutation });
        const tracker = dispatch.mock.calls[0]?.[0];
        dispatch.mockRestore();
        expect(tracker).toBeDefined();
        // No term.spawned acknowledgement either: dispatch itself is enough.
        if (event === "disconnect") await relaySessionManager.removeSession(socket);
        if (event === "revoke") cancelCommandsForToken("token-a");
        if (event === "ban") cancelRelayWorkForBannedUser("user-id");
        if (event === "grant")
          relaySessionManager.applyFeatureGrants("desktop", {
            allowHumanTerminal: false,
            mcpCommandMode: "off",
            mcpFileRead: false,
          });
        if (event === "stop-unanswered") {
          expect(tracker?.requestDecline()).toBe("requested");
          await vi.advanceTimersByTimeAsync(SUPERVISED_STOP_GRACE_MS);
        }
        if (event === "confirm-ttl")
          await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS + SUPERVISED_STOP_GRACE_MS);
        if (event === "token-expiry") await vi.advanceTimersByTimeAsync(1000);
        if (event === "terminal-exit") tracker?.onTerminalGone("exit");
        const code =
          event === "disconnect"
            ? "offline"
            : event === "grant"
              ? "grant_disabled"
              : ["revoke", "ban", "token-expiry"].includes(event)
                ? "token_inactive"
                : event === "confirm-ttl"
                  ? "timeout"
                  : "cancelled";
        expect(snapshot(request.commandId)).toMatchObject({
          started: null,
          fileError: { code, outcome: "unknown" },
        });
        const finished = snapshot(request.commandId);
        expect(audit).toHaveBeenCalledOnce();
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          kind: "supervised_file_write",
          outcome: "unknown",
          reason: `${mutation.op}:${code}`,
        });
        for (const report of ["accepted", "settled"] as const) tracker?.onLateReport(report);
        tracker?.onAccepted();
        tracker?.onDeclined();
        tracker?.onRejected("unsupported");
        tracker?.onDone({ review: false, fileError: { code: "conflict" } });
        expect(snapshot(request.commandId)).toEqual(finished);
        expect(audit).toHaveBeenCalledOnce();
      },
    );

    it.each(
      mutations.flatMap((mutation) =>
        ["declined", "rejected", "blocked-done"].map((event) => ({ mutation, event })),
      ),
    )(
      "$mutation.op authoritative $event before acceptance stays definitive",
      async ({ mutation, event }) => {
        const socket = await connect();
        const request = await fileStarted({ body: undefined, ...mutation });
        if (event === "declined")
          await say(socket, { type: "supervised.declined", commandId: request.commandId });
        if (event === "rejected")
          await say(socket, {
            type: "supervised.rejected",
            commandId: request.commandId,
            reason: "unsupported",
          });
        if (event === "blocked-done")
          await say(socket, {
            type: "supervised.done",
            commandId: request.commandId,
            review: false,
            fileError: { code: "conflict" },
          });
        const code =
          event === "declined" ? "declined" : event === "rejected" ? "unsupported" : "conflict";
        expect(snapshot(request.commandId)).toMatchObject({ started: false, fileError: { code } });
        expect(snapshot(request.commandId)?.fileError).toEqual({ code });
        const finished = snapshot(request.commandId);
        await say(socket, { type: "supervised.accepted", commandId: request.commandId });
        expect(snapshot(request.commandId)).toEqual(finished);
        expect(audit).toHaveBeenCalledOnce();
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          outcome: event === "declined" ? "declined" : event === "rejected" ? "refused" : "failed",
        });
      },
    );

    it.each(mutations)(
      "$op never-dispatched spawn failure remains definitive",
      async (mutation) => {
        await connect();
        vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn").mockReturnValueOnce(false);
        expect(await fileStart({ body: undefined, ...mutation })).toEqual({
          ok: false,
          code: "offline",
        });
        expect(audit).toHaveBeenCalledOnce();
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          outcome: "refused",
          reason: `${mutation.op}:offline`,
        });
      },
    );

    it.each([
      ["done-result", "completed", "completed"],
      ["done-error", "unknown", "conflict"],
      ["dismissed-error", "failed", "conflict"],
      ["declined", "declined", "declined"],
      ["expired", "expired", "timeout"],
      ["accepted-timeout", "unknown", "timeout"],
      ["accepted-offline", "unknown", "offline"],
      ["offline", "unknown", "offline"],
      ["spawn-rejected", "refused", "path_denied"],
      ["admission-refusal", "refused", "unsupported"],
      ["admission-grant", "refused", "grant_disabled"],
      ["admission-mode", "refused", "feature_disabled"],
      ["admission-limit", "refused", "limit"],
      ["admission-revoked", "refused", "token_inactive"],
      ["invalid-input", "refused", "invalid_input"],
      ["inactive-token", "refused", "token_inactive"],
      ["banned-owner", "refused", "token_inactive"],
      ["revoked-token", "unknown", "token_inactive"],
      ["accepted-revoked-token", "unknown", "token_inactive"],
      ["expired-token", "unknown", "token_inactive"],
      ["accepted-expired-token", "unknown", "token_inactive"],
    ] as const)(
      "audits supervised file %s exactly once as %s with metadata only",
      async (event, outcome, code) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(now);
        const tokenExpiry = new Date(now.getTime() + 1000);
        const socket = await connect("desktop", {
          terminalSupported: event !== "admission-refusal",
          grant: event === "admission-grant" ? "OFF" : "SUPERVISED",
          mode: event === "admission-mode" ? "off" : "supervised",
        });
        if (event === "admission-limit") {
          await start();
          socket.sends.length = 0;
        }
        if (event === "inactive-token") db.mcpPersonalToken.findFirst.mockResolvedValueOnce(null);
        if (event.endsWith("expired-token"))
          db.mcpPersonalToken.findFirst.mockResolvedValueOnce(liveToken("Agent", tokenExpiry));
        if (event === "banned-owner") db.user.findUnique.mockResolvedValueOnce({ banned: true });
        const dispatch = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
        const body = encode("AUDIT BODY TEXT");
        const starting = fileStart({
          expiresAt: event.endsWith("expired-token") ? tokenExpiry : null,
          args: {
            path: "~/audit.txt",
            reason: "AUDIT REQUEST REASON",
            expectedEtag: "h:before",
            ...(event === "invalid-input" ? { extra: "AUDIT EXTRA TEXT" } : {}),
          },
          body,
        });
        if (event === "admission-revoked") cancelCommandsForToken("token-a");
        const started = await starting;
        const tracker = dispatch.mock.calls[0]?.[0];
        dispatch.mockRestore();
        const events = () => audit.mock.calls.map(([row]) => row as Record<string, unknown>);
        if (started.ok && "commandId" in started) {
          expect(events()).toEqual([]);
          await say(socket, {
            type: "term.spawned",
            commandId: started.commandId,
            terminalId: started.terminalId,
          });
          if (event === "done-result" || event === "done-error" || event.startsWith("accepted-")) {
            await say(socket, { type: "supervised.accepted", commandId: started.commandId });
            expect(events()).toEqual([]);
          }
          switch (event) {
            case "done-result":
              await say(socket, {
                type: "supervised.done",
                commandId: started.commandId,
                review: false,
                fileResult: { ...result, result: { ...result.result, size: body.byteLength } },
              });
              break;
            case "done-error":
            case "dismissed-error":
              await say(socket, {
                type: "supervised.done",
                commandId: started.commandId,
                review: false,
                fileError: { code: "conflict" },
              });
              break;
            case "expired":
              await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS);
              expect(events()).toEqual([]);
              await say(socket, { type: "supervised.declined", commandId: started.commandId });
              break;
            case "declined":
              await say(socket, { type: "supervised.declined", commandId: started.commandId });
              break;
            case "accepted-timeout":
              await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS);
              break;
            case "accepted-offline":
            case "offline":
              await relaySessionManager.removeSession(socket);
              break;
            case "spawn-rejected":
              await say(socket, {
                type: "supervised.rejected",
                commandId: started.commandId,
                reason: "path_denied",
              });
              break;
            case "revoked-token":
            case "accepted-revoked-token":
              cancelCommandsForToken("token-a");
              break;
            case "expired-token":
            case "accepted-expired-token":
              expect(sweepExpiredTokenCommands(tokenExpiry.getTime() - 1)).toBe(0);
              expect(snapshot(started.commandId)?.status).toBe(
                event === "expired-token" ? "awaiting_user" : "running",
              );
              await vi.advanceTimersByTimeAsync(1000);
              // The exact expiry timer already ended the file request.
              expect(sweepExpiredTokenCommands(tokenExpiry.getTime())).toBe(0);
              expect(sweepExpiredTokenCommands(tokenExpiry.getTime())).toBe(0);
              expect(snapshot(started.commandId)).toMatchObject({
                status: "cancelled",
                rejectionReason: "token_expired",
                fileError: {
                  code: "token_inactive",
                  outcome: "unknown",
                },
              });
              break;
            default:
              throw new Error(`unexpected successful admission: ${event}`);
          }
          expect(snapshot(started.commandId)?.fileError?.outcome).toBe(
            outcome === "unknown" ? "unknown" : undefined,
          );
          // Redelivered terminal reports and later revoke/teardown all converge
          // at finishSupervised; none may write a second audit event.
          tracker?.onDone({ review: false, fileError: { code: "conflict" } });
          tracker?.onDeclined();
          tracker?.onRejected("spawn_failed");
          tracker?.onTerminalGone("exit");
          cancelCommandsForToken("token-a");
        } else {
          expect(started).toMatchObject({ ok: false, code });
          expect(socket.sends).toEqual([]);
        }
        expect(events()).toHaveLength(1);
        expect(events()[0]).toEqual({
          userId: "user-id",
          cliDeviceId:
            event === "inactive-token" || event === "banned-owner" || event === "admission-revoked"
              ? "unknown"
              : "desktop",
          mcpTokenId: "token-a",
          kind: "supervised_file_write",
          path: "~/audit.txt",
          etagBefore: "h:before",
          ...(started.ok ? { etagAfter: event === "done-result" ? result.result.etag : null } : {}),
          bytes: body.byteLength,
          outcome,
          reason: `write:${code}`,
          startedAt: expect.any(Date),
          finishedAt: expect.any(Date),
        });
        const serialized = JSON.stringify(events());
        for (const text of [
          "AUDIT BODY TEXT",
          "AUDIT REQUEST REASON",
          "AUDIT EXTRA TEXT",
          "content",
          "diff",
          "hunks",
          "fileOp",
          '"kind":"file_write"',
        ])
          expect(serialized).not.toContain(text);
      },
    );

    it.each(["edit", "rename", "mkdir", "delete"] as const)(
      "audits supervised %s with its requested path and op, never edit text or rename destination",
      async (op) => {
        const socket = await connect();
        const args =
          op === "edit"
            ? {
                path: "~/source",
                edits: [{ oldText: "AUDIT OLD TEXT", newText: "AUDIT NEW TEXT" }],
              }
            : op === "rename"
              ? { from: "~/source", to: "~/AUDIT DESTINATION" }
              : { path: "~/source" };
        const request = await fileStarted({ op, args, body: undefined });
        await say(socket, { type: "supervised.declined", commandId: request.commandId });
        expect(audit).toHaveBeenCalledTimes(1);
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          kind: "supervised_file_write",
          path: "~/source",
          reason: `${op}:declined`,
          outcome: "declined",
          bytes: null,
        });
        expect(JSON.stringify(audit.mock.calls)).not.toContain("AUDIT");
      },
    );

    it.each([
      [false, "unknown"],
      [true, "unknown"],
    ] as const)(
      "settles callback failure once after registration (accepted=%s)",
      async (accepted, outcome) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        await connect();
        const dispatch = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
        await expect(
          fileStart({
            onSupervisedStart: () => {
              if (accepted) dispatch.mock.calls[0]?.[0].onAccepted();
              throw new Error("AUDIT CALLBACK TEXT");
            },
          }),
        ).rejects.toThrow("AUDIT CALLBACK TEXT");
        const tracker = dispatch.mock.calls[0]?.[0];
        dispatch.mockRestore();
        expect(listPendingSupervised("user-id")).toEqual([]);
        expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([]);
        tracker?.onTerminalGone("exit");
        cancelCommandsForToken("token-a");
        await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS + SUPERVISED_STOP_GRACE_MS);
        expect(audit).toHaveBeenCalledTimes(1);
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          kind: "supervised_file_write",
          path: "~/notes.txt",
          outcome,
          reason: "write:io_error",
          cliDeviceId: "desktop",
        });
        expect(JSON.stringify(audit.mock.calls)).not.toContain("AUDIT CALLBACK TEXT");
      },
    );

    it.each(["missing", "foreign", "inactive", "throws"] as const)(
      "masks the device in a direct supervised file admission refusal: %s",
      async (admission) => {
        await connect();
        if (admission === "inactive") db.mcpPersonalToken.findFirst.mockResolvedValueOnce(null);
        if (admission === "throws")
          db.cliDevice.findUnique.mockRejectedValueOnce(new Error("AUDIT INTERNAL TEXT"));
        const request = startSupervisedRequest({
          kind: "file",
          userId: "user-id",
          tokenId: "token-a",
          expiresAt: null,
          cliDeviceId: admission === "missing" || admission === "foreign" ? admission : "desktop",
          fileOp: { op: "mkdir", args: { path: "~/source", reason: "AUDIT REQUEST REASON" } },
        });
        if (admission === "throws") await expect(request).rejects.toThrow("AUDIT INTERNAL TEXT");
        else await expect(request).resolves.toMatchObject({ ok: false });
        expect(audit).toHaveBeenCalledTimes(1);
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          kind: "supervised_file_write",
          path: "~/source",
          cliDeviceId: "unknown",
          outcome: admission === "throws" ? "failed" : "refused",
          reason: `mkdir:${admission === "throws" ? "internal_error" : admission === "inactive" ? "token_inactive" : "not_found"}`,
        });
        expect(JSON.stringify(audit.mock.calls)).not.toContain("AUDIT");
      },
    );

    it.each([
      ["OFF", "supervised", "2.8", true, "grant_disabled"],
      ["SUPERVISED", "off", "2.8", true, "feature_disabled"],
      ["SUPERVISED", "supervised", "2.7", true, "offline"],
      ["SUPERVISED", "supervised", "2.8", false, "offline"],
    ] as const)(
      "direct file admission refuses grant %s / live %s / protocol %s / fileOps %s as %s",
      async (grant, mode, protocolVersion, fileOps, error) => {
        const socket = await connect("desktop", { grant, mode });
        const live = relaySessionManager.getLiveCliFeatures(["desktop"]).get("desktop");
        if (!live) throw new Error("missing live features");
        // Current hello validation refuses 2.7 / missing fileOps already.
        // Inject the live snapshot to exercise admission's own guards.
        const features = vi
          .spyOn(relaySessionManager, "getLiveCliFeatures")
          .mockReturnValue(new Map([["desktop", { ...live, protocolVersion, fileOps }]]));
        const dispatch = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
        try {
          await expect(
            startSupervisedRequest({
              kind: "file",
              userId: "user-id",
              tokenId: "token-a",
              expiresAt: null,
              cliDeviceId: "desktop",
              fileOp: { op: "mkdir", args: { path: "~/source" } },
            }),
          ).resolves.toEqual({ ok: false, error });
          expect(dispatch).not.toHaveBeenCalled();
          expect(socket.sends).toEqual([]);
          expect(listPendingSupervised("user-id")).toEqual([]);
        } finally {
          dispatch.mockRestore();
          features.mockRestore();
        }
      },
    );

    it.each([
      ["OFF", "supervised", "grant_disabled"],
      ["OFF", "unsupervised", "grant_disabled"],
      ["OFF", "off", "grant_disabled"],
      ["SUPERVISED", "off", "feature_disabled"],
      ["UNSUPERVISED", "off", "feature_disabled"],
    ] as const)("runFileOp refuses write grant %s / live %s as %s", async (grant, mode, code) => {
      const socket = await connect("desktop", { grant, mode });
      await expect(fileStart()).resolves.toMatchObject({ ok: false, code });
      expect(socket.sends).toEqual([]);
      expect(listPendingSupervised("user-id")).toEqual([]);
    });

    it.each([
      ["SUPERVISED", "supervised"],
      ["SUPERVISED", "unsupervised"],
      ["UNSUPERVISED", "supervised"],
    ] as const)(
      "routes grant %s / live %s to a supervised spawn and one following body",
      async (grant, mode) => {
        const socket = await connect("desktop", { grant, mode });
        const request = await fileStarted();
        expect(socket.sends).toHaveLength(2);
        expect(JSON.parse(String(socket.sends[0]))).toMatchObject({
          type: "term.spawn",
          kind: "file",
          commandId: request.commandId,
          fileOp: { op: "write", args: { path: "~/notes.txt" } },
          bodyBytes: 4,
          shareOutput: false,
        });
        const body = parseRelayBinaryFrame(socket.sends[1] as ArrayBuffer);
        expect(body.metadata).toEqual({ type: "file.body", opId: request.commandId });
        expect(body.body).toEqual(encode("new\n"));
        expect(socket.json().some((frame) => frame.type === "file.op")).toBe(false);
        await say(socket, {
          type: "term.spawned",
          commandId: request.commandId,
          terminalId: request.terminalId,
        });
        expect(listPendingSupervised("user-id")[0]).toMatchObject({
          command: expect.stringContaining("File write"),
          shareOutput: false,
        });
        await say(socket, { type: "supervised.accepted", commandId: request.commandId });
        await say(socket, {
          type: "supervised.done",
          commandId: request.commandId,
          review: false,
          fileResult: result,
        });
        expect(snapshot(request.commandId)).toMatchObject({
          status: "exited",
          requestKind: "file",
          file: result,
          fileError: null,
        });
      },
    );

    it.each([
      ["read", { path: "~/a" }, undefined],
      ["edit", { ...edit, dryRun: true }, undefined],
      ["write", { path: "~/a", content: "x" }, encode("x")],
      ["write", { path: "~/a" }, undefined],
      ["write", { path: "~/a" }, new Uint8Array(1024 * 1024 + 1)],
      ["mkdir", { path: "~/a", extra: true }, undefined],
    ] as const)(
      "refuses read/dryRun/malformed or oversized %s without a spawn",
      async (op, args, body) => {
        const socket = await connect();
        await expect(fileStart({ op, args, body })).resolves.toMatchObject({
          ok: false,
          code: op === "read" ? "supervised_only" : "invalid_input",
        });
        expect(socket.sends).toEqual([]);
      },
    );

    it.each(["edit", "rename", "mkdir", "delete"] as const)(
      "starts %s with no binary body",
      async (op) => {
        const socket = await connect();
        const args =
          op === "edit" ? edit : op === "rename" ? { from: "~/a", to: "~/b" } : { path: "~/a" };
        await fileStarted({ op, args, body: undefined });
        expect(socket.sends).toHaveLength(1);
        expect(socket.json()[0]).toMatchObject({ kind: "file", fileOp: { op, args } });
        expect(socket.json()[0]).not.toHaveProperty("bodyBytes");
      },
    );

    it.each(["protocol", "fileOps"] as const)(
      "uses the supervised file capability guard for %s",
      async (missing) => {
        await connect();
        const live = relaySessionManager.getLiveCliFeatures(["desktop"]).get("desktop");
        if (!live) throw new Error("missing live features");
        const spy = vi.spyOn(relaySessionManager, "getLiveCliFeatures").mockReturnValue(
          new Map([
            [
              "desktop",
              {
                ...live,
                ...(missing === "protocol"
                  ? { protocolVersion: "2.7" as const }
                  : { fileOps: false }),
              },
            ],
          ]),
        );
        await expect(fileStart()).resolves.toMatchObject({ ok: false, code: "offline" });
        spy.mockRestore();
      },
    );

    it.each([
      { kind: "file", fileOp: { op: "write", args: { path: "~/a" } }, bodyBytes: 1 },
      { kind: "file", fileOp: { op: "mkdir", args: { path: "~/a" } }, bodyBytes: 1 },
      { kind: "command", fileOp: { op: "write", args: { path: "~/a" } }, bodyBytes: 4 },
      {
        kind: "file",
        fileOp: { op: "write", args: { path: "~/a" } },
        bodyBytes: 4,
        shareOutput: true,
      },
      { kind: "file", fileOp: { op: "mkdir", args: { path: "~/a", injected: "forged" } } },
    ])("registers nothing when spawn encoding/body agreement fails (%j)", async (extra) => {
      const socket = await connect();
      const spy = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
      await fileStarted();
      const args = spy.mock.calls[0];
      if (!args) throw new Error("no spawn");
      spy.mockRestore();
      const cancel = sent(socket, "term.spawn")[0];
      if (!cancel) throw new Error("no initial spawn");
      await say(socket, {
        type: "supervised.rejected",
        commandId: cancel.commandId,
        reason: "limit",
      });
      socket.sends.length = 0;
      const tracker = {
        ...args[0],
        commandId: Buffer.alloc(16, 12).toString("base64url"),
        terminalId: Buffer.alloc(16, 13).toString("base64url"),
      };
      try {
        relaySessionManager.dispatchSupervisedSpawn(
          tracker,
          { ...args[1], ...extra } as Parameters<
            typeof relaySessionManager.dispatchSupervisedSpawn
          >[1],
          encode("new\n"),
        );
      } catch {
        /* encoding must precede registration */
      }
      expect(socket.sends).toEqual([]);
      expect(relaySessionManager.hasTerminal(tracker.terminalId)).toBe(false);
    });

    it.each(["tracker-kind", "tracker-op", "missing-body", "short-body", "nonwrite-body"] as const)(
      "rejects inconsistent internal dispatch %s before registration",
      async (mismatch) => {
        const socket = await connect();
        const spy = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
        const request = await fileStarted();
        const args = spy.mock.calls[0];
        if (!args) throw new Error("missing spawn");
        spy.mockRestore();
        await say(socket, {
          type: "supervised.rejected",
          commandId: request.commandId,
          reason: "limit",
        });
        socket.sends.length = 0;
        const tracker = {
          ...args[0],
          commandId: Buffer.alloc(16, 15).toString("base64url"),
          terminalId: Buffer.alloc(16, 16).toString("base64url"),
          ...(mismatch === "tracker-kind" ? { kind: "command" as const } : {}),
          ...(mismatch === "tracker-op" ? { fileOp: "edit" as const } : {}),
          ...(mismatch === "nonwrite-body" ? { fileOp: "mkdir" as const } : {}),
        };
        const spawn =
          mismatch === "nonwrite-body"
            ? {
                ...args[1],
                fileOp: { op: "mkdir" as const, args: { path: "~/a" } },
                bodyBytes: undefined,
              }
            : args[1];
        const body =
          mismatch === "missing-body"
            ? undefined
            : mismatch === "short-body"
              ? encode("x")
              : encode("new\n");
        expect(relaySessionManager.dispatchSupervisedSpawn(tracker, spawn, body)).toBe(false);
        expect(socket.sends).toEqual([]);
        expect(relaySessionManager.hasTerminal(tracker.terminalId)).toBe(false);
      },
    );

    it("cancels a partial file dispatch when the body send throws and registers nothing", async () => {
      const socket = await connect();
      const dispatch = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
      const request = await fileStarted();
      const args = dispatch.mock.calls[0];
      dispatch.mockRestore();
      if (!args) throw new Error("missing spawn");
      await say(socket, {
        type: "supervised.rejected",
        commandId: request.commandId,
        reason: "limit",
      });
      socket.sends.length = 0;
      const tracker = {
        ...args[0],
        commandId: Buffer.alloc(16, 17).toString("base64url"),
        terminalId: Buffer.alloc(16, 18).toString("base64url"),
        onAccepted: vi.fn(),
      };
      const send = socket.send.bind(socket);
      const throwingSend = vi.spyOn(socket, "send").mockImplementation((frame) => {
        if (typeof frame !== "string") throw new Error("body send failed");
        send(frame);
      });
      try {
        expect(relaySessionManager.dispatchSupervisedSpawn(tracker, args[1], args[2])).toBe(false);
        expect(throwingSend.mock.calls).toHaveLength(3);
        expect(socket.json()).toEqual([
          expect.objectContaining({ type: "term.spawn", commandId: tracker.commandId }),
          { type: "supervised.cancel", commandId: tracker.commandId },
        ]);
        expect(relaySessionManager.hasTerminal(tracker.terminalId)).toBe(false);
        expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([]);
        expect(
          relaySessionManager.requestSupervisedStop("desktop", tracker.commandId, "decline"),
        ).toBe(false);
        await say(socket, { type: "supervised.accepted", commandId: tracker.commandId });
        expect(tracker.onAccepted).not.toHaveBeenCalled();
      } finally {
        throwingSend.mockRestore();
      }
    });

    it("enforces the total live cap across accepted commands and files", async () => {
      const socket = await connect();
      await spawnedAndAccepted(socket);
      const file = await fileStarted();
      await say(socket, { type: "supervised.accepted", commandId: file.commandId });
      await expect(fileStart()).resolves.toMatchObject({ ok: false, code: "limit" });
    });

    it("arms file expiry from acceptance, clears it on completion, and settles once", async () => {
      vi.useFakeTimers();
      const socket = await connect();
      const request = await fileStarted();
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS - 1000);
      await say(socket, { type: "supervised.accepted", commandId: request.commandId });
      await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS - 1);
      expect(snapshot(request.commandId)?.status).toBe("running");
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        review: false,
        fileResult: result,
      });
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        review: false,
        fileError: { code: "conflict" },
      });
      await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS + SUPERVISED_CONFIRM_TTL_MS);
      expect(snapshot(request.commandId)).toMatchObject({
        status: "exited",
        file: result,
        fileError: null,
      });
      expect(sent(socket, "supervised.cancel")).toEqual([]);
    });

    it.each(["missing", "foreign"])(
      "binds file admission to owned device %s",
      async (cliDeviceId) => {
        const socket = await connect();
        await expect(fileStart({ cliDeviceId })).resolves.toMatchObject({
          ok: false,
          code: "not_found",
        });
        expect(socket.sends).toEqual([]);
      },
    );

    it.each(["expiry", "scope", "flag", "owner-deleting"])(
      "refuses inactive file requester (%s)",
      async (cause) => {
        const socket = await connect();
        if (cause === "owner-deleting")
          db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });
        else
          db.mcpPersonalToken.findFirst.mockResolvedValue({
            ...liveToken(),
            ...(cause === "expiry"
              ? { expiresAt: new Date(Date.now() - 1) }
              : cause === "scope"
                ? { scopes: ["mcp:read"] }
                : { allowCliCommands: false }),
          });
        await expect(fileStart()).resolves.toMatchObject({ ok: false, code: "token_inactive" });
        expect(socket.sends).toEqual([]);
      },
    );

    it.each(["grant", "live", "banned", "token", "offline"] as const)(
      "refuses a file on %s admission",
      async (cause) => {
        const socket =
          cause === "offline"
            ? null
            : await connect("desktop", {
                grant: cause === "grant" ? "OFF" : "SUPERVISED",
                mode: cause === "live" ? "off" : "supervised",
              });
        if (cause === "banned")
          db.user.findUnique.mockResolvedValue({ banned: true, banExpires: null });
        if (cause === "token") db.mcpPersonalToken.findFirst.mockResolvedValue(null);
        const expected = {
          grant: "grant_disabled",
          live: "feature_disabled",
          banned: "token_inactive",
          token: "token_inactive",
          offline: "grant_disabled",
        };
        if (cause === "offline") grants.desktop = "SUPERVISED";
        await expect(fileStart()).resolves.toMatchObject({
          ok: false,
          code: cause === "offline" ? "offline" : expected[cause],
        });
        expect(socket?.sends ?? []).toEqual([]);
      },
    );

    it.each(["before", "after"] as const)(
      "file abort %s registration applies the id-delivery rule",
      async (moment) => {
        const socket = await connect();
        const controller = new AbortController();
        const enteredOwner = Promise.withResolvers<void>();
        let release!: (row: unknown) => void;
        db.user.findUnique.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
              enteredOwner.resolve();
            }),
        );
        const pending = fileStart({
          signal: controller.signal,
          onSupervisedStart: () => controller.abort(),
        });
        await enteredOwner.promise;
        if (moment === "before") controller.abort();
        release({ banned: false });
        const request = await pending;
        if (moment === "before") {
          expect(request).toEqual({ ok: false, code: "cancelled" });
          expect(socket.sends).toEqual([]);
        } else {
          expect(request).toMatchObject({ ok: true, kind: "supervised" });
          expect(controller.signal.aborted).toBe(true);
          expect(sent(socket, "supervised.cancel")).toEqual([]);
          if (!request.ok || !("commandId" in request)) throw new Error("missing file id");
          expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
        }
      },
    );

    it.each([
      "started",
      "token-refused",
      "capability-refused",
      "limit",
      "missing-body",
      "oversized-body",
      "unexpected-body",
      "invalid-args",
      "dry-run",
      "oversized-frame",
      "abort-before-read",
      "abort-during-read",
      "device-read-throws",
      "token-read-throws",
      "owner-read-throws",
      "mode-read-throws",
      "judge-throws",
      "dispatch-throws",
      "delivery-throws",
    ] as const)("closes the supervised admission exactly once on %s", async (branch) => {
      const socket = await connect("desktop", {
        terminalSupported: branch !== "capability-refused",
      });
      if (branch === "limit") await started();
      socket.sends.length = 0;
      const judge = vi.spyOn(cliAgentAdmission, "judgeCliAgentAdmission");
      const close = vi.spyOn(cliAgentAdmission, "closeCliAgentAdmission");
      const controller = new AbortController();
      const extra: Partial<Parameters<typeof runFileOp>[0]> = { signal: controller.signal };
      const throws = branch.endsWith("throws");
      if (branch === "token-refused") db.mcpPersonalToken.findFirst.mockResolvedValueOnce(null);
      if (branch === "missing-body") extra.body = undefined;
      if (branch === "oversized-body") extra.body = new Uint8Array(1024 * 1024 + 1);
      if (branch === "unexpected-body") {
        extra.op = "mkdir";
        extra.args = { path: "~/a" };
      }
      if (branch === "invalid-args") extra.args = { path: 42 };
      if (branch === "dry-run" || branch === "oversized-frame") {
        extra.op = "edit";
        extra.body = undefined;
        extra.args =
          branch === "dry-run"
            ? { ...edit, dryRun: true }
            : { path: "~/a", edits: [{ oldText: "x".repeat(70_000), newText: "y" }] };
      }
      if (branch === "abort-before-read") controller.abort();
      if (branch === "device-read-throws")
        db.cliDevice.findUnique.mockRejectedValueOnce(new Error("read failed"));
      if (branch === "token-read-throws")
        db.mcpPersonalToken.findFirst.mockRejectedValueOnce(new Error("read failed"));
      if (branch === "owner-read-throws")
        db.user.findUnique.mockRejectedValueOnce(new Error("read failed"));
      const features = relaySessionManager.getLiveCliFeatures.bind(relaySessionManager);
      if (branch === "mode-read-throws")
        vi.spyOn(relaySessionManager, "getLiveCliFeatures").mockImplementationOnce(() => {
          throw new Error("mode failed");
        });
      if (branch === "judge-throws")
        vi.spyOn(relaySessionManager, "getLiveCliFeatures")
          .mockImplementationOnce(features)
          .mockImplementationOnce(() => {
            throw new Error("mode failed");
          });
      if (branch === "dispatch-throws")
        vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn").mockImplementationOnce(() => {
          throw new Error("dispatch failed");
        });
      if (branch === "delivery-throws")
        extra.onSupervisedStart = () => {
          throw new Error("delivery failed");
        };
      try {
        const pending = fileStart(extra);
        if (branch === "abort-during-read") controller.abort();
        if (throws && branch !== "dispatch-throws") await expect(pending).rejects.toThrow();
        else {
          const codes = {
            "token-refused": "token_inactive",
            "capability-refused": "unsupported",
            limit: "limit",
          };
          const expected =
            branch in codes
              ? Reflect.get(codes, branch)
              : branch.startsWith("abort")
                ? "cancelled"
                : "invalid_input";
          if (branch === "started")
            await expect(pending).resolves.toMatchObject({ ok: true, kind: "supervised" });
          else await expect(pending).resolves.toEqual({ ok: false, code: expected });
        }
        const failedRead =
          branch === "device-read-throws" ||
          branch === "token-read-throws" ||
          branch === "owner-read-throws";
        const unjudged = branch.startsWith("abort") || failedRead || branch === "mode-read-throws";
        expect(judge).toHaveBeenCalledTimes(unjudged ? 0 : 1);
        expect(close).toHaveBeenCalledTimes(
          branch === "abort-during-read" || branch === "mode-read-throws" ? 1 : 0,
        );
        expect(cliAgentAdmission.openCliAgentAdmissionCountForTests()).toBe(0);
        if (branch !== "started" && branch !== "delivery-throws") expect(socket.sends).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it.each(["revoke", "other-token", "abort"] as const)(
      "handles %s after the admission read and before the supervised judge",
      async (event) => {
        const socket = await connect();
        const controller = new AbortController();
        const read = cliAgentAdmission.readCliAgentAdmission;
        const judge = vi.spyOn(cliAgentAdmission, "judgeCliAgentAdmission");
        const close = vi.spyOn(cliAgentAdmission, "closeCliAgentAdmission");
        vi.spyOn(cliAgentAdmission, "readCliAgentAdmission").mockImplementationOnce(
          async (input) => {
            const reads = await read(input);
            expect(cliAgentAdmission.openCliAgentAdmissionCountForTests()).toBe(1);
            if (event === "abort") controller.abort();
            else cancelCommandsForToken(event === "revoke" ? "token-a" : "another-token");
            return reads;
          },
        );
        try {
          const pending = fileStart({ signal: controller.signal });
          if (event === "other-token")
            await expect(pending).resolves.toMatchObject({ ok: true, kind: "supervised" });
          else {
            await expect(pending).resolves.toEqual({
              ok: false,
              code: event === "revoke" ? "token_inactive" : "cancelled",
            });
            expect(socket.sends).toEqual([]);
          }
          expect(judge).toHaveBeenCalledTimes(event === "abort" ? 0 : 1);
          expect(close).toHaveBeenCalledTimes(event === "abort" ? 1 : 0);
          expect(cliAgentAdmission.openCliAgentAdmissionCountForTests()).toBe(0);
        } finally {
          vi.restoreAllMocks();
        }
      },
    );

    it("uses one combined admission snapshot to select supervised dispatch", async () => {
      await connect();
      db.mcpPersonalToken.findFirst.mockClear();
      db.user.findUnique.mockClear();
      db.cliDevice.findUnique.mockClear();
      await fileStarted();
      // A second read inserts an asynchronous admission boundary between the
      // selected file mode and registration. The shared dispatcher reuses it.
      expect(db.mcpPersonalToken.findFirst).toHaveBeenCalledTimes(1);
      expect(db.user.findUnique).toHaveBeenCalledTimes(1);
      expect(db.cliDevice.findUnique).toHaveBeenCalledTimes(1);
    });

    it.each(["revoke", "ban", "grant"] as const)(
      "refuses %s during file admission",
      async (cause) => {
        const socket = await connect();
        const enteredOwner = Promise.withResolvers<void>();
        let release!: (row: unknown) => void;
        db.user.findUnique.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
              enteredOwner.resolve();
            }),
        );
        const pending = fileStart();
        await enteredOwner.promise;
        if (cause === "revoke") cancelCommandsForToken("token-a");
        else if (cause === "ban") cancelRelayWorkForBannedUser("user-id");
        else {
          grants.desktop = "OFF";
          relaySessionManager.applyFeatureGrants("desktop", {
            allowHumanTerminal: false,
            mcpCommandMode: "off",
            mcpFileRead: false,
          });
        }
        release({ banned: false });
        await expect(pending).resolves.toMatchObject({
          ok: false,
          code: cause === "grant" ? "grant_disabled" : "token_inactive",
        });
        expect(socket.sends).toEqual([]);
      },
    );

    it.each(["ban", "deletion"] as const)(
      "reads an owner %s after the slow device read for supervised admission",
      async (cause) => {
        const socket = await connect();
        const device = Promise.withResolvers<unknown>();
        db.cliDevice.findUnique.mockReturnValueOnce(device.promise);
        db.user.findUnique.mockClear();
        const pending = fileStart();
        expect(db.user.findUnique).not.toHaveBeenCalled();
        db.user.findUnique.mockResolvedValueOnce({
          banned: cause === "ban",
          banExpires: null,
          deletionRequestedAt: cause === "deletion" ? now : null,
        });
        device.resolve({
          id: "desktop",
          userId: "user-id",
          mcpCommandMode: "SUPERVISED",
          rejectedRelayProtocolVersion: null,
        });
        await expect(pending).resolves.toMatchObject({ ok: false, code: "token_inactive" });
        expect(socket.sends).toEqual([]);
        expect(audit).toHaveBeenCalledOnce();
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          kind: "supervised_file_write",
          outcome: "refused",
          reason: "write:token_inactive",
        });
      },
    );

    it.each(["cli", "user"] as const)("shares the %s pending cap with commands", async (limit) => {
      await connect();
      if (limit === "cli") await started();
      else {
        await connect("laptop");
        await connect("third");
        await started({ cliDeviceId: "laptop" });
        await started({ cliDeviceId: "third" });
      }
      await expect(fileStart()).resolves.toMatchObject({ ok: false, code: "limit" });
    });

    it.each([
      "decline",
      "expiry",
      "disconnect",
      "accepted-timeout",
      "accepted-disconnect",
      "revoke",
      "grant",
      "accepted-revoke",
      "accepted-grant",
      "ban",
      "accepted-ban",
    ] as const)("settles %s with only the justified uncertainty", async (event) => {
      vi.useFakeTimers();
      const socket = await connect();
      const request = await fileStarted();
      const commandId = request.commandId;
      await say(socket, { type: "term.spawned", commandId, terminalId: request.terminalId });
      if (event.startsWith("accepted"))
        await say(socket, { type: "supervised.accepted", commandId });
      if (event === "decline") {
        expect(
          relaySessionManager.declineTerminalFromBrowser(request.terminalId, "user-id", "tab"),
        ).toBe("requested");
        expect(sent(socket, "supervised.cancel")[0]).toMatchObject({ reason: "decline" });
        await say(socket, { type: "supervised.declined", commandId });
      }
      if (event === "expiry") {
        await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS);
        expect(sent(socket, "supervised.cancel")[0]).toMatchObject({ reason: "expire" });
        await vi.advanceTimersByTimeAsync(SUPERVISED_STOP_GRACE_MS);
      }
      if (event === "accepted-timeout") {
        await vi.advanceTimersByTimeAsync(FILE_OP_DEADLINE_MS);
        expect(sent(socket, "supervised.cancel")).toEqual([
          { type: "supervised.cancel", commandId },
        ]);
        expect(sent(socket, "supervised.cancel")[0]).not.toHaveProperty("reason");
      }
      if (event.includes("disconnect")) await relaySessionManager.removeSession(socket);
      if (event.endsWith("revoke")) cancelCommandsForToken("token-a");
      if (event.endsWith("ban")) cancelRelayWorkForBannedUser("user-id");
      if (event.endsWith("grant"))
        relaySessionManager.applyFeatureGrants("desktop", {
          allowHumanTerminal: false,
          mcpCommandMode: "off",
          mcpFileRead: false,
        });
      const codes = {
        decline: "declined",
        expiry: "timeout",
        disconnect: "offline",
        "accepted-timeout": "timeout",
        "accepted-disconnect": "offline",
        revoke: "token_inactive",
        grant: "grant_disabled",
        "accepted-revoke": "token_inactive",
        "accepted-grant": "grant_disabled",
        // A banned user's tokens are dead: same code as a revoked token.
        ban: "token_inactive",
        "accepted-ban": "token_inactive",
      };
      expect(snapshot(commandId)?.fileError).toEqual({
        code: codes[event],
        ...(event !== "decline" ? { outcome: "unknown" } : {}),
      });
      expect(snapshot(commandId)?.started).toBe(
        event.startsWith("accepted") ? true : event === "decline" ? false : null,
      );
      expect(socket.json().some((frame) => frame.type === "go")).toBe(false);
    });

    it("returns a state-dependent error only on done, without acceptance or details", async () => {
      const socket = await connect();
      const request = await fileStarted();
      expect(snapshot(request.commandId)?.fileError).toBeNull();
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        review: false,
        fileError: { code: "conflict" },
      });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "rejected",
        started: false,
        fileError: { code: "conflict" },
      });
      await say(socket, { type: "supervised.accepted", commandId: request.commandId });
      expect(snapshot(request.commandId)?.fileError).toEqual({ code: "conflict" });
    });

    it.each([
      "command-with-file",
      "file-with-command",
      "wrong-op",
      "both",
      "diff",
      "extra-error",
    ] as const)("isolates %s as a protocol violation", async (shape) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const socket = await connect();
      const request = shape === "command-with-file" ? await started() : await fileStarted();
      await say(socket, { type: "supervised.accepted", commandId: request.commandId });
      const fields =
        shape === "file-with-command"
          ? {}
          : shape === "both"
            ? { fileResult: result, fileError: { code: "conflict" } }
            : shape === "extra-error"
              ? { fileError: { code: "conflict", detail: "forged" } }
              : shape === "wrong-op"
                ? { fileResult: { op: "mkdir", result: { created: true } } }
                : shape === "diff"
                  ? { fileResult: { ...result, result: { ...result.result, diff: "forged" } } }
                  : { fileResult: result };
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        review: false,
        ...fields,
      });
      expect(snapshot(request.commandId)?.status).toBe("cancelled");
      expect(sent(socket, "term.close")).toHaveLength(1);
      expect(socket.closes).toEqual([]);
    });

    it.each([
      ["disabled", "feature_disabled"],
      ["bad_command", "invalid_input"],
      ["invalid_input", "invalid_input"],
      ["bad_frame", "io_error"],
      ["already_open", "limit"],
      ["limit", "limit"],
      ["spawn_failed", "io_error"],
      ["unsupported", "unsupported"],
      ["path_denied", "path_denied"],
      ["secret_file", "secret_file"],
      ["too_large", "too_large"],
      ["redacted_span", "redacted_span"],
    ])("maps pre-display refusal %s to %s", async (reason, code) => {
      const socket = await connect();
      const request = await fileStarted();
      await say(socket, { type: "supervised.rejected", commandId: request.commandId, reason });
      expect(snapshot(request.commandId)?.fileError).toEqual({ code });
    });

    it.each(["conflict", "not_found", "exists", "owner_mismatch", "forged"])(
      "rejects state disclosure %s before keypress",
      async (reason) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const socket = await connect();
        const request = await fileStarted();
        await say(socket, { type: "supervised.rejected", commandId: request.commandId, reason });
        expect(snapshot(request.commandId)?.fileError).toEqual({
          code: "cancelled",
          outcome: "unknown",
        });
        expect(sent(socket, "term.close")).toHaveLength(1);
      },
    );

    it("reports unknown before late acceptance and keeps the finished file answer immutable", async () => {
      vi.useFakeTimers();
      const socket = await connect();
      const request = await fileStarted();
      await vi.advanceTimersByTimeAsync(SUPERVISED_CONFIRM_TTL_MS + SUPERVISED_STOP_GRACE_MS);
      expect(snapshot(request.commandId)).toMatchObject({
        started: null,
        fileError: { code: "timeout", outcome: "unknown" },
      });
      const finished = snapshot(request.commandId);
      await say(socket, { type: "supervised.accepted", commandId: request.commandId });
      expect(snapshot(request.commandId)).toEqual(finished);
      expect(audit).toHaveBeenCalledOnce();
      expect(audit.mock.calls[0]?.[0]).toMatchObject({ outcome: "unknown" });
    });

    it.each(
      FILE_ERROR_CODES.flatMap((code) => [
        { code, accepted: false },
        { code, accepted: true },
      ]),
    )(
      "CLI $code with accepted=$accepted follows the acceptance boundary",
      async ({ code, accepted }) => {
        const unknown = accepted;
        const socket = await connect();
        const request = await fileStarted();
        if (accepted)
          await say(socket, { type: "supervised.accepted", commandId: request.commandId });
        await say(socket, {
          type: "supervised.done",
          commandId: request.commandId,
          review: false,
          fileError: { code },
        });
        expect(snapshot(request.commandId)).toMatchObject({
          status: "rejected",
          started: accepted,
          waitDeadline: null,
        });
        expect(snapshot(request.commandId)?.fileError).toEqual({
          code,
          ...(unknown ? { outcome: "unknown" } : {}),
        });
        expect(audit).toHaveBeenCalledOnce();
        expect(audit.mock.calls[0]?.[0]).toMatchObject({
          kind: "supervised_file_write",
          outcome: unknown ? "unknown" : "failed",
          reason: `write:${code}`,
        });
      },
    );

    it.each([
      ["row", false],
      ["row", true],
      ["credential", false],
      ["credential", true],
      ["row-earlier", true],
      ["credential-earlier", true],
    ] as const)(
      "expires the %s token with accepted=%s without a sweep",
      async (source, accepted) => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const socket = await connect();
        const expiry = new Date(now.getTime() + 1000);
        const later = new Date(now.getTime() + 2000);
        db.mcpPersonalToken.findFirst.mockResolvedValueOnce(
          liveToken(
            "Agent",
            source === "credential" ? null : source === "credential-earlier" ? later : expiry,
          ),
        );
        const request = await fileStarted({
          expiresAt: source === "row" ? null : source === "row-earlier" ? later : expiry,
        });
        if (accepted)
          await say(socket, { type: "supervised.accepted", commandId: request.commandId });
        await vi.advanceTimersByTimeAsync(999);
        expect(snapshot(request.commandId)?.status).toBe(accepted ? "running" : "awaiting_user");
        await vi.advanceTimersByTimeAsync(1);
        expect(snapshot(request.commandId)?.fileError).toEqual({
          code: "token_inactive",
          outcome: "unknown",
        });
        expect(sent(socket, "supervised.cancel")).toEqual([
          { type: "supervised.cancel", commandId: request.commandId },
        ]);
        await say(socket, {
          type: "supervised.done",
          commandId: request.commandId,
          review: false,
          fileResult: result,
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(snapshot(request.commandId)?.file).toBeNull();
        expect(audit).toHaveBeenCalledOnce();
      },
    );

    it.each(["success", "error", "accepted"] as const)(
      "rejects an expired credential on %s before its timer runs",
      async (answer) => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const socket = await connect();
        const request = await fileStarted({ expiresAt: new Date(now.getTime() + 1000) });
        if (answer !== "accepted")
          await say(socket, { type: "supervised.accepted", commandId: request.commandId });
        vi.setSystemTime(now.getTime() + 1000);
        await say(
          socket,
          answer === "accepted"
            ? { type: "supervised.accepted", commandId: request.commandId }
            : {
                type: "supervised.done",
                commandId: request.commandId,
                review: false,
                ...(answer === "success"
                  ? { fileResult: result }
                  : { fileError: { code: "conflict" } }),
              },
        );
        expect(snapshot(request.commandId)).toMatchObject({
          status: "cancelled",
          started: true,
          file: null,
          fileError: { code: "token_inactive", outcome: "unknown" },
        });
        expect(audit).toHaveBeenCalledOnce();
      },
    );

    it("refuses a successful file result before acceptance", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const socket = await connect();
      const request = await fileStarted();
      await say(socket, {
        type: "supervised.done",
        commandId: request.commandId,
        review: false,
        fileResult: result,
      });
      expect(snapshot(request.commandId)).toMatchObject({
        status: "cancelled",
        started: null,
        file: null,
      });
      expect(sent(socket, "term.close")).toHaveLength(1);
    });

    it.each([1, 2])("cleans tracking when send %s throws", async (sendIndex) => {
      const socket = await connect();
      const dispatch = vi.spyOn(relaySessionManager, "dispatchSupervisedSpawn");
      const original = socket.send.bind(socket);
      let count = 0;
      const spy = vi.spyOn(socket, "send").mockImplementation((data) => {
        count += 1;
        if (count === sendIndex) throw new Error("send failed");
        original(data);
      });
      await expect(fileStart()).resolves.toMatchObject({ ok: false, code: "offline" });
      expect(listPendingSupervised("user-id")).toEqual([]);
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([]);
      const tracker = dispatch.mock.calls[0]?.[0];
      if (!tracker) throw new Error("missing dispatch tracker");
      expect(relaySessionManager.hasTerminal(tracker.terminalId)).toBe(false);
      const sessions = Reflect.get(relaySessionManager, "sessionsByCliDeviceId") as Map<
        string,
        { supervisedById: Map<string, unknown> }
      >;
      expect(sessions.get("desktop")?.supervisedById.size).toBe(0);
      dispatch.mockRestore();
      spy.mockRestore();
      await expect(fileStart()).resolves.toMatchObject({ ok: true, kind: "supervised" });
    });
  });
});

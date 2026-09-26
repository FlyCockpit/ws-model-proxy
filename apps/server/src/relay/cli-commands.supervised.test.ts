import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayBinaryFrame, RELAY_REQUEST_BODY_WINDOW_CHUNKS } from "./protocol.js";

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
const { relaySessionManager, registerTerminalBridge } = await import("./session-manager.js");
const {
  cancelCommandsForToken,
  listPendingSupervised,
  resetCliCommandsForTests,
  snapshotSupervisedCommand,
  startCliCommand,
  startSupervisedCommand,
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
    protocolVersion: "2.6",
    cli: {
      slug,
      hostname: `${slug}.local`,
      version: "0.4.0",
      capabilities: {
        protocolVersion: "2.6",
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
        },
        terminalPublicKey: uncompressedKey(),
        terminalViewers: true,
        supervisedCommands: true,
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
    resetCliCommandsForTests();
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
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets) await relaySessionManager.removeSession(socket, now);
    resetCliCommandsForTests();
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
        allowHumanTerminal: false,
        mcpCommandMode: "supervised",
      });
      expect(snapshot(request.commandId)?.status).toBe("awaiting_user");
      expect(sent(socket, "exec.cancel")).toHaveLength(1);
      expect(sent(socket, "term.close")).toEqual([]);

      relaySessionManager.applyFeatureGrants("desktop", {
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
});

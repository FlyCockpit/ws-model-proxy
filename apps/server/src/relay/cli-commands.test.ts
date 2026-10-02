import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { notifyUserBanned, onUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandAuditDigest } from "./command-audit-digest.js";
import { generateTestHelloIdentity } from "./hello-identity.js";
import { encodeRelayBinaryFrame, RELAY_REQUEST_BODY_WINDOW_CHUNKS } from "./protocol.js";
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

const { default: prisma } = await import("@ws-model-proxy/db");
const { recordCliAgentAction } = await import("./cli-agent-audit.js");
const audit = recordCliAgentAction as unknown as MockInstance;
const { relaySessionManager } = await import("./session-manager.js");
const {
  cancelCommandsForToken,
  cancelCommandsForUser,
  resetCliCommandsForTests,
  snapshotCliCommand,
  startCliCommand,
  sweepExpiredTokenCommands,
  waitCliCommand,
} = await import("./cli-commands.js");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: { upsert: MockInstance; update: MockInstance; findUnique: MockInstance };
  cliToken: { update: MockInstance; updateMany: MockInstance; findUnique: MockInstance };
  endpoint: {
    upsert: MockInstance;
    findUnique: MockInstance;
    findMany: MockInstance;
    updateMany: MockInstance;
  };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: { findMany: MockInstance; updateMany: MockInstance };
  executionTarget: { findMany: MockInstance; upsert: MockInstance };
  inferenceCapacity: { findMany: MockInstance; updateMany: MockInstance };
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
const testIdentity = generateTestHelloIdentity();

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

type Mode = "off" | "supervised" | "unsupervised";

function challengeNonce(socket: FakeSocket): string {
  for (const send of socket.sends) {
    if (typeof send !== "string") continue;
    const parsed = JSON.parse(send) as { type?: string; nonce?: string };
    if (parsed.type === "hello.challenge" && typeof parsed.nonce === "string") {
      return parsed.nonce;
    }
  }
  throw new Error("expected hello.challenge");
}

function hello(socket: FakeSocket, slug: string, features: { mcpCommandMode: Mode }) {
  return JSON.stringify({
    type: "hello",
    id: `hello-${slug}`,
    protocolVersion: "2.4",
    cli: {
      slug,
      hostname: `${slug}.local`,
      identityPublicKey: testIdentity.publicKey,
      identitySignature: testIdentity.sign(challengeNonce(socket), slug),
      version: "9.9.9",
      capabilities: {
        features: {
          humanTerminal: false,
          mcpCommandMode: features.mcpCommandMode,
          terminalApproval: false,
          terminalSupported: false,
          remoteMetricSources: false,
          remoteEngineAdapters: false,
          mcpFileRead: false,
          fileRootsConfigured: false,
          allowFileToolsAsRoot: false,
        },
        terminalPublicKey: uncompressedKey(),
      },
    },
    endpoints: [],
  });
}

async function connect(
  slug = "desktop",
  features: { mcpCommandMode: Mode } = { mcpCommandMode: "unsupervised" },
) {
  const socket = new FakeSocket();
  relaySessionManager.acceptAuthenticatedSocket({ socket, identity, now });
  await relaySessionManager.handleTextFrame(socket, hello(socket, slug, features), now);
  return socket;
}

/** Closes every session and clears the drain flag, which production never clears. */
async function resetRelaySessions() {
  await relaySessionManager.closeRelaySessions();
  Reflect.set(relaySessionManager, "relayDrain", false);
}

describe("cli commands", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    resetCliCommandsForTests();
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    // An unbound CLI token: every hello's conditional bind claims it.
    db.cliToken.findUnique.mockResolvedValue({
      revokedAt: null,
      expiresAt: null,
      cliDeviceId: null,
      identityPublicKey: null,
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
    db.cliDevice.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === "missing") return null;
      if (args.where.id === "foreign")
        return { id: "foreign", userId: "other-user", mcpCommandMode: "UNSUPERVISED" };
      return { id: args.where.id, userId: "user-id", mcpCommandMode: "UNSUPERVISED" };
    });
    db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken());
    db.endpoint.findUnique.mockResolvedValue(null);
    db.endpoint.findMany.mockResolvedValue([]);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    await resetRelaySessions();
    sweepExpiredTokenCommands(Date.now() + 16 * 60 * 1000);
  });

  it("refuses commands for a user marked for deletion", async () => {
    db.user.findUnique.mockResolvedValue({
      banned: true,
      deletionRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    db.cliDevice.findUnique.mockResolvedValue({
      id: "desktop",
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
    });
    const socket = await connect("desktop");
    socket.sends.length = 0;
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    expect(started).toEqual({ ok: false, error: "token_inactive" });
  });

  /** Pauses only the owner-state read (the select carrying the deletion marker). */
  function pauseOwnerRead() {
    let release!: (row: { banned: boolean; banExpires: null; deletionRequestedAt: null }) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fallback = db.user.findUnique.getMockImplementation();
    db.user.findUnique.mockImplementation(
      (args: { select?: { deletionRequestedAt?: boolean } }) => {
        if (!args.select?.deletionRequestedAt) return fallback?.(args) ?? { slug: "owner" };
        return new Promise((resolve) => {
          release = resolve;
          entered();
        });
      },
    );
    return {
      reached,
      release: () => release({ banned: false, banExpires: null, deletionRequestedAt: null }),
    };
  }

  function execStarts(socket: FakeSocket) {
    return socket.sends.filter((send) => typeof send === "string" && send.includes("exec.start"));
  }

  it("refuses a start whose token is revoked while the owner read is pending", async () => {
    const socket = await connect("desktop");
    socket.sends.length = 0;
    const owner = pauseOwnerRead();
    const start = startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    await owner.reached;
    cancelCommandsForToken("token");
    owner.release();
    await expect(start).resolves.toEqual({ ok: false, error: "token_inactive" });
    expect(execStarts(socket)).toEqual([]);
  });

  it("refuses an owner whose temporary ban is active and admits one whose ban expired", async () => {
    const socket = await connect("desktop");
    socket.sends.length = 0;
    db.user.findUnique.mockResolvedValue({
      banned: true,
      banExpires: new Date(Date.now() + 60_000),
      deletionRequestedAt: null,
    });
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      }),
    ).resolves.toEqual({ ok: false, error: "token_inactive" });
    db.user.findUnique.mockResolvedValue({
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
      deletionRequestedAt: null,
    });
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    expect(started.ok).toBe(true);
  });

  it("a deletion mark committed after the owner read closes the device before dispatch", async () => {
    const socket = await connect("desktop");
    socket.sends.length = 0;
    // The owner read resolves unmarked; the token read is still pending.
    let releaseToken!: (row: ReturnType<typeof liveToken>) => void;
    let tokenEntered!: () => void;
    const tokenReached = new Promise<void>((resolve) => {
      tokenEntered = resolve;
    });
    db.mcpPersonalToken.findFirst.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseToken = resolve;
          tokenEntered();
        }),
    );
    const start = startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    await tokenReached;
    // What `onUserDeletionMarked` runs in-process after the marker commits.
    const closing = relaySessionManager.closeSessionsForUser("user-id");
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    releaseToken(liveToken());
    await expect(start).resolves.toEqual({ ok: false, error: "offline" });
    await closing;
    expect(execStarts(socket)).toEqual([]);
  });

  it("a deletion mark committed after dispatch ends the registered command", async () => {
    const socket = await connect("desktop");
    socket.sends.length = 0;
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    if (!started.ok) throw new Error("start refused");
    await relaySessionManager.closeSessionsForUser("user-id");
    expect(snapshotCliCommand(started.commandId, "user-id", "token")?.status).not.toBe("running");
  });

  it("uses the same not-found result for an unknown device and another user's device", async () => {
    const unknown = await startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "missing",
      command: "pwd",
    });
    const foreign = await startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "foreign",
      command: "pwd",
    });
    expect(unknown).toEqual({ ok: false, error: "not_found" });
    expect(foreign).toEqual(unknown);
  });

  it("starts commands on a 2.6 CLI through the version check", async () => {
    const socket = await connect("desktop");
    socket.sends.length = 0;
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    expect(started.ok).toBe(true);
    expect(
      socket.sends
        .filter((send): send is string => typeof send === "string")
        .map((send) => JSON.parse(send).type),
    ).toEqual(["exec.start"]);
  });

  it("follows grant, session, feature, limit, and command checks before exec.start", async () => {
    db.cliDevice.findUnique.mockResolvedValue({
      id: "desktop",
      userId: "user-id",
      mcpCommandMode: "OFF",
    });
    const socket = await connect();
    socket.sends.length = 0;
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      }),
    ).resolves.toEqual({ ok: false, error: "grant_disabled" });
    expect(socket.sends).toEqual([]);

    db.cliDevice.findUnique.mockResolvedValue({
      id: "desktop",
      userId: "user-id",
      mcpCommandMode: "UNSUPERVISED",
    });
    await resetRelaySessions();
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      }),
    ).resolves.toEqual({ ok: false, error: "offline" });

    const old = new FakeSocket();
    relaySessionManager.acceptAuthenticatedSocket({ socket: old, identity, now });
    await relaySessionManager.handleTextFrame(
      old,
      JSON.stringify({
        type: "hello",
        id: "hello-old",
        protocolVersion: "2.1",
        cli: {
          slug: "desktop",
          hostname: "desktop.local",
          capabilities: {
            protocolVersion: "2.1",
            inventoryAck: true,
            inventoryReplace: true,
            endpointTargeting: true,
            binaryFrames: true,
            cancellation: true,
            maxBinaryChunkBytes: 1024 * 1024,
            requestBodyStreaming: true,
            requestBodyWindowChunks: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
          },
        },
        endpoints: [],
      }),
      now,
    );
    old.sends.length = 0;
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      }),
    ).resolves.toEqual({ ok: false, error: "offline" });
    expect(old.sends.some((send) => typeof send === "string" && send.includes("exec."))).toBe(
      false,
    );

    await resetRelaySessions();
    const disabled = await connect("desktop", { mcpCommandMode: "off" });
    disabled.sends.length = 0;
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      }),
    ).resolves.toEqual({ ok: false, error: "feature_disabled" });
    expect(disabled.sends).toEqual([]);

    await resetRelaySessions();
    const live = await connect();
    const first = await startCliCommand({
      userId: "user-id",
      tokenId: "token-a",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    const second = await startCliCommand({
      userId: "user-id",
      tokenId: "token-a",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "ls",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "whoami",
      }),
    ).resolves.toEqual({ ok: false, error: "limit" });
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "",
      }),
    ).resolves.toEqual({ ok: false, error: "limit" });

    cancelCommandsForToken("token-a");
    expect(
      live.sends.some(
        (send) => typeof send === "string" && JSON.parse(String(send)).type === "exec.cancel",
      ),
    ).toBe(true);
    if (!first.ok) throw new Error("expected command");
    // Ended for the caller at once; the slot stays held (limit below) until the CLI answers.
    expect(snapshotCliCommand(first.commandId, "user-id", "token-a")?.status).toBe("cancelled");

    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "",
      }),
    ).resolves.toEqual({ ok: false, error: "limit" });
  });

  it("a token revoke ends a running command for a waiting call at once, and its late exit is not a success", async () => {
    const socket = await connect("desktop");
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token-r",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "sleep 3600",
    });
    if (!started.ok) throw new Error("expected start");
    const waiting = waitCliCommand(started.commandId, "user-id", "token-r", 60_000);
    cancelCommandsForToken("token-r");
    await expect(waiting).resolves.toMatchObject({ status: "cancelled", exitCode: null });
    await relaySessionManager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "exec.done",
        commandId: started.commandId,
        timedOut: false,
        exitCode: 0,
      }),
    );
    expect(snapshotCliCommand(started.commandId, "user-id", "token-r")).toMatchObject({
      status: "cancelled",
      exitCode: null,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      outcome: "cancelled",
      reason: "token_revoked",
    });
  });

  it("keeps bounded output, waits without cancelling on abort, and sweeps expiry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const socket = await connect();
    const marker = "super-secret-command-marker";
    const expiry = new Date(Date.now() + 60_000);
    db.mcpPersonalToken.findFirst.mockResolvedValueOnce(liveToken("MCP agent", expiry));
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token-b",
      expiresAt: expiry,
      cliDeviceId: "desktop",
      command: marker,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(marker);
    const control = socket.sends.find(
      (send) => typeof send === "string" && send.includes("exec.start"),
    );
    expect(String(control)).toContain(marker);

    const payload = new Uint8Array(10_000);
    payload[0] = 7;
    payload[8192] = 9;
    payload[9999] = 3;
    await relaySessionManager.handleBinaryFrame(
      socket,
      encodeRelayBinaryFrame(
        { type: "exec.stdout", commandId: started.commandId, seq: 1 },
        payload,
      ),
    );
    const running = snapshotCliCommand(started.commandId, "user-id", "token-b");
    expect(running?.stdout.totalBytes).toBe(10_000);
    expect(running?.stdout.head.byteLength).toBe(8192);
    expect(running?.stdout.head[0]).toBe(7);
    expect(running?.stdout.tail.byteLength).toBe(10_000);
    expect(running?.stdout.tail[0]).toBe(7);
    expect(running?.stdout.tail[9999]).toBe(3);
    expect(snapshotCliCommand(started.commandId, "other-user", "token-b")).toBeNull();
    expect(snapshotCliCommand(started.commandId, "user-id", "token-other")).toBeNull();

    const controller = new AbortController();
    const aborted = waitCliCommand(
      started.commandId,
      "user-id",
      "token-b",
      60_000,
      controller.signal,
    );
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ status: "running" });
    expect(snapshotCliCommand(started.commandId, "user-id", "token-b")?.status).toBe("running");

    const pending = waitCliCommand(started.commandId, "user-id", "token-b", 60_000);
    await relaySessionManager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "exec.done",
        commandId: started.commandId,
        timedOut: false,
        exitCode: 0,
      }),
    );
    await expect(pending).resolves.toMatchObject({
      status: "exited",
      exitCode: 0,
      timedOut: false,
    });

    expect(sweepExpiredTokenCommands()).toBe(0);
    expect(sweepExpiredTokenCommands(Date.now() + 16 * 60 * 1000)).toBeGreaterThan(0);
    expect(snapshotCliCommand(started.commandId, "user-id", "token-b")).toBeNull();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("starts the stdout tail after a control string the head/tail gap cuts into", async () => {
    const { formatBoundedStream } = await import("@ws-model-proxy/config/cli-command-output");
    const socket = await connect();
    db.mcpPersonalToken.findFirst.mockResolvedValueOnce(liveToken());
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token-gap",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "cat sixel.txt",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const stream = new TextEncoder().encode(
      `VISIBLE\n\u001b_${"x".repeat(60_000)}\nHIDDEN PAYLOAD\n\u001b\\ AFTER\n`,
    );
    let seq = 1;
    for (let offset = 0; offset < stream.length; offset += 4096) {
      await relaySessionManager.handleBinaryFrame(
        socket,
        encodeRelayBinaryFrame(
          { type: "exec.stdout", commandId: started.commandId, seq },
          stream.subarray(offset, offset + 4096),
        ),
      );
      seq += 1;
    }
    const snapshot = snapshotCliCommand(started.commandId, "user-id", "token-gap");
    expect(snapshot?.stdout.totalBytes).toBe(stream.length);
    const text = snapshot ? formatBoundedStream(snapshot.stdout).text : "";
    expect(text.startsWith("VISIBLE\n")).toBe(true);
    expect(text).not.toContain("HIDDEN");
    expect(text.endsWith(" AFTER\n")).toBe(true);
  });

  it("cancels and frees a command that never reports done after 11 minutes plus 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const socket = await connect();
      const started = await startCliCommand({
        userId: "user-id",
        tokenId: "token-deadline",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "sleep",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      socket.sends.length = 0;
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000 - 1);
      expect(
        socket.sends.some((send) => typeof send === "string" && send.includes("exec.cancel")),
      ).toBe(false);
      expect(snapshotCliCommand(started.commandId, "user-id", "token-deadline")?.status).toBe(
        "running",
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(
        socket.sends.some((send) => typeof send === "string" && send.includes("exec.cancel")),
      ).toBe(true);
      expect(snapshotCliCommand(started.commandId, "user-id", "token-deadline")?.status).toBe(
        "running",
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(snapshotCliCommand(started.commandId, "user-id", "token-deadline")?.status).toBe(
        "cancelled",
      );
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({ type: "heartbeat", id: "after-command-wait" }),
        new Date(),
      );
      const second = await startCliCommand({
        userId: "user-id",
        tokenId: "token-deadline",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      });
      const third = await startCliCommand({
        userId: "user-id",
        tokenId: "token-deadline",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "ls",
      });
      expect(second.ok).toBe(true);
      expect(third.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps running commands at eight per user across CLIs", async () => {
    const slugs = ["desk-a", "desk-b", "desk-c", "desk-d"];
    for (const slug of slugs) await connect(slug);
    for (const slug of slugs) {
      for (let index = 0; index < 2; index += 1) {
        const started = await startCliCommand({
          userId: "user-id",
          tokenId: "token-user-cap",
          expiresAt: null,
          cliDeviceId: slug,
          command: `echo ${slug}-${index}`,
        });
        expect(started.ok).toBe(true);
      }
    }
    await connect("desk-e");
    await expect(
      startCliCommand({
        userId: "user-id",
        tokenId: "token-user-cap",
        expiresAt: null,
        cliDeviceId: "desk-e",
        command: "echo overflow",
      }),
    ).resolves.toEqual({ ok: false, error: "limit" });
  });

  it("refuses a command or cwd with an unpaired surrogate before sending anything", async () => {
    const socket = await connect();
    socket.sends.length = 0;
    const base = {
      userId: "user-id",
      tokenId: "token-u",
      expiresAt: null,
      cliDeviceId: "desktop",
    };
    for (const input of [
      { command: "echo \ud800" },
      { command: "echo \udc00" },
      { command: "pwd", cwd: "/tmp/\ud83d" },
    ]) {
      await expect(startCliCommand({ ...base, ...input })).resolves.toEqual({
        ok: false,
        error: "invalid_command",
      });
    }
    expect(socket.sends).toEqual([]);
    const ok = await startCliCommand({ ...base, command: "echo 😀", cwd: "/tmp/😀" });
    expect(ok.ok).toBe(true);
    const raw = socket.sends.find(
      (send): send is string => typeof send === "string" && send.includes("exec.start"),
    );
    expect(raw?.isWellFormed()).toBe(true);
  });

  it("never runs a command whose token is revoked or narrowed while it looks things up", async () => {
    const socket = await connect();
    socket.sends.length = 0;
    for (const race of ["token", "device"] as const) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (race === "token") {
        db.mcpPersonalToken.findFirst.mockImplementationOnce(async () => {
          await gate;
          return liveToken();
        });
      } else {
        const device = db.cliDevice.findUnique.getMockImplementation();
        db.cliDevice.findUnique.mockImplementationOnce(async (args: { where: { id: string } }) => {
          await gate;
          return device?.(args);
        });
      }
      const pending = startCliCommand({
        userId: "user-id",
        tokenId: "token-r",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "touch /tmp/ran",
      });
      await Promise.resolve();
      cancelCommandsForToken("token-r");
      release();
      await expect(pending).resolves.toEqual({ ok: false, error: "token_inactive" });
    }
    // A token row that is no longer live (revoked in the database, or narrowed).
    for (const row of [null, { ...liveToken(), allowCliCommands: false }]) {
      db.mcpPersonalToken.findFirst.mockResolvedValueOnce(row);
      await expect(
        startCliCommand({
          userId: "user-id",
          tokenId: "token-r",
          expiresAt: null,
          cliDeviceId: "desktop",
          command: "touch /tmp/ran",
        }),
      ).resolves.toEqual({ ok: false, error: "token_inactive" });
    }
    expect(socket.sends).toEqual([]);
  });

  it("cancels a running command whose token expiry has passed", async () => {
    const socket = await connect();
    const expiry = new Date(Date.now() + 1_000);
    db.mcpPersonalToken.findFirst.mockResolvedValueOnce(liveToken("MCP agent", expiry));
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token-c",
      expiresAt: expiry,
      cliDeviceId: "desktop",
      command: "pwd",
    });
    if (!started.ok) throw new Error("expected start");
    expect(sweepExpiredTokenCommands(expiry.getTime() - 1)).toBe(0);
    expect(sweepExpiredTokenCommands(expiry.getTime())).toBe(1);
    expect(snapshotCliCommand(started.commandId, "user-id", "token-c")?.status).toBe("cancelled");
    // A late answer is dropped: no output, no success, one audit row.
    await relaySessionManager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "exec.done",
        commandId: started.commandId,
        timedOut: false,
        exitCode: 0,
      }),
    );
    expect(snapshotCliCommand(started.commandId, "user-id", "token-c")).toMatchObject({
      status: "cancelled",
      exitCode: null,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      outcome: "cancelled",
      reason: "token_expired",
    });
    expect(
      socket.sends.some(
        (send) => typeof send === "string" && JSON.parse(String(send)).type === "exec.cancel",
      ),
    ).toBe(true);
  });

  describe("agent audit events", () => {
    const base = {
      userId: "user-id",
      tokenId: "token-audit",
      expiresAt: null,
      cliDeviceId: "desktop",
    };

    function events() {
      return audit.mock.calls.map(([event]) => event as Record<string, unknown>);
    }

    it("records each refusal once with its code, without starting anything", async () => {
      db.cliDevice.findUnique.mockResolvedValue({
        id: "desktop",
        userId: "user-id",
        mcpCommandMode: "OFF",
      });
      await connect();
      await startCliCommand({ ...base, command: "pwd" });
      db.cliDevice.findUnique.mockResolvedValue(null);
      await startCliCommand({ ...base, command: "pwd" });
      db.cliDevice.findUnique.mockResolvedValue({
        id: "desktop",
        userId: "user-id",
        mcpCommandMode: "UNSUPERVISED",
      });
      await startCliCommand({ ...base, command: "bad\0command" });
      expect(events().map((event) => [event.kind, event.outcome, event.reason])).toEqual([
        ["command", "refused", "grant_disabled"],
        ["command", "refused", "not_found"],
        ["command", "refused", "invalid_command"],
      ]);
      expect(events()[0]).toMatchObject({
        userId: "user-id",
        cliDeviceId: "desktop",
        mcpTokenId: "token-audit",
        path: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64} pwd$/),
      });
    });

    it("stores ? as the program of an oversized refused command, never a cut path component", async () => {
      await connect();
      db.cliDevice.findUnique.mockResolvedValue(null);
      // The cut lands right after an allowlisted word ("... git"), so only the relay's truncated flag yields "?".
      const command = `A=${"b".repeat(16_384 - 6)} gitx status`;
      await startCliCommand({ ...base, command });
      expect(String(events()[0]?.path)).toMatch(/^hmac-sha256:[0-9a-f]{64} \?$/);
      expect(JSON.stringify(events())).not.toContain("bbbbbbbb");
      expect(JSON.stringify(events())).not.toContain("gitx");
    });

    it("stores an unknown device for a token_inactive refusal raised before the ownership check", async () => {
      await connect();
      await startCliCommand({
        ...base,
        expiresAt: new Date(Date.now() - 1),
        cliDeviceId: "NAME=AUDIT_MARKER",
        command: "pwd",
      });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ reason: "token_inactive", cliDeviceId: "unknown" });
      expect(JSON.stringify(events())).not.toContain("AUDIT_MARKER");
    });

    it("stores an unknown device, never the request's text, when the device is not verified", async () => {
      await connect();
      db.cliDevice.findUnique.mockResolvedValue(null);
      await startCliCommand({ ...base, cliDeviceId: "NAME=AUDIT_MARKER", command: "pwd" });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ reason: "not_found", cliDeviceId: "unknown" });
      expect(JSON.stringify(events())).not.toContain("AUDIT_MARKER");
    });

    it("records a failed internal_error once and rethrows when admission throws", async () => {
      await connect();
      const boom = new TypeError("admission read failed");
      db.cliDevice.findUnique.mockRejectedValueOnce(boom);
      await expect(startCliCommand({ ...base, command: "pwd" })).rejects.toBe(boom);
      expect(events().map((event) => [event.kind, event.outcome, event.reason])).toEqual([
        ["command", "failed", "internal_error"],
      ]);
      expect(events()[0]).toMatchObject({
        userId: "user-id",
        cliDeviceId: "unknown",
        mcpTokenId: "token-audit",
        path: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64} pwd$/),
      });
    });

    it("records a refusal for a token that is no longer live", async () => {
      await connect();
      db.mcpPersonalToken.findFirst.mockResolvedValue(null);
      await startCliCommand({ ...base, command: "pwd" });
      expect(events()).toEqual([
        expect.objectContaining({ outcome: "refused", reason: "token_inactive" }),
      ]);
    });

    it("records one completed event with the exit status and no output", async () => {
      const socket = await connect();
      const result = await startCliCommand({ ...base, command: "curl --api-key sk-secret-9 x" });
      if (!result.ok) throw new Error("expected start");
      expect(events()).toEqual([]);
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: result.commandId,
          timedOut: false,
          exitCode: 3,
        }),
      );
      // A second terminal frame for the same command adds nothing.
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: result.commandId,
          timedOut: false,
          exitCode: 0,
        }),
      );
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        kind: "command",
        outcome: "completed",
        reason: "exit:3",
        mcpTokenId: "token-audit",
      });
      const path = String(events()[0]?.path);
      expect(path).toMatch(/^hmac-sha256:[0-9a-f]{64} curl$/);
      expect(JSON.stringify(events())).not.toContain("sk-secret-9");
      // No stored field of the row may contain any argument text.
      expect(path.split(" ").slice(1).join(" ")).toBe("curl");
    });

    it("maps a signalled exec to signal:<name> and a timeout to timed_out", async () => {
      const socket = await connect();
      const signalled = await startCliCommand({ ...base, command: "killed" });
      if (!signalled.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: signalled.commandId,
          timedOut: false,
          signal: "SIGKILL",
        }),
      );
      const timedOut = await startCliCommand({ ...base, command: "slow" });
      if (!timedOut.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: timedOut.commandId,
          timedOut: true,
        }),
      );
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["completed", "signal:SIGKILL"],
        ["completed", "timed_out"],
      ]);
    });

    it("stores an unknown exec signal as signal:unknown, never the CLI's text", async () => {
      const socket = await connect();
      const result = await startCliCommand({ ...base, command: "killed" });
      if (!result.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: result.commandId,
          timedOut: false,
          signal: "AUDIT_MARKER",
        }),
      );
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["completed", "signal:unknown"],
      ]);
      expect(JSON.stringify(events())).not.toContain("AUDIT_MARKER");
    });

    it("stores the hash of the command text and its program, never a preview", async () => {
      const socket = await connect();
      const command = "SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz git run";
      const result = await startCliCommand({ ...base, command });
      if (!result.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: result.commandId,
          timedOut: false,
          exitCode: 0,
        }),
      );
      const path = String(events()[0]?.path ?? "");
      // The first word is a secret-bearing assignment: it is skipped and never
      // stored; the program is the allowlisted word after it.
      expect(path).not.toContain("abcdefghij");
      expect(path.split(" ").slice(1).join(" ")).toBe("git");
      expect(path.slice(0, path.indexOf(" "))).toBe(`hmac-sha256:${commandAuditDigest(command)}`);
    });

    it("never stores raw argument text for a secret-bearing command", async () => {
      const socket = await connect();
      const command = "curl --api-key sk-secret-9 https://x";
      const result = await startCliCommand({ ...base, command });
      if (!result.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: result.commandId,
          timedOut: false,
          exitCode: 0,
        }),
      );
      const serialized = JSON.stringify(events());
      for (const leak of ["sk-secret-9", "https://x", "--api-key"])
        expect(serialized, `row leaks ${leak}`).not.toContain(leak);
      expect(String(events()[0]?.path)).toMatch(/^hmac-sha256:[0-9a-f]{64} curl$/);
    });

    it("records a command the session loss cancelled and one the CLI rejected", async () => {
      const socket = await connect();
      const rejected = await startCliCommand({ ...base, command: "first" });
      if (!rejected.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.rejected",
          commandId: rejected.commandId,
          reason: "bad_command",
        }),
      );
      const cancelled = await startCliCommand({ ...base, command: "sleep 100" });
      if (!cancelled.ok) throw new Error("expected start");
      await relaySessionManager.closeRelaySessions();
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["refused", "bad_command"],
        ["cancelled", null],
      ]);
    });

    it("maps an unknown CLI rejection reason to the fallback", async () => {
      const socket = await connect();
      // `reason` is a stable machine code, never free text: a conforming CLI
      // sends a REASON_* constant, but the wire accepts any string. Storing it
      // verbatim would put agent-supplied free text in the audit column.
      const rejected = await startCliCommand({ ...base, command: "first" });
      if (!rejected.ok) throw new Error("expected start");
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.rejected",
          commandId: rejected.commandId,
          reason: "unknown-code-9f3a",
        }),
      );
      expect(events().map((event) => [event.outcome, event.reason])).toEqual([
        ["refused", "rejected"],
      ]);
      expect(JSON.stringify(events())).not.toContain("unknown-code-9f3a");
    });
  });

  describe("ban fence (#159)", () => {
    let unsubscribe: () => void;
    beforeEach(() => {
      // The same subscription apps/server/src/app.ts makes.
      unsubscribe = onUserBanned(cancelRelayWorkForBannedUser);
    });
    afterEach(() => unsubscribe());

    const execCancels = (socket: FakeSocket) =>
      socket.sends
        .filter((send): send is string => typeof send === "string")
        .map((send) => JSON.parse(send) as { type: string; commandId?: string })
        .filter((frame) => frame.type === "exec.cancel");

    it("a ban during long-running commands cancels every command of that user on the CLI, and only theirs", async () => {
      const socket = await connect("desktop");
      // A second owner's CLI and command.
      const otherSocket = new FakeSocket();
      relaySessionManager.acceptAuthenticatedSocket({
        socket: otherSocket,
        identity: { ...identity, id: "token-id-other", userId: "other-user" },
        now,
      });
      await relaySessionManager.handleTextFrame(
        otherSocket,
        hello(otherSocket, "laptop", { mcpCommandMode: "unsupervised" }),
        now,
      );
      db.cliDevice.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
        id: args.where.id,
        userId: args.where.id === "laptop" ? "other-user" : "user-id",
        mcpCommandMode: "UNSUPERVISED",
      }));
      socket.sends.length = 0;
      otherSocket.sends.length = 0;
      const start = (userId: string, tokenId: string, cliDeviceId: string, command: string) =>
        startCliCommand({ userId, tokenId, expiresAt: null, cliDeviceId, command });
      // Two tokens of the banned user and one command of another user, none finished.
      const first = await start("user-id", "token-a", "desktop", "sleep 3600");
      const second = await start("user-id", "token-b", "desktop", "sleep 3601");
      const others = await start("other-user", "token-o", "laptop", "sleep 3602");
      if (!first.ok || !second.ok || !others.ok) throw new Error("expected three running commands");
      expect(snapshotCliCommand(first.commandId, "user-id", "token-a")?.status).toBe("running");

      await notifyUserBanned("user-id");

      expect(execCancels(socket).map((frame) => frame.commandId)).toEqual([
        first.commandId,
        second.commandId,
      ]);
      expect(execCancels(otherSocket)).toEqual([]);
      expect(socket.closes).toEqual([]);
      // Ended for the caller at once, not when the CLI answers: the record is terminal,
      // a call waiting across the ban is woken, and the other user's command keeps running.
      expect(snapshotCliCommand(first.commandId, "user-id", "token-a")?.status).toBe("cancelled");
      expect(snapshotCliCommand(second.commandId, "user-id", "token-b")?.status).toBe("cancelled");
      expect(snapshotCliCommand(others.commandId, "other-user", "token-o")?.status).toBe("running");
      expect(
        audit.mock.calls.map(([event]) => [event.mcpTokenId, event.outcome, event.reason]),
      ).toEqual([
        ["token-a", "cancelled", "user_banned"],
        ["token-b", "cancelled", "user_banned"],
      ]);
    });

    it("a call waiting across the ban returns cancelled, and the CLI's late output and exit never become a success", async () => {
      const socket = await connect("desktop");
      socket.sends.length = 0;
      const started = await startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "sleep 3600",
      });
      if (!started.ok) throw new Error("expected start");
      const waiting = waitCliCommand(started.commandId, "user-id", "token-a", 60_000);
      await notifyUserBanned("user-id");
      await expect(waiting).resolves.toMatchObject({
        status: "cancelled",
        exitCode: null,
        timedOut: false,
      });
      // What the unchanged CLI does after exec.cancel: flush held output, then report the exit.
      relaySessionManager.handleBinaryFrame(
        socket,
        encodeRelayBinaryFrame(
          { type: "exec.stdout", commandId: started.commandId, seq: 1 },
          new TextEncoder().encode("late-output"),
        ),
      );
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: started.commandId,
          timedOut: false,
          exitCode: 0,
        }),
      );
      const after = snapshotCliCommand(started.commandId, "user-id", "token-a");
      expect(after).toMatchObject({ status: "cancelled", exitCode: null });
      expect(after?.stdout.totalBytes).toBe(0);
      // One audit row, never "completed".
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0]?.[0]).toMatchObject({
        outcome: "cancelled",
        reason: "user_banned",
      });
    });

    it("a late exec.rejected keeps the reason the server ended the command for and frees its slot", async () => {
      const socket = await connect("desktop");
      const start = (tokenId: string, command: string) =>
        startCliCommand({
          userId: "user-id",
          tokenId,
          expiresAt: null,
          cliDeviceId: "desktop",
          command,
        });
      const first = await start("token-a", "sleep 1");
      const second = await start("token-a", "sleep 2");
      if (!first.ok || !second.ok) throw new Error("expected two starts");
      await notifyUserBanned("user-id");
      db.user.findUnique.mockResolvedValue({
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
      });
      await expect(start("token-b", "pwd")).resolves.toEqual({ ok: false, error: "limit" });
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({ type: "exec.rejected", commandId: first.commandId, reason: "limit" }),
      );
      // The record is still the server's cancel: neither its status nor its audit reason changed.
      expect(snapshotCliCommand(first.commandId, "user-id", "token-a")).toMatchObject({
        status: "cancelled",
        rejectionReason: "user_banned",
      });
      // (The refused start above is its own "refused" row; the ended commands have exactly one each.)
      expect(
        audit.mock.calls
          .map(([event]) => [event.outcome, event.reason])
          .filter(([outcome]) => outcome !== "refused"),
      ).toEqual([
        ["cancelled", "user_banned"],
        ["cancelled", "user_banned"],
      ]);
      await expect(start("token-b", "pwd")).resolves.toMatchObject({ ok: true });
    });

    it("a lost session keeps the held slot only until the grace runs out (over-holds, never under-holds)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await connect("desktop");
      const start = (tokenId: string, command: string) =>
        startCliCommand({
          userId: "user-id",
          tokenId,
          expiresAt: null,
          cliDeviceId: "desktop",
          command,
        });
      const first = await start("token-a", "sleep 1");
      const second = await start("token-a", "sleep 2");
      if (!first.ok || !second.ok) throw new Error("expected two starts");
      await notifyUserBanned("user-id");
      await resetRelaySessions();
      await connect("desktop");
      db.user.findUnique.mockResolvedValue({
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
      });
      await expect(start("token-b", "pwd")).resolves.toEqual({ ok: false, error: "limit" });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(start("token-b", "pwd")).resolves.toMatchObject({ ok: true });
    });

    it("holds the execution slot of a cancelled command until the CLI answers or the grace runs out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const socket = await connect("desktop");
      const start = (tokenId: string, command: string) =>
        startCliCommand({
          userId: "user-id",
          tokenId,
          expiresAt: null,
          cliDeviceId: "desktop",
          command,
        });
      const first = await start("token-a", "sleep 1");
      const second = await start("token-a", "sleep 2");
      if (!first.ok || !second.ok) throw new Error("expected two starts");
      await notifyUserBanned("user-id");
      // Both per-CLI slots are still held: the remote processes may exist.
      db.user.findUnique.mockResolvedValue({
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
      });
      await expect(start("token-b", "pwd")).resolves.toEqual({ ok: false, error: "limit" });
      // One CLI answer frees its slot.
      await relaySessionManager.handleTextFrame(
        socket,
        JSON.stringify({
          type: "exec.done",
          commandId: first.commandId,
          timedOut: false,
          signal: "SIGTERM",
        }),
      );
      const third = await start("token-b", "pwd");
      expect(third.ok).toBe(true);
      // A CLI that never answers does not hold the other slot for ever.
      await expect(start("token-b", "pwd2")).resolves.toEqual({ ok: false, error: "limit" });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(start("token-b", "pwd3")).resolves.toMatchObject({ ok: true });
    });

    it("revoking the CLI credential ends a long-running command on the CLI too (the revoke half of #159)", async () => {
      const socket = await connect("desktop");
      socket.sends.length = 0;
      const started = await startCliCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "sleep 3600",
      });
      if (!started.ok) throw new Error("start refused");
      await relaySessionManager.closeSessionsForRevokedCredentials({
        kind: "cliToken",
        ids: [identity.id],
      });
      expect(execCancels(socket).map((frame) => frame.commandId)).toEqual([started.commandId]);
      expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    });

    it("refuses a start whose admission is still reading when the ban lands", async () => {
      const socket = await connect("desktop");
      socket.sends.length = 0;
      const owner = pauseOwnerRead();
      const started = startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      });
      await owner.reached;
      await notifyUserBanned("user-id");
      owner.release();
      await expect(started).resolves.toEqual({ ok: false, error: "token_inactive" });
      expect(execStarts(socket)).toEqual([]);
    });

    it("cancelCommandsForUser alone also refuses a start still in admission", async () => {
      const socket = await connect("desktop");
      socket.sends.length = 0;
      const owner = pauseOwnerRead();
      const started = startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      });
      await owner.reached;
      cancelCommandsForUser("user-id");
      owner.release();
      await expect(started).resolves.toEqual({ ok: false, error: "token_inactive" });
      expect(execStarts(socket)).toEqual([]);
    });

    it("does not refuse a start whose admission reads for another user's ban", async () => {
      const socket = await connect("desktop");
      socket.sends.length = 0;
      const owner = pauseOwnerRead();
      const started = startCliCommand({
        userId: "user-id",
        tokenId: "token",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "pwd",
      });
      await owner.reached;
      await notifyUserBanned("someone-else");
      owner.release();
      await expect(started).resolves.toMatchObject({ ok: true });
      expect(execStarts(socket)).toHaveLength(1);
    });
  });
});

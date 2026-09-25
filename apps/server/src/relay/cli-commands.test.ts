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
const { relaySessionManager } = await import("./session-manager.js");
const {
  cancelCommandsForToken,
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
  endpoint: { upsert: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: { updateMany: MockInstance };
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

function hello(slug: string, features: { mcpCommandMode: Mode }) {
  return JSON.stringify({
    type: "hello",
    id: `hello-${slug}`,
    protocolVersion: "2.6",
    cli: {
      slug,
      hostname: `${slug}.local`,
      version: "9.9.9",
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
          mcpCommandMode: features.mcpCommandMode,
          terminalApproval: false,
          terminalSupported: false,
        },
        terminalPublicKey: uncompressedKey(),
        terminalViewers: true,
        supervisedCommands: true,
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
  await relaySessionManager.handleTextFrame(socket, hello(slug, features), now);
  return socket;
}

describe("cli commands", () => {
  beforeEach(() => {
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
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    await relaySessionManager.closeRelaySessions();
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
    await relaySessionManager.closeRelaySessions();
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

    await relaySessionManager.closeRelaySessions();
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

    await relaySessionManager.closeRelaySessions();
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
    expect(snapshotCliCommand(first.commandId, "user-id", "token-a")?.status).toBe("running");

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

  it("cancels and frees a command that never reports done after 11 minutes plus 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    expect(snapshotCliCommand(started.commandId, "user-id", "token-c")?.status).toBe("running");
    expect(
      socket.sends.some(
        (send) => typeof send === "string" && JSON.parse(String(send)).type === "exec.cancel",
      ),
    ).toBe(true);
  });
});

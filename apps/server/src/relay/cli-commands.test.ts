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

function uncompressedKey(): string {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
}

function hello(
  slug: string,
  features: { mcpCommands: boolean },
  protocolVersion: "2.4" | "2.5" = "2.4",
) {
  return JSON.stringify({
    type: "hello",
    id: `hello-${slug}`,
    protocolVersion,
    cli: {
      slug,
      hostname: `${slug}.local`,
      version: "9.9.9",
      capabilities: {
        protocolVersion,
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
          mcpCommands: features.mcpCommands,
          terminalApproval: false,
          terminalSupported: false,
        },
        terminalPublicKey: uncompressedKey(),
        ...(protocolVersion === "2.5" ? { terminalViewers: true } : {}),
      },
    },
    endpoints: [],
  });
}

async function connect(
  slug = "desktop",
  features = { mcpCommands: true },
  protocolVersion: "2.4" | "2.5" = "2.4",
) {
  const socket = new FakeSocket();
  relaySessionManager.acceptAuthenticatedSocket({ socket, identity, now });
  await relaySessionManager.handleTextFrame(socket, hello(slug, features, protocolVersion), now);
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
      allowMcpCommands: true,
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
        return { id: "foreign", userId: "other-user", allowMcpCommands: true };
      return { id: args.where.id, userId: "user-id", allowMcpCommands: true };
    });
    db.endpoint.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    await relaySessionManager.closeRelaySessions();
    sweepExpiredTokenCommands(Date.now() + 16 * 60 * 1000);
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

  it("starts commands on a 2.5 CLI through the version check", async () => {
    const socket = await connect("desktop", { mcpCommands: true }, "2.5");
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
      allowMcpCommands: false,
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
      allowMcpCommands: true,
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
    const disabled = await connect("desktop", { mcpCommands: false });
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
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token-b",
      expiresAt: new Date(Date.now() - 1000),
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

  it("cancels a running command whose token expiry has passed", async () => {
    const socket = await connect();
    const started = await startCliCommand({
      userId: "user-id",
      tokenId: "token-c",
      expiresAt: new Date(1_000),
      cliDeviceId: "desktop",
      command: "pwd",
    });
    if (!started.ok) throw new Error("expected start");
    expect(sweepExpiredTokenCommands(1_000)).toBe(1);
    expect(snapshotCliCommand(started.commandId, "user-id", "token-c")?.status).toBe("running");
    expect(
      socket.sends.some(
        (send) => typeof send === "string" && JSON.parse(String(send)).type === "exec.cancel",
      ),
    ).toBe(true);
  });
});

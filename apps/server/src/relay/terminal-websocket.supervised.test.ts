import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_REQUEST_BODY_WINDOW_CHUNKS } from "./protocol.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: "http://localhost:3001",
    MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES: 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES: 4 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS: 4,
    MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES: 0,
    MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS: 30_000,
    MODEL_API_TRANSCRIPTION_STALE_SPOOL_MS: 24 * 60 * 60 * 1000,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

vi.mock("../rate-limit.js", () => ({
  rpcLimiter: {},
  createRateLimiterMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { relaySessionManager } = await import("./session-manager.js");
const { terminalBrowserHub } = await import("./terminal-websocket.js");
const { resetCliCommandsForTests, startSupervisedCommand } = await import("./cli-commands.js");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: {
    upsert: MockInstance;
    update: MockInstance;
    findUnique: MockInstance;
    findMany: MockInstance;
  };
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

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sends: Array<string | ArrayBuffer> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sends.push(typeof data === "string" ? data : new ArrayBuffer(0));
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

function hello() {
  return JSON.stringify({
    type: "hello",
    id: "hello-desktop",
    protocolVersion: "2.6",
    cli: {
      slug: "desktop",
      hostname: "desktop.local",
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
          mcpCommandMode: "supervised",
          terminalApproval: false,
          terminalSupported: true,
        },
        terminalPublicKey: uncompressedKey(),
        terminalViewers: true,
        supervisedCommands: true,
      },
    },
    endpoints: [],
  });
}

async function flush() {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("terminal list pushes for supervised requests", () => {
  let cli: FakeSocket;

  beforeEach(async () => {
    resetCliCommandsForTests();
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
    db.cliDevice.upsert.mockResolvedValue({
      id: "desktop",
      userId: "user-id",
      slug: "desktop",
      allowHumanTerminal: false,
      mcpCommandMode: "SUPERVISED",
      inventorySeq: 0,
      inventoryDigest: null,
      inventoryAcknowledgedAt: null,
    });
    db.cliDevice.update.mockResolvedValue({
      inventorySeq: 1,
      inventoryDigest: "digest",
      inventoryAcknowledgedAt: now,
      id: "desktop",
    });
    db.cliDevice.findUnique.mockResolvedValue({
      id: "desktop",
      userId: "user-id",
      mcpCommandMode: "SUPERVISED",
    });
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "desktop",
        slug: "desktop",
        status: "CONNECTED",
        allowHumanTerminal: false,
        reportedHumanTerminal: false,
        reportedTerminalSupported: true,
        relayProtocolVersion: "2.6",
      },
    ]);
    db.mcpPersonalToken.findFirst.mockResolvedValue(liveToken("Agent"));
    db.endpoint.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    cli = new FakeSocket();
    relaySessionManager.acceptAuthenticatedSocket({ socket: cli, identity, now });
    await relaySessionManager.handleTextFrame(cli, hello(), now);
  });

  afterEach(async () => {
    terminalBrowserHub.closeAll();
    await relaySessionManager.removeSession(cli, now);
    resetCliCommandsForTests();
  });

  it("pushes a pushed:true list to that user's sockets only, and agent entries carry origin", async () => {
    const owner = new FakeSocket();
    const ownerTab = new FakeSocket();
    const stranger = new FakeSocket();
    terminalBrowserHub.accept({ socket: owner, userId: "user-id", sessionId: "s1" });
    terminalBrowserHub.accept({ socket: ownerTab, userId: "user-id", sessionId: "s2" });
    terminalBrowserHub.accept({ socket: stranger, userId: "other-user", sessionId: "s3" });

    const started = await startSupervisedCommand({
      userId: "user-id",
      tokenId: "token-a",
      expiresAt: null,
      cliDeviceId: "desktop",
      command: "make install",
      shareOutput: false,
    });
    if (!started.ok) throw new Error("expected start");
    await relaySessionManager.handleTextFrame(
      cli,
      JSON.stringify({
        type: "term.spawned",
        terminalId: started.terminalId,
        commandId: started.commandId,
      }),
      now,
    );
    await flush();

    for (const socket of [owner, ownerTab]) {
      const pushes = socket.json().filter((message) => message.type === "terminals");
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        pushed: true,
        terminals: [
          {
            terminalId: started.terminalId,
            origin: "agent",
            supervised: {
              commandId: started.commandId,
              status: "awaiting_user",
              requester: "Agent",
              command: "make install",
              shareOutput: false,
            },
          },
        ],
      });
      // The CLI's key is listed even though the human terminal is not granted.
      expect(pushes[0]?.clis).toEqual([
        expect.objectContaining({ cliDeviceId: "desktop", publicKey: uncompressedKey() }),
      ]);
    }
    expect(stranger.sends).toEqual([]);

    await relaySessionManager.handleTextFrame(
      cli,
      JSON.stringify({ type: "supervised.declined", commandId: started.commandId }),
      now,
    );
    await relaySessionManager.handleTextFrame(
      cli,
      JSON.stringify({ type: "term.exit", terminalId: started.terminalId }),
      now,
    );
    await flush();
    const last = owner
      .json()
      .filter((message) => message.type === "terminals")
      .at(-1);
    expect(last).toMatchObject({ pushed: true, terminals: [] });
    expect(stranger.sends).toEqual([]);
  });

  describe("Decline from the browser", () => {
    async function spawnedRequest() {
      const started = await startSupervisedCommand({
        userId: "user-id",
        tokenId: "token-a",
        expiresAt: null,
        cliDeviceId: "desktop",
        command: "make install",
        shareOutput: false,
      });
      if (!started.ok) throw new Error("expected start");
      await cliSays({
        type: "term.spawned",
        terminalId: started.terminalId,
        commandId: started.commandId,
      });
      cli.sends.length = 0;
      return started;
    }

    async function cliSays(message: Record<string, unknown>) {
      await relaySessionManager.handleTextFrame(cli, JSON.stringify(message), now);
    }

    function browser(userId = "user-id") {
      const socket = new FakeSocket();
      terminalBrowserHub.accept({ socket, userId, sessionId: `session-${userId}` });
      return socket;
    }

    const toCli = (type: string) => cli.json().filter((message) => message.type === type);
    const toBrowser = (socket: FakeSocket, type: string) =>
      socket.json().filter((message) => message.type === type);

    it("never kills a command whose Enter the server already took (CLI first)", async () => {
      const request = await spawnedRequest();
      const tab = browser();
      await cliSays({ type: "supervised.accepted", commandId: request.commandId });
      // The tab still showed "Decline" (its list was stale) and sent it.
      await terminalBrowserHub.handleText(
        tab,
        JSON.stringify({ type: "decline", terminalId: request.terminalId }),
      );
      expect(toCli("term.close")).toEqual([]);
      expect(toCli("supervised.cancel")).toEqual([]);
      expect(toBrowser(tab, "decline")).toEqual([
        { type: "decline", terminalId: request.terminalId, outcome: "started" },
      ]);
      // The command runs to its normal end.
      await cliSays({
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 0,
        review: false,
      });
      await cliSays({ type: "term.exit", terminalId: request.terminalId, exitCode: 0 });
      expect(toCli("term.close")).toEqual([]);
    });

    it("tells a declining tab when the CLI's Enter beat its Decline (server first)", async () => {
      const request = await spawnedRequest();
      const tab = browser();
      await terminalBrowserHub.handleText(
        tab,
        JSON.stringify({ type: "decline", terminalId: request.terminalId }),
      );
      // A request to the CLI, not a kill.
      expect(toCli("supervised.cancel")).toEqual([
        { type: "supervised.cancel", commandId: request.commandId, reason: "decline" },
      ]);
      expect(toCli("term.close")).toEqual([]);
      expect(toBrowser(tab, "decline")).toEqual([]);
      expect(toBrowser(tab, "error")).toEqual([]);
      // The CLI had already taken an Enter.
      await cliSays({ type: "supervised.accepted", commandId: request.commandId });
      // A repeated report changes nothing and is not told twice.
      await cliSays({ type: "supervised.accepted", commandId: request.commandId });
      expect(toBrowser(tab, "decline")).toEqual([
        { type: "decline", terminalId: request.terminalId, outcome: "started" },
      ]);
      await cliSays({
        type: "supervised.done",
        commandId: request.commandId,
        exitCode: 3,
        review: false,
      });
      await cliSays({ type: "term.exit", terminalId: request.terminalId, exitCode: 3 });
      expect(toCli("term.close")).toEqual([]);
      // The declining tab did not view the terminal, yet hears how it ended.
      expect(toBrowser(tab, "exit")).toEqual([
        {
          type: "exit",
          terminalId: request.terminalId,
          exitCode: 3,
          supervisedStatus: "exited",
        },
      ]);
    });

    it("keeps the declining tab informed when the CLI declines, and refuses strangers", async () => {
      const request = await spawnedRequest();
      const stranger = browser("other-user");
      await terminalBrowserHub.handleText(
        stranger,
        JSON.stringify({ type: "decline", terminalId: request.terminalId }),
      );
      expect(toBrowser(stranger, "error")).toEqual([
        expect.objectContaining({ code: "not_found", terminalId: request.terminalId }),
      ]);
      expect(toCli("supervised.cancel")).toEqual([]);

      const tab = browser();
      await terminalBrowserHub.handleText(
        tab,
        JSON.stringify({ type: "decline", terminalId: request.terminalId }),
      );
      await cliSays({ type: "supervised.declined", commandId: request.commandId });
      await cliSays({ type: "term.exit", terminalId: request.terminalId });
      expect(toBrowser(tab, "exit")).toEqual([
        { type: "exit", terminalId: request.terminalId, supervisedStatus: "declined" },
      ]);
      expect(toBrowser(tab, "decline")).toEqual([]);
    });

    it("answers every Decline by its request id, also one the rate limit refused unread", async () => {
      const request = await spawnedRequest();
      const tab = browser();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        // Use up the socket's text budget.
        for (let index = 0; index < 20; index += 1) {
          await terminalBrowserHub.handleText(tab, "not json");
        }
        tab.sends.length = 0;
        const decline = (requestId: string) =>
          JSON.stringify({ type: "decline", terminalId: request.terminalId, requestId });
        await terminalBrowserHub.handleText(tab, decline("first"));
        expect(toBrowser(tab, "error")).toEqual([
          expect.objectContaining({
            code: "rate_limited",
            requestId: "first",
            terminalId: request.terminalId,
          }),
        ]);
        expect(toCli("supervised.cancel")).toEqual([]);
        // A frame too big to be a real one is refused without being read.
        tab.sends.length = 0;
        await terminalBrowserHub.handleText(
          tab,
          JSON.stringify({ type: "decline", requestId: "big", pad: "x".repeat(5000) }),
        );
        expect(toBrowser(tab, "error")).toEqual([
          expect.not.objectContaining({ requestId: expect.anything() }),
        ]);

        // Once the window has passed, the retried Decline goes through.
        clock.mockReturnValue(1_000_000 + 10_000);
        tab.sends.length = 0;
        await terminalBrowserHub.handleText(tab, decline("second"));
        expect(toCli("supervised.cancel")).toHaveLength(1);
        // Answered later (the exit, or `started`); nothing refused it.
        expect(toBrowser(tab, "error")).toEqual([]);
        expect(toBrowser(tab, "decline")).toEqual([]);
        // A frame the schema refuses still names its Decline.
        await terminalBrowserHub.handleText(
          tab,
          JSON.stringify({ ...JSON.parse(decline("third")), extra: true }),
        );
        expect(toBrowser(tab, "error")).toEqual([
          expect.objectContaining({
            code: "invalid",
            requestId: "third",
            terminalId: request.terminalId,
          }),
        ]);
        // The Enter came first: the direct answer names the Decline too.
        await cliSays({ type: "supervised.accepted", commandId: request.commandId });
        tab.sends.length = 0;
        await terminalBrowserHub.handleText(tab, decline("fourth"));
        expect(toBrowser(tab, "decline")).toEqual([
          {
            type: "decline",
            terminalId: request.terminalId,
            outcome: "started",
            requestId: "fourth",
          },
        ]);
        // A Decline whose handling fails is still answered.
        const failing = vi
          .spyOn(relaySessionManager, "declineTerminalFromBrowser")
          .mockImplementation(() => {
            throw new Error("boom");
          });
        tab.sends.length = 0;
        await expect(terminalBrowserHub.handleText(tab, decline("fifth"))).rejects.toThrow("boom");
        expect(toBrowser(tab, "error")).toEqual([
          expect.objectContaining({
            code: "invalid",
            requestId: "fifth",
            terminalId: request.terminalId,
          }),
        ]);
        failing.mockRestore();
      } finally {
        clock.mockRestore();
      }
    });

    it("keeps End session an explicit kill, also of a request still waiting", async () => {
      const request = await spawnedRequest();
      const tab = browser();
      await terminalBrowserHub.handleText(
        tab,
        JSON.stringify({ type: "close", terminalId: request.terminalId }),
      );
      expect(toCli("term.close")).toEqual([{ type: "term.close", terminalId: request.terminalId }]);
      expect(toCli("supervised.cancel")).toEqual([]);
    });
  });
});

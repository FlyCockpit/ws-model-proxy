import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { Hono } from "hono";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayBinaryFrame, RELAY_REQUEST_BODY_WINDOW_CHUNKS } from "./protocol.js";

const limiterState = vi.hoisted(() => ({ fail: false }));
const sessions = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

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
  auth: { api: { getSession: sessions.getSession } },
}));

vi.mock("../rate-limit.js", () => ({
  rpcLimiter: {},
  createRateLimiterMiddleware:
    () =>
    async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => {
      if (limiterState.fail) {
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }
      await next();
    },
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { relaySessionManager } = await import("./session-manager.js");
const { createTerminalWebsocketMiddleware, terminalBrowserHub } = await import(
  "./terminal-websocket.js"
);
const { settleSocketHandler } = await import("./socket-handler.js");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: {
    upsert: MockInstance;
    update: MockInstance;
    findFirst: MockInstance;
    findMany: MockInstance;
  };
  cliToken: { update: MockInstance };
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
  session: { findUnique: MockInstance };
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
  jsonSends() {
    return this.sends
      .filter((send): send is string => typeof send === "string")
      .map((send) => JSON.parse(send));
  }
}

function uncompressedKey(): string {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
}
function nonce(): string {
  return Buffer.alloc(16, 5).toString("base64url");
}

function hello(
  slug: string,
  protocol: "2.4" | "2.1",
  features?: { humanTerminal?: boolean; terminalSupported?: boolean },
) {
  if (protocol === "2.1") {
    return JSON.stringify({
      type: "hello",
      id: `hello-${slug}`,
      protocolVersion: "2.1",
      cli: {
        slug,
        label: slug,
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
    });
  }
  return JSON.stringify({
    type: "hello",
    id: `hello-${slug}`,
    protocolVersion: "2.4",
    cli: {
      slug,
      label: slug,
      version: "9.9.9",
      capabilities: {
        protocolVersion: "2.4",
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
          humanTerminal: features?.humanTerminal ?? true,
          mcpCommands: false,
          terminalApproval: false,
          terminalSupported: features?.terminalSupported ?? true,
        },
        terminalPublicKey: uncompressedKey(),
      },
    },
    endpoints: [],
  });
}

function device(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    slug: id,
    status: "CONNECTED",
    allowHumanTerminal: true,
    reportedHumanTerminal: true,
    reportedTerminalSupported: true,
    relayProtocolVersion: "2.4",
    ...overrides,
  };
}

function browserSession(cookieUser = "user-id") {
  return {
    user: { id: cookieUser },
    session: {
      id: "session-id",
      userId: cookieUser,
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    },
  };
}

function middlewareApp() {
  const app = new Hono();
  app.use("/api/dashboard/terminal/ws", createTerminalWebsocketMiddleware());
  app.get("/api/dashboard/terminal/ws", (c) => c.text("upgraded"));
  return app;
}

async function connectCli(
  slug: string,
  protocol: "2.4" | "2.1" = "2.4",
  features?: { humanTerminal?: boolean; terminalSupported?: boolean },
) {
  const socket = new FakeSocket();
  relaySessionManager.acceptAuthenticatedSocket({ socket, identity, now });
  await relaySessionManager.handleTextFrame(socket, hello(slug, protocol, features), now);
  return socket;
}

describe("terminal websocket admission", () => {
  beforeEach(() => {
    limiterState.fail = false;
    sessions.getSession.mockReset();
  });

  it("rejects a missing upgrade, a missing session, and a bearer-only credential", async () => {
    sessions.getSession.mockImplementation(async ({ headers }: { headers: Headers }) => {
      if (headers.get("authorization") && !headers.get("cookie"))
        return browserSession("bearer-user");
      if (headers.get("cookie")?.includes("session=ok")) return browserSession();
      return null;
    });
    const app = middlewareApp();
    const upgrade = await app.request("/api/dashboard/terminal/ws", {
      headers: { cookie: "session=ok", origin: "https://proxy.example.com" },
    });
    expect(upgrade.status).toBe(426);

    const anonymous = await app.request("/api/dashboard/terminal/ws", {
      headers: { upgrade: "websocket", origin: "https://proxy.example.com" },
    });
    expect(anonymous.status).toBe(401);

    const bearer = await app.request("/api/dashboard/terminal/ws", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer secret",
        origin: "https://proxy.example.com",
      },
    });
    expect(bearer.status).toBe(401);
    await expect(bearer.json()).resolves.toEqual(await anonymous.json());
  });

  it("rejects a missing or foreign origin and allows the app and dev origins", async () => {
    sessions.getSession.mockResolvedValue(browserSession());
    const app = middlewareApp();
    const headers = { upgrade: "websocket", cookie: "session=ok" };
    expect((await app.request("/api/dashboard/terminal/ws", { headers })).status).toBe(403);
    expect(
      (
        await app.request("/api/dashboard/terminal/ws", {
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/dashboard/terminal/ws", {
          headers: { ...headers, origin: "https://proxy.example.com" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/dashboard/terminal/ws", {
          headers: { ...headers, origin: "http://localhost:3001" },
        })
      ).status,
    ).toBe(200);
  });

  it("returns the limiter response instead of continuing the upgrade", async () => {
    limiterState.fail = true;
    sessions.getSession.mockResolvedValue(browserSession());
    let continued = false;
    const app = new Hono();
    app.use("/api/dashboard/terminal/ws", createTerminalWebsocketMiddleware());
    app.get("/api/dashboard/terminal/ws", (c) => {
      continued = true;
      return c.text("upgraded");
    });
    const response = await app.request("/api/dashboard/terminal/ws", {
      headers: { upgrade: "websocket", cookie: "session=ok", origin: "https://proxy.example.com" },
    });
    expect(response.status).toBe(429);
    expect(continued).toBe(false);
  });
});

describe("terminal browser hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.user.findUnique.mockResolvedValue({ slug: "owner" });
    db.cliDevice.upsert.mockImplementation(async (args: { create: { slug: string } }) => ({
      id: args.create.slug,
      userId: "user-id",
      slug: args.create.slug,
      allowHumanTerminal: true,
      allowMcpCommands: false,
      inventorySeq: 0,
      inventoryDigest: null,
      inventoryAcknowledgedAt: null,
    }));
    db.cliDevice.update.mockResolvedValue({
      inventorySeq: 1,
      inventoryDigest: "digest",
      inventoryAcknowledgedAt: now,
      id: "one",
    });
    db.cliDevice.findFirst.mockImplementation(
      async (args: { where: { id?: string; userId?: string } }) => {
        const id = args.where.id;
        if (!id || id === "missing" || id === "foreign") return null;
        if (args.where.userId && args.where.userId !== "user-id") return null;
        if (id === "foreign") return device("foreign", { label: "Foreign secret" });
        return device(id, id === "ungranted" ? { allowHumanTerminal: false } : {});
      },
    );
    db.cliDevice.findMany.mockResolvedValue([]);
    db.endpoint.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.session.findUnique.mockResolvedValue({
      userId: "user-id",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    terminalBrowserHub.closeAll();
    await relaySessionManager.closeRelaySessions();
  });

  function attachBrowser() {
    const browser = new FakeSocket();
    terminalBrowserHub.accept({ socket: browser, userId: "user-id", sessionId: "session-id" });
    return browser;
  }

  async function open(browser: FakeSocket, cliDeviceId: string) {
    await terminalBrowserHub.handleText(
      browser,
      JSON.stringify({
        type: "open",
        cliDeviceId,
        cols: 80,
        rows: 24,
        publicKey: uncompressedKey(),
        nonce: nonce(),
      }),
    );
  }

  it("returns the same not-found error for an unknown CLI and a foreign CLI", async () => {
    const browser = attachBrowser();
    await open(browser, "missing");
    await open(browser, "foreign");
    const errors = browser.jsonSends().filter((message) => message.type === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      type: "error",
      code: "not_found",
      message: "CLI device not found.",
    });
    expect(errors[1]).toMatchObject({
      type: "error",
      code: "not_found",
      message: "CLI device not found.",
    });
    expect(errors[0]?.terminalId).not.toBe(errors[1]?.terminalId);
    expect(typeof errors[0]?.terminalId).toBe("string");
    expect(JSON.stringify(errors)).not.toContain("Foreign");
  });

  it("refuses a CLI below 2.4, a missing grant, and a disabled feature without sending frames", async () => {
    const old = await connectCli("old", "2.1");
    const ungranted = await connectCli("ungranted");
    const disabled = await connectCli("disabled", "2.4", { humanTerminal: false });
    db.cliDevice.findFirst.mockImplementation(async (args: { where: { id?: string } }) => {
      if (args.where.id === "old")
        return device("old", {
          relayProtocolVersion: "2.1",
          reportedHumanTerminal: null,
          reportedTerminalSupported: null,
        });
      if (args.where.id === "ungranted") return device("ungranted", { allowHumanTerminal: false });
      if (args.where.id === "disabled") return device("disabled", { reportedHumanTerminal: false });
      return null;
    });
    const browser = attachBrowser();
    await open(browser, "old");
    await open(browser, "ungranted");
    await open(browser, "disabled");
    expect(
      browser
        .jsonSends()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["cli_too_old", "not_granted", "device_disabled"]);
    for (const socket of [old, ungranted, disabled]) {
      expect(socket.jsonSends().some((message) => String(message.type).startsWith("term."))).toBe(
        false,
      );
    }
  });

  it("enforces per-CLI and per-user terminal limits", async () => {
    const first = await connectCli("one");
    const second = await connectCli("two");
    const third = await connectCli("three");
    const browser = attachBrowser();
    await open(browser, "one");
    await open(browser, "one");
    await open(browser, "one");
    expect(browser.jsonSends().at(-1)).toMatchObject({ code: "limit" });
    expect(first.jsonSends().filter((message) => message.type === "term.open")).toHaveLength(2);

    await open(browser, "two");
    await open(browser, "two");
    await open(browser, "three");
    expect(browser.jsonSends().at(-1)).toMatchObject({ code: "limit" });
    expect(third.jsonSends().some((message) => message.type === "term.open")).toBe(false);
    expect(second.jsonSends().filter((message) => message.type === "term.open")).toHaveLength(2);
  });

  it("detaches on tab close and when the browser buffer exceeds 4 MiB without killing the terminal", async () => {
    const cli = await connectCli("one");
    const browser = attachBrowser();
    await open(browser, "one");
    const opened = cli.jsonSends().find((message) => message.type === "term.open");
    const terminalId = opened?.terminalId as string;
    await relaySessionManager.handleTextFrame(
      cli,
      JSON.stringify({ type: "term.opened", terminalId, cliNonce: nonce() }),
    );
    expect(browser.jsonSends().some((message) => message.type === "opened")).toBe(true);
    db.cliDevice.findMany.mockResolvedValue([device("one")]);
    await terminalBrowserHub.handleText(browser, JSON.stringify({ type: "list" }));
    const listed = browser.jsonSends().find((message) => message.type === "terminals");
    expect(listed?.clis).toEqual([
      expect.objectContaining({
        cliDeviceId: "one",
        available: true,
        publicKey: uncompressedKey(),
        reason: "ok",
      }),
    ]);
    expect(listed?.terminals).toEqual([
      expect.objectContaining({ terminalId, viewerAttached: true }),
    ]);

    browser.bufferedAmount = 4 * 1024 * 1024 + 1;
    await relaySessionManager.handleBinaryFrame(
      cli,
      encodeRelayBinaryFrame(
        { type: "term.sealed", terminalId, seq: 1 },
        new Uint8Array([1, 2, 3]),
      ),
    );
    expect(browser.jsonSends().at(-1)).toMatchObject({ type: "detached", terminalId });
    expect(browser.sends.some((send) => typeof send !== "string")).toBe(false);
    expect(cli.jsonSends().some((message) => message.type === "term.detach")).toBe(true);
    expect(cli.jsonSends().some((message) => message.type === "term.close")).toBe(false);
    expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
      expect.objectContaining({ terminalId, viewerAttached: false }),
    ]);

    const reattached = new FakeSocket();
    terminalBrowserHub.accept({ socket: reattached, userId: "user-id", sessionId: "session-id" });
    await terminalBrowserHub.handleText(
      reattached,
      JSON.stringify({
        type: "attach",
        terminalId,
        publicKey: uncompressedKey(),
        nonce: nonce(),
      }),
    );
    expect(cli.jsonSends().some((message) => message.type === "term.attach")).toBe(true);
    terminalBrowserHub.handleClose(reattached);
    expect(cli.jsonSends().filter((message) => message.type === "term.close")).toHaveLength(0);
    expect(relaySessionManager.listTerminalsForUser("user-id")).toHaveLength(1);
  });

  it("rate-limits browser sealed frames per terminal tab", async () => {
    const cli = await connectCli("one");
    const browser = attachBrowser();
    await open(browser, "one");
    await open(browser, "one");
    const terminalIds = cli
      .jsonSends()
      .filter((message) => message.type === "term.open")
      .map((message) => message.terminalId as string);
    expect(terminalIds).toHaveLength(2);
    for (const terminalId of terminalIds) {
      await relaySessionManager.handleTextFrame(
        cli,
        JSON.stringify({ type: "term.opened", terminalId, cliNonce: nonce() }),
      );
    }
    const [first, second] = terminalIds as [string, string];
    const sealed = (terminalId: string, seq: number) =>
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq }, new Uint8Array([seq % 256]));
    const binarySends = () => cli.sends.filter((send) => typeof send !== "string").length;

    const dropped = () =>
      browser
        .jsonSends()
        .filter((message) => message.type === "error" && message.code === "input_dropped");
    for (let seq = 1; seq <= 305; seq += 1) {
      terminalBrowserHub.handleBinary(browser, sealed(first, seq));
    }
    expect(binarySends()).toBe(300);
    expect(dropped()).toEqual([expect.objectContaining({ terminalId: first })]);

    terminalBrowserHub.handleBinary(browser, sealed(second, 1));
    expect(binarySends()).toBe(301);
  });

  it("closes with 4401 when the browser session is gone or expired", async () => {
    const browser = attachBrowser();
    db.session.findUnique.mockResolvedValueOnce(null);
    await terminalBrowserHub.recheckSessions(Date.now());
    expect(browser.closes).toEqual([{ code: 4401, reason: "session_expired" }]);

    const expired = attachBrowser();
    db.session.findUnique.mockResolvedValueOnce({
      userId: "user-id",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await terminalBrowserHub.recheckSessions(Date.now());
    expect(expired.closes).toEqual([{ code: 4401, reason: "session_expired" }]);
  });

  it("reports offline for a disconnected CLI and not-found for a foreign terminal id", async () => {
    const browser = attachBrowser();
    await open(browser, "one");
    const offline = browser.jsonSends().filter((message) => message.type === "error");
    expect(offline.at(-1)).toMatchObject({ code: "offline" });
    expect(offline.at(-1)?.terminalId).toEqual(expect.any(String));

    const cli = await connectCli("one");
    const owner = attachBrowser();
    await open(owner, "one");
    const terminalId = cli.jsonSends().find((message) => message.type === "term.open")
      ?.terminalId as string;
    const stranger = new FakeSocket();
    terminalBrowserHub.accept({
      socket: stranger,
      userId: "other-user",
      sessionId: "session-id",
    });
    await terminalBrowserHub.handleText(
      stranger,
      JSON.stringify({
        type: "close",
        terminalId,
      }),
    );
    expect(stranger.jsonSends().at(-1)).toMatchObject({ type: "error", code: "not_found" });
    expect(JSON.stringify(stranger.jsonSends())).not.toContain("Desktop");
    expect(cli.jsonSends().some((message) => message.type === "term.close")).toBe(false);
  });

  it("clears the viewer on an opening terminal when the browser socket closes", async () => {
    const cli = await connectCli("one");
    const browser = attachBrowser();
    await open(browser, "one");
    expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
      expect.objectContaining({ viewerAttached: true }),
    ]);
    terminalBrowserHub.handleClose(browser);
    expect(cli.jsonSends().some((message) => message.type === "term.detach")).toBe(true);
    expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
      expect.objectContaining({ viewerAttached: false }),
    ]);
  });

  it("catches a throwing list without rejecting the socket handler", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.cliDevice.findMany.mockRejectedValue(new Error("SECRET_DB_MESSAGE"));
    const browser = attachBrowser();
    settleSocketHandler("browser text", terminalBrowserHub.handleText(browser, '{"type":"list"}'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SECRET_DB_MESSAGE");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("Error");
    errorSpy.mockRestore();
  });
});

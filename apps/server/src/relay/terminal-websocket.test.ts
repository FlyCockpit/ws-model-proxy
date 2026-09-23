import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { Hono } from "hono";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
} from "./protocol.js";

const limiterState = vi.hoisted(() => ({ fail: false }));
const twoFactorPolicy = vi.hoisted(() => ({ required: vi.fn(async () => false) }));
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

vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: twoFactorPolicy.required,
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

type CliFeatures = {
  humanTerminal?: boolean;
  terminalSupported?: boolean;
  terminalApproval?: boolean;
};

function hello(slug: string, protocol: "2.5" | "2.4" | "2.1", features?: CliFeatures) {
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
    protocolVersion: protocol,
    cli: {
      slug,
      label: slug,
      version: "9.9.9",
      capabilities: {
        protocolVersion: protocol,
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
          terminalApproval: features?.terminalApproval ?? false,
          terminalSupported: features?.terminalSupported ?? true,
        },
        terminalPublicKey: uncompressedKey(),
        ...(protocol === "2.5" ? { terminalViewers: true, terminalIdentity: cliIdentity() } : {}),
      },
    },
    endpoints: [],
  });
}

/** Opaque to the relay: it stores and lists these without verifying them. */
function cliIdentity() {
  const publicKey = Buffer.alloc(65, 3);
  publicKey[0] = 0x04;
  return {
    publicKey: publicKey.toString("base64url"),
    signature: Buffer.alloc(64, 7).toString("base64url"),
  };
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

function browserSession(cookieUser = "user-id", twoFactorEnabled = false) {
  return {
    user: { id: cookieUser, twoFactorEnabled },
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
  protocol: "2.5" | "2.4" | "2.1" = "2.4",
  features?: CliFeatures,
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
    twoFactorPolicy.required.mockReset();
    twoFactorPolicy.required.mockResolvedValue(false);
  });

  it("rejects an unenrolled user before upgrade when two-factor is mandatory", async () => {
    twoFactorPolicy.required.mockResolvedValue(true);
    sessions.getSession.mockResolvedValue(browserSession("user-id", false));
    let continued = false;
    const app = new Hono();
    app.use("/api/dashboard/terminal/ws", createTerminalWebsocketMiddleware());
    app.get("/api/dashboard/terminal/ws", (c) => {
      continued = true;
      return c.text("upgraded");
    });
    const headers = {
      upgrade: "websocket",
      cookie: "session=ok",
      origin: "https://proxy.example.com",
    };
    const rejected = await app.request("/api/dashboard/terminal/ws", { headers });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({
      error: "Two-factor authentication setup is required.",
    });
    expect(continued).toBe(false);

    sessions.getSession.mockResolvedValue(browserSession("user-id", true));
    expect((await app.request("/api/dashboard/terminal/ws", { headers })).status).toBe(200);
    expect(continued).toBe(true);
  });

  it("admits an unenrolled user when two-factor is not mandatory", async () => {
    sessions.getSession.mockResolvedValue(browserSession("user-id", false));
    const response = await middlewareApp().request("/api/dashboard/terminal/ws", {
      headers: { upgrade: "websocket", cookie: "session=ok", origin: "https://proxy.example.com" },
    });
    expect(response.status).toBe(200);
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
      user: { twoFactorEnabled: false },
    });
    twoFactorPolicy.required.mockReset();
    twoFactorPolicy.required.mockResolvedValue(false);
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

  it("closes an unenrolled viewer on recheck once two-factor becomes mandatory", async () => {
    const cli = await connectCli("one");
    const browser = attachBrowser();
    await open(browser, "one");
    expect(cli.jsonSends().some((message) => message.type === "term.open")).toBe(true);

    await terminalBrowserHub.recheckSessions(now.getTime());
    expect(browser.closes).toEqual([]);

    twoFactorPolicy.required.mockResolvedValue(true);
    await terminalBrowserHub.recheckSessions(now.getTime());
    expect(browser.closes).toEqual([{ code: 4401, reason: "two_factor_required" }]);
    expect(cli.jsonSends().some((message) => message.type === "term.detach")).toBe(true);
    expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
      expect.objectContaining({ viewerAttached: false }),
    ]);
  });

  it("keeps an enrolled viewer when two-factor is mandatory", async () => {
    twoFactorPolicy.required.mockResolvedValue(true);
    db.session.findUnique.mockResolvedValue({
      userId: "user-id",
      expiresAt: new Date("2026-02-01T00:00:00.000Z"),
      user: { twoFactorEnabled: true },
    });
    const browser = attachBrowser();
    await terminalBrowserHub.recheckSessions(now.getTime());
    expect(browser.closes).toEqual([]);
  });

  it("does not start a terminal when the browser leaves during the device lookup", async () => {
    const cli = await connectCli("one");
    const browser = attachBrowser();
    let releaseLookup: (() => void) | undefined;
    const lookupStarted = new Promise<void>((started) => {
      db.cliDevice.findFirst.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseLookup = () => resolve(device("one"));
            started();
          }),
      );
    });
    const pending = open(browser, "one");
    await lookupStarted;
    browser.readyState = 3;
    terminalBrowserHub.handleClose(browser);
    releaseLookup?.();
    await pending;

    expect(cli.jsonSends().some((message) => message.type === "term.open")).toBe(false);
    expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([]);
    expect(relaySessionManager.terminalCounts("user-id", "one")).toMatchObject({ user: 0, cli: 0 });
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

  describe("protocol 2.5 viewers", () => {
    type Json = Record<string, unknown>;

    function binaryFrames(socket: FakeSocket) {
      return socket.sends
        .filter((send): send is ArrayBuffer => typeof send !== "string")
        .map((send) => parseRelayBinaryFrame(send).metadata);
    }

    async function send(browser: FakeSocket, message: Json) {
      await terminalBrowserHub.handleText(browser, JSON.stringify(message));
    }

    async function cliSays(cli: FakeSocket, message: Json) {
      await relaySessionManager.handleTextFrame(cli, JSON.stringify(message));
    }

    /** Browser A opens on a 2.5 CLI; the CLI spawns. */
    async function openShared(features?: CliFeatures) {
      const cli = await connectCli("one", "2.5", features);
      const a = attachBrowser();
      await open(a, "one");
      const opening = a.jsonSends().find((message) => message.type === "opening");
      const termOpen = cli.jsonSends().find((message) => message.type === "term.open");
      const terminalId = termOpen?.terminalId as string;
      expect(opening).toEqual({ type: "opening", terminalId, viewerId: termOpen?.viewerId });
      const aViewer = termOpen?.viewerId as string;
      await cliSays(cli, { type: "term.opened", terminalId, viewerId: aViewer, cliNonce: nonce() });
      return { cli, a, terminalId, aViewer };
    }

    async function join(cli: FakeSocket, terminalId: string, approve = true) {
      const browser = attachBrowser();
      await send(browser, {
        type: "attach",
        terminalId,
        publicKey: uncompressedKey(),
        nonce: nonce(),
      });
      const attaching = browser.jsonSends().find((message) => message.type === "attaching");
      const termAttach = cli.jsonSends().at(-1);
      expect(termAttach).toMatchObject({ type: "term.attach", terminalId });
      expect(attaching).toEqual({ type: "attaching", terminalId, viewerId: termAttach?.viewerId });
      const viewerId = termAttach?.viewerId as string;
      if (approve) {
        await cliSays(cli, { type: "term.attached", terminalId, viewerId, cliNonce: nonce() });
      }
      return { browser, viewerId };
    }

    it("lets two tabs view one terminal, with unicast and broadcast routing", async () => {
      const { cli, a, terminalId, aViewer } = await openShared();
      const { browser: b, viewerId: bViewer } = await join(cli, terminalId);
      expect(bViewer).not.toBe(aViewer);
      expect([...a.jsonSends(), ...b.jsonSends()].some((m) => m.type === "detached")).toBe(false);
      expect(a.jsonSends().at(-1)).toEqual({
        type: "viewers",
        terminalId,
        count: 2,
        writer: "you",
      });
      expect(b.jsonSends().at(-2)).toMatchObject({ type: "attached", terminalId });
      expect(b.jsonSends().at(-1)).toEqual({
        type: "viewers",
        terminalId,
        count: 2,
        writer: "other",
      });

      const body = new Uint8Array([4, 5]);
      relaySessionManager.handleBinaryFrame(
        cli,
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId, seq: 1, viewerId: bViewer },
          body,
        ),
      );
      relaySessionManager.handleBinaryFrame(
        cli,
        encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 7, epoch: 2 }, body),
      );
      relaySessionManager.handleBinaryFrame(
        cli,
        encodeRelayBinaryFrame(
          {
            type: "term.sealed",
            terminalId,
            seq: 8,
            viewerId: Buffer.alloc(16, 1).toString("base64url"),
          },
          body,
        ),
      );
      expect(binaryFrames(a)).toEqual([{ type: "term.sealed", terminalId, seq: 7, epoch: 2 }]);
      expect(binaryFrames(b)).toEqual([
        { type: "term.sealed", terminalId, seq: 1 },
        { type: "term.sealed", terminalId, seq: 7, epoch: 2 },
      ]);

      db.cliDevice.findMany.mockResolvedValue([device("one")]);
      await send(b, { type: "list" });
      const listed = b.jsonSends().find((message) => message.type === "terminals");
      expect(listed?.clis).toEqual([
        expect.objectContaining({
          terminalViewers: true,
          slug: "one",
          publicKey: uncompressedKey(),
          identityPublicKey: cliIdentity().publicKey,
          identitySignature: cliIdentity().signature,
        }),
      ]);
      expect(listed?.terminals).toEqual([
        expect.objectContaining({
          terminalId,
          viewerAttached: true,
          viewerCount: 2,
          attachedHere: true,
          writerHere: false,
        }),
      ]);
    });

    it("stamps the viewer id on input and refuses a browser-supplied viewer id", async () => {
      const { cli, terminalId } = await openShared();
      const { browser: b, viewerId: bViewer } = await join(cli, terminalId);
      terminalBrowserHub.handleBinary(
        b,
        encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq: 1 }, new Uint8Array([1])),
      );
      expect(binaryFrames(cli)).toEqual([
        { type: "term.sealed", terminalId, seq: 1, viewerId: bViewer },
      ]);
      terminalBrowserHub.handleBinary(
        b,
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId, seq: 2, viewerId: bViewer },
          new Uint8Array([1]),
        ),
      );
      terminalBrowserHub.handleBinary(
        b,
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId, seq: 3, epoch: 1 },
          new Uint8Array([1]),
        ),
      );
      expect(binaryFrames(cli)).toHaveLength(1);
      expect(b.jsonSends().filter((message) => message.code === "invalid")).toHaveLength(2);
    });

    it("reports CLI input drops to that viewer only and keeps the terminal", async () => {
      const { cli, a, terminalId } = await openShared();
      const { browser: b, viewerId: bViewer } = await join(cli, terminalId);
      await cliSays(cli, { type: "term.input_dropped", terminalId, viewerId: bViewer });
      await cliSays(cli, {
        type: "term.input_dropped",
        terminalId,
        viewerId: Buffer.alloc(16, 1).toString("base64url"),
      });
      const dropped = (socket: typeof a) =>
        socket.jsonSends().filter((message) => message.code === "input_dropped");
      expect(dropped(b)).toEqual([expect.objectContaining({ type: "error", terminalId })]);
      expect(dropped(a)).toEqual([]);
      expect(cli.jsonSends().some((message) => message.type === "term.close")).toBe(false);
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
        expect.objectContaining({ terminalId, viewerCount: 2 }),
      ]);
    });

    it("detaches one tab on X, reports it, and forwards writer changes", async () => {
      const { cli, a, terminalId, aViewer } = await openShared();
      const { browser: b, viewerId: bViewer } = await join(cli, terminalId);
      await cliSays(cli, { type: "term.writer", terminalId, viewerId: bViewer });
      expect(a.jsonSends().at(-1)).toEqual({
        type: "viewers",
        terminalId,
        count: 2,
        writer: "other",
      });
      expect(b.jsonSends().at(-1)).toEqual({
        type: "viewers",
        terminalId,
        count: 2,
        writer: "you",
      });

      await send(b, { type: "detach", terminalId });
      expect(b.jsonSends().at(-1)).toEqual({ type: "detached", terminalId, reason: "self" });
      expect(cli.jsonSends().at(-1)).toEqual({
        type: "term.detach",
        terminalId,
        viewerId: bViewer,
      });
      expect(a.jsonSends().at(-1)).toEqual({
        type: "viewers",
        terminalId,
        count: 1,
        writer: "none",
      });
      expect(cli.jsonSends().some((message) => message.type === "term.close")).toBe(false);

      await send(b, { type: "detach", terminalId });
      expect(b.jsonSends().at(-1)).toMatchObject({ type: "error", code: "not_found" });

      // Closing the last tab leaves the shell running for a later attach.
      terminalBrowserHub.handleClose(a);
      expect(cli.jsonSends().at(-1)).toEqual({
        type: "term.detach",
        terminalId,
        viewerId: aViewer,
      });
      expect(relaySessionManager.listTerminalsForUser("user-id")).toEqual([
        expect.objectContaining({ terminalId, viewerCount: 0, viewerAttached: false }),
      ]);
    });

    it("detaches only the slow tab when its buffer passes 4 MiB", async () => {
      const { cli, a, terminalId, aViewer } = await openShared();
      const { browser: b } = await join(cli, terminalId);
      a.bufferedAmount = 4 * 1024 * 1024 + 1;
      relaySessionManager.handleBinaryFrame(
        cli,
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId, seq: 1, epoch: 1 },
          new Uint8Array([1]),
        ),
      );
      expect(a.jsonSends().at(-1)).toEqual({ type: "detached", terminalId, reason: "slow" });
      expect(binaryFrames(a)).toEqual([]);
      expect(binaryFrames(b)).toEqual([{ type: "term.sealed", terminalId, seq: 1, epoch: 1 }]);
      expect(cli.jsonSends().at(-1)).toEqual({
        type: "term.detach",
        terminalId,
        viewerId: aViewer,
      });
      expect(b.jsonSends().at(-1)).toEqual({
        type: "viewers",
        terminalId,
        count: 1,
        writer: "none",
      });

      relaySessionManager.handleBinaryFrame(
        cli,
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId, seq: 2, epoch: 2 },
          new Uint8Array([1]),
        ),
      );
      expect(binaryFrames(b)).toHaveLength(2);
      expect(a.jsonSends().filter((message) => message.type === "detached")).toHaveLength(1);
    });

    it("approves tabs independently and sends exit to every viewer", async () => {
      const { cli, a, terminalId } = await openShared({ terminalApproval: true });
      const { browser: b, viewerId: bViewer } = await join(cli, terminalId, false);
      const { browser: c, viewerId: cViewer } = await join(cli, terminalId, false);
      await cliSays(cli, {
        type: "term.pending",
        terminalId,
        viewerId: bViewer,
        cliNonce: nonce(),
        approvalCode: "ABCDEFGH",
      });
      await cliSays(cli, {
        type: "term.pending",
        terminalId,
        viewerId: cViewer,
        cliNonce: nonce(),
      });
      expect(b.jsonSends().filter((message) => message.type === "pending")).toEqual([
        expect.objectContaining({ approvalCode: "ABCDEFGH" }),
      ]);
      expect(c.jsonSends().filter((message) => message.type === "pending")).toHaveLength(1);
      expect(a.jsonSends().some((message) => message.type === "pending")).toBe(false);

      await send(c, { type: "auth", terminalId, signature: "c2lnbmF0dXJl" });
      expect(cli.jsonSends().at(-1)).toEqual({
        type: "term.auth",
        terminalId,
        viewerId: cViewer,
        signature: "c2lnbmF0dXJl",
      });
      await cliSays(cli, {
        type: "term.attached",
        terminalId,
        viewerId: cViewer,
        cliNonce: nonce(),
      });
      await cliSays(cli, {
        type: "term.rejected",
        terminalId,
        viewerId: bViewer,
        reason: "denied",
      });
      expect(b.jsonSends().at(-1)).toEqual({ type: "rejected", terminalId, reason: "denied" });
      expect(c.jsonSends().some((message) => message.type === "rejected")).toBe(false);
      expect(a.jsonSends().some((message) => message.type === "rejected")).toBe(false);

      await cliSays(cli, { type: "term.exit", terminalId, exitCode: 0 });
      expect(a.jsonSends().at(-1)).toEqual({ type: "exit", terminalId, exitCode: 0 });
      expect(c.jsonSends().at(-1)).toEqual({ type: "exit", terminalId, exitCode: 0 });
      expect(b.jsonSends().some((message) => message.type === "exit")).toBe(false);
    });

    it("refuses a ninth viewer with limit", async () => {
      const { cli, terminalId } = await openShared({ terminalApproval: true });
      for (let index = 0; index < 7; index += 1) await join(cli, terminalId, false);
      const ninth = attachBrowser();
      await send(ninth, {
        type: "attach",
        terminalId,
        publicKey: uncompressedKey(),
        nonce: nonce(),
      });
      expect(ninth.jsonSends().at(-1)).toMatchObject({ type: "error", code: "limit", terminalId });
      expect(cli.jsonSends().filter((message) => message.type === "term.attach")).toHaveLength(7);
    });

    it("caps input per terminal across every tab", async () => {
      const { cli, a, terminalId } = await openShared();
      const { browser: b } = await join(cli, terminalId);
      const { browser: c } = await join(cli, terminalId);
      let seq = 0;
      for (const browser of [a, b, c]) {
        for (let index = 0; index < 250; index += 1) {
          seq += 1;
          terminalBrowserHub.handleBinary(
            browser,
            encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq }, new Uint8Array([1])),
          );
        }
      }
      expect(binaryFrames(cli)).toHaveLength(600);
      expect(a.jsonSends().some((message) => message.code === "input_dropped")).toBe(false);
      expect(c.jsonSends().filter((message) => message.code === "input_dropped")).toHaveLength(1);
    });
  });

  it("keeps the 2.4 steal: a second tab takes the terminal and the first hears detached", async () => {
    const cli = await connectCli("one");
    const a = attachBrowser();
    await open(a, "one");
    const termOpen = cli.jsonSends().find((message) => message.type === "term.open");
    expect(termOpen).not.toHaveProperty("viewerId");
    const terminalId = termOpen?.terminalId as string;
    await relaySessionManager.handleTextFrame(
      cli,
      JSON.stringify({ type: "term.opened", terminalId, cliNonce: nonce() }),
    );
    const b = attachBrowser();
    await terminalBrowserHub.handleText(
      b,
      JSON.stringify({ type: "attach", terminalId, publicKey: uncompressedKey(), nonce: nonce() }),
    );
    expect(a.jsonSends().at(-1)).toEqual({ type: "detached", terminalId });
    expect(cli.jsonSends().at(-1)).not.toHaveProperty("viewerId");
    expect(b.jsonSends().at(-1)).toMatchObject({ type: "attaching", terminalId });
    expect([...a.jsonSends(), ...b.jsonSends()].some((m) => m.type === "viewers")).toBe(false);
    db.cliDevice.findMany.mockResolvedValue([device("one")]);
    await terminalBrowserHub.handleText(b, JSON.stringify({ type: "list" }));
    const listed = b.jsonSends().find((message) => message.type === "terminals");
    expect(listed?.clis).toEqual([
      expect.objectContaining({
        terminalViewers: false,
        identityPublicKey: null,
        identitySignature: null,
      }),
    ]);
    expect(listed?.terminals).toEqual([
      expect.objectContaining({ viewerCount: 1, attachedHere: true, writerHere: true }),
    ]);
  });
});

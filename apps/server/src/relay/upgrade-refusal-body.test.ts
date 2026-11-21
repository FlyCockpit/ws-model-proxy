import { once } from "node:events";
import { connect } from "node:net";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { selectWebSocketSubprotocol } from "../websocket-subprotocols.js";
import { installUpgradeRefusalBodies, retainUpgradeRefusalBody } from "./upgrade-refusal-body.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    WMP_RATE_LIMIT_SCALE: 1,
    TRUST_PROXY_HOPS: 0,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("./node-credential-auth.js", () => ({ authenticateNodeCredential: vi.fn() }));
vi.mock("./registration.js", () => ({
  recordRejectedNodeHello: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./session-manager.js", () => ({
  relaySessionManager: {
    isDraining: vi.fn(() => false),
    acceptAuthenticatedSocket: vi.fn(() => true),
    removeSession: vi.fn().mockResolvedValue(undefined),
  },
}));

const { relayUpgradeIpLimiter, relayUpgradeNodeLimiter } = await import("../rate-limit.js");
const { SERVER_VERSION } = await import("../version.js");
const { authenticateNodeCredential } = await import("./node-credential-auth.js");
const { relaySessionManager } = await import("./session-manager.js");
const { createRelayWebsocketMiddleware, relayUpgradeHandler } = await import("./websocket.js");

const identity = {
  credentialId: "test-credential",
  nodeId: "test-node",
  userId: "test-user",
  identityPublicKey: "test-key",
};

describe("Node WebSocket upgrade refusal bodies", () => {
  let server: ServerType;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(authenticateNodeCredential).mockResolvedValue(identity);
    await relayUpgradeIpLimiter.delete("ip:127.0.0.1");
    await relayUpgradeNodeLimiter.delete(`node:${identity.nodeId}`);

    const app = new Hono();
    app.use("/api/cli/ws", createRelayWebsocketMiddleware());
    app.get("/api/cli/ws", relayUpgradeHandler());
    app.get("/unretained", (c) => c.json({ error: "Not retained." }, 426));
    app.get("/unicode", (c) =>
      retainUpgradeRefusalBody(c.env, c.json({ error: "Upgrade requis — 更新" }, 400)),
    );
    wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols, request) => selectWebSocketSubprotocol(protocols, request.url),
    });
    server = createAdaptorServer({ fetch: app.fetch, websocket: { server: wss } });
    installUpgradeRefusalBodies(server);
    expect(server.listenerCount("upgrade")).toBe(1);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    port = address.port;
  });

  afterEach(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wss.close();
  });

  function rawUpgrade(protocol: string, path = "/api/cli/ws"): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(2000, () => socket.destroy(new Error("Upgrade response timed out")));
      socket.on("error", reject);
      socket.on("close", () => resolve(chunks));
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        // A successful WebSocket stays open; its HTTP handshake is all we need.
        const response = Buffer.concat(chunks).toString("utf8");
        if (response.startsWith("HTTP/1.1 101 ") && response.includes("\r\n\r\n")) {
          socket.destroy();
        }
      });
      socket.once("connect", () => {
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Sec-WebSocket-Protocol: ${protocol}`,
            "Authorization: Bearer test-node-secret",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });
  }

  it("delivers the complete v3 refusal JSON with the first header chunk", async () => {
    const chunks = await rawUpgrade("ws-model-proxy.relay.v3");
    const response = Buffer.concat(chunks).toString("utf8");
    const boundary = response.indexOf("\r\n\r\n");
    const headers = response.slice(0, boundary);
    const body = response.slice(boundary + 4);
    expect(headers).toMatch(/^HTTP\/1\.1 426 /);
    expect(headers).toContain(`\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`);
    expect(JSON.parse(body)).toMatchObject({
      type: "protocol.error",
      failure: "protocol_error",
      code: "upgrade_cli",
      supportedSubprotocol: "ws-model-proxy.relay.v4",
      supportedVersions: ["4.0"],
      serverVersion: SERVER_VERSION,
      minimumCliVersion: "1.0.0",
    });
    expect(chunks[0]?.toString("utf8")).toBe(response);
  });

  it("keeps node-server's empty rejection when no body was retained", async () => {
    const response = Buffer.concat(
      await rawUpgrade("ws-model-proxy.relay.v3", "/unretained"),
    ).toString("utf8");
    expect(response).toMatch(/^HTTP\/1\.1 426 /);
    expect(response).toContain("\r\nContent-Length: 0\r\n");
    expect(response.split("\r\n\r\n")[1]).toBe("");
  });

  it("uses UTF-8 byte length for the exact retained JSON", async () => {
    const response = Buffer.concat(
      await rawUpgrade("ws-model-proxy.relay.v4", "/unicode"),
    ).toString("utf8");
    const body = response.split("\r\n\r\n")[1];
    expect(body).toBe(JSON.stringify({ error: "Upgrade requis — 更新" }));
    expect(response).toContain(`\r\nContent-Length: ${Buffer.byteLength(body ?? "")}\r\n`);
  });

  it("isolates bodies between concurrent upgrade requests", async () => {
    const [relay, unicode, unretained] = await Promise.all([
      rawUpgrade("ws-model-proxy.relay.v3"),
      rawUpgrade("ws-model-proxy.relay.v4", "/unicode"),
      rawUpgrade("ws-model-proxy.relay.v3", "/unretained"),
    ]);
    const body = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8").split("\r\n\r\n")[1];
    expect(JSON.parse(body(relay) ?? "")).toMatchObject({ code: "upgrade_cli" });
    expect(body(unicode)).toBe(JSON.stringify({ error: "Upgrade requis — 更新" }));
    expect(body(unretained)).toBe("");
  });

  it("leaves an authenticated v4 WebSocket handshake intact", async () => {
    const response = Buffer.concat(await rawUpgrade("ws-model-proxy.relay.v4")).toString("utf8");
    expect(response).toMatch(/^HTTP\/1\.1 101 Switching Protocols\r\n/);
    expect(response).toContain("\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n");
    expect(response).toContain("\r\nSec-WebSocket-Protocol: ws-model-proxy.relay.v4\r\n");
    expect(response.toLowerCase()).not.toContain("content-length:");
    expect(relaySessionManager.acceptAuthenticatedSocket).toHaveBeenCalledWith({
      identity,
      socket: expect.objectContaining({ send: expect.any(Function), close: expect.any(Function) }),
    });
  });
});

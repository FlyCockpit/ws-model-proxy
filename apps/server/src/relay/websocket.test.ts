import type { WebSocketLike } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_PROTOCOL_VERSIONS, RELAY_SUBPROTOCOL } from "./protocol.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    WMP_RATE_LIMIT_SCALE: 1,
    TRUST_PROXY_HOPS: 0,
  },
}));

vi.mock("./node-credential-auth.js", () => ({
  authenticateNodeCredential: vi.fn(),
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("../client-ip.js", () => ({
  resolveClientIp: (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header("x-test-ip") ?? "203.0.113.1",
}));

vi.mock("./registration.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./registration.js")>();
  return { ...original, recordRejectedNodeHello: vi.fn(original.recordRejectedNodeHello) };
});

const prisma = (await import("@ws-model-proxy/db")).default;
const { mockDeep } = await import("vitest-mock-extended");
const db = prisma as unknown as ReturnType<typeof mockDeep<typeof prisma>>;
const { recordRejectedNodeHello } = await import("./registration.js");
const { registerNodeHttpRoutes } = await import("../node-http.js");
const { SERVER_VERSION } = await import("../version.js");
const { authenticateNodeCredential } = await import("./node-credential-auth.js");
const { createRelayWebsocketMiddleware, relaySocketEvents } = await import("./websocket.js");
const { relaySessionManager } = await import("./session-manager.js");
const { authLimiter, DEFAULTS, relayUpgradeIpLimiter, relayUpgradeNodeLimiter } = await import(
  "../rate-limit.js"
);
const { WSContext } = await import("hono/ws");

const authenticateMock = vi.mocked(authenticateNodeCredential);

function app() {
  const hono = new Hono();
  hono.use("/api/cli/ws", createRelayWebsocketMiddleware());
  hono.get("/api/cli/ws", (c) => c.text("ok"));
  return hono;
}

async function resetLimiters() {
  for (const ip of ["203.0.113.1", "203.0.113.2"]) {
    await relayUpgradeIpLimiter.delete(`ip:${ip}`);
    await authLimiter.delete(ip);
  }
  for (const node of ["node-id", "node-a", "node-b"]) {
    await relayUpgradeNodeLimiter.delete(`node:${node}`);
  }
}

function identityFor(nodeId: string) {
  return { credentialId: `cred-${nodeId}`, userId: "user-id", nodeId, identityPublicKey: "key" };
}

function websocketHeaders(extra: Record<string, string> = {}) {
  return {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": RELAY_SUBPROTOCOL,
    ...extra,
  };
}

describe("createRelayWebsocketMiddleware", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetLimiters();
  });

  it("rejects unauthenticated websocket upgrades", async () => {
    const response = await app().request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Node credential required.",
    });
  });

  it("records an authenticated v3 refusal without charging the IP", async () => {
    const token = "ws-model-proxy.relay.v3";
    const protocolVersion = "3.0";
    authenticateMock.mockResolvedValue(identityFor("node-id"));
    const response = await app().request("/api/cli/ws", {
      headers: websocketHeaders({
        Authorization: "Bearer wsmp_node_secret",
        "Sec-WebSocket-Protocol": token,
      }),
    });
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({
      type: "protocol.error",
      failure: "protocol_error",
      code: "upgrade_cli",
      message:
        "This server runs WS Model Proxy 1.0 and needs wsmp 1.0 or later. Upgrade wsmp (re-run the server's install.sh, or brew upgrade wsmp), then restart it.",
      supportedVersions: RELAY_PROTOCOL_VERSIONS,
      supportedSubprotocol: RELAY_SUBPROTOCOL,
      serverVersion: SERVER_VERSION,
      minimumCliVersion: "1.0.0",
    });
    expect(recordRejectedNodeHello).toHaveBeenCalledWith(
      identityFor("node-id"),
      { protocolVersion, cliVersion: null },
      expect.any(Date),
    );
    expect(await relayUpgradeIpLimiter.get("ip:203.0.113.1")).toBeNull();
    expect((await relayUpgradeNodeLimiter.get("node:node-id"))?.consumedPoints).toBe(1);
    const write = db.node.updateMany.mock.calls[0]?.[0];
    const rejectedAt = write?.data.rejectedAt;
    expect(rejectedAt).toBeInstanceOf(Date);
    if (!(rejectedAt instanceof Date)) throw new Error("missing refusal timestamp");
    expect(write?.where).toEqual({
      id: "node-id",
      userId: "user-id",
      OR: [{ rejectedAt: null }, { rejectedAt: { lt: new Date(rejectedAt.getTime() - 60_000) } }],
    });
  });

  it("uses the same per-node budget for v3 refusals and current upgrades", async () => {
    authenticateMock.mockResolvedValue(identityFor("node-id"));
    for (let attempt = 0; attempt < DEFAULTS.relayUpgradeNode.points; attempt += 1) {
      const response = await app().request("/api/cli/ws", {
        headers: websocketHeaders({
          Authorization: "Bearer wsmp_node_secret",
          "Sec-WebSocket-Protocol": "ws-model-proxy.relay.v3",
        }),
      });
      expect(response.status).toBe(426);
    }
    vi.mocked(recordRejectedNodeHello).mockClear();
    db.node.updateMany.mockClear();
    for (const token of ["ws-model-proxy.relay.v3", RELAY_SUBPROTOCOL]) {
      const response = await app().request("/api/cli/ws", {
        headers: websocketHeaders({
          Authorization: "Bearer wsmp_node_secret",
          "Sec-WebSocket-Protocol": token,
        }),
      });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(recordRejectedNodeHello).not.toHaveBeenCalled();
    expect(db.node.updateMany).not.toHaveBeenCalled();
    expect(await relayUpgradeIpLimiter.get("ip:203.0.113.1")).toBeNull();
  });

  it.each([undefined, "Bearer invalid"])(
    "charges an old-token refusal with missing or invalid credentials (%s)",
    async (authorization) => {
      authenticateMock.mockResolvedValue(null);
      const response = await app().request("/api/cli/ws", {
        headers: websocketHeaders({
          "Sec-WebSocket-Protocol": "ws-model-proxy.relay.v3",
          ...(authorization ? { Authorization: authorization } : {}),
        }),
      });
      expect(response.status).toBe(426);
      expect(recordRejectedNodeHello).not.toHaveBeenCalled();
      expect((await relayUpgradeIpLimiter.get("ip:203.0.113.1"))?.consumedPoints).toBe(1);
    },
  );

  it.each(["ws-model-proxy.relay.v1", "ws-model-proxy.relay.v2", "ws-model-proxy.relay.v99"])(
    "charges %s to the IP without inspecting credentials",
    async (token) => {
      authenticateMock.mockResolvedValue(identityFor("node-id"));
      const response = await app().request("/api/cli/ws", {
        headers: websocketHeaders({
          Authorization: "Bearer wsmp_node_secret",
          "Sec-WebSocket-Protocol": token,
        }),
      });
      expect(response.status).toBe(426);
      expect(authenticateMock).not.toHaveBeenCalled();
      expect(recordRejectedNodeHello).not.toHaveBeenCalled();
      expect((await relayUpgradeIpLimiter.get("ip:203.0.113.1"))?.consumedPoints).toBe(1);
    },
  );

  // Permanent bootstrap contract: released clients must understand a protocol refusal.
  it("keeps the released-client refusal predicate and five-field discovery contract", async () => {
    const response = await app().request("/api/cli/ws", {
      headers: websocketHeaders({ "Sec-WebSocket-Protocol": "ws-model-proxy.relay.v3" }),
    });
    expect(response.status).toBe(426);
    const text = await response.text();
    expect(new TextEncoder().encode(text).length).toBeLessThan(1024);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.code === "upgrade_cli" || "supportedSubprotocol" in body).toBe(true);
    const hono = new Hono();
    registerNodeHttpRoutes(hono);
    const discovery = (await (await hono.request("/.well-known/wsmp")).json()) as Record<
      string,
      unknown
    >;
    expect(discovery).toEqual({
      serverVersion: SERVER_VERSION,
      protocolVersion: "4.0",
      origin: "https://proxy.example.test",
      installScript: "/install.sh",
      enrollPath: "/api/node/enroll",
    });
    expect(String(discovery.protocolVersion) > "3.0").toBe(true);
    expect(Number(discovery.protocolVersion)).toBeGreaterThan(Number("3.0"));
  });

  it("blocks an address that keeps failing, with Retry-After, without checking credentials", async () => {
    authenticateMock.mockResolvedValue(null);
    for (let attempt = 0; attempt < DEFAULTS.relayUpgradeIp.points; attempt += 1) {
      const response = await app().request("/api/cli/ws", {
        method: "GET",
        headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
      });
      expect(response.status).toBe(401);
    }
    authenticateMock.mockClear();
    let continued = false;
    const hono = new Hono();
    hono.use("/api/cli/ws", createRelayWebsocketMiddleware());
    hono.get("/api/cli/ws", (c) => {
      continued = true;
      return c.text("ok");
    });

    const response = await hono.request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
    });

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(continued).toBe(false);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it("charges authenticated upgrades to the node, not the address, and never to sign-in", async () => {
    authenticateMock.mockResolvedValue(identityFor("node-a"));
    const upgrade = () =>
      app().request("/api/cli/ws", {
        method: "GET",
        headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
      });
    for (let attempt = 0; attempt < DEFAULTS.relayUpgradeNode.points; attempt += 1) {
      expect((await upgrade()).status).toBe(200);
    }

    // The storming node is now limited, with a Retry-After the CLI honours…
    const limited = await upgrade();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // …while another node behind the same address still connects…
    authenticateMock.mockResolvedValue(identityFor("node-b"));
    expect((await upgrade()).status).toBe(200);
    // …the address spent none of its failure budget…
    expect(await relayUpgradeIpLimiter.get("ip:203.0.113.1")).toBeNull();
    // …and the sign-in bucket for that address was never touched.
    expect(await authLimiter.get("203.0.113.1")).toBeNull();
  });

  it("lets many honest nodes behind one address connect at once", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let index = 0;
    authenticateMock.mockImplementation(async () => {
      const nodeId = `nat-${index++}`;
      await gate;
      return identityFor(nodeId);
    });
    const upgrades = Array.from({ length: 64 }, () =>
      app().request("/api/cli/ws", {
        method: "GET",
        headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
      }),
    );
    await vi.waitFor(() => expect(authenticateMock).toHaveBeenCalledTimes(64));
    finish();
    const statuses = (await Promise.all(upgrades)).map((response) => response.status);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(await relayUpgradeIpLimiter.get("ip:203.0.113.1")).toBeNull();
    for (let n = 0; n < 64; n += 1) await relayUpgradeNodeLimiter.delete(`node:nat-${n}`);
  });

  it("rejects revoked websocket credentials", async () => {
    authenticateMock.mockResolvedValue(null);

    const response = await app().request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid or revoked node credential.",
    });
  });
});

describe("relay upgrade during shutdown", () => {
  const identity: Parameters<typeof relaySocketEvents>[0] = {
    credentialId: "cred-id",
    userId: "user-id",
    nodeId: "node-id",
    identityPublicKey: "key",
  };

  function fakeWs() {
    const closes: Array<{ code?: number; reason?: string }> = [];
    const raw = {
      readyState: 1 as 0 | 1 | 2 | 3,
      send: () => undefined,
      close: (code?: number, reason?: string) => {
        closes.push({ code, reason });
      },
    };
    return { ws: new WSContext<WebSocketLike>(raw), closes };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetLimiters();
  });

  afterEach(() => {
    // Test hygiene only: production never clears the flag.
    Reflect.set(relaySessionManager, "lifecycle", "running");
  });

  const sessionCount = () =>
    (Reflect.get(relaySessionManager, "sessionsBySocket") as Map<unknown, unknown>).size;

  it("closes with the shutdown code and never registers a socket whose authentication finishes after the drain began", async () => {
    let finishAuth: (value: typeof identity) => void = () => {};
    authenticateMock.mockReturnValue(
      new Promise((resolve) => {
        finishAuth = resolve as typeof finishAuth;
      }),
    );
    const hono = new Hono();
    hono.use("/api/cli/ws", createRelayWebsocketMiddleware());
    let handlerIdentity: typeof identity | undefined;
    hono.get("/api/cli/ws", (c) => {
      handlerIdentity = (c as unknown as { get: (k: string) => typeof identity }).get(
        "relayIdentity",
      );
      return c.text("upgraded");
    });

    // The drain check passed; authentication is now in flight.
    const upgrade = hono.request("/api/cli/ws", {
      method: "GET",
      headers: websocketHeaders({ Authorization: "Bearer wsmp_node_secret" }),
    });
    await vi.waitFor(() => expect(authenticateMock).toHaveBeenCalledTimes(1));
    expect(relaySessionManager.isDraining()).toBe(false);
    relaySessionManager.beginDrain();
    finishAuth(identity);
    expect((await upgrade).status).toBe(200);
    expect(handlerIdentity).toBe(identity);

    // The upgrade completes: onOpen runs for the authenticated socket.
    const { ws, closes } = fakeWs();
    relaySocketEvents(handlerIdentity as typeof identity).onOpen?.(new Event("open"), ws);
    expect(closes).toEqual([{ code: 1001, reason: "shutdown" }]);
    expect(sessionCount()).toBe(0);
  });

  it("still registers a socket that opens before the drain", async () => {
    const { ws, closes } = fakeWs();
    relaySocketEvents(identity).onOpen?.(new Event("open"), ws);
    try {
      expect(closes).toEqual([]);
      expect(sessionCount()).toBe(1);
    } finally {
      relaySocketEvents(identity).onClose?.(new CloseEvent("close"), ws);
      await vi.waitFor(() => expect(sessionCount()).toBe(0));
    }
  });
});

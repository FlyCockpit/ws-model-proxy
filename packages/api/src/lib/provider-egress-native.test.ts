import { lookup as dnsLookup } from "node:dns";
import { once } from "node:events";
import {
  Agent as HttpAgent,
  get as httpGet,
  createServer as httpServer,
  type IncomingMessage,
} from "node:http";
import {
  globalAgent,
  Agent as HttpsAgent,
  get as httpsGet,
  createServer as httpsServer,
} from "node:https";
import { type LookupFunction, type Socket, createServer as tcpServer } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderEgressError,
  type ProviderRequestOptions,
  providerHttpsRequest,
} from "./provider-egress";
import { providerTlsFixture } from "./provider-egress-tls-fixture";

const tls = providerTlsFixture();
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const servers: Array<ReturnType<typeof httpServer> | ReturnType<typeof tcpServer>> = [];
const tcpSockets: Socket[] = [];
const agents: Array<HttpAgent | HttpsAgent> = [];
const auth = { type: "BEARER", token: "synthetic-egress-test" } as const;
const policy = { egressEnabled: true, allowPrivateNetworks: true, timeoutMs: 1_000 };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) agent.destroy();
  globalAgent.destroy();
  for (const socket of tcpSockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function body(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

async function fixture(secure: boolean, host = "127.0.0.1", matching = true) {
  const sockets: Socket[] = [];
  const requests: Array<{ authorization: string | undefined; path: string | undefined }> = [];
  const certificates = matching ? tls : providerTlsFixture(false);
  const listener = (request: IncomingMessage, response: import("node:http").ServerResponse) => {
    sockets.push(request.socket);
    requests.push({ authorization: request.headers.authorization, path: request.url });
    response.end("native-ok");
  };
  const server = secure ? httpsServer(certificates, listener) : httpServer(listener);
  servers.push(server);
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const prefix = secure ? "https" : "http";
  return {
    server,
    sockets,
    requests,
    ca: certificates.cert,
    port: address.port,
    url: `${prefix}://localhost:${address.port}/original`,
  };
}

describe("native owned provider connections", () => {
  it.each([false, true])(
    "cold production-default hostname works before native inverse: TLS=%s",
    async (secure) => {
      const target = await fixture(secure);
      const options = { method: "GET", ...(secure ? { ca: target.ca } : {}) };
      // Helper first: a native control must not warm a pool and hide DNS bugs.
      expect(
        await body(await providerHttpsRequest(target.url, options, policy, "openai", auth)),
      ).toBe("native-ok");
      expect(target.sockets).toHaveLength(1);
      expect(target.sockets[0]?.remoteAddress).toBe("127.0.0.1");
      expect(target.requests[0]?.path).toBe("/original");
      const get = secure ? httpsGet : httpGet;
      expect(
        await new Promise<string>((resolve, reject) => {
          get(target.url, { ...options, agent: false }, (response) => {
            void body(response).then(resolve, reject);
          }).on("error", reject);
        }),
      ).toBe("native-ok");
      expect(target.sockets).toHaveLength(2);
      expect(target.sockets[1]).not.toBe(target.sockets[0]);
    },
  );

  it.each([false, true])("scalar lookup remains valid: TLS=%s", async (secure) => {
    const target = await fixture(secure);
    expect(
      await body(
        await providerHttpsRequest(
          target.url,
          { method: "GET", ca: target.ca, family: 4, autoSelectFamily: false },
          policy,
          "openai",
          auth,
        ),
      ),
    ).toBe("native-ok");
    expect(target.sockets[0]?.remoteAddress).toBe("127.0.0.1");
  });

  it("foreign warmed global TLS socket cannot carry restrictive credentials", async () => {
    const target = await fixture(true);
    const options = { method: "GET", ca: target.ca, family: 4 };
    const restrictive = { ...policy, allowPrivateNetworks: false };
    await expect(
      providerHttpsRequest(target.url, options, restrictive, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(target.requests).toHaveLength(0);
    expect(
      await new Promise<string>((resolve, reject) => {
        httpsGet(target.url, { ca: target.ca, family: 4, rejectUnauthorized: true }, (response) => {
          void body(response).then(resolve, reject);
        }).on("error", reject);
      }),
    ).toBe("native-ok");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = Object.values(globalAgent.freeSockets).flat()[0];
    expect(socket).toBeDefined(); // Exact foreign pool really exists.
    expect(socket?.remoteAddress).toBe("127.0.0.1");
    const attempted = await providerHttpsRequest(
      target.url,
      options,
      restrictive,
      "openai",
      auth,
    ).then(
      async (response) => ({
        rejected: false,
        bytes: await body(response),
        leaked: target.requests[1]?.authorization !== undefined,
        reused: target.sockets[1] === target.sockets[0],
      }),
      (error: unknown) => ({
        rejected: error instanceof ProviderEgressError,
        bytes: undefined,
        leaked: false,
        reused: false,
      }),
    );
    expect(
      attempted,
      "restrictive policy must reject before credentials reach a foreign socket",
    ).toEqual({ rejected: true, bytes: undefined, leaked: false, reused: false });
    expect(target.requests).toEqual([{ authorization: undefined, path: "/original" }]);
    expect(Object.values(globalAgent.freeSockets).flat()[0]).toBe(socket);
    // Legitimate permissive operation owns a different connection.
    expect(
      await body(await providerHttpsRequest(target.url, options, policy, "openai", auth)),
    ).toBe("native-ok");
    expect(target.sockets[1]).not.toBe(target.sockets[0]);
    expect(target.requests[1]?.authorization).toBe("Bearer synthetic-egress-test");
    await expect(
      providerHttpsRequest(target.url, options, restrictive, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(target.requests).toHaveLength(2);
  });

  it.each([false, true])(
    "successive permissive exchanges cannot reuse sockets: TLS=%s",
    async (secure) => {
      const target = await fixture(secure);
      for (let index = 0; index < 3; index += 1) {
        expect(
          await body(
            await providerHttpsRequest(target.url, { ca: target.ca }, policy, "openai", auth),
          ),
        ).toBe("native-ok");
      }
      expect(new Set(target.sockets).size).toBe(3);
      await vi.waitFor(() => expect(target.sockets.every((socket) => socket.destroyed)).toBe(true));
    },
  );

  it.each([
    "agent",
    "createConnection",
    "socketPath",
    "lookup",
    "hostname",
    "host",
    "port",
    "protocol",
    "servername",
    "checkServerIdentity",
    "rejectUnauthorized",
    "_defaultAgent",
    "proxyEnv",
    "auth",
  ])("rejects runtime %s override before dispatch", async (name) => {
    const target = await fixture(true);
    const connector = vi.fn();
    const agent = new HttpsAgent({ keepAlive: true });
    agents.push(agent);
    const values: Record<string, unknown> = {
      agent,
      createConnection: connector,
      checkServerIdentity: connector,
      rejectUnauthorized: false,
    };
    const options = { ca: target.ca, [name]: values[name] ?? "unsafe" };
    await expect(
      providerHttpsRequest(target.url, options as ProviderRequestOptions, policy, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(connector).not.toHaveBeenCalled();
    expect(target.requests).toHaveLength(0);
  });

  it.each(["127.0.0.1", "::1"])("literal TLS %s verifies its IP SAN without SNI", async (host) => {
    const target = await fixture(true, host);
    const literal = host.includes(":") ? `[${host}]` : host;
    const url = `https://${literal}:${target.port}`;
    expect(
      await body(await providerHttpsRequest(url, { ca: target.ca }, policy, "openai", auth)),
    ).toBe("native-ok");
    expect((target.sockets[0] as TLSSocket).servername).toBe(false);
    const mismatch = await fixture(true, host, false);
    await expect(
      providerHttpsRequest(
        `https://${literal}:${mismatch.port}`,
        { ca: mismatch.ca },
        policy,
        "openai",
        auth,
      ),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(mismatch.requests).toHaveLength(0);
  });

  it("hostname TLS retains SAN/SNI verification and default CA distrust", async () => {
    const target = await fixture(true);
    expect(
      await body(await providerHttpsRequest(target.url, { ca: target.ca }, policy, "openai", auth)),
    ).toBe("native-ok");
    expect((target.sockets[0] as TLSSocket).servername).toBe("localhost");
    await expect(
      providerHttpsRequest(target.url, {}, policy, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    const mismatch = await fixture(true, "127.0.0.1", false);
    await expect(
      providerHttpsRequest(mismatch.url, { ca: mismatch.ca }, policy, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(target.requests).toHaveLength(1);
    expect(mismatch.requests).toHaveLength(0);
  });

  it("pre-aborted signal constructs no connection", async () => {
    const target = await fixture(true);
    const connections = vi.fn();
    target.server.on("connection", connections);
    const signal = AbortSignal.abort();
    await expect(
      providerHttpsRequest(target.url, { ca: target.ca, signal }, policy, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connections).not.toHaveBeenCalled();
    expect(target.requests).toHaveLength(0);
  });

  it("stalled TLS handshake settles by header deadline and closes owned socket", async () => {
    const sockets: Socket[] = [];
    const server = tcpServer((socket) => socket.on("data", () => undefined));
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.push(socket);
      tcpSockets.push(socket);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    const start = performance.now();
    await expect(
      providerHttpsRequest(
        `https://127.0.0.1:${address.port}`,
        {},
        { ...policy, timeoutMs: 100 },
        "openai",
        auth,
      ),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(performance.now() - start).toBeGreaterThanOrEqual(80);
    expect(sockets).toHaveLength(1);
    await vi.waitFor(() => expect(sockets[0]?.destroyed).toBe(true));
  });

  it("all-family failover preserves each validated address on actual sockets", async () => {
    const target = await fixture(false);
    const override: LookupFunction = (_hostname, _options, callback) =>
      callback(null, [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]);
    vi.mocked(dnsLookup).mockImplementation(override as typeof dnsLookup);
    expect(await body(await providerHttpsRequest(target.url, {}, policy, "openai", auth))).toBe(
      "native-ok",
    );
    expect(target.sockets[0]?.remoteAddress).toBe("127.0.0.1");
    expect(target.requests).toHaveLength(1);
  });

  it.each(["private only", "mixed public/private", "empty"])(
    "unsafe DNS %s sends no credentials on real TLS transport",
    async (answers) => {
      const target = await fixture(true);
      const addresses =
        answers === "empty"
          ? []
          : answers === "private only"
            ? [{ address: "127.0.0.1", family: 4 }]
            : [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
              ];
      const override: LookupFunction = (_hostname, _options, callback) => callback(null, addresses);
      vi.mocked(dnsLookup).mockImplementation(override as typeof dnsLookup);
      await expect(
        providerHttpsRequest(
          target.url,
          { ca: target.ca },
          { ...policy, allowPrivateNetworks: false },
          "openai",
          auth,
        ),
      ).rejects.toBeInstanceOf(ProviderEgressError);
      expect(target.requests).toHaveLength(0);
    },
  );

  it("DNS deadline settles, ignores late resolution, and permits a fresh exchange", async () => {
    const target = await fixture(false);
    let release!: () => void;
    const override: LookupFunction = (_hostname, _options, callback) => {
      release = () => callback(null, [{ address: "127.0.0.1", family: 4 }]);
    };
    vi.mocked(dnsLookup).mockImplementation(override as typeof dnsLookup);
    const start = performance.now();
    await expect(
      providerHttpsRequest(target.url, {}, { ...policy, timeoutMs: 60 }, "openai", auth),
    ).rejects.toBeInstanceOf(ProviderEgressError);
    expect(performance.now() - start).toBeLessThan(1_000);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(target.requests).toHaveLength(0);
    vi.mocked(dnsLookup).mockRestore();
    expect(await body(await providerHttpsRequest(target.url, {}, policy, "openai", auth))).toBe(
      "native-ok",
    );
  });

  it.each(["timeout", "abort"])(
    "slow real body rejects rather than clean EOF on %s",
    async (trigger) => {
      const server = httpServer((_request, response) => {
        response.writeHead(200);
        response.write("partial");
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture did not bind");
      const controller = new AbortController();
      const response = await providerHttpsRequest(
        `http://127.0.0.1:${address.port}`,
        { signal: controller.signal },
        { ...policy, timeoutMs: trigger === "timeout" ? 60 : 0 },
        "openai",
        auth,
      );
      const pending = expect(body(response)).rejects.toBeInstanceOf(ProviderEgressError);
      if (trigger === "abort") controller.abort();
      await pending;
      expect(response.destroyed).toBe(true);
    },
  );
});

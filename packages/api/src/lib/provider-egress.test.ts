import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertResolvedAddressesSafe,
  isPrivateOrSpecialAddress,
  providerHttpsRequest,
  redactProviderError,
  sanitizeProviderHeaders,
  validateProviderBaseUrl,
} from "./provider-egress";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("provider egress policy", () => {
  it.each([
    [{ type: "API_KEY", apiKey: "key", token: "also-present" }],
    [{ type: "BEARER", token: "token", apiKey: "also-present" }],
    [{ type: "NONE" }],
  ])("rejects malformed or ambiguous provider auth at runtime", async (auth) => {
    await expect(
      providerHttpsRequest(
        "http://127.0.0.1:1",
        { method: "GET" },
        { allowPrivateNetworks: true, egressEnabled: true },
        "openai",
        auth as never,
      ),
    ).rejects.toThrow("Provider request failed");
  });

  it.each([
    [
      { type: "API_KEY", apiKey: "api-secret" } as const,
      { accept: "application/json", "x-api-key": "api-secret" },
    ],
    [
      { type: "BEARER", token: "bearer-secret" } as const,
      { accept: "application/json", authorization: "Bearer bearer-secret" },
    ],
  ])("emits exactly the selected provider authentication headers", async (auth, expected) => {
    let observed: Record<string, string | string[] | undefined> = {};
    const server = createServer((request, response) => {
      observed = request.headers;
      response.writeHead(204);
      response.end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const response = await providerHttpsRequest(
      `http://127.0.0.1:${address.port}`,
      {
        method: "GET",
        headers: { accept: "application/json", authorization: "inbound", "x-api-key": "inbound" },
      },
      { allowPrivateNetworks: true, egressEnabled: true },
      "openai",
      auth,
    );
    response.resume();
    expect(observed.accept).toBe(expected.accept);
    expect(observed.authorization).toBe(expected.authorization);
    expect(observed["x-api-key"]).toBe(expected["x-api-key"]);
    expect(observed.cookie).toBeUndefined();
  });

  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"])(
    "recognizes private address %s",
    (address) => expect(isPrivateOrSpecialAddress(address)).toBe(true),
  );
  it.each([
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "::a9fe:a9fe",
    "fe80::1",
    "fec0::1",
    "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "2001:2::1",
    "3fff::1",
    "100::1",
    "64:ff9b:1::1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
  ])("recognizes special IPv6 spelling %s", (address) => {
    expect(isPrivateOrSpecialAddress(address)).toBe(true);
  });
  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "64:ff9b::808:808",
  ])("allows globally routable address %s", (address) =>
    expect(isPrivateOrSpecialAddress(address)).toBe(false),
  );
  it("requires HTTPS, forbids URL credentials, and rejects literal private targets", () => {
    const policy = { allowPrivateNetworks: false };
    expect(() => validateProviderBaseUrl("http://example.com", policy)).toThrow(/HTTPS/u);
    expect(() => validateProviderBaseUrl("https://user:pass@example.com", policy)).toThrow(
      /credentials/u,
    );
    expect(() => validateProviderBaseUrl("https://127.0.0.1", policy)).toThrow(/private/u);
    expect(() => validateProviderBaseUrl("https://[::ffff:7f00:1]", policy)).toThrow(/private/u);
    expect(() => validateProviderBaseUrl("https://[fec0::1]", policy)).toThrow(/private/u);
    expect(validateProviderBaseUrl("https://api.example.com/v1", policy).href).toBe(
      "https://api.example.com/v1",
    );
  });
  it("allows explicit private deployment targets", () => {
    expect(
      validateProviderBaseUrl("http://127.0.0.1:11434/v1", { allowPrivateNetworks: true }).hostname,
    ).toBe("127.0.0.1");
  });
  it("drops client cookies and arbitrary headers", () => {
    expect(
      sanitizeProviderHeaders(
        {
          Cookie: "bad",
          Authorization: "Bearer ok",
          "X-Unsafe": "bad",
          Accept: "application/json",
        },
        "openai",
      ),
    ).toEqual({ accept: "application/json" });
  });
  it("uses separate protocol allowlists and never forwards inbound credentials or selectors", () => {
    const incoming = {
      Authorization: "Bearer inbound",
      "X-Api-Key": "inbound-key",
      Cookie: "session=bad",
      "OpenAI-Organization": "wrong-account",
      "Anthropic-Version": "2023-06-01",
      Accept: "application/json",
    };
    expect(sanitizeProviderHeaders(incoming, "openai")).toEqual({ accept: "application/json" });
    expect(sanitizeProviderHeaders(incoming, "anthropic")).toEqual({
      accept: "application/json",
      "anthropic-version": "2023-06-01",
    });
  });
  it("redacts credential-looking error text", () => {
    expect(redactProviderError("authorization: Bearer-secret token=token-abcdefgh")).not.toContain(
      "Bearer-secret",
    );
    expect(redactProviderError("authorization: Bearer-secret token=token-abcdefgh")).not.toContain(
      "token-abcdefgh",
    );
  });
  it("rejects mixed DNS answers to close rebinding and multi-address bypasses", () => {
    expect(() =>
      assertResolvedAddressesSafe([{ address: "93.184.216.34" }, { address: "127.0.0.1" }], {
        allowPrivateNetworks: false,
      }),
    ).toThrow("Provider request failed");
    expect(() => assertResolvedAddressesSafe([], { allowPrivateNetworks: false })).toThrow(
      "Provider request failed",
    );
    expect(() =>
      assertResolvedAddressesSafe([{ address: "::ffff:a9fe:a9fe" }], {
        allowPrivateNetworks: false,
      }),
    ).toThrow("Provider request failed");
    expect(() =>
      assertResolvedAddressesSafe([{ address: "fec0::1" }], {
        allowPrivateNetworks: false,
      }),
    ).toThrow("Provider request failed");
  });
  it("rejects redirects and exposes only a stable error", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    await expect(
      providerHttpsRequest(
        `http://127.0.0.1:${address.port}`,
        { method: "GET" },
        { allowPrivateNetworks: true, egressEnabled: true, timeoutMs: 500 },
        "openai",
        { type: "NONE", purpose: "UNAUTHENTICATED_PROBE" },
      ),
    ).rejects.toThrow("Provider request failed");
  });
  it("bounds stalled provider requests", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    await expect(
      providerHttpsRequest(
        `http://127.0.0.1:${address.port}`,
        { method: "GET" },
        { allowPrivateNetworks: true, egressEnabled: true, timeoutMs: 20 },
        "anthropic",
        { type: "NONE", purpose: "UNAUTHENTICATED_PROBE" },
      ),
    ).rejects.toThrow("Provider request failed");
  });
  it("fails closed when the public-provider egress release gate is omitted", async () => {
    await expect(
      providerHttpsRequest(
        "https://example.com",
        { method: "GET" },
        { allowPrivateNetworks: false },
        "openai",
        { type: "NONE", purpose: "UNAUTHENTICATED_PROBE" },
      ),
    ).rejects.toThrow("Provider request failed");
  });
});

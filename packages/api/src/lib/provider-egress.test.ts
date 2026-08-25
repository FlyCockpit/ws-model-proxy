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
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"])(
    "recognizes private address %s",
    (address) => expect(isPrivateOrSpecialAddress(address)).toBe(true),
  );
  it("requires HTTPS, forbids URL credentials, and rejects literal private targets", () => {
    const policy = { allowPrivateNetworks: false };
    expect(() => validateProviderBaseUrl("http://example.com", policy)).toThrow(/HTTPS/u);
    expect(() => validateProviderBaseUrl("https://user:pass@example.com", policy)).toThrow(
      /credentials/u,
    );
    expect(() => validateProviderBaseUrl("https://127.0.0.1", policy)).toThrow(/private/u);
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
      ),
    ).rejects.toThrow("Provider request failed");
  });
});

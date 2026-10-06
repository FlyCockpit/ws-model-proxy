import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertResolvedAddressesSafe,
  isPrivateOrSpecialAddress,
  ProviderEgressError,
  providerHttpsRequest,
  redactProviderError,
  sanitizeProviderHeaders,
  validateProviderBaseUrl,
} from "./provider-egress";

const servers: ReturnType<typeof createServer>[] = [];

// IANA special-purpose registries, Last Updated 2025-10-09. Every Globally
// Reachable=False row is pinned here (the paired IPv4 discovery row is split).
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Mapped IPv6 follows our effective embedded-IPv4 policy, not a blanket deny;
// its endpoints are special and the public interior inverse is tested below.
const NON_GLOBAL_IPV4_BOUNDARIES = [
  ["0.0.0.0/8", "0.0.0.0", "0.255.255.255"],
  ["0.0.0.0/32", "0.0.0.0", "0.0.0.0"],
  ["10.0.0.0/8", "10.0.0.0", "10.255.255.255"],
  ["100.64.0.0/10", "100.64.0.0", "100.127.255.255"],
  ["127.0.0.0/8", "127.0.0.0", "127.255.255.255"],
  ["169.254.0.0/16", "169.254.0.0", "169.254.255.255"],
  ["172.16.0.0/12", "172.16.0.0", "172.31.255.255"],
  ["192.0.0.0/24", "192.0.0.0", "192.0.0.255"],
  ["192.0.0.0/29", "192.0.0.0", "192.0.0.7"],
  ["192.0.0.8/32", "192.0.0.8", "192.0.0.8"],
  ["192.0.0.170/32", "192.0.0.170", "192.0.0.170"],
  ["192.0.0.171/32", "192.0.0.171", "192.0.0.171"],
  ["192.0.2.0/24", "192.0.2.0", "192.0.2.255"],
  ["192.88.99.2/32", "192.88.99.2", "192.88.99.2"],
  ["192.168.0.0/16", "192.168.0.0", "192.168.255.255"],
  ["198.18.0.0/15", "198.18.0.0", "198.19.255.255"],
  ["198.51.100.0/24", "198.51.100.0", "198.51.100.255"],
  ["203.0.113.0/24", "203.0.113.0", "203.0.113.255"],
  ["240.0.0.0/4", "240.0.0.0", "255.255.255.255"],
  ["255.255.255.255/32", "255.255.255.255", "255.255.255.255"],
] as const;
const NON_GLOBAL_IPV6_BOUNDARIES = [
  ["::1/128", "::1", "::1"],
  ["::/128", "::", "::"],
  ["::ffff:0:0/96", "::ffff:0:0", "::ffff:ffff:ffff"],
  ["64:ff9b:1::/48", "64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
  ["100::/64", "100::", "100::ffff:ffff:ffff:ffff"],
  ["100:0:0:1::/64", "100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff"],
  ["2001::/23", "2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2001:2::/48", "2001:2::", "2001:2:0:ffff:ffff:ffff:ffff:ffff"],
  ["2001:db8::/32", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["3fff::/20", "3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["5f00::/16", "5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fc00::/7", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fe80::/10", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
] as const;

function assertStrictAddressRejected(address: string): void {
  const policy = { allowPrivateNetworks: false };
  expect(isPrivateOrSpecialAddress(address), address).toBe(true);
  expect(() => assertResolvedAddressesSafe([{ address }], policy), address).toThrow(
    ProviderEgressError,
  );
  // A mixed public/special answer cannot escape the same classifier boundary.
  expect(() => assertResolvedAddressesSafe([{ address: "8.8.8.8" }, { address }], policy)).toThrow(
    ProviderEgressError,
  );
  const host = address.includes(":") ? `[${address}]` : address;
  expect(() => validateProviderBaseUrl(`https://${host}/v1`, policy), address).toThrow(
    /private or special/u,
  );
  expect(() =>
    assertResolvedAddressesSafe([{ address }], { allowPrivateNetworks: true }),
  ).not.toThrow();
  expect(
    validateProviderBaseUrl(`https://${host}/v1`, { allowPrivateNetworks: true }).pathname,
  ).toBe("/v1");
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe("provider egress policy", () => {
  it.each(NON_GLOBAL_IPV4_BOUNDARIES)(
    "rejects pinned IANA IPv4 False row %s",
    (_cidr, first, last) => {
      for (const address of new Set([first, last])) {
        assertStrictAddressRejected(address);
        const octets = address.split(".").map(Number);
        const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
        const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
        for (const embedded of [
          `::ffff:${high}:${low}`,
          `::${high}:${low}`,
          `64:ff9b::${high}:${low}`,
        ]) {
          assertStrictAddressRejected(embedded);
        }
      }
    },
  );
  it.each(NON_GLOBAL_IPV6_BOUNDARIES)(
    "rejects pinned IANA IPv6 False row %s",
    (_cidr, first, last) => {
      for (const address of new Set([first, last])) assertStrictAddressRejected(address);
    },
  );
  it.each([
    "224.0.0.0",
    "239.255.255.255",
    "ff00::",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fec0::",
    "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "::ffff:192.88.99.2",
    "::192.88.99.2",
    "64:ff9b::192.88.99.2",
    "0100:0000:0000:0001:0000:0000:0000:0001",
  ])("rejects special extras and encoded omission sibling %s", assertStrictAddressRejected);
  it.each([
    "192.88.99.1",
    "192.88.99.3",
    "100:0:0:2::",
    "8.8.8.8",
    "93.184.216.34",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:808:808",
    "::808:808",
    "64:ff9b::808:808",
    "::ffff:c058:6301",
    "::c058:6303",
    "64:ff9b::c058:6303",
  ])("preserves ordinary public and exact-prefix neighbor %s", (address) => {
    expect(isPrivateOrSpecialAddress(address)).toBe(false);
    expect(() =>
      assertResolvedAddressesSafe([{ address }], { allowPrivateNetworks: false }),
    ).not.toThrow();
    const host = address.includes(":") ? `[${address}]` : address;
    expect(
      validateProviderBaseUrl(`https://${host}/v1`, { allowPrivateNetworks: false }).pathname,
    ).toBe("/v1");
  });
  it.each([
    "192.0.0.9",
    "192.0.0.10",
    "2001:1::1",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
    "2002:808:808::1",
    "2002:7f00:1::1",
  ])(
    "preserves conservative public-special and deprecated 6to4 policy %s",
    assertStrictAddressRejected,
  );
  it.each(["3227017986", "0xc0586302", "0300.0130.0143.0002", "192.88.99.2."])(
    "rejects URL-normalized encoding of non-global relay %s",
    (hostname) => {
      const raw = `https://${hostname}/v1`;
      expect(new URL(raw).hostname).toBe("192.88.99.2");
      expect(() => validateProviderBaseUrl(raw, { allowPrivateNetworks: false })).toThrow(
        /private or special/u,
      );
      expect(validateProviderBaseUrl(raw, { allowPrivateNetworks: true }).hostname).toBe(
        "192.88.99.2",
      );
    },
  );
  it.each(["100:0:0:1::1%fixture", "::ffff:c058:6302%fixture"])(
    "rejects scoped resolved encoding %s",
    (address) => {
      expect(isPrivateOrSpecialAddress(address)).toBe(true);
      expect(() =>
        assertResolvedAddressesSafe([{ address }], { allowPrivateNetworks: false }),
      ).toThrow(ProviderEgressError);
    },
  );

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
    expect(observed.authorization).toBe(
      "authorization" in expected ? expected.authorization : undefined,
    );
    expect(observed["x-api-key"]).toBe("x-api-key" in expected ? expected["x-api-key"] : undefined);
    expect(observed.cookie).toBeUndefined();
  });

  it("sends Bearer Messages to OpenRouter without x-api-key and keeps anthropic-version", async () => {
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
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "must-stay-blank",
        },
      },
      { allowPrivateNetworks: true, egressEnabled: true },
      "anthropic",
      { type: "BEARER", token: "openrouter-key" },
    );
    response.resume();
    expect(observed.authorization).toBe("Bearer openrouter-key");
    expect(observed["x-api-key"]).toBeUndefined();
    expect(observed["anthropic-version"]).toBe("2023-06-01");
  });

  it("streams the exact request bytes without reflecting inbound credentials", async () => {
    let observedBody = Buffer.alloc(0);
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observedBody = Buffer.concat(chunks);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const body = new TextEncoder().encode('{"model":"rewritten","stream":true}');
    const response = await providerHttpsRequest(
      `http://127.0.0.1:${address.port}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-must-not-leak",
          "anthropic-version": "2023-06-01",
        },
        body,
      },
      { allowPrivateNetworks: true, egressEnabled: true },
      "anthropic",
      { type: "API_KEY", apiKey: "provider-secret" },
    );
    response.resume();
    await once(response, "end");
    expect(observedBody).toEqual(Buffer.from(body));
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
  it.each(["idle timeout", "abort signal", "already-aborted signal"] as const)(
    "rejects before response: %s",
    async (trigger) => {
      let received!: () => void;
      const requestReceived = new Promise<void>((resolve) => {
        received = resolve;
      });
      const server = createServer(() => received());
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const controller = new AbortController();
      if (trigger === "already-aborted signal") controller.abort();
      const rejection = expect(
        providerHttpsRequest(
          `http://127.0.0.1:${address.port}`,
          { method: "GET", signal: controller.signal },
          {
            allowPrivateNetworks: true,
            egressEnabled: true,
            // Disable the idle timeout for abort rows so it cannot hide a
            // missing signal handler by eventually rejecting for another reason.
            timeoutMs: trigger === "idle timeout" ? 100 : 0,
          },
          "anthropic",
          { type: "NONE", purpose: "UNAUTHENTICATED_PROBE" },
        ),
      ).rejects.toBeInstanceOf(ProviderEgressError);
      if (trigger === "abort signal") {
        await requestReceived;
        controller.abort();
      }
      await rejection;
    },
  );

  // A stalled web reader fills toWeb's queue. A separate trailing write then
  // remains in IncomingMessage even though the HTTP parser has seen the FIN.
  // Honest EOF rows preserve exactly the same bytes as the teardown rows.
  it.each(
    (["idle timeout", "abort signal", "honest EOF"] as const).flatMap((trigger) =>
      (["response.failed", "conflicting usage"] as const).map((tail) => ({ trigger, tail })),
    ),
  )("classifies buffered egress EOF: $trigger / $tail", async ({ trigger, tail }) => {
    let outgoing!: ServerResponse;
    const server = createServer((_request, response) => {
      outgoing = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const controller = new AbortController();
    const response = await providerHttpsRequest(
      `http://127.0.0.1:${address.port}`,
      { method: "GET", signal: controller.signal },
      { allowPrivateNetworks: true, egressEnabled: true, timeoutMs: 5_000 },
      "openai",
      { type: "NONE", purpose: "UNAUTHENTICATED_PROBE" },
    );
    const reader = Readable.toWeb(response).getReader();
    try {
      const terminal = 'event: response.completed\ndata: {"usage":{"output_tokens":1}}\n\n';
      const prefix = `${terminal}: ${"x".repeat(70 * 1024)}\n\n`;
      const trailing =
        tail === "response.failed"
          ? 'event: response.failed\ndata: {"error":{}}\n\n'
          : 'event: response.completed\ndata: {"usage":{"output_tokens":14}}\n\n';
      const receivedPrefix = once(response, "data");
      outgoing.write(prefix);
      await receivedPrefix;
      await vi.waitFor(() => expect(response.isPaused()).toBe(true));
      outgoing.end(trailing);
      await vi.waitFor(() => {
        expect(response.complete).toBe(true);
        expect(response.readableLength).toBeGreaterThanOrEqual(Buffer.byteLength(trailing));
      });
      if (trigger === "idle timeout") {
        // Shorten the real socket's idle timer only once the unread tail is in
        // place. The callback remains the one installed by provider egress.
        response.socket.setTimeout(20);
        await vi.waitFor(() => expect(response.destroyed).toBe(true));
      } else if (trigger === "abort signal") {
        controller.abort();
      }
      let bytes = "";
      let failure: unknown;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += Buffer.from(chunk.value).toString("utf8");
        }
      } catch (error) {
        failure = error;
      }
      if (trigger === "honest EOF") {
        expect(failure).toBeUndefined();
        expect(bytes).toBe(prefix + trailing);
        controller.abort();
        expect(response.errored).toBeNull();
      } else {
        expect(failure).toBeInstanceOf(ProviderEgressError);
        expect((failure as Error).message).toBe("Provider request failed");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      response.destroy();
      server.closeAllConnections();
    }
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

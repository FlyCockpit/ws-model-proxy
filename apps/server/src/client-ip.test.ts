import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";

// Mutable env so each test can set TRUST_PROXY_HOPS independently.
const mockEnv: { TRUST_PROXY_HOPS: number } = { TRUST_PROXY_HOPS: 0 };
vi.mock("@ws-model-proxy/env/server", () => ({ env: mockEnv }));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

const { resolveClientIp, withResolvedClientIp } = await import("./client-ip.js");

function ctx(opts: { socket?: string; xff?: string }): Context {
  mockGetConnInfo.mockReturnValue({ remote: { address: opts.socket ?? "" } });
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? opts.xff : undefined),
    },
  } as unknown as Context;
}

function resolve(hops: number, opts: { socket?: string; xff?: string }): string {
  mockEnv.TRUST_PROXY_HOPS = hops;
  return resolveClientIp(ctx(opts));
}

describe("resolveClientIp, TRUST_PROXY_HOPS=0 (clients connect directly)", () => {
  it("keys on the socket peer", () => {
    expect(resolve(0, { socket: "198.51.100.50" })).toBe("198.51.100.50");
    expect(resolve(0, { socket: "127.0.0.1" })).toBe("127.0.0.1");
  });

  it("ignores X-Forwarded-For entirely, even from a private socket peer", () => {
    // A LAN client, or internet traffic rewritten to the Docker bridge gateway,
    // must not be able to choose its key by sending a public address.
    for (let i = 0; i < 5; i++) {
      expect(resolve(0, { socket: "172.17.0.1", xff: `203.0.113.${i}` })).toBe("172.17.0.1");
    }
    expect(resolve(0, { socket: "10.0.0.5", xff: "8.8.8.8, 198.51.100.7" })).toBe("10.0.0.5");
  });

  it("returns 'unknown' when there is no socket peer", () => {
    expect(resolve(0, { socket: "" })).toBe("unknown");
  });
});

describe("resolveClientIp, TRUST_PROXY_HOPS=1 (one reverse proxy)", () => {
  it("takes the entry the proxy appended", () => {
    expect(resolve(1, { socket: "10.0.0.5", xff: "198.51.100.7" })).toBe("198.51.100.7");
  });

  it("works for a proxy with a public address", () => {
    expect(resolve(1, { socket: "104.16.0.1", xff: "198.51.100.7" })).toBe("198.51.100.7");
  });

  it("ignores client-supplied entries left of the proxy's", () => {
    for (let i = 0; i < 5; i++) {
      expect(resolve(1, { socket: "10.0.0.5", xff: `203.0.113.${i}, 198.51.100.7` })).toBe(
        "198.51.100.7",
      );
    }
    expect(resolve(1, { socket: "10.0.0.5", xff: "8.8.8.8, 10.1.1.1, 198.51.100.7" })).toBe(
      "198.51.100.7",
    );
  });

  it("keys on a private client address like any other", () => {
    expect(resolve(1, { socket: "10.0.0.5", xff: "192.168.1.20" })).toBe("192.168.1.20");
  });

  it("falls back to the socket peer when the proxy appended nothing", () => {
    expect(resolve(1, { socket: "10.0.0.5" })).toBe("10.0.0.5");
    expect(resolve(1, { socket: "10.0.0.5", xff: " , ," })).toBe("10.0.0.5");
  });

  it("handles IPv6 clients and proxies", () => {
    expect(resolve(1, { socket: "fd00::1", xff: "2001:db8::5" })).toBe("2001:db8::5");
    expect(resolve(1, { socket: "::1", xff: "2001:db8::bad, 2001:db8::5" })).toBe("2001:db8::5");
  });

  it("strips a port some load balancers append", () => {
    expect(resolve(1, { socket: "10.0.0.5", xff: "198.51.100.7:51234" })).toBe("198.51.100.7");
    expect(resolve(1, { socket: "10.0.0.5", xff: "[2001:db8::5]:443" })).toBe("2001:db8::5");
    expect(resolve(1, { socket: "10.0.0.5", xff: "[2001:db8::5]" })).toBe("2001:db8::5");
  });

  it("falls back to the socket peer when the selected entry is not an IP", () => {
    for (const garbage of ["not-an-ip", "unknown", "999.1.1.1", "1.2.3.4:x", "x".repeat(4096)]) {
      expect(resolve(1, { socket: "10.0.0.5", xff: garbage })).toBe("10.0.0.5");
    }
  });
});

describe("resolveClientIp, TRUST_PROXY_HOPS=2 (CDN in front of a proxy)", () => {
  it("takes the entry the outer proxy appended", () => {
    expect(resolve(2, { socket: "10.0.0.5", xff: "198.51.100.7, 104.16.0.1" })).toBe(
      "198.51.100.7",
    );
  });

  it("ignores client-supplied entries", () => {
    expect(resolve(2, { socket: "10.0.0.5", xff: "203.0.113.1, 198.51.100.7, 104.16.0.1" })).toBe(
      "198.51.100.7",
    );
  });

  it("falls back to the socket peer on a short chain, never a client-written entry", () => {
    // Fewer entries than proxies: the outer proxy was bypassed, so the one
    // header entry may be client-written. Only the socket peer is unforgeable.
    expect(resolve(2, { socket: "10.0.0.5", xff: "203.0.113.1" })).toBe("10.0.0.5");
    expect(resolve(2, { socket: "10.0.0.5" })).toBe("10.0.0.5");
    expect(resolve(9, { socket: "10.0.0.5", xff: "203.0.113.1, 198.51.100.7" })).toBe("10.0.0.5");
  });

  it("returns 'unknown' on a short chain with no socket peer", () => {
    expect(resolve(2, { socket: "", xff: "203.0.113.1" })).toBe("unknown");
  });
});

describe("withResolvedClientIp", () => {
  it("replaces every client-supplied forwarding header with the resolved IP", async () => {
    const original = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      body: '{"email":"a@example.com"}',
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.1, 198.51.100.7",
        "x-real-ip": "203.0.113.2",
        forwarded: "for=203.0.113.3",
      },
    });
    const rewritten = withResolvedClientIp(original, "198.51.100.7");
    expect(rewritten.headers.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(rewritten.headers.get("x-real-ip")).toBeNull();
    expect(rewritten.headers.get("forwarded")).toBeNull();
    expect(rewritten.headers.get("content-type")).toBe("application/json");
    expect(rewritten.method).toBe("POST");
    expect(rewritten.url).toBe(original.url);
    expect(await rewritten.text()).toBe('{"email":"a@example.com"}');
  });

  it("drops X-Forwarded-For when the client IP is unknown", () => {
    const original = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(withResolvedClientIp(original, "unknown").headers.get("x-forwarded-for")).toBeNull();
  });
});

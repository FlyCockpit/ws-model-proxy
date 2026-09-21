import type { Session } from "@ws-model-proxy/auth";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Inject a sentinel-carrying rejection through the REAL middleware path.
// NOTE: @ws-model-proxy/auth/cookie-session is deliberately NOT mocked —
// the bearer-stripping regression below drives the REAL stripping helper
// through real Hono requests (R37/R38 finding 3).
const getSession = vi.fn();

vi.mock("@ws-model-proxy/auth", () => ({
  auth: {
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

import { auth } from "@ws-model-proxy/auth";
import { sessionMiddleware } from "./session-middleware";

const SENTINEL = "SECRET-TOKEN-VALUE";

function sentinelError(): Error {
  const err = new Error(
    `Invalid \`prisma.session.findUnique()\` invocation: client_secret=${SENTINEL} SELECT "Session"`,
  );
  err.stack = `Error: ${SENTINEL}\n    at getSession (factory.mjs:191:5)`;
  return err;
}

function fakeContext(): Context {
  return {
    req: { raw: new Request("http://localhost/rpc/x") },
    set: vi.fn(),
  } as unknown as Context;
}

beforeEach(() => {
  getSession.mockReset();
});

describe("sessionMiddleware", () => {
  it("resolves browser sessions without forwarding bearer authorization", async () => {
    getSession.mockResolvedValue(null);
    const app = new Hono();
    app.use("/*", sessionMiddleware);
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("/", {
      headers: {
        Authorization: "Bearer wsmp_model_secret",
        Cookie: "better-auth.session_token=signed-session",
      },
    });

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledOnce();
    const call = getSession.mock.calls[0]?.[0] as { headers: Headers };
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("cookie")).toBe("better-auth.session_token=signed-session");
  });
});

describe("sessionMiddleware — getSession failure sink (pass 10, L19)", () => {
  it("logs the constructor name ONLY — sentinel message/stack never reach console.warn", async () => {
    vi.mocked(auth.api.getSession).mockRejectedValue(sentinelError());
    const next: Next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext();

    const chunks: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      chunks.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await sessionMiddleware(c, next);
    } finally {
      warnSpy.mockRestore();
    }

    const output = chunks.join("\n");
    expect(output).toContain("[session-middleware] getSession failed, treating as anonymous:");
    expect(output).toContain("(Error: Error)");
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain("client_secret");
    expect(output).not.toContain("SELECT");
    expect(output).not.toContain("factory.mjs");
  });

  it("still degrades to anonymous (session null) and calls next — failure mode unchanged", async () => {
    vi.mocked(auth.api.getSession).mockRejectedValue(sentinelError());
    const next: Next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await sessionMiddleware(c, next);
    } finally {
      warnSpy.mockRestore();
    }

    expect(c.set).toHaveBeenCalledWith("session", null);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("success path: session stored, nothing logged", async () => {
    const session = { user: { id: "u1" }, session: { id: "s1" } } as unknown as Session;
    vi.mocked(auth.api.getSession).mockResolvedValue(session);
    const next: Next = vi.fn().mockResolvedValue(undefined);
    const c = fakeContext();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await sessionMiddleware(c, next);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnSpy).not.toHaveBeenCalled();
    expect(c.set).toHaveBeenCalledWith("session", session);
  });
});

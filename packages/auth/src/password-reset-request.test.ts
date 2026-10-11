import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn(async (_mail: { to: string; html: string }) => {}));

// The reset mail looks up the recipient's locale through the shared Prisma client.
vi.mock("@ws-model-proxy/db", () => ({
  default: { user: { findUnique: vi.fn(async () => ({ locale: "en-US" })) } },
}));
vi.mock("@ws-model-proxy/mailer", () => ({
  sendEmail,
  renderResetPassword: (args: { url: string }) => ({ subject: "reset", html: args.url }),
}));

const { passwordResetOptions } = await import("./password-reset");
const {
  createPasswordResetRequestHandler,
  PASSWORD_RESET_REQUESTED_MESSAGE,
  PASSWORD_RESET_RESPONSE_FLOOR_MS,
} = await import("./password-reset-request");

const BASE = "https://proxy.example.com";
const PASSWORD = "old-password-1";

type Row = Record<string, unknown>;

/**
 * A real Better Auth instance (in-memory database) with this app's reset options, served the way
 * apps/server serves it: the uniform request handler first, then Better Auth's own handler.
 */
function setup({ floorMs = 0, rateLimit = false }: { floorMs?: number; rateLimit?: boolean } = {}) {
  const db = {
    user: [] as Row[],
    session: [] as Row[],
    account: [] as Row[],
    verification: [] as Row[],
  };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "password-reset-request-test-secret-32chars",
    baseURL: BASE,
    trustedOrigins: [BASE],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      ...passwordResetOptions(true, undefined),
    },
    rateLimit: { enabled: rateLimit },
  });
  const uniform = createPasswordResetRequestHandler(auth, { floorMs });
  const handle = async (request: Request) =>
    (await uniform(request, (forwarded) => auth.handler(forwarded))) ?? auth.handler(request);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { auth, db, post };
}

async function signUp(ctx: ReturnType<typeof setup>, email: string) {
  await ctx.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Person" } });
  return ctx.db.user.find((row) => row.email === email)?.id as string;
}

/** The token from the reset link mailed to `email` (waits for the background mail). */
async function mailedToken(email: string): Promise<string> {
  let html = "";
  await vi.waitFor(() => {
    const mail = sendEmail.mock.calls.find(([m]) => m.to === email)?.[0];
    expect(mail).toBeDefined();
    html = mail?.html ?? "";
  });
  const token = /\/reset-password\/([^?]+)\?/.exec(html)?.[1];
  if (!token) throw new Error("no token in the reset mail");
  return token;
}

describe("uniform /request-password-reset", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sendEmail.mockClear();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers an existing and an unknown email identically", async () => {
    const ctx = setup();
    await signUp(ctx, "person@example.com");

    const known = await ctx.post("/request-password-reset", { email: "person@example.com" });
    const unknown = await ctx.post("/request-password-reset", { email: "nobody@example.com" });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const knownBody = await known.json();
    expect(knownBody).toEqual({ status: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
    expect(await unknown.json()).toEqual(knownBody);
    await mailedToken("person@example.com");
    expect(sendEmail.mock.calls.some(([m]) => m.to === "nobody@example.com")).toBe(false);
  });

  it("answers identically even when the reset-token write fails", async () => {
    const ctx = setup();
    await signUp(ctx, "person@example.com");
    const context = await ctx.auth.$context;
    const insert = vi
      .spyOn(context.internalAdapter, "createVerificationValue")
      .mockRejectedValue(new Error("database down"));

    const known = await ctx.post("/request-password-reset", { email: "person@example.com" });
    const unknown = await ctx.post("/request-password-reset", { email: "nobody@example.com" });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    await vi.waitFor(() => expect(insert).toHaveBeenCalled());
    expect(error).toHaveBeenCalledWith(
      "[auth] password reset request failed:",
      expect.stringMatching(/^status 5\d\d$/),
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses bad input and untrusted origins the same way for every address", async () => {
    const ctx = setup();
    await signUp(ctx, "person@example.com");
    for (const email of ["person@example.com", "nobody@example.com"]) {
      expect(
        (await ctx.post("/request-password-reset", { email }, { origin: "https://evil.example" }))
          .status,
      ).toBe(403);
      expect(
        (
          await ctx.post("/request-password-reset", {
            email,
            redirectTo: "https://evil.example/en-US/reset-password",
          })
        ).status,
      ).toBe(403);
    }
    expect((await ctx.post("/request-password-reset", { email: "not-an-email" })).status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("issues a token Better Auth's /reset-password accepts once, and revokes every session", async () => {
    const ctx = setup();
    const userId = await signUp(ctx, "person@example.com");
    await ctx.auth.api.signInEmail({ body: { email: "person@example.com", password: PASSWORD } });
    expect(ctx.db.session.filter((row) => row.userId === userId).length).toBeGreaterThan(0);

    await ctx.post("/request-password-reset", { email: "person@example.com" });
    const token = await mailedToken("person@example.com");

    const reset = await ctx.post("/reset-password", { token, newPassword: "new-password-1" });
    expect(reset.status).toBe(200);
    expect(ctx.db.session.filter((row) => row.userId === userId)).toEqual([]);

    // The new password signs in; the old one no longer does.
    await expect(
      ctx.auth.api.signInEmail({
        body: { email: "person@example.com", password: "new-password-1" },
      }),
    ).resolves.toBeTruthy();
    await expect(
      ctx.auth.api.signInEmail({ body: { email: "person@example.com", password: PASSWORD } }),
    ).rejects.toThrow();

    // Replay: the token was consumed.
    const replay = await ctx.post("/reset-password", { token, newPassword: "another-pass-1" });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("refuses an expired token (one-hour lifetime)", async () => {
    const ctx = setup();
    await signUp(ctx, "person@example.com");
    await ctx.post("/request-password-reset", { email: "person@example.com" });
    const token = await mailedToken("person@example.com");

    const row = ctx.db.verification.find((r) => r.identifier === `reset-password:${token}`);
    const expiresAt = row?.expiresAt as Date;
    const lifetimeMs = expiresAt.getTime() - Date.now();
    expect(lifetimeMs).toBeGreaterThan(59 * 60_000);
    expect(lifetimeMs).toBeLessThanOrEqual(60 * 60_000);
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    const reset = await ctx.post("/reset-password", { token, newPassword: "new-password-1" });
    expect(reset.status).toBe(400);
    expect(await reset.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("falls through to Better Auth when reset is disabled (no SMTP)", async () => {
    const auth = betterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      secret: "password-reset-request-test-secret-32chars",
      baseURL: BASE,
      emailAndPassword: { enabled: true, ...passwordResetOptions(false, undefined) },
    });
    const handler = createPasswordResetRequestHandler(auth);
    const request = new Request(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    });
    expect(await handler(request, (forwarded) => auth.handler(forwarded))).toBeNull();
  });
});

describe("Better Auth's own rate limit still applies", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers the 4th request in a minute from one IP with Better Auth's 429, for any address, with no account work", async () => {
    const ctx = setup({ rateLimit: true });
    await signUp(ctx, "person@example.com");
    const context = await ctx.auth.$context;
    const lookup = vi.spyOn(context.internalAdapter, "findUserByEmail");
    const from = (ip: string, email: string) =>
      ctx.post("/request-password-reset", { email }, { "x-forwarded-for": ip });

    for (let i = 0; i < 3; i++) {
      expect((await from("192.0.2.1", "nobody@example.com")).status).toBe(200);
      expect((await from("192.0.2.2", "person@example.com")).status).toBe(200);
    }
    const lookupsBefore = lookup.mock.calls.length;
    const existing = await from("192.0.2.1", "person@example.com");
    const unknown = await from("192.0.2.2", "nobody@example.com");

    expect(existing.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(await existing.json()).toEqual(await unknown.json());
    expect(lookup.mock.calls.length).toBe(lookupsBefore);
  });
});

describe("response floor", () => {
  const handlerWith = () =>
    createPasswordResetRequestHandler({
      options: { emailAndPassword: { sendResetPassword: async () => {} } },
      $context: Promise.resolve({ isTrustedOrigin: () => true }),
    });
  const request = () =>
    new Request(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["a token insert (200)", async () => Response.json({ status: true, message: "x" })],
    ["a lookup miss (200)", async () => Response.json({ status: true })],
    ["a database failure (500)", async () => Response.json({ code: "x" }, { status: 500 })],
    [
      "a thrown error",
      async (): Promise<Response> => {
        throw new Error("boom");
      },
    ],
  ])("pads %s to the floor and answers the same 200", async (_label, forward) => {
    let settled: Response | null | undefined;
    const pending = handlerWith()(request(), forward).then((response) => {
      settled = response;
    });

    await vi.advanceTimersByTimeAsync(PASSWORD_RESET_RESPONSE_FLOOR_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled?.status).toBe(200);
    expect(await settled?.json()).toEqual({
      status: true,
      message: PASSWORD_RESET_REQUESTED_MESSAGE,
    });
  });

  it("answers as soon as work slower than the floor is done (documented residual)", async () => {
    let settled = false;
    const slow = () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(Response.json({ status: true })), 1_000),
      );
    const pending = handlerWith()(request(), slow).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(settled).toBe(true);
  });

  it("passes Better Auth's 429 through without padding", async () => {
    const limited = Response.json({ message: "Too many requests" }, { status: 429 });
    const response = await handlerWith()(request(), async () => limited);
    expect(response).toBe(limited);
  });
});

import { Hono } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { limiter, signupLimiter } = vi.hoisted(() => ({
  limiter: {
    points: 3,
    consume: vi.fn<(key: string) => Promise<unknown>>(),
  },
  signupLimiter: {
    points: 6,
    consume: vi.fn<(key: string) => Promise<unknown>>(),
  },
}));

vi.mock("./rate-limit.js", () => ({
  emailRecipientLimiter: limiter,
  signupRecipientLimiter: signupLimiter,
  emailRateLimitKey: (email: string) => email.trim().toLowerCase(),
}));

const { EMAIL_RECIPIENT_PATHS, emailRecipientLimit, SIGNUP_MEDIA_TYPES, SIGNUP_RECIPIENT_PATH } =
  await import("./email-recipient-limit.js");

const PATH = "/api/auth/send-verification-email";

/**
 * Wires the middleware in front of a handler that reads the body the same way
 * the real auth handler does — `auth.handler(c.req.raw)`. If the middleware
 * consumes the stream instead of cloning, `seen` stays null and the assertions
 * below catch it.
 */
function buildApp() {
  const app = new Hono();
  let seen: unknown = null;
  app.use(PATH, emailRecipientLimit());
  app.post(PATH, async (c) => {
    seen = await c.req.raw.json();
    return c.json({ status: true });
  });
  return { app, downstream: () => seen };
}

function post(app: Hono, body: unknown) {
  return app.request(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  limiter.points = 3;
  limiter.consume.mockReset();
  limiter.consume.mockResolvedValue({});
  signupLimiter.points = 6;
  signupLimiter.consume.mockReset();
  signupLimiter.consume.mockResolvedValue({});
});

describe("signup recipient limiting", () => {
  function buildSignupApp() {
    const app = new Hono();
    app.use(SIGNUP_RECIPIENT_PATH, emailRecipientLimit(signupLimiter));
    app.post(SIGNUP_RECIPIENT_PATH, (c) => c.json({ status: true }));
    return app;
  }

  it("consumes from the signup bucket, never the shared email bucket", async () => {
    const app = buildSignupApp();
    const res = await app.request(SIGNUP_RECIPIENT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "New.User@Example.com ", password: "hunter2" }),
    });

    expect(res.status).toBe(200);
    expect(signupLimiter.consume).toHaveBeenCalledWith("new.user@example.com");
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("429s once the signup budget for that address is spent", async () => {
    const app = buildSignupApp();
    signupLimiter.consume.mockRejectedValue(new RateLimiterRes(0, 45_000));

    const res = await app.request(SIGNUP_RECIPIENT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "victim@example.com", password: "hunter2" }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("is skipped entirely when the signup budget is disabled", async () => {
    signupLimiter.points = 0;
    const app = buildSignupApp();

    const res = await app.request(SIGNUP_RECIPIENT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "hunter2" }),
    });

    expect(res.status).toBe(200);
    expect(signupLimiter.consume).not.toHaveBeenCalled();
  });
});

describe("emailRecipientLimit", () => {
  it("lets a request through and leaves the body readable downstream", async () => {
    const { app, downstream } = buildApp();
    const res = await post(app, { email: "user@example.com" });

    expect(res.status).toBe(200);
    expect(downstream()).toEqual({ email: "user@example.com" });
  });

  it("keys on the normalized recipient, not the caller", async () => {
    const { app } = buildApp();
    await post(app, { email: "  User@Example.COM  " });
    expect(limiter.consume).toHaveBeenCalledWith("user@example.com");
  });

  it("rejects with 429 and Retry-After once the address is over its cap", async () => {
    const { app, downstream } = buildApp();
    limiter.consume.mockRejectedValue(new RateLimiterRes(0, 60_000));

    const res = await post(app, { email: "victim@example.com" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(downstream()).toBeNull();
  });

  it("does not consume a point when the body has no usable email", async () => {
    const { app } = buildApp();
    for (const body of [{}, { email: "" }, { email: "   " }, { email: 42 }]) {
      await post(app, body);
    }
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("passes through non-JSON bodies for Better-Auth to reject", async () => {
    const app = new Hono();
    let reached = false;
    app.use(PATH, emailRecipientLimit());
    app.post(PATH, (c) => {
      reached = true;
      return c.json({ status: true });
    });

    const res = await app.request(PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(limiter.consume).not.toHaveBeenCalled();
    expect(reached).toBe(true);
    expect(res.status).toBe(200);
  });

  describe("media-type handling", () => {
    function buildAnyBodyApp(allowed?: readonly string[]) {
      const app = new Hono();
      app.use(PATH, emailRecipientLimit(limiter, allowed));
      app.post(PATH, (c) => c.json({ status: true }));
      return app;
    }

    it("counts a form-urlencoded recipient on the signup path, which allows it", async () => {
      const app = buildAnyBodyApp(SIGNUP_MEDIA_TYPES);
      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "Victim@Example.com" }).toString(),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).toHaveBeenCalledWith("victim@example.com");
    });

    it("shares one budget across encodings, so switching format cannot reset it", async () => {
      const real = new RateLimiterMemory({ points: 3, duration: 3600 });
      limiter.consume.mockImplementation((key: string) => real.consume(key));

      const app = buildAnyBodyApp(SIGNUP_MEDIA_TYPES);
      for (let i = 0; i < 3; i++) {
        expect((await post(app, { email: "victim@example.com" })).status).toBe(200);
      }

      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });
      expect(res.status).toBe(429);
    });

    it("matches on the media type's BASE, not a substring of the whole header", async () => {
      const app = buildAnyBodyApp(SIGNUP_MEDIA_TYPES);
      const res = await app.request(PATH, {
        method: "POST",
        headers: {
          "Content-Type": 'application/x-www-form-urlencoded; charset="application/json"',
        },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).toHaveBeenCalledWith("victim@example.com");
    });

    it("still parses JSON when the header carries parameters", async () => {
      const app = buildAnyBodyApp();
      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ email: "victim@example.com" }),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).toHaveBeenCalledWith("victim@example.com");
    });

    it("refuses a media type Better-Auth would refuse, without consuming budget", async () => {
      const app = new Hono();
      let reached = false;
      app.use(PATH, emailRecipientLimit());
      app.post(PATH, (c) => {
        reached = true;
        return c.json({ status: true });
      });

      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });

      expect(res.status).toBe(415);
      expect(reached).toBe(false);
      expect(limiter.consume).not.toHaveBeenCalled();
    });

    it("refuses multipart, which no protected route accepts", async () => {
      const app = buildAnyBodyApp(SIGNUP_MEDIA_TYPES);
      const form = new FormData();
      form.set("email", "victim@example.com");
      const res = await app.request(PATH, { method: "POST", body: form });

      expect(res.status).toBe(415);
      expect(limiter.consume).not.toHaveBeenCalled();
    });

    it("lets a bodyless POST through for Better-Auth to 400", async () => {
      const app = buildAnyBodyApp();
      const res = await app.request(PATH, { method: "POST" });

      expect(res.status).toBe(200);
      expect(limiter.consume).not.toHaveBeenCalled();
    });
  });

  it("fails OPEN when the store throws unexpectedly", async () => {
    const { app, downstream } = buildApp();
    limiter.consume.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post(app, { email: "user@example.com" });

    expect(res.status).toBe(200);
    expect(downstream()).toEqual({ email: "user@example.com" });
  });

  it("skips the limiter entirely when POINTS is 0", async () => {
    const { app } = buildApp();
    limiter.points = 0;

    const res = await post(app, { email: "user@example.com" });

    expect(res.status).toBe(200);
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("covers every anonymous endpoint that mails a caller-supplied address", () => {
    expect([...EMAIL_RECIPIENT_PATHS]).toEqual([
      "/api/auth/send-verification-email",
      "/api/auth/request-password-reset",
    ]);
  });
});

describe("emailRecipientLimit — enumeration safety", () => {
  it("returns the same response for an unknown and a real address", async () => {
    const { app } = buildApp();
    const unknown = await post(app, { email: "nobody@example.com" });
    const real = await post(app, { email: "registered@example.com" });

    expect(unknown.status).toBe(real.status);
    expect(await unknown.json()).toEqual(await real.json());
  });
});

describe("emailRecipientLimiter budget", () => {
  it("blocks the 4th request for one address while leaving another untouched", async () => {
    const real = new RateLimiterMemory({ points: 3, duration: 3600 });
    limiter.consume.mockImplementation((key: string) => real.consume(key));

    const { app } = buildApp();
    const victim = { email: "victim@example.com" };

    for (let i = 0; i < 3; i++) {
      expect((await post(app, victim)).status).toBe(200);
    }
    expect((await post(app, victim)).status).toBe(429);

    expect((await post(app, { email: "someone-else@example.com" })).status).toBe(200);
  });

  it("counts case and whitespace variants against the same budget", async () => {
    const real = new RateLimiterMemory({ points: 3, duration: 3600 });
    limiter.consume.mockImplementation((key: string) => real.consume(key));

    const { app } = buildApp();
    await post(app, { email: "victim@example.com" });
    await post(app, { email: "VICTIM@example.com" });
    await post(app, { email: "  Victim@Example.com  " });

    expect((await post(app, { email: "victim@example.com" })).status).toBe(429);
  });
});

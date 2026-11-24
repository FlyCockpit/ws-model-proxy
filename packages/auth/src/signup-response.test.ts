import { beforeEach, describe, expect, it, vi } from "vitest";

// `/sign-up/email` must not tell a free address from a registered one. These tests run the
// app's production auth options (user fields, e-mail/password, verification, hooks, database
// hooks, plugins) on a real Better Auth handler; only the database is Better Auth's in-memory
// adapter. Prisma (read by the user-create hook's slug lookups, the slug pre-check and the
// verification mail) is a stub that reads the same memory tables.

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "signup-response-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
  SIGNUP_ENABLED: true,
}));

const memory = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  reset() {
    this.tables = { user: [], account: [], session: [], verification: [], twoFactor: [] };
  },
}));
vi.mock("@ws-model-proxy/db", () => {
  const findUnique = async ({ where }: { where: Record<string, unknown> }) => {
    const [[key, value] = []] = Object.entries(where);
    return memory.tables.user?.find((row) => key !== undefined && row[key] === value) ?? null;
  };
  return { default: { user: { findUnique } } };
});

const emailConfigured = vi.hoisted(() => ({ value: true }));
const sendEmail = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => emailConfigured.value,
  sendEmail,
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderResetPassword: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const OPEN = { signupEnabled: true, adminBootstrapSignupEnabled: false, userCount: 3 };
const getSignupAccessState = vi.hoisted(() => vi.fn());
vi.mock("./signup-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signup-policy")>()),
  getSignupAccessState,
}));

const ORIGIN = "https://proxy.example.com";
const INVITE = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A user name the database below refuses to insert (a stand-in for a constraint or an outage). */
const REFUSED_BY_DB = "refused-by-the-database";

/**
 * Better Auth's memory adapter, refusing what Postgres refuses in a text column (a NUL byte) and
 * a user named {@link REFUSED_BY_DB}, so a failure only the database raises reaches user creation
 * the way it does in production.
 */
async function postgresLikeMemoryAdapter() {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const memoryFactory = memoryAdapter(memory.tables);
  const hasNul = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((field) => typeof field === "string" && field.includes("\u0000"));
  // Also wraps the adapter a transaction callback receives: sign-up writes through it.
  const refusingNul = <A extends object>(adapter: A): A =>
    new Proxy(adapter, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const [first] = args;
          if (key === "create" && typeof first === "object" && first !== null) {
            const data = (first as { data?: { name?: unknown } }).data;
            if (hasNul(data)) {
              return Promise.reject(new Error("invalid byte sequence for encoding UTF8: 0x00"));
            }
            if (data?.name === REFUSED_BY_DB) {
              return Promise.reject(new Error("the database refused the insert"));
            }
          }
          if (key === "transaction" && typeof first === "function") {
            args[0] = (trx: object) => first(refusingNul(trx));
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  return ((options: Parameters<typeof memoryFactory>[0]) =>
    refusingNul(memoryFactory(options))) as typeof memoryFactory;
}

/** The production auth options on a real handler, with SMTP on or off. */
async function realAuth(smtp: boolean) {
  emailConfigured.value = smtp;
  vi.resetModules();
  const { auth } = await import("./index");
  const invites = await import("./share-invite-acceptance");
  const { betterAuth } = await import("better-auth");
  const instance = betterAuth({
    ...auth.options,
    database: await postgresLikeMemoryAdapter(),
    rateLimit: { enabled: false },
  });
  const signUp = async (
    email: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const res = await instance.handler(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
        body: JSON.stringify({
          name: "Same Name",
          email,
          password: "same-password-12345",
          ...extra,
        }),
      }),
    );
    return {
      status: res.status,
      headers: [...res.headers.entries()].filter(([name]) => name !== "date"),
      body: await res.text(),
    };
  };
  /** Resend verification: answers without waiting for the mail. */
  const resend = async (email: string) => {
    const res = await instance.handler(
      new Request(`${ORIGIN}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email }),
      }),
    );
    return {
      status: res.status,
      headers: [...res.headers.entries()].filter(([name]) => name !== "date"),
      body: await res.text(),
    };
  };
  return { signUp, resend, invites };
}

/** One pending invite, held like the API's compare-and-swap claim (see share-invite-accept.ts). */
function statefulInvite() {
  const state = { claimedEmail: null as string | null, claimedAt: null as Date | null };
  const acceptor = {
    isPending: vi.fn(async () => true),
    claim: vi.fn(async (_token: string, email: string, claimedAt: Date) => {
      if (state.claimedEmail !== null && state.claimedEmail !== email) return "in_use" as const;
      Object.assign(state, { claimedEmail: email, claimedAt });
      return "claimed" as const;
    }),
    release: vi.fn(async (_token: string, email: string, claimedAt: Date) => {
      if (state.claimedEmail === email && state.claimedAt === claimedAt) {
        Object.assign(state, { claimedEmail: null, claimedAt: null });
      }
    }),
    accept: vi.fn(async () => true),
  };
  return { state, acceptor };
}

const NEUTRAL = '{"token":null,"user":null}';
const emails = () => (memory.tables.user ?? []).map((row) => row.email).sort();

// Every sign-up pays a real scrypt hash, hence the roomier timeout.
describe("sign-up response is the same for free and registered addresses", {
  timeout: 30_000,
}, () => {
  beforeEach(() => {
    memory.reset();
    sendEmail.mockReset();
    getSignupAccessState.mockReset();
    getSignupAccessState.mockResolvedValue(OPEN);
  });

  it("answers a new and an existing address byte-identically (SMTP on)", async () => {
    const { signUp } = await realAuth(true);
    await signUp("taken-verified@example.test");
    await signUp("taken-unverified@example.test");
    const verified = memory.tables.user?.find((u) => u.email === "taken-verified@example.test");
    if (!verified) throw new Error("seed user missing");
    verified.emailVerified = true;
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2));
    sendEmail.mockClear();

    const fresh = await signUp("fresh@example.test");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe(NEUTRAL);
    expect(fresh.headers.some(([name]) => name === "set-cookie")).toBe(false);
    expect(await signUp("taken-verified@example.test")).toEqual(fresh);
    expect(await signUp("taken-unverified@example.test")).toEqual(fresh);
    // The new address really got an account (with the hook's slug and role) and its
    // verification mail; the duplicates got neither a second account nor a mail.
    expect(emails()).toEqual([
      "fresh@example.test",
      "taken-unverified@example.test",
      "taken-verified@example.test",
    ]);
    const created = memory.tables.user?.find((u) => u.email === "fresh@example.test");
    expect(created).toMatchObject({ role: "user", slug: "fresh" });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
  });

  it("refuses a slug another account holds the same way for a new and an existing address", async () => {
    const { signUp } = await realAuth(true);
    await signUp("holder@example.test", { slug: "held-slug" });
    await signUp("taken@example.test");

    const fresh = await signUp("fresh@example.test", { slug: "held-slug" });
    expect(fresh.status).toBe(422);
    expect(JSON.parse(fresh.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });
    expect(await signUp("taken@example.test", { slug: "held-slug" })).toEqual(fresh);
    expect(await signUp("holder@example.test", { slug: " held-slug " })).toEqual(fresh);
    expect(emails()).toEqual(["holder@example.test", "taken@example.test"]);

    // A free slug is the neutral 200 for both, and only the new address gets an account.
    const freeSlug = await signUp("fresh@example.test", { slug: "free-slug" });
    expect(freeSlug.body).toBe(NEUTRAL);
    expect(await signUp("taken@example.test", { slug: "other-free-slug" })).toEqual(freeSlug);
    expect(memory.tables.user?.find((u) => u.email === "fresh@example.test")?.slug).toBe(
      "free-slug",
    );
  });

  it("answers a malformed slug with the same 400 for a new and an existing address", async () => {
    const { signUp } = await realAuth(true);
    await signUp("taken@example.test");
    const fresh = await signUp("fresh@example.test", { slug: "Not A Slug!" });
    expect(fresh.status).toBe(400);
    expect(await signUp("taken@example.test", { slug: "Not A Slug!" })).toEqual(fresh);
  });

  it("refuses a NUL byte in a stored field with the same 400 before the address lookup", async () => {
    const { signUp } = await realAuth(true);
    await signUp("taken@example.test");
    for (const field of [{ name: "probe\u0000" }, { image: "x\u0000" }, { slug: "a\u0000b" }]) {
      const fresh = await signUp("fresh@example.test", field);
      expect(fresh.status).toBe(400);
      expect(JSON.parse(fresh.body)).toMatchObject({ code: "INVALID_INPUT" });
      expect(await signUp("taken@example.test", field)).toEqual(fresh);
    }
    expect(emails()).toEqual(["taken@example.test"]);
  });

  it("answers a refusal past the address lookup like a registered address (the database refuses)", async () => {
    const { signUp } = await realAuth(true);
    await signUp("taken@example.test");
    const refused = { name: REFUSED_BY_DB };
    const fresh = await signUp("fresh@example.test", refused);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe(NEUTRAL);
    expect(await signUp("taken@example.test", refused)).toEqual(fresh);
    // Nothing was created by the refused request, and the address is still free.
    expect(emails()).toEqual(["taken@example.test"]);
    expect(await signUp("fresh@example.test")).toEqual(fresh);
    expect(emails()).toEqual(["fresh@example.test", "taken@example.test"]);
  });

  it("releases the invite a refused sign-up claimed, so the invite reads as if it never ran", async () => {
    const { signUp, invites } = await realAuth(true);
    await signUp("taken@example.test");
    const { state, acceptor } = statefulInvite();
    invites.registerShareInviteLinkAcceptor(acceptor);
    const header = { "x-wsmp-invite": INVITE };
    const refused = { name: REFUSED_BY_DB };

    const registered = await signUp("taken@example.test", refused, header);
    expect(acceptor.claim).not.toHaveBeenCalled();
    const fresh = await signUp("fresh@example.test", refused, header);
    expect(fresh).toEqual(registered);
    expect(acceptor.claim).toHaveBeenCalledTimes(1);
    const [, , claimedAt] = acceptor.claim.mock.calls[0] ?? [];
    expect(acceptor.release).toHaveBeenCalledWith(INVITE, "fresh@example.test", claimedAt);
    expect(state).toEqual({ claimedEmail: null, claimedAt: null });
    // Another e-mail can use the link at once, as after the registered address's attempt.
    expect((await signUp("other@example.test", {}, header)).body).toBe(NEUTRAL);
    expect(state.claimedEmail).toBe("other@example.test");
    expect(acceptor.accept).toHaveBeenCalledTimes(1);
    expect(acceptor.release).toHaveBeenCalledTimes(1);
  });

  it("answers the same when the verification mail cannot be sent", async () => {
    const { signUp } = await realAuth(true);
    await signUp("taken@example.test");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendEmail.mockRejectedValue(new TypeError("smtp down"));
    try {
      const fresh = await signUp("fresh@example.test");
      expect(fresh.status).toBe(200);
      expect(fresh.body).toBe(NEUTRAL);
      expect(await signUp("taken@example.test")).toEqual(fresh);
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          "verification email send failed",
          expect.stringMatching(/^user=/),
          "TypeError",
        ),
      );
    } finally {
      error.mockRestore();
    }
    // The account exists; the person can ask for the mail again.
    expect(emails()).toEqual(["fresh@example.test", "taken@example.test"]);
  });

  it.each([
    ["open sign-up", OPEN, "in_use" as const],
    ["closed sign-up", { ...OPEN, signupEnabled: false }, "in_use" as const],
    ["closed sign-up", { ...OPEN, signupEnabled: false }, "invalid" as const],
  ])(
    "answers an invite link whose claim is refused (%s, %s) like a registered address",
    async (_label, state, claimResult) => {
      const { signUp, invites } = await realAuth(true);
      await signUp("taken@example.test");
      getSignupAccessState.mockResolvedValue(state);
      const claim = vi.fn(async (_token: string, _email: string, _at: Date) => claimResult);
      invites.registerShareInviteLinkAcceptor({
        isPending: async () => true,
        claim,
        release: async () => {},
        accept: async () => true,
      });
      const header = { "x-wsmp-invite": INVITE };
      const fresh = await signUp("fresh@example.test", {}, header);
      expect(claim).toHaveBeenCalledWith(INVITE, "fresh@example.test", expect.any(Date));
      expect(fresh.status).toBe(200);
      expect(fresh.body).toBe(NEUTRAL);
      expect(await signUp("taken@example.test", {}, header)).toEqual(fresh);
      expect(emails()).toEqual(["taken@example.test"]);
    },
  );

  it("lets a refusal stand while no account exists (nothing to reveal: the first-admin bootstrap)", async () => {
    const { signUp } = await realAuth(true);
    getSignupAccessState.mockResolvedValue({
      signupEnabled: false,
      adminBootstrapSignupEnabled: true,
      userCount: 0,
    });
    const refused = await signUp("owner@example.test", { name: REFUSED_BY_DB });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });
    const created = await signUp("owner@example.test");
    expect(created.body).toBe(NEUTRAL);
    expect(memory.tables.user?.[0]).toMatchObject({ email: "owner@example.test", role: "admin" });
  });

  it("answers sign-up and resend without waiting for the mail", async () => {
    const { signUp, resend } = await realAuth(true);
    await signUp("taken-verified@example.test");
    await signUp("taken-unverified@example.test");
    const verified = memory.tables.user?.find((u) => u.email === "taken-verified@example.test");
    if (!verified) throw new Error("seed user missing");
    verified.emailVerified = true;
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2));
    sendEmail.mockClear();
    // SMTP that never answers: a response that awaited it would never come back.
    sendEmail.mockImplementation(() => new Promise<never>(() => {}));
    const fresh = await signUp("fresh@example.test");
    expect(fresh.body).toBe(NEUTRAL);
    expect(await signUp("taken-unverified@example.test")).toEqual(fresh);
    const unknown = await resend("unknown@example.test");
    expect(unknown.status).toBe(200);
    expect(await resend("taken-verified@example.test")).toEqual(unknown);
    expect(await resend("taken-unverified@example.test")).toEqual(unknown);
    // The fresh sign-up and the unverified resend did start a mail.
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2));
  });

  it("without SMTP keeps the intended no-mail flow: sign-in at once, a taken address is told so", async () => {
    const { signUp } = await realAuth(false);
    const fresh = await signUp("fresh@example.test");
    expect(fresh.status).toBe(200);
    // The person's own new account and session (scripts/e2e reads `user.id` and the cookie).
    expect(JSON.parse(fresh.body)).toMatchObject({ user: { email: "fresh@example.test" } });
    expect(fresh.headers.some(([name]) => name === "set-cookie")).toBe(true);
    const again = await signUp("fresh@example.test");
    expect(again.status).toBe(422);
    expect(JSON.parse(again.body)).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
  });
});

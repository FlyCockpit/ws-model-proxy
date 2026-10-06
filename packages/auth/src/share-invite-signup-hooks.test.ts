import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "invite-signup-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
  SIGNUP_ENABLED: false,
}));

// Callable-proxy Prisma stub (see user-ban-listeners.test.ts): lets the real auth instance
// construct without a database; the user-create hook reads only `user.findUnique` here.
function makePrismaStub(): unknown {
  return new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
}
vi.mock("@ws-model-proxy/db", () => {
  const stub = makePrismaStub() as Record<string, unknown>;
  return {
    default: new Proxy(stub, {
      get(target, prop, receiver) {
        if (prop === "user") return { findUnique: async () => null };
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const getSignupAccessState = vi.hoisted(() => vi.fn());
vi.mock("./signup-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signup-policy")>()),
  getSignupAccessState,
}));

const { registerShareInviteAcceptor, registerShareInviteLinkAcceptor } = await import(
  "./share-invite-acceptance"
);
const { SIGNUP_DISABLED_MESSAGE } = await import("./signup-policy");
const { auth } = await import("./index");

const TOKEN = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CLAIM_WINDOW_MS = 10 * 60_000;

/**
 * One invite, held the way the API's guarded updates hold it: a claim succeeds only while the
 * invite is pending and unclaimed (or the claim is stale); acceptance needs that claim.
 */
const invite = {
  pending: true,
  claimedAt: null as Date | null,
  clock: Date.now(),
  failAccept: false,
};
const isPending = vi.fn(async (_token: string) => invite.pending);
const claim = vi.fn(async (_token: string): Promise<Date | null> => {
  const now = new Date(invite.clock);
  const free =
    invite.claimedAt === null || invite.claimedAt.getTime() < now.getTime() - CLAIM_WINDOW_MS;
  if (!invite.pending || !free) return null;
  invite.claimedAt = now;
  return now;
});
const accept = vi.fn(
  async (_user: { id: string; email: string }, _token: string, claimedAt: Date) => {
    if (invite.failAccept) throw new RangeError(`boom ${TOKEN}`);
    if (!invite.pending || invite.claimedAt !== claimedAt) return false;
    invite.pending = false;
    return true;
  },
);
const acceptEmail = vi.fn(async () => 0);

const row = (id = "new-user") => ({
  id,
  email: "someone-else@example.test",
  emailVerified: true,
  name: "New",
  createdAt: new Date(),
  updatedAt: new Date(),
});

function hookContext(path: string, headers: Record<string, string> = {}): never {
  return { path, headers: new Headers(headers) } as never;
}
const withToken = (path = "/sign-up/email") => hookContext(path, { "x-wsmp-invite": TOKEN });

const hooks = () => auth.options.databaseHooks?.user?.create;
const closed = { signupEnabled: false, adminBootstrapSignupEnabled: false, userCount: 3 };

/** One sign-up the way Better Auth runs it: before, then (if admitted) after, one context. */
async function signUp(context: never, id = "new-user") {
  const result = await hooks()?.before?.({ ...row(id), role: "admin" }, context);
  await hooks()?.after?.(row(id), context);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(invite, { pending: true, claimedAt: null, clock: Date.now(), failAccept: false });
  getSignupAccessState.mockResolvedValue(closed);
  registerShareInviteAcceptor(acceptEmail);
  registerShareInviteLinkAcceptor({ isPending, claim, accept });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("invite-link sign-up with open sign-up off", () => {
  it("admits a pending token as user, reserves the invite and accepts it for the new account", async () => {
    const context = withToken();
    await expect(signUp(context)).resolves.toMatchObject({ data: { role: "user" } });
    expect(claim).toHaveBeenCalledWith(TOKEN);
    expect(accept).toHaveBeenCalledWith(
      { id: "new-user", email: "someone-else@example.test" },
      TOKEN,
      invite.claimedAt,
    );
    expect(invite.pending).toBe(false);
    expect(acceptEmail).toHaveBeenCalledTimes(1);
  });

  it("lets one of two sign-ups with one token at once create, and refuses the other", async () => {
    const results = await Promise.allSettled([
      hooks()?.before?.(row("a"), withToken()),
      hooks()?.before?.(row("b"), withToken()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain(SIGNUP_DISABLED_MESSAGE);
  });

  it("refuses the token again within the claim window after a failed acceptance, then frees it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    invite.failAccept = true;
    await signUp(withToken(), "first");
    expect(error).toHaveBeenCalledWith(
      "share invite link acceptance failed",
      "user=first",
      "RangeError",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);

    invite.failAccept = false;
    invite.clock += CLAIM_WINDOW_MS / 2;
    await expect(hooks()?.before?.(row("second"), withToken())).rejects.toThrow(
      SIGNUP_DISABLED_MESSAGE,
    );

    invite.clock += CLAIM_WINDOW_MS;
    const context = withToken();
    await expect(signUp(context, "third")).resolves.toMatchObject({ data: { role: "user" } });
    expect(invite.pending).toBe(false);
  });

  it("refuses a token that is not pending, and a sign-up without one", async () => {
    invite.pending = false;
    await expect(hooks()?.before?.(row(), withToken())).rejects.toThrow(SIGNUP_DISABLED_MESSAGE);
    await expect(hooks()?.before?.(row(), hookContext("/sign-up/email"))).rejects.toThrow(
      SIGNUP_DISABLED_MESSAGE,
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("logs a refused acceptance (revoked or expired after the claim) with the user id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = withToken();
    await hooks()?.before?.(row(), context);
    invite.pending = false;
    await hooks()?.after?.(row(), context);
    expect(error).toHaveBeenCalledWith("share invite link acceptance refused", "user=new-user");
  });

  it("opens no other creation route", async () => {
    for (const path of ["/callback/github", "/magic-link/verify", "/sign-in/email", "/sign-up"]) {
      await expect(hooks()?.before?.(row(), withToken(path))).rejects.toThrow(
        SIGNUP_DISABLED_MESSAGE,
      );
    }
    expect(isPending).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("leaves admin create-user as it was: requested role kept, no claim, no link acceptance", async () => {
    const context = withToken("/admin/create-user");
    await expect(hooks()?.before?.({ ...row(), role: "admin" }, context)).resolves.toMatchObject({
      data: { role: "admin" },
    });
    await hooks()?.after?.(row(), context);
    expect(claim).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(acceptEmail).not.toHaveBeenCalled();
  });
});

describe("invite-link sign-up with open sign-up on", () => {
  it("still reserves and accepts the invite, and signs up without it when it is taken", async () => {
    getSignupAccessState.mockResolvedValue({ ...closed, signupEnabled: true });
    await signUp(withToken(), "first");
    expect(invite.pending).toBe(false);
    await expect(signUp(withToken(), "second")).resolves.toMatchObject({
      data: { role: "user" },
    });
    expect(accept).toHaveBeenCalledTimes(1);
  });
});

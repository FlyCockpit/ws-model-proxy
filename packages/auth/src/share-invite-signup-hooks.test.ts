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
const IN_USE = "This invite link is in use";

/**
 * One invite, held the way the API's compare-and-swap claim holds it: free when unclaimed; the
 * same e-mail may take over; another e-mail waits out a fresh claim, and a stale claim is
 * released only if no account has the claimant e-mail. Acceptance needs this e-mail's claim.
 */
const invite = {
  pending: true,
  claimedAt: null as number | null,
  claimedEmail: null as string | null,
  clock: Date.now(),
  failAccept: false,
  accounts: new Set<string>(),
};
const isPending = vi.fn(async (_token: string) => invite.pending);
const claim = vi.fn(async (_token: string, email: string) => {
  if (!invite.pending) return "invalid" as const;
  if (invite.claimedAt !== null && invite.claimedEmail !== email) {
    if (invite.claimedAt > invite.clock - CLAIM_WINDOW_MS) return "in_use" as const;
    if (invite.claimedEmail !== null && invite.accounts.has(invite.claimedEmail))
      return "invalid" as const;
  }
  invite.claimedAt = invite.clock;
  invite.claimedEmail = email;
  return "claimed" as const;
});
const accept = vi.fn(async (user: { id: string; email: string }, _token: string) => {
  if (invite.failAccept) throw new RangeError(`boom ${TOKEN}`);
  if (!invite.pending || invite.claimedEmail !== user.email) return false;
  invite.pending = false;
  return true;
});
const acceptEmail = vi.fn(async () => 0);

const row = (id = "new-user", email = `${id}@example.test`) => ({
  id,
  email,
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

/**
 * One sign-up the way Better Auth runs it: before, the insert (the account now exists), then
 * after, all with one context.
 */
async function signUp(id: string, context: never = withToken()) {
  const result = await hooks()?.before?.({ ...row(id), role: "admin" }, context);
  invite.accounts.add(row(id).email);
  await hooks()?.after?.(row(id), context);
  return result;
}
/** A sign-up whose insert rolled back after the claim: before ran, no account, no after. */
const rolledBackSignUp = (id: string) => hooks()?.before?.(row(id), withToken());

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(invite, {
    pending: true,
    claimedAt: null,
    claimedEmail: null,
    clock: Date.now(),
    failAccept: false,
    accounts: new Set<string>(),
  });
  getSignupAccessState.mockResolvedValue(closed);
  registerShareInviteAcceptor(acceptEmail);
  registerShareInviteLinkAcceptor({ isPending, claim, accept });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("invite-link sign-up with open sign-up off", () => {
  it("admits a pending token as user, claims the invite for the e-mail and accepts it", async () => {
    await expect(signUp("friend")).resolves.toMatchObject({ data: { role: "user" } });
    expect(claim).toHaveBeenCalledWith(TOKEN, "friend@example.test");
    expect(accept).toHaveBeenCalledWith({ id: "friend", email: "friend@example.test" }, TOKEN);
    expect(invite.pending).toBe(false);
    expect(acceptEmail).toHaveBeenCalledTimes(1);
  });

  it("lets one of two sign-ups (two e-mails, one token) at once in; the other hears it is in use", async () => {
    const results = await Promise.allSettled([
      hooks()?.before?.(row("a"), withToken()),
      hooks()?.before?.(row("b"), withToken()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain(IN_USE);
  });

  it("lets the same e-mail retry at once after its sign-up rolled back", async () => {
    await rolledBackSignUp("friend");
    invite.clock += 1_000;
    await expect(signUp("friend")).resolves.toMatchObject({ data: { role: "user" } });
    expect(invite.pending).toBe(false);
  });

  it("releases a rolled-back sign-up's claim to another e-mail once the window passed", async () => {
    await rolledBackSignUp("gone");
    invite.clock += CLAIM_WINDOW_MS / 2;
    await expect(hooks()?.before?.(row("other"), withToken())).rejects.toThrow(IN_USE);
    invite.clock += CLAIM_WINDOW_MS;
    await expect(signUp("other")).resolves.toMatchObject({ data: { role: "user" } });
    expect(invite.pending).toBe(false);
  });

  it("keeps the invite with the account whose acceptance failed, in and after the window", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    invite.failAccept = true;
    await signUp("first");
    expect(error).toHaveBeenCalledWith(
      "share invite link acceptance failed",
      "user=first",
      "RangeError",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
    invite.failAccept = false;

    invite.clock += CLAIM_WINDOW_MS / 2;
    await expect(hooks()?.before?.(row("second"), withToken())).rejects.toThrow(IN_USE);
    invite.clock += CLAIM_WINDOW_MS;
    // The claimant has an account (it accepts signed in, auth.acceptInvite): nobody else may.
    await expect(hooks()?.before?.(row("third"), withToken())).rejects.toThrow(
      SIGNUP_DISABLED_MESSAGE,
    );
    expect(invite.claimedEmail).toBe("first@example.test");
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
  beforeEach(() => {
    getSignupAccessState.mockResolvedValue({ ...closed, signupEnabled: true });
  });

  it("still claims and accepts the invite, and signs up without it once it is used", async () => {
    await signUp("first");
    expect(invite.pending).toBe(false);
    await expect(signUp("second")).resolves.toMatchObject({ data: { role: "user" } });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("says the link is in use rather than signing up without the invite", async () => {
    await rolledBackSignUp("first");
    await expect(hooks()?.before?.(row("second"), withToken())).rejects.toThrow(IN_USE);
  });
});

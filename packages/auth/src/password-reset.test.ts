import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const renderResetPassword = vi.hoisted(() =>
  vi.fn((args: { url: string; locale: string }) => ({
    subject: `subject:${args.locale}`,
    html: `html:${args.url}`,
  })),
);

vi.mock("@ws-model-proxy/db", () => ({ default: { user: { findUnique } } }));
vi.mock("@ws-model-proxy/mailer", () => ({ renderResetPassword, sendEmail }));
const recordResetLinkMailed = vi.hoisted(() => vi.fn(async (_input: unknown) => true));
vi.mock("./password-reset-links", () => ({ recordResetLinkMailed }));

const {
  deliverResetPasswordEmail,
  passwordResetOptions,
  RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
  withResetPasswordCallback,
} = await import("./password-reset");

const API = "https://proxy.example.com/api/auth/reset-password/TOKEN123";
const withCallback = (callback: string) => `${API}?callbackURL=${encodeURIComponent(callback)}`;
const callbackOf = (url: string) => new URL(url).searchParams.get("callbackURL");

describe("withResetPasswordCallback", () => {
  it("points an empty callback at the recipient's locale-prefixed reset page", () => {
    expect(callbackOf(withResetPasswordCallback(`${API}?callbackURL=`, "es-MX"))).toBe(
      "/es-MX/reset-password",
    );
  });

  it("keeps the token path and leaves exactly one callbackURL", () => {
    const url = new URL(withResetPasswordCallback(withCallback("/en-US/reset-password"), "en-US"));
    expect(url.pathname).toBe("/api/auth/reset-password/TOKEN123");
    expect(url.searchParams.getAll("callbackURL")).toEqual(["/en-US/reset-password"]);
  });

  it("takes the locale of a requested reset page on a trusted origin", () => {
    expect(
      callbackOf(withResetPasswordCallback(withCallback("/es-MX/reset-password"), "en-US")),
    ).toBe("/es-MX/reset-password");
    expect(
      callbackOf(
        withResetPasswordCallback(
          withCallback("https://proxy.example.com/es-MX/reset-password"),
          "en-US",
        ),
      ),
    ).toBe("/es-MX/reset-password");
    expect(
      callbackOf(
        withResetPasswordCallback(
          withCallback("https://app.example.com/es-MX/reset-password"),
          "en-US",
          "https://app.example.com",
        ),
      ),
    ).toBe("https://app.example.com/es-MX/reset-password");
  });

  it("never honours another path or origin (the callback receives the token)", () => {
    for (const callback of [
      "/en-US/settings",
      "/es-MX/reset-password/../settings?x=1",
      "https://evil.example/es-MX/reset-password",
      "//evil.example/es-MX/reset-password",
      "\\\\evil.example/es-MX/reset-password",
      "javascript:alert(1)",
      "/fr-FR/reset-password",
      "/",
    ]) {
      expect(callbackOf(withResetPasswordCallback(withCallback(callback), "en-US"))).toBe(
        "/en-US/reset-password",
      );
    }
  });

  it("falls back to the default locale for an unsupported recipient locale", () => {
    for (const locale of ["fr-FR", "", undefined, null, "../../evil"]) {
      expect(callbackOf(withResetPasswordCallback(`${API}?callbackURL=`, locale))).toBe(
        "/en-US/reset-password",
      );
    }
  });

  it("absolutizes the callback onto the app origin on split-origin deploys", () => {
    expect(
      callbackOf(
        withResetPasswordCallback(`${API}?callbackURL=`, "en-US", "https://app.example.com"),
      ),
    ).toBe("https://app.example.com/en-US/reset-password");
  });

  it("returns an unparseable URL unchanged", () => {
    expect(withResetPasswordCallback("not a url", "en-US")).toBe("not a url");
  });
});

describe("passwordResetOptions", () => {
  beforeEach(() => {
    findUnique.mockReset();
    sendEmail.mockReset();
    renderResetPassword.mockClear();
    recordResetLinkMailed.mockReset();
    recordResetLinkMailed.mockResolvedValue(true);
  });

  it("offers no reset mail without SMTP but still revokes sessions on reset", () => {
    const options = passwordResetOptions(false, undefined);
    expect(options.sendResetPassword).toBeUndefined();
    expect(options.revokeSessionsOnPasswordReset).toBe(true);
    expect(options.resetPasswordTokenExpiresIn).toBe(RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS);
    expect(RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS).toBe(3600);
  });

  it("with SMTP, mails a localized link without waiting for delivery", async () => {
    findUnique.mockResolvedValue({ locale: "es-MX" });
    let releaseSend: () => void = () => {};
    sendEmail.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const options = passwordResetOptions(true, "https://app.example.com");

    // Settles while the mail is still in flight: SMTP latency must not reach the response.
    await options.sendResetPassword?.({
      user: { id: "u1", email: "person@example.com" },
      url: withCallback("/en-US/reset-password"),
      token: "TOKEN123",
    });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    releaseSend();
    // Recorded as mailed before the send: spending it verifies (and proves) the address.
    expect(recordResetLinkMailed).toHaveBeenCalledWith({
      token: "TOKEN123",
      userId: "u1",
      email: "person@example.com",
    });
    expect(recordResetLinkMailed.mock.invocationCallOrder[0]).toBeLessThan(
      sendEmail.mock.invocationCallOrder[0] ?? 0,
    );

    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { locale: true } });
    const rendered = renderResetPassword.mock.calls[0]?.[0];
    expect(rendered?.locale).toBe("es-MX");
    expect(callbackOf(rendered?.url ?? "")).toBe("https://app.example.com/en-US/reset-password");
    expect(sendEmail).toHaveBeenCalledWith({
      to: "person@example.com",
      subject: "subject:es-MX",
      html: expect.stringContaining("/api/auth/reset-password/TOKEN123"),
    });
  });

  it("a mail failure is logged by class only and never rejects", async () => {
    findUnique.mockResolvedValue(null);
    sendEmail.mockRejectedValue(new TypeError("smtp down for person@example.com"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deliverResetPasswordEmail(
        { id: "u1", email: "person@example.com" },
        `${API}?callbackURL=`,
        "TOKEN123",
        undefined,
      ),
    ).resolves.toBeUndefined();

    expect(renderResetPassword.mock.calls[0]?.[0]?.locale).toBe("en-US");
    expect(error).toHaveBeenCalledWith("[auth] password reset mail failed:", "TypeError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("person@example.com");
    error.mockRestore();
  });

  it("sends nothing when the link cannot be recorded as mailed (it would be refused)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const outcome of ["gone", "failed"] as const) {
      sendEmail.mockReset();
      if (outcome === "gone") recordResetLinkMailed.mockResolvedValueOnce(false);
      else recordResetLinkMailed.mockRejectedValueOnce(new TypeError("db down"));
      await expect(
        deliverResetPasswordEmail(
          { id: "u1", email: "person@example.com" },
          `${API}?callbackURL=`,
          "TOKEN123",
          undefined,
        ),
      ).resolves.toBeUndefined();
      expect(sendEmail).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(error.mock.calls)).not.toContain("TOKEN123");
    expect(JSON.stringify(error.mock.calls)).not.toContain("person@example.com");
    error.mockRestore();
  });
});

describe("a finished password reset", () => {
  async function spend({ invited, smtp = false }: { invited: boolean; smtp?: boolean }) {
    const { default: prisma } = await import("@ws-model-proxy/db");
    const calls: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, held: string[], wait: boolean) => {
        calls.push(`lock ${strings.join("?").trim()} ${JSON.stringify(held)} ${wait}`);
        return [{ acquired: true }];
      }),
      user: {
        updateMany: vi.fn(async (args: unknown) => {
          calls.push(`verify ${JSON.stringify(args)}`);
          return { count: 1 };
        }),
      },
      verification: {
        findFirst: vi.fn(async (args: unknown) => {
          calls.push(`mark? ${JSON.stringify(args)}`);
          return invited ? { id: "mark" } : null;
        }),
        deleteMany: vi.fn(async (args: unknown) => {
          calls.push(`delete ${JSON.stringify(args)}`);
          return { count: 1 };
        }),
      },
    };
    const transaction = vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx));
    Object.assign(prisma, { $transaction: transaction });
    await passwordResetOptions(smtp, undefined).onPasswordReset({
      user: { id: "u1", email: "invitee@example.test" },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    return calls;
  }
  const lock = 'lock SELECT wsmp_acquire_fences(?::text[], ?) AS acquired ["00:owner:u1"] true';
  const mark = `mark? ${JSON.stringify({ where: { identifier: "admin-invited:u1" }, select: { id: true } })}`;
  const deleteLinks = `delete ${JSON.stringify({ where: { value: "u1", identifier: { startsWith: "reset-password:" } } })}`;

  it("without SMTP activates an invited account and deletes every other reset link, under the owner fence", async () => {
    // The same per-user lock the invite link writer takes (packages/api set-password-link.ts),
    // first: a resend racing this reset either sees the account verified, or its link is deleted.
    expect(await spend({ invited: true })).toEqual([
      lock,
      mark,
      `verify ${JSON.stringify({ where: { id: "u1", email: "invitee@example.test" }, data: { emailVerified: true } })}`,
      deleteLinks,
    ]);
  });

  it("without SMTP leaves a public sign-up alone (it was created verified)", async () => {
    expect(await spend({ invited: false })).toEqual([lock, mark, deleteLinks]);
  });

  it("with SMTP verifies nothing itself: only a mailed link does, in the after-hook", async () => {
    // A link shown to the admin may have been spent: this callback cannot tell which.
    expect(await spend({ invited: true, smtp: true })).toEqual([lock, deleteLinks]);
    expect(await spend({ invited: false, smtp: true })).toEqual([lock, deleteLinks]);
  });
});

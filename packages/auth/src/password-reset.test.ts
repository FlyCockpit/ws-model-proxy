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
    });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    releaseSend();

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
        undefined,
      ),
    ).resolves.toBeUndefined();

    expect(renderResetPassword.mock.calls[0]?.[0]?.locale).toBe("en-US");
    expect(error).toHaveBeenCalledWith("[auth] password reset mail failed:", "TypeError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("person@example.com");
    error.mockRestore();
  });
});

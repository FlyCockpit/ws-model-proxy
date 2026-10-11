import { describe, expect, it } from "vitest";

import { renderResetPassword } from "./reset-password";

const URL_IN =
  "https://example.com/api/auth/reset-password/abc?callbackURL=%2Fen-US%2Freset-password";
const EN_BODY =
  "Someone asked to reset the password for your account. Click the button below to choose a new one. The link expires in one hour and can be used once.";

describe("renderResetPassword", () => {
  it("renders the en-US bundle with lang='en-US'", () => {
    const { subject, html } = renderResetPassword({ url: URL_IN, locale: "en-US" });

    expect(subject).toBe("Reset your password");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain(EN_BODY);
    expect(html).toContain(">\n            Reset password\n");
  });

  it("renders the es-MX bundle with lang='es-MX' and no English copy", () => {
    const { subject, html } = renderResetPassword({ url: URL_IN, locale: "es-MX" });

    expect(subject).toBe("Restablece tu contraseña");
    expect(html).toContain('<html lang="es-MX">');
    expect(html).toContain("Restablecer contraseña");
    expect(html).not.toContain(EN_BODY);
  });

  it("falls back to en-US for an unsupported locale", () => {
    const { subject, html } = renderResetPassword({ url: URL_IN, locale: "fr-FR" });

    expect(subject).toBe("Reset your password");
    expect(html).toContain('<html lang="en-US">');
  });

  it("escapes the link in the href attribute", () => {
    const { html } = renderResetPassword({
      url: "https://example.com/api/auth/reset-password/abc?callbackURL=%2Fx&a=b",
      locale: "en-US",
    });

    expect(html).toContain(
      'href="https://example.com/api/auth/reset-password/abc?callbackURL=%2Fx&amp;a=b"',
    );
  });

  it("rejects non-http links", () => {
    expect(() => renderResetPassword({ url: "javascript:alert(1)", locale: "en-US" })).toThrow(
      "Email link must use HTTP or HTTPS.",
    );
  });
});

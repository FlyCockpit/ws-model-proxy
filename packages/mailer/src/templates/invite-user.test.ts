import { describe, expect, it } from "vitest";

import { renderInviteUser } from "./invite-user";

describe("renderInviteUser", () => {
  const baseArgs = {
    name: "Jane Doe",
    email: "jane@example.com",
    setPasswordUrl: "https://example.com/api/auth/reset-password/tok",
    expiresInDays: 7,
  };

  it("returns the en-US bundle for locale='en-US'", () => {
    const { subject, html } = renderInviteUser({ ...baseArgs, locale: "en-US" });

    expect(subject).toBe("You've been invited");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("You've been invited");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
    expect(html).toContain("https://example.com/api/auth/reset-password/tok");
    expect(html).toContain("Your sign-in email"); // label
    expect(html).toContain("expires in 7 days"); // expiry note
    expect(html).toContain("Set your password"); // CTA
    // One mail does it all: the link also confirms the address, and an
    // expired link has a next step that needs no admin.
    expect(html).toContain("confirms your email address");
    expect(html).toContain("Forgot password?");
    // Never a password in the email.
    expect(html).not.toMatch(/temporary password/i);
  });

  it("returns the Spanish bundle for locale='es-MX'", () => {
    const { subject, html } = renderInviteUser({ ...baseArgs, locale: "es-MX" });

    expect(subject).not.toBe("");
    expect(html).toContain('<html lang="es-MX">');
    // The user-supplied data passes through the body regardless of locale.
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
    expect(html).toContain("https://example.com/api/auth/reset-password/tok");
    // The en-US CTA literal should not survive (would indicate fallback to
    // en-US per-key, i.e. unpopulated bundle).
    expect(html).not.toContain("Set your password");
    expect(html).toContain("vence en 7 días");
    expect(html).toContain("confirma tu correo");
    expect(html).toContain("¿Olvidaste tu contraseña?");
  });

  it("falls back to en-US for an unsupported locale", () => {
    const { subject, html } = renderInviteUser({ ...baseArgs, locale: "fr-FR" });

    expect(subject).toBe("You've been invited");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Set your password");
  });

  it("HTML-escapes user-provided values to defeat injection", () => {
    const { html } = renderInviteUser({
      ...baseArgs,
      name: '<script>alert("xss")</script>',
      email: 'evil"@example.com',
      locale: "en-US",
    });

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("evil&quot;@example.com");
  });

  it("escapes set-password href attribute values", () => {
    const { html } = renderInviteUser({
      ...baseArgs,
      setPasswordUrl: "https://example.com/api/auth/reset-password/tok?callbackURL=%2Fen-US&next=1",
      locale: "en-US",
    });

    expect(html).toContain(
      'href="https://example.com/api/auth/reset-password/tok?callbackURL=%2Fen-US&amp;next=1"',
    );
  });

  it("rejects non-http set-password URLs", () => {
    expect(() =>
      renderInviteUser({
        ...baseArgs,
        setPasswordUrl: "data:text/html,<script>alert(1)</script>",
        locale: "en-US",
      }),
    ).toThrow("Email link must use HTTP or HTTPS.");
  });
});

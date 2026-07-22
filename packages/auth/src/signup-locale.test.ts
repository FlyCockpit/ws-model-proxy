import { APP_LOCALE_HEADER, DEFAULT_LOCALE } from "@ws-model-proxy/config/locales";
import { describe, expect, it } from "vitest";
import { resolveSignupLocale } from "./signup-locale.js";

describe("resolveSignupLocale", () => {
  it("seeds the locale the client is rendering", () => {
    const headers = new Headers({ [APP_LOCALE_HEADER]: "es-MX" });
    expect(resolveSignupLocale(headers)).toBe("es-MX");
  });

  it("rejects unsupported client-controlled values", () => {
    for (const hostile of ["fr-FR", "es-mx", "en_US", "../../evil", "en-US, es-MX", ""]) {
      const headers = new Headers({ [APP_LOCALE_HEADER]: hostile });
      expect(resolveSignupLocale(headers)).toBe(DEFAULT_LOCALE);
    }
  });

  it("falls back to the default locale when the header is absent", () => {
    expect(resolveSignupLocale(new Headers())).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default locale when there is no request context", () => {
    expect(resolveSignupLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveSignupLocale(null)).toBe(DEFAULT_LOCALE);
  });
});

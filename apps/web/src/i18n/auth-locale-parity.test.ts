import { describe, expect, it } from "vitest";
import enAuth from "../locales/en-US/auth.json";
import esAuth from "../locales/es-MX/auth.json";

/**
 * Key-tree parity between the locale bundles' auth namespace. Every
 * user-facing MCP login/consent string (Phase 6) ships in BOTH bundles, so a
 * missing key can never leak the en-US fallback into an es-MX UI.
 */
function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("auth locale key parity (en-US / es-MX)", () => {
  // Scope note: full-file key-tree parity is a pre-existing drift (the en-US
  // bundle lacks es-MX's top-level "accountCreatedSuccess" key). This test
  // pins parity for the Phase 6 MCP additions, where BOTH bundles were
  // authored together; widening it to the whole file is a separate cleanup.
  it("has identical key trees for the MCP login/consent and verifyEmail sections", () => {
    expect(keyTree(esAuth.mcpLogin)).toEqual(keyTree(enAuth.mcpLogin));
    expect(keyTree(esAuth.mcpConsent)).toEqual(keyTree(enAuth.mcpConsent));
    expect(keyTree(esAuth.verifyEmail).sort()).toEqual(keyTree(enAuth.verifyEmail).sort());
  });

  it("keeps no-resend verifyEmail copy free of email-input prompts while preserving admin-verification copy", () => {
    expect(enAuth.verifyEmail.pendingDescriptionNoResend).not.toMatch(/enter your email/i);
    expect(enAuth.verifyEmail.invalidDescriptionNoResend).not.toMatch(/enter your email/i);
    expect(esAuth.verifyEmail.pendingDescriptionNoResend).not.toMatch(/ingresa tu correo/i);
    expect(esAuth.verifyEmail.invalidDescriptionNoResend).not.toMatch(/ingresa tu correo/i);
    expect(enAuth.verifyEmail.emailUnavailable).toMatch(
      /ask an administrator to verify your account/i,
    );
    expect(enAuth.verifyEmail.accountCreatedNoEmail).toMatch(
      /ask an administrator to verify your account/i,
    );
    expect(esAuth.verifyEmail.emailUnavailable).toMatch(
      /pide a un administrador que verifique tu cuenta/i,
    );
    expect(esAuth.verifyEmail.accountCreatedNoEmail).toMatch(
      /pide a un administrador que verifique tu cuenta/i,
    );
  });

  it("ties the narrowing warning to authorization in every locale", () => {
    expect(enAuth.mcpConsent.narrowWarning).toMatch(/^Authorizing removes access immediately/);
    expect(esAuth.mcpConsent.narrowWarning).toMatch(
      /^Al autorizar, el acceso se quita de inmediato/,
    );
    expect(enAuth.mcpConsent.narrowWarning).not.toContain("Saving");
    expect(esAuth.mcpConsent.narrowWarning).not.toContain("Al guardar");
  });

  it("contains the full MCP login/consent key sets in both bundles", () => {
    for (const bundle of [enAuth, esAuth]) {
      expect(keyTree(bundle.mcpLogin).sort()).toEqual(
        [
          "title",
          "description",
          "clientDescription",
          "reauthTitle",
          "reauthDescription",
          "reauthConfirm",
          "signOutFailed",
          "signingOut",
          "invalidTitle",
          "invalidDescription",
        ].sort(),
      );
      expect(keyTree(bundle.mcpConsent).sort()).toEqual(
        [
          "title",
          "description",
          "unknownClient",
          "scopesTitle",
          "noScopes",
          "readOnlyRequested",
          "narrowWarning",
          "accept",
          "deny",
          "submitting",
          "deniedTitle",
          "deniedDescription",
          "invalidTitle",
          "invalidDescription",
          "manageNote",
          "returnsTo",
          "failedTitle",
          "failedDescription",
          "connectionsFailed",
          "requestedCeiling",
          "widenNotice",
          "scopes.read.name",
          "scopes.read.description",
          "scopes.offline_access.name",
          "scopes.offline_access.description",
          "scopes.additionalName",
          "scopes.additionalDescription",
        ].sort(),
      );
    }
  });
});

import { describe, expect, it } from "vitest";

import { ENV_VARS } from "./lib/env-manifest";
import { generateProviderCredentialKeyring } from "./lib/provider-credential-keyring";

const KEYRING = /^v1:[A-Za-z0-9+/]{43}=$/;

describe("provider credential keyring generator", () => {
  it("emits v1: plus standard base64 of 32 bytes", () => {
    const value = generateProviderCredentialKeyring();
    expect(value).toMatch(KEYRING);
    expect(value.startsWith("v1:")).toBe(true);
    expect(value).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the manifest generator for the encryption keyring, not secret32", () => {
    const entry = ENV_VARS.find(
      (variable) => variable.key === "WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS",
    );
    expect(entry).toMatchObject({ source: "generate", generator: "keyring", secret: true });
    expect(entry?.example).toBeUndefined();
  });
});

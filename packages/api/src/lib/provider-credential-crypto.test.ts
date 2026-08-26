import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  parseProviderCredentialKeyring,
  providerCredentialNeedsRotation,
} from "./provider-credential-crypto";

const key = () => randomBytes(32).toString("base64");
const identity = {
  userId: "owner-1",
  providerAccountId: "account-1",
  credentialId: "credential-1",
  credentialType: "API_KEY" as const,
  aadVersion: 1,
};

describe("provider credential encryption", () => {
  it("round trips, uses unique nonces, and exposes only a suffix", () => {
    const keyring = parseProviderCredentialKeyring(`v2:${key()}`);
    const first = encryptProviderCredential("super-secret-value", identity, keyring);
    const second = encryptProviderCredential("super-secret-value", identity, keyring);
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
    expect(first.displaySuffix).toBe("alue");
    expect(decryptProviderCredential(first, identity, keyring)).toBe("super-secret-value");
  });

  it.each(["userId", "providerAccountId", "credentialId", "credentialType", "aadVersion"] as const)(
    "rejects %s identity substitution",
    (field) => {
      const keyring = parseProviderCredentialKeyring(`v1:${key()}`);
      const encrypted = encryptProviderCredential("secret", identity, keyring);
      const changed = { ...identity, [field]: field === "aadVersion" ? 2 : "substituted" };
      expect(() =>
        decryptProviderCredential(encrypted, changed as typeof identity, keyring),
      ).toThrow();
    },
  );

  it("detects ciphertext, nonce, and tag tampering", () => {
    const keyring = parseProviderCredentialKeyring(`v1:${key()}`);
    const encrypted = encryptProviderCredential("secret", identity, keyring);
    for (const field of ["ciphertext", "nonce", "authTag"] as const) {
      const tampered = { ...encrypted, [field]: Buffer.from(encrypted[field]) };
      tampered[field][0] ^= 1;
      expect(() => decryptProviderCredential(tampered, identity, keyring)).toThrow();
    }
  });

  it("reads old keys, writes the active key, and fails closed for unknown versions", () => {
    const oldKey = key();
    const oldRing = parseProviderCredentialKeyring(`old:${oldKey}`);
    const encrypted = encryptProviderCredential("secret", identity, oldRing);
    const rotatedRing = parseProviderCredentialKeyring(`active:${key()},old:${oldKey}`);
    expect(decryptProviderCredential(encrypted, identity, rotatedRing)).toBe("secret");
    expect(providerCredentialNeedsRotation(encrypted, rotatedRing)).toBe(true);
    expect(() =>
      decryptProviderCredential({ ...encrypted, keyVersion: "missing" }, identity, rotatedRing),
    ).toThrow();
    expect(encryptProviderCredential("new", identity, rotatedRing).keyVersion).toBe("active");
  });
});

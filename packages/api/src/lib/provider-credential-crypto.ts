import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const AAD_DOMAIN = "ws-model-proxy/provider-credential";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface ProviderCredentialIdentity {
  userId: string;
  providerAccountId: string;
  credentialId: string;
  credentialType: "API_KEY" | "BEARER";
  aadVersion: number;
}

export interface EncryptedProviderCredential {
  algorithm: "AES-256-GCM";
  keyVersion: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  displaySuffix: string;
}

export interface ProviderCredentialKeyring {
  activeVersion: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Parses `version:base64key,old-version:base64key`. The first entry is the
 * active write key; remaining entries are decrypt-only rotation keys.
 */
export function parseProviderCredentialKeyring(value: string): ProviderCredentialKeyring {
  const keys = new Map<string, Buffer>();
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("Provider credential keyring entries must use version:base64key");
    }
    const version = entry.slice(0, separator);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(version) || keys.has(version)) {
      throw new Error("Provider credential key versions must be unique safe identifiers");
    }
    const encoded = entry.slice(separator + 1);
    const key = Buffer.from(encoded, "base64");
    if (
      key.byteLength !== 32 ||
      key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
    ) {
      throw new Error(
        "Provider credential encryption keys must be canonical base64-encoded 32-byte keys",
      );
    }
    keys.set(version, key);
  }
  const activeVersion = keys.keys().next().value;
  if (!activeVersion) throw new Error("Provider credential encryption keyring is empty");
  return { activeVersion, keys };
}

function aad(identity: ProviderCredentialIdentity): Buffer {
  if (!Number.isSafeInteger(identity.aadVersion) || identity.aadVersion < 1) {
    throw new Error("Unsupported provider credential AAD version");
  }
  // A length-delimited JSON tuple avoids ambiguity and intentionally excludes
  // mutable account metadata such as label, base URL, status, and timestamps.
  return Buffer.from(
    JSON.stringify([
      AAD_DOMAIN,
      identity.aadVersion,
      identity.userId,
      identity.providerAccountId,
      identity.credentialId,
      identity.credentialType,
    ]),
    "utf8",
  );
}

export function encryptProviderCredential(
  plaintext: string,
  identity: ProviderCredentialIdentity,
  keyring: ProviderCredentialKeyring,
): EncryptedProviderCredential {
  if (plaintext.length === 0) throw new Error("Provider credential cannot be empty");
  const key = keyring.keys.get(keyring.activeVersion);
  if (!key) throw new Error("Active provider credential key is unavailable");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: "AES-256-GCM",
    keyVersion: keyring.activeVersion,
    ciphertext: Uint8Array.from(ciphertext),
    nonce: Uint8Array.from(nonce),
    authTag: Uint8Array.from(cipher.getAuthTag()),
    displaySuffix: [...plaintext].slice(-4).join(""),
  };
}

export function decryptProviderCredential(
  encrypted: Omit<EncryptedProviderCredential, "displaySuffix">,
  identity: ProviderCredentialIdentity,
  keyring: ProviderCredentialKeyring,
): string {
  if (encrypted.algorithm !== "AES-256-GCM")
    throw new Error("Unsupported provider credential algorithm");
  if (encrypted.nonce.byteLength !== NONCE_BYTES || encrypted.authTag.byteLength !== TAG_BYTES) {
    throw new Error("Invalid provider credential envelope");
  }
  const key = keyring.keys.get(encrypted.keyVersion);
  if (!key) throw new Error("Provider credential key version is unavailable");
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}

export function providerCredentialNeedsRotation(
  encrypted: Pick<EncryptedProviderCredential, "keyVersion">,
  keyring: ProviderCredentialKeyring,
): boolean {
  return encrypted.keyVersion !== keyring.activeVersion;
}

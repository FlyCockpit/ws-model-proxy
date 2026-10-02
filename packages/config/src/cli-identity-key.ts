/**
 * CLI identity public key used as the device-credential bind.
 *
 * `wsmp login` sends the persistent P-256 identity public key from
 * `terminal-identity.json`. The exchange stores that value on the credential.
 * Every later hello must present the same key and prove possession by signing
 * a server nonce. Hostname stays a display label.
 *
 * The wire encoding matches the relay hello (`uncompressedP256PublicKeySchema`).
 */

/** Uncompressed P-256 point: 65 bytes, leading 0x04, unpadded base64url (87 characters). */
const IDENTITY_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;

/**
 * What a copied credential's hello is told. Printed by wsmp before it exits.
 * Re-login mints a credential bound to the identity key that is actually running.
 */
export const DEVICE_CREDENTIAL_IDENTITY_MISMATCH_MESSAGE =
  "This device credential is bound to another CLI identity key. Run `wsmp login` on this machine.";

/**
 * What a CLI token hello is told when its TOFU-bound identity key does not
 * match. The owner can reset the bind from the dashboard without revoking
 * the token.
 */
export const CLI_TOKEN_IDENTITY_MISMATCH_MESSAGE =
  "This CLI token is bound to another CLI identity key. Reset the token identity bind, or use the machine that first registered it.";

/**
 * Normalize a CLI identity public key, or null when it is not an uncompressed
 * P-256 point. Trims; does not rewrite the base64url (it is case-sensitive).
 */
export function normalizeIdentityPublicKey(raw: string): string | null {
  const value = raw.trim();
  if (!IDENTITY_PUBLIC_KEY_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 65 || bytes[0] !== 0x04) return null;
  return value;
}

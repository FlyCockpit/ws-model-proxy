import { randomBytes } from "node:crypto";

/**
 * Active provider-credential keyring entry. `secret32` is hex and is the wrong
 * format: the env schema requires `version:` plus standard base64 of 32 bytes
 * (44 characters, one trailing `=`).
 */
export function generateProviderCredentialKeyring(): string {
  return `v1:${randomBytes(32).toString("base64")}`;
}

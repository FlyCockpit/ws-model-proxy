/**
 * Defense-in-depth redactor for MCP tool output (it runs after the procedure's own output
 * schema, which is the primary control). It never restores removed data; it only hides
 * credential material that reached output by mistake:
 *
 * - VALUES: any string that is, or embeds, a product credential (`wsmp_key_`, `wsmp_node_`,
 *   `wsmp_agent_`, `wsmp_enr_`, `wsmp_inv_` — `PRODUCT_CREDENTIAL_PREFIXES`), and bearer/DPoP
 *   authorization values and JWTs, under any key.
 * - KEYS: only exact names that hold credential values (`secretDigest`, `password`,
 *   `accessToken`, `privateKey`, …), compared case-insensitively with `_`/`-` ignored.
 *   Names that merely mention a secret stay visible: node secret NAMES (`secretNames`,
 *   `secrets[].name`, `WSMP_SECRET_*`) are product data the output schemas promise.
 *
 * Node secret VALUES never reach output at all: the sensitive procedures return names only.
 * It never throws and always returns a new value.
 */

import { PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/node-security";
import { isPrismaDecimalLike } from "./serialization";

/** Marker substituted for every redacted value. */
export const MCP_REDACTED_VALUE = "[redacted]";

/** Normalized (lower case, no `_`/`-`) key names whose values are credentials. */
const CREDENTIAL_VALUE_KEYS: ReadonlySet<string> = new Set([
  "secretdigest",
  "tokendigest",
  "codedigest",
  "clientsecret",
  "password",
  "passwordhash",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "privatekey",
  "ciphertext",
  "authtag",
  "encryptionkey",
  "backupcodes",
  "apikeysecret",
  "bearertoken",
]);

function isCredentialValueKey(key: string): boolean {
  return CREDENTIAL_VALUE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

const PREFIXES = Object.values(PRODUCT_CREDENTIAL_PREFIXES);

/** A product credential embedded in text (credential-length random part only). */
const EMBEDDED_PRODUCT_CREDENTIAL = new RegExp(`(?:${PREFIXES.join("|")})[A-Za-z0-9_.-]{20,}`, "g");
/** `Bearer …` / `DPoP …` authorization values. */
const AUTHORIZATION_VALUE = /\b(?:Bearer|DPoP)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
/** Compact JWS/JWT (three base64url segments, header starting `eyJ`). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactString(value: string): string {
  if (PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length + 8))
    return MCP_REDACTED_VALUE;
  return value
    .replace(EMBEDDED_PRODUCT_CREDENTIAL, MCP_REDACTED_VALUE)
    .replace(AUTHORIZATION_VALUE, MCP_REDACTED_VALUE)
    .replace(JWT, MCP_REDACTED_VALUE);
}

const MAX_REDACTION_DEPTH = 24;

/** Recursively redact credential values and credential-value keys. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return MCP_REDACTED_VALUE;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    // Kinds the serializer converts structurally pass through by reference.
    if (value instanceof Date || value instanceof Uint8Array || isPrismaDecimalLike(value))
      return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value))
      out[key] = isCredentialValueKey(key) ? MCP_REDACTED_VALUE : redactSecrets(entry, depth + 1);
    return out;
  }
  return value;
}

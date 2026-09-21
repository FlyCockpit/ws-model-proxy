/**
 * Recursive defense-in-depth secret-key redactor for MCP tool output
 * (Phase 5 — "Serialization and errors").
 *
 * Layering contract (order matters):
 *   1. descriptor-specific safe projections (tool-manifest.ts) run FIRST and
 *      are the primary control — they pick exactly the fields a tool may
 *      return;
 *   2. THIS redactor runs SECOND over whatever the projection produced. It
 *      can never restore removed data, so it is pure defense: if a future
 *      procedure change starts returning a secret-bearing key that no
 *      projection anticipated, the value is replaced with `[redacted]`
 *      before serialization.
 *
 * What it redacts:
 * - VALUES under keys whose names carry credential/secret semantics
 *   (`secret`, `ciphertext`, `nonce`, `authTag`, token hashes, OAuth/JWT
 *   material, passwords, bearer/authorization material, a bare `token` or
 *   `credential` key, private keys, JWKs, API keys). Key matching is
 *   substring-on-normalized-key (case-insensitive, `_`/`-` equivalent) so
 *   spellings like `secretDigest`, `client_secret`, `auth-tag` all match;
 *   metadata fields that merely DESCRIBE a secret (`credentialType`,
 *   `displaySuffix`, `keyVersion`, `lookupPrefix`) deliberately do NOT
 *   match any rule and remain visible.
 * - STRING VALUES that carry a live product credential by prefix
 *   (`wsmp_model_…`, `wsmp_cli_…`, `wsmp_device_…` — the shared
 *   `PRODUCT_CREDENTIAL_PREFIXES` constants) under ANY key, so a raw token
 *   that reached an unexpected field never reaches tool output.
 *
 * It never throws: unknown shapes pass through structurally (serialization
 * handles them next). Redaction always produces a NEW object; input values
 * are never mutated.
 */

import { PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/forwarder-security";
import { isPrismaDecimalLike } from "./serialization";

/** Marker substituted for every redacted value. */
export const MCP_REDACTED_VALUE = "[redacted]";

/**
 * Secret-bearing key fragments. Each entry matches as a substring of the
 * normalized key name. Add fragments ONLY for keys whose VALUES are secrets
 * — never for names that merely describe secret metadata.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  "secret",
  "ciphertext",
  "nonce",
  "authtag",
  "tokenhash",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "password",
  "authorization",
  "bearer",
  "dpop",
  "privatekey",
  "apikey",
  "signature",
  "jwk",
  "jwt",
  "encryptionkey",
  "hmac",
];

/** Exact key names (after lowercasing) that bear whole secrets. */
const SECRET_EXACT_KEYS: ReadonlySet<string> = new Set(["token", "credential"]);

function isSecretBearingKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SECRET_EXACT_KEYS.has(normalized)) return true;
  // `_` and `-` are collapsed so `client_secret`, `client-secret`, and
  // `clientSecret` (via case folding) all match the `secret` fragment.
  const collapsed = normalized.replace(/[-_]/g, "");
  return SECRET_KEY_FRAGMENTS.some((fragment) => collapsed.includes(fragment));
}

function carriesProductCredential(value: string): boolean {
  return (
    value.startsWith(PRODUCT_CREDENTIAL_PREFIXES.modelApiToken) ||
    value.startsWith(PRODUCT_CREDENTIAL_PREFIXES.cliToken) ||
    value.startsWith(PRODUCT_CREDENTIAL_PREFIXES.deviceCredential)
  );
}

/** Depth bound: mirrors the serialization bound; deeper nests redact whole. */
const MAX_REDACTION_DEPTH = 24;

/** Recursively redact secret-bearing keys and product-credential values. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return MCP_REDACTED_VALUE;
  if (typeof value === "string") {
    return carriesProductCredential(value) ? MCP_REDACTED_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    // KINDS THE SERIALIZER CONVERTS STRUCTURALLY (without enumerating
    // fields) pass through BY REFERENCE: Dates (→ ISO string), byte
    // containers (→ elision marker), and Prisma Decimal-like values
    // (→ decimal string). Rebuilding any of these here would destroy the
    // structural shape the serializer depends on.
    if (value instanceof Date || value instanceof Uint8Array || isPrismaDecimalLike(value)) {
      return value;
    }
    // ALIGNMENT WITH THE SERIALIZER (G8b): every OTHER object — plain
    // records AND unknown class instances — is enumerated by
    // `toJsonSafe`'s generic object arm, so the redactor rebuilds exactly
    // that enumeration (own enumerable entries) with secret-bearing keys
    // redacted. A class instance with a `secret` field therefore redacts
    // the SAME way a plain object would; the serializer then emits the
    // already-redacted plain copy (identical field set — Object.entries is
    // the shared enumeration). Map/Set instances enumerate to `{}`
    // downstream either way; cycles are bounded by the depth guard.
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSecretBearingKey(key) ? MCP_REDACTED_VALUE : redactSecrets(entry, depth + 1);
    }
    return out;
  }
  return value;
}

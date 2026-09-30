/**
 * Keyed digest for the agent audit log's command `path`.
 *
 * A bare SHA-256 of the command lets anyone who can read the table check
 * guesses of short secrets on the command line (`mysql -pPassword1`). This
 * module instead returns HMAC-SHA256 of the well-formed command text under a
 * key derived from the server's auth secret with HKDF-SHA256 and the fixed info
 * label {@link CLI_AGENT_ACTION_AUDIT_HKDF_INFO}. The key is never stored or
 * logged, so a database dump alone cannot confirm a candidate command.
 *
 * Fail-open-to-safe: when the secret is missing or derivation fails, the digest
 * is {@link CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE} (stored as
 * `hmac-sha256:unavailable <program>`), which leaks nothing and, unlike a bare
 * hash, cannot be checked against guesses. The audit event is still written and
 * the command never fails.
 *
 * The key is derived lazily on first use and cached in module scope, keyed by
 * the secret string so a test that changes the secret re-derives.
 */
import { createHmac, hkdfSync } from "node:crypto";
import {
  CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE,
  CLI_AGENT_ACTION_AUDIT_HKDF_INFO,
} from "@ws-model-proxy/config/cli-agent-audit";
import { env } from "@ws-model-proxy/env/server";

const KEY_BYTES = 32;

/**
 * HKDF-SHA256 key for the audit digest, or null when no secret is available.
 * Empty salt is deliberate: the fixed info label is the domain separation, and
 * the auth secret is already high-entropy. A throw (it should not) degrades to
 * null, never to an unkeyed hash.
 */
export function deriveCommandAuditKey(secret: string | null | undefined): Buffer | null {
  if (typeof secret !== "string" || secret.length === 0) return null;
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(secret, "utf8"),
        Buffer.alloc(0),
        CLI_AGENT_ACTION_AUDIT_HKDF_INFO,
        KEY_BYTES,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * A digest function for the given secret: lowercase hex HMAC-SHA256 of the
 * text, or {@link CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE} when the key cannot
 * be derived. Never throws.
 */
export function commandAuditDigestFor(secret: string | null | undefined): (text: string) => string {
  const key = deriveCommandAuditKey(secret);
  return (text) => {
    if (key === null) return CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE;
    try {
      return createHmac("sha256", key).update(text).digest("hex");
    } catch {
      return CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE;
    }
  };
}

let cachedSecret: string | null | undefined;
let cachedDigest: ((text: string) => string) | null = null;

/**
 * The server's audit digest, keyed by BETTER_AUTH_SECRET. Derived once per
 * secret value and cached in module scope. The digest function itself decides
 * the unavailable outcome, so this never throws and never logs.
 */
export function commandAuditDigest(text: string): string {
  const secret = env.BETTER_AUTH_SECRET;
  if (cachedDigest === null || secret !== cachedSecret) {
    cachedDigest = commandAuditDigestFor(secret);
    cachedSecret = secret;
  }
  return cachedDigest(text);
}

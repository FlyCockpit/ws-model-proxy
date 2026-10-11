/**
 * Audit subject of a node command: `hmac-sha256:<hex> <program>` (never the text). Same key
 * derivation as apps/server/src/relay/command-audit-digest.ts (HKDF-SHA256 of the auth secret
 * with the fixed info label), so digests from either side verify against each other.
 */
import { createHmac, hkdfSync } from "node:crypto";
import {
  CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE,
  CLI_AGENT_ACTION_AUDIT_HKDF_INFO,
  commandAuditPath,
} from "@ws-model-proxy/config/cli-agent-audit";
import { env } from "@ws-model-proxy/env/server";

let cached: { secret: string | undefined; key: Buffer | null } | null = null;

function auditKey(): Buffer | null {
  const secret = env.BETTER_AUTH_SECRET;
  if (cached && cached.secret === secret) return cached.key;
  let key: Buffer | null = null;
  if (typeof secret === "string" && secret.length > 0) {
    try {
      key = Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from(secret, "utf8"),
          Buffer.alloc(0),
          CLI_AGENT_ACTION_AUDIT_HKDF_INFO,
          32,
        ),
      );
    } catch {
      key = null;
    }
  }
  cached = { secret, key };
  return key;
}

function digest(text: string): string {
  const key = auditKey();
  if (!key) return CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE;
  try {
    return createHmac("sha256", key).update(text).digest("hex");
  } catch {
    return CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE;
  }
}

export function commandAuditSubject(command: string): string {
  return commandAuditPath(command, digest);
}

/** The program name stored after the digest (`?` when unknown). */
export function programOfSubject(subject: string): string {
  const space = subject.lastIndexOf(" ");
  return space >= 0 ? subject.slice(space + 1) || "?" : "?";
}

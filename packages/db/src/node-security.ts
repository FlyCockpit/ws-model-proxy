import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@ws-model-proxy/env/server";

export const PRODUCT_CREDENTIAL_SECRET_BYTES = 32;

/**
 * Prefixes of every bearer secret the product mints. Redaction (MCP output, logs) masks any
 * value that starts with one of them.
 */
export const PRODUCT_CREDENTIAL_PREFIXES = {
  apiKey: "wsmp_key_",
  nodeCredential: "wsmp_node_",
  agentToken: "wsmp_agent_",
  enrollmentCode: "wsmp_enr_",
  shareInvite: "wsmp_inv_",
} as const;

/** HMAC purposes: one derived key per purpose, so a digest never verifies across purposes. */
export const HMAC_CONTEXTS = {
  apiKey: "ws-model-proxy:api-key:v1",
  nodeCredential: "ws-model-proxy:node-credential:v1",
  agentToken: "ws-model-proxy:agent-token:v1",
  enrollmentCode: "ws-model-proxy:enrollment-code:v1",
  shareInvite: "ws-model-proxy:share-invite:v1",
  responsesStickiness: "ws-model-proxy:responses-stickiness:v1",
  responsesStickinessUpstreamId: "ws-model-proxy:responses-stickiness-upstream-id:v1",
  cacheAffinity: "ws-model-proxy:cache-affinity:v1",
  mediaSignedUrl: "ws-model-proxy:media-signed-url:v1",
} as const;

export type ProductCredentialPurpose = keyof typeof PRODUCT_CREDENTIAL_PREFIXES;
export type HmacPurpose = keyof typeof HMAC_CONTEXTS;

export function generateProductCredentialSecret(purpose: ProductCredentialPurpose): string {
  return `${PRODUCT_CREDENTIAL_PREFIXES[purpose]}${randomBytes(PRODUCT_CREDENTIAL_SECRET_BYTES).toString("base64url")}`;
}

export function credentialLookupPrefix(secret: string): string {
  const prefix = Object.values(PRODUCT_CREDENTIAL_PREFIXES).find((candidate) =>
    secret.startsWith(candidate),
  );
  const visibleRandomChars = 12;
  return secret.slice(0, (prefix?.length ?? 0) + visibleRandomChars);
}

function derivePurposeKey(purpose: HmacPurpose, betterAuthSecret: string): Buffer {
  return createHmac("sha256", Buffer.from(betterAuthSecret, "utf8"))
    .update(HMAC_CONTEXTS[purpose])
    .digest();
}

export function hmacDigestForPurpose({
  purpose,
  value,
  betterAuthSecret = env.BETTER_AUTH_SECRET,
}: {
  purpose: HmacPurpose;
  value: string;
  betterAuthSecret?: string;
}): string {
  return createHmac("sha256", derivePurposeKey(purpose, betterAuthSecret))
    .update(value)
    .digest("base64url");
}

/**
 * The stored `secretDigest` / `codeDigest` / `tokenDigest` of a product credential: the purpose
 * HMAC as 64 lower-case hex characters (the hardening shape of those columns).
 */
export function credentialDigest(
  purpose: ProductCredentialPurpose,
  secret: string,
  betterAuthSecret: string = env.BETTER_AUTH_SECRET,
): string {
  return createHmac("sha256", derivePurposeKey(purpose, betterAuthSecret))
    .update(secret)
    .digest("hex");
}

export function verifyHmacDigest({
  purpose,
  value,
  digest,
  betterAuthSecret = env.BETTER_AUTH_SECRET,
}: {
  purpose: HmacPurpose;
  value: string;
  digest: string;
  betterAuthSecret?: string;
}): boolean {
  const candidate = hmacDigestForPurpose({ purpose, value, betterAuthSecret });
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const digestBuffer = Buffer.from(digest, "utf8");
  return (
    candidateBuffer.length === digestBuffer.length && timingSafeEqual(candidateBuffer, digestBuffer)
  );
}

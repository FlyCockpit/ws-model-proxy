import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@ws-model-proxy/env/server";

export const PRODUCT_CREDENTIAL_SECRET_BYTES = 32;

export const PRODUCT_CREDENTIAL_PREFIXES = {
  modelApiToken: "wsmp_model_",
  cliToken: "wsmp_cli_",
  deviceCredential: "wsmp_device_",
} as const;

export const FORWARDER_HMAC_CONTEXTS = {
  modelApiToken: "ws-model-proxy:model-api-token:v1",
  cliToken: "ws-model-proxy:cli-token:v1",
  deviceCredential: "ws-model-proxy:device-credential:v1",
  responsesStickiness: "ws-model-proxy:responses-stickiness:v1",
  mediaSignedUrl: "ws-model-proxy:media-signed-url:v1",
} as const;

export type ProductCredentialPurpose = keyof typeof PRODUCT_CREDENTIAL_PREFIXES;
export type ForwarderHmacPurpose = keyof typeof FORWARDER_HMAC_CONTEXTS;

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

function derivePurposeKey(purpose: ForwarderHmacPurpose, betterAuthSecret: string): Buffer {
  return createHmac("sha256", Buffer.from(betterAuthSecret, "utf8"))
    .update(FORWARDER_HMAC_CONTEXTS[purpose])
    .digest();
}

export function hmacDigestForForwarderPurpose({
  purpose,
  value,
  betterAuthSecret = env.BETTER_AUTH_SECRET,
}: {
  purpose: ForwarderHmacPurpose;
  value: string;
  betterAuthSecret?: string;
}): string {
  return createHmac("sha256", derivePurposeKey(purpose, betterAuthSecret))
    .update(value)
    .digest("base64url");
}

export function verifyForwarderHmacDigest({
  purpose,
  value,
  digest,
  betterAuthSecret = env.BETTER_AUTH_SECRET,
}: {
  purpose: ForwarderHmacPurpose;
  value: string;
  digest: string;
  betterAuthSecret?: string;
}): boolean {
  const candidate = hmacDigestForForwarderPurpose({ purpose, value, betterAuthSecret });
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const digestBuffer = Buffer.from(digest, "utf8");
  return (
    candidateBuffer.length === digestBuffer.length && timingSafeEqual(candidateBuffer, digestBuffer)
  );
}

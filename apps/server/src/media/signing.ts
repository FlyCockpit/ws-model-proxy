import {
  hmacDigestForForwarderPurpose,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";

/**
 * Short-lived signature TTL for signed GET URLs. This is DELIBERATELY separate
 * from (and much shorter than) the asset TTL (hours): the signature only needs
 * to live long enough for the upstream/model fetcher to GET the bytes once,
 * shortly after the client asks for a fresh URL at send time.
 */
export const MEDIA_SIGNATURE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Canonical string signed by the HMAC. Signing over `id + "." + exp` binds the
 * signature to both the asset and its expiry, so an attacker can neither swap
 * the id nor extend the window.
 */
function signedValue(id: string, expUnixSeconds: number): string {
  return `${id}.${expUnixSeconds}`;
}

export interface SignedMediaUrl {
  id: string;
  url: string;
  signatureExpiresAt: string;
}

/**
 * Build a fresh signed URL for an asset id. The signing key is DERIVED from
 * BETTER_AUTH_SECRET via the `mediaSignedUrl` forwarder purpose — there is no
 * separate media signing secret.
 *
 * URL shape: `${publicBaseUrl}/media/:id?exp=<unixSeconds>&sig=<base64url>`
 */
export function buildSignedMediaUrl({
  id,
  publicBaseUrl,
  now = Date.now(),
  ttlMs = MEDIA_SIGNATURE_TTL_MS,
}: {
  id: string;
  publicBaseUrl: string;
  now?: number;
  ttlMs?: number;
}): SignedMediaUrl {
  const expUnixSeconds = Math.floor((now + ttlMs) / 1000);
  const sig = hmacDigestForForwarderPurpose({
    purpose: "mediaSignedUrl",
    value: signedValue(id, expUnixSeconds),
  });
  const base = publicBaseUrl.replace(/\/+$/, "");
  const url = `${base}/media/${encodeURIComponent(id)}?exp=${expUnixSeconds}&sig=${sig}`;
  return {
    id,
    url,
    signatureExpiresAt: new Date(expUnixSeconds * 1000).toISOString(),
  };
}

export type MediaSignatureCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

/**
 * Verify a signed GET request: the `exp` must be a valid future unix timestamp
 * and the `sig` must match (timing-safe, via the forwarder-security helper).
 */
export function verifyMediaSignature({
  id,
  exp,
  sig,
  now = Date.now(),
}: {
  id: string;
  exp: string | undefined | null;
  sig: string | undefined | null;
  now?: number;
}): MediaSignatureCheck {
  if (!exp || !sig) return { ok: false, reason: "malformed" };
  const expUnixSeconds = Number(exp);
  if (!Number.isInteger(expUnixSeconds) || expUnixSeconds <= 0) {
    return { ok: false, reason: "malformed" };
  }
  // Timing-safe compare BEFORE the expiry check so a mismatched signature and
  // an expired-but-valid signature are indistinguishable by early-return.
  const valid = verifyForwarderHmacDigest({
    purpose: "mediaSignedUrl",
    value: signedValue(id, expUnixSeconds),
    digest: sig,
  });
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (expUnixSeconds * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}

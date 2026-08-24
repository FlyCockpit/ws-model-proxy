import { env } from "@ws-model-proxy/env/server";

/**
 * Resolved, validated media-store configuration. Only produced when the local
 * backend is fully configured; otherwise upload/sign routes short-circuit with
 * a "not configured" error.
 */
export interface MediaConfig {
  storage: "local";
  root: string;
  maxUploadBytes: number;
  /**
   * Total bytes one user may hold in unexpired assets. 0 disables the quota.
   * Enforced in uploadMedia so both upload routes inherit it.
   */
  maxBytesPerUser: number;
  /** Public origin used to build signed URLs (no trailing slash). */
  publicBaseUrl: string;
}

/**
 * Returns the resolved config, or `null` when media is not configured. Callers
 * that reach here with `null` should return the "media upload is not
 * configured" error to the client.
 */
export function getMediaConfig(): MediaConfig | null {
  if (env.MEDIA_STORAGE !== "local" || !env.MEDIA_ROOT) return null;
  const publicBaseUrl = (env.MEDIA_PUBLIC_BASE_URL ?? env.BETTER_AUTH_URL).replace(/\/+$/, "");
  return {
    storage: "local",
    root: env.MEDIA_ROOT,
    maxUploadBytes: env.MEDIA_MAX_UPLOAD_BYTES,
    maxBytesPerUser: env.MEDIA_MAX_BYTES_PER_USER,
    publicBaseUrl,
  };
}

export const MEDIA_NOT_CONFIGURED_MESSAGE =
  "Media upload is not configured on this server. Send images/audio/video as base64 data URLs or external https URLs instead.";

/**
 * Shared media-asset TTL policy constants and clamp. Lives in
 * @ws-model-proxy/config so both the server media store (apps/server) and the
 * oRPC settings router (packages/api) enforce identical bounds without importing
 * across the app <-> package boundary.
 */
export const MEDIA_ASSET_TTL_HOURS_SETTING_KEY = "mediaAssetTtlHours";

export const MEDIA_ASSET_TTL_DEFAULT_HOURS = 24;
export const MEDIA_ASSET_TTL_MIN_HOURS = 1;
export const MEDIA_ASSET_TTL_MAX_HOURS = 168; // 7 days

/** Clamp an arbitrary hours value into the safe range; NaN/invalid -> default. */
export function clampMediaAssetTtlHours(value: number): number {
  if (!Number.isFinite(value)) return MEDIA_ASSET_TTL_DEFAULT_HOURS;
  return Math.min(
    MEDIA_ASSET_TTL_MAX_HOURS,
    Math.max(MEDIA_ASSET_TTL_MIN_HOURS, Math.trunc(value)),
  );
}

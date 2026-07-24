import {
  clampMediaAssetTtlHours,
  MEDIA_ASSET_TTL_DEFAULT_HOURS,
  MEDIA_ASSET_TTL_HOURS_SETTING_KEY,
} from "@ws-model-proxy/config/media-policy";
import prisma from "@ws-model-proxy/db";

// Re-export the shared policy constants + clamp so existing media-module imports
// keep working. The single source of truth lives in @ws-model-proxy/config so the
// oRPC settings router (packages/api) enforces the same bounds. See media-policy.ts.
export {
  clampMediaAssetTtlHours,
  MEDIA_ASSET_TTL_DEFAULT_HOURS,
  MEDIA_ASSET_TTL_HOURS_SETTING_KEY,
  MEDIA_ASSET_TTL_MAX_HOURS,
  MEDIA_ASSET_TTL_MIN_HOURS,
} from "@ws-model-proxy/config/media-policy";

/**
 * Reads the configured asset TTL in hours (default 24, clamped 1-168). A
 * missing/blank/invalid setting falls back to the default. Phase 2 adds the
 * admin UI that writes it (through the oRPC settings router); this reads it with
 * a default + clamp, following the `signupEnabled` read pattern in
 * @ws-model-proxy/auth/signup-policy.
 */
export async function getMediaAssetTtlHours(): Promise<number> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: MEDIA_ASSET_TTL_HOURS_SETTING_KEY },
    select: { value: true },
  });
  if (!setting?.value) return MEDIA_ASSET_TTL_DEFAULT_HOURS;
  const parsed = Number(setting.value);
  if (!Number.isFinite(parsed)) return MEDIA_ASSET_TTL_DEFAULT_HOURS;
  return clampMediaAssetTtlHours(parsed);
}

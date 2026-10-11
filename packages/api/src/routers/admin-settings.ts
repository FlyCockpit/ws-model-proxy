import { ORPCError } from "@orpc/server";
import {
  invalidateForceTwoFactorPolicyCache,
  isForceTwoFactorRequired,
} from "@ws-model-proxy/auth/force-two-factor-policy";
import {
  getRuntimeSignupEnabled,
  SIGNUP_ENABLED_SETTING_KEY,
} from "@ws-model-proxy/auth/signup-policy";
import {
  clampMediaAssetTtlHours,
  clampMediaAttachmentMaxBytes,
  MEDIA_ASSET_TTL_DEFAULT_HOURS,
  MEDIA_ASSET_TTL_HOURS_SETTING_KEY,
  MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT,
  MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY,
} from "@ws-model-proxy/config/media-policy";
import prisma from "@ws-model-proxy/db";
import { contractProcedure } from "../contract-procedure";
import { adminSettingsContract as c } from "../contracts/account";

const FORCE_TWO_FACTOR_SETTING_KEY = "force2fa";

function numberSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readServerSettings() {
  const rows = await prisma.appSetting.findMany({
    where: {
      key: { in: [MEDIA_ASSET_TTL_HOURS_SETTING_KEY, MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY] },
    },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    signupEnabled: await getRuntimeSignupEnabled(),
    forceTwoFactor: await isForceTwoFactorRequired(),
    mediaAssetTtlHours: clampMediaAssetTtlHours(
      numberSetting(byKey.get(MEDIA_ASSET_TTL_HOURS_SETTING_KEY), MEDIA_ASSET_TTL_DEFAULT_HOURS),
    ),
    mediaAttachmentMaxBytes: clampMediaAttachmentMaxBytes(
      numberSetting(
        byKey.get(MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY),
        MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT,
      ),
    ),
  };
}

async function writeSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Server settings (admin). Kept from 0.3 `settings.update`, as one typed object. */
export const adminSettingsRouter = {
  get: contractProcedure(c.get).handler(async () => readServerSettings()),
  update: contractProcedure(c.update).handler(async ({ input, context }) => {
    if (input.forceTwoFactor === true && !context.session.user.twoFactorEnabled) {
      throw new ORPCError("FORBIDDEN", {
        message: "You must enable 2FA for your own account before requiring it for others",
      });
    }
    if (input.signupEnabled !== undefined) {
      await writeSetting(SIGNUP_ENABLED_SETTING_KEY, String(input.signupEnabled));
    }
    if (input.mediaAssetTtlHours !== undefined) {
      await writeSetting(
        MEDIA_ASSET_TTL_HOURS_SETTING_KEY,
        String(clampMediaAssetTtlHours(input.mediaAssetTtlHours)),
      );
    }
    if (input.mediaAttachmentMaxBytes !== undefined) {
      await writeSetting(
        MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY,
        String(clampMediaAttachmentMaxBytes(input.mediaAttachmentMaxBytes)),
      );
    }
    if (input.forceTwoFactor !== undefined) {
      await writeSetting(FORCE_TWO_FACTOR_SETTING_KEY, String(input.forceTwoFactor));
      invalidateForceTwoFactorPolicyCache();
    }
    return readServerSettings();
  }),
};

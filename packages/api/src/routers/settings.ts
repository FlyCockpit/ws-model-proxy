import { ORPCError } from "@orpc/server";
import { invalidateForceTwoFactorPolicyCache } from "@ws-model-proxy/auth/force-two-factor-policy";
import { SIGNUP_ENABLED_SETTING_KEY } from "@ws-model-proxy/auth/signup-policy";
import {
  clampMediaAssetTtlHours,
  MEDIA_ASSET_TTL_HOURS_SETTING_KEY,
} from "@ws-model-proxy/config/media-policy";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";

import { adminOr404Procedure, authenticatedProcedure } from "../index";

// Leak-prevention boundary: only keys listed here are exposed to clients via
// getAll; future settings must be explicitly opted in.
//
// mediaAssetTtlHours is deliberately NOT here: least-exposure default keeps
// operator policy off the any-authenticated-user read surface. Admins read the
// current TTL through the admin-only media stats endpoint in apps/server, which
// already gates on verified-admin.
const CLIENT_READABLE_SETTING_KEYS: readonly string[] = ["force2fa", SIGNUP_ENABLED_SETTING_KEY];

// Boolean policy toggles keep their existing "true"/"false" string contract.
const booleanSettingUpdateSchema = z.object({
  key: z.enum(["force2fa", SIGNUP_ENABLED_SETTING_KEY]),
  value: z.enum(["true", "false"]),
});

// The media asset TTL is a numeric-hours setting. Value is validated as an
// integer here and clamped to the safe 1-168 range server-side before storage.
const ttlSettingUpdateSchema = z.object({
  key: z.literal(MEDIA_ASSET_TTL_HOURS_SETTING_KEY),
  value: z.number().int(),
});

const settingUpdateSchema = z.union([booleanSettingUpdateSchema, ttlSettingUpdateSchema]);

export const settingsRouter = {
  getAll: authenticatedProcedure.handler(async () => {
    const settings = await prisma.appSetting.findMany({
      where: { key: { in: [...CLIENT_READABLE_SETTING_KEYS] } },
    });
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }),

  myNotificationPreferences: authenticatedProcedure.handler(async ({ context }) => {
    const user = await prisma.user.findUnique({
      where: { id: context.session.user.id },
      select: { operationalAlerts: true },
    });
    return {
      operationalAlerts: user?.operationalAlerts ?? true,
    };
  }),

  updateMyNotificationPreferences: authenticatedProcedure
    .input(
      z.object({
        operationalAlerts: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      await prisma.user.update({
        where: { id: context.session.user.id },
        data: { operationalAlerts: input.operationalAlerts },
      });
      return { success: true };
    }),

  update: adminOr404Procedure.input(settingUpdateSchema).handler(async ({ input, context }) => {
    // Numeric media TTL: clamp to the safe range, then store as a string
    // (AppSetting.value is text). Kept separate from the boolean toggles so
    // their existing "true"/"false" behavior is untouched.
    if (input.key === MEDIA_ASSET_TTL_HOURS_SETTING_KEY) {
      const value = String(clampMediaAssetTtlHours(input.value));
      await prisma.appSetting.upsert({
        where: { key: input.key },
        update: { value },
        create: { key: input.key, value },
      });
      return { success: true };
    }

    if (input.key === "force2fa" && input.value === "true") {
      if (!context.session.user.twoFactorEnabled) {
        throw new ORPCError("FORBIDDEN", {
          message: "You must enable 2FA for your own account before requiring it for others",
        });
      }
    }

    await prisma.appSetting.upsert({
      where: { key: input.key },
      update: { value: input.value },
      create: { key: input.key, value: input.value },
    });
    if (input.key === "force2fa") {
      invalidateForceTwoFactorPolicyCache();
    }

    return { success: true };
  }),
};

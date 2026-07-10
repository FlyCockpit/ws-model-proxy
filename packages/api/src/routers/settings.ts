import { ORPCError } from "@orpc/server";
import { invalidateForceTwoFactorPolicyCache } from "@ws-model-proxy/auth/force-two-factor-policy";
import { SIGNUP_ENABLED_SETTING_KEY } from "@ws-model-proxy/auth/signup-policy";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";

import { adminOr404Procedure, authenticatedProcedure } from "../index";

// Leak-prevention boundary: only keys listed here are exposed to clients via getAll; future settings must be explicitly opted in.
const CLIENT_READABLE_SETTING_KEYS: readonly string[] = ["force2fa", SIGNUP_ENABLED_SETTING_KEY];
const writableSettingKeySchema = z.enum(["force2fa", SIGNUP_ENABLED_SETTING_KEY]);

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

  update: adminOr404Procedure
    .input(
      z.object({
        key: writableSettingKeySchema,
        value: z.enum(["true", "false"]),
      }),
    )
    .handler(async ({ input, context }) => {
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

import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { contractProcedure } from "../contract-procedure";
import { settingsContract as c } from "../contracts/account";

const USER_SETTINGS_SELECT = {
  name: true,
  email: true,
  slug: true,
  locale: true,
  operationalAlerts: true,
  twoFactorEnabled: true,
  onboardingDoneAt: true,
} as const;

type UserSettingsRow = {
  name: string;
  email: string;
  slug: string;
  locale: string;
  operationalAlerts: boolean;
  twoFactorEnabled: boolean | null;
  onboardingDoneAt: Date | null;
};

function settingsView(row: UserSettingsRow) {
  return {
    ...row,
    twoFactorEnabled: row.twoFactorEnabled ?? false,
    onboardingDoneAt: row.onboardingDoneAt?.toISOString() ?? null,
  };
}

async function readSettings(userId: string) {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: USER_SETTINGS_SELECT });
  if (!row) throw new ORPCError("UNAUTHORIZED");
  return settingsView(row);
}

/** Per-person settings (server settings are `adminSettings`). */
export const settingsRouter = {
  get: contractProcedure(c.get).handler(async ({ context }) =>
    readSettings(context.session.user.id),
  ),
  update: contractProcedure(c.update).handler(async ({ input, context }) => {
    const row = await prisma.user.update({
      where: { id: context.session.user.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.operationalAlerts !== undefined
          ? { operationalAlerts: input.operationalAlerts }
          : {}),
      },
      select: USER_SETTINGS_SELECT,
    });
    return settingsView(row);
  }),
  onboarding: {
    complete: contractProcedure(c.onboarding.complete).handler(async ({ context }) => {
      // Idempotent: the first completion time is kept.
      await prisma.user.updateMany({
        where: { id: context.session.user.id, onboardingDoneAt: null },
        data: { onboardingDoneAt: new Date() },
      });
      return readSettings(context.session.user.id);
    }),
  },
};

import { ORPCError } from "@orpc/server";
import { type Locale, SUPPORTED_LOCALES } from "@ws-model-proxy/config/locales";
import prisma from "@ws-model-proxy/db";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { settingsContract as c } from "../contracts/account";
import { callableIdOf } from "../lib/access-views";
import { callerActor } from "../lib/caller-actor";
import { graphWrite } from "../lib/graph-write";
import { modelNameClashes, refuseCallableIdClash } from "../lib/model-names";
import { isUniqueViolation, refuse } from "../lib/refuse";

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

function supportedLocale(value: string): Locale {
  return SUPPORTED_LOCALES.find((locale) => locale === value) ?? "en-US";
}

function settingsView(row: UserSettingsRow) {
  return {
    ...row,
    locale: supportedLocale(row.locale),
    twoFactorEnabled: row.twoFactorEnabled ?? false,
    onboardingDoneAt: row.onboardingDoneAt?.toISOString() ?? null,
  };
}

async function readSettings(userId: string) {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: USER_SETTINGS_SELECT });
  if (!row) throw new ORPCError("UNAUTHORIZED");
  return settingsView(row);
}

type UserFields = { name?: string; locale?: Locale; operationalAlerts?: boolean };

/**
 * A new account slug renames every callable ID of the person's pools. It claims the new names in
 * their own namespace (lib/model-names.ts) under their owner fence, in one transaction with the
 * other fields: one equal to their own alias is refused (name_aliased). Share holders' aliases are
 * never looked at (one with a renamed ID keeps winning for its holder, resolve.ts), so the person
 * learns nothing about them. The slug is written first, so a slug another account has is
 * `slug_taken` before any alias is looked at.
 */
async function changeSlug(context: SignedInContext, slug: string, data: UserFields) {
  const userId = context.session.user.id;
  try {
    await graphWrite([userId], async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { slug: true } });
      if (!user) throw new ORPCError("UNAUTHORIZED");
      if (user.slug !== slug) {
        const pools = await tx.pool.findMany({
          where: { userId },
          select: { slug: true },
          orderBy: { slug: "asc" },
        });
        // Unique: another account's slug fails here (P2002), before any alias is read.
        await tx.user.update({ where: { id: userId }, data: { slug } });
        refuseCallableIdClash(
          await modelNameClashes(tx, [
            { userId, callableIds: pools.map((pool) => callableIdOf(slug, pool.slug)) },
          ]),
        );
        const actor = callerActor(context.auth, userId);
        await tx.auditEvent.create({
          data: {
            userId,
            actor: actor.actor,
            actorUserId: actor.actorUserId,
            agentTokenId: actor.agentTokenId,
            mcpGrantId: actor.mcpGrantId,
            action: "account.slug_change",
            resourceType: "user",
            resourceId: userId,
            before: { slug: user.slug },
            after: { slug },
          },
        });
      }
      if (Object.keys(data).length > 0) await tx.user.update({ where: { id: userId }, data });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw refuse("slug_taken", "That slug is already used.");
    throw error;
  }
}

/** Per-person settings (server settings are `adminSettings`). */
export const settingsRouter = {
  get: contractProcedure(c.get).handler(async ({ context }) =>
    readSettings(context.session.user.id),
  ),
  update: contractProcedure(c.update).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const data: UserFields = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.operationalAlerts !== undefined
        ? { operationalAlerts: input.operationalAlerts }
        : {}),
    };
    if (input.slug !== undefined) {
      await changeSlug(context, input.slug, data);
      return readSettings(userId);
    }
    const row = await prisma.user.update({
      where: { id: userId },
      data,
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

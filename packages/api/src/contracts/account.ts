/**
 * Account, admin and kept plumbing: `app`, `auth` (kept unchanged), `settings` (per user),
 * `users` (admin, kept), `adminObservability`, `adminSettings`.
 */
import { SUPPORTED_LOCALES } from "@ws-model-proxy/config/locales";
import { SHARE_INVITE_TOKEN_PATTERN } from "@ws-model-proxy/config/share-invite";
import { z } from "zod";
import {
  emailSchema,
  INSTANCE_PHASE,
  idSchema,
  isoDateSchema,
  MODEL_TYPE,
  NODE_CONNECTION,
  NODE_TRUST,
  nameSchema,
  noInputSchema,
  REQUEST_STATUS,
  RUNTIME_KIND,
} from "./common";
import { mutation, query } from "./procedure";

const successSchema = z.object({ success: z.literal(true) }).strict();
const localeSchema = z.enum(SUPPORTED_LOCALES);

const adminPageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  ownerQuery: z.string().trim().min(1).max(200).optional(),
};
function adminPageOf<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item),
      total: z.number().int(),
      page: z.number().int(),
      pageSize: z.number().int(),
      /** `total` is a lower bound (a capped count, or an owner query that matched too many). */
      partial: z.literal(true).optional(),
    })
    .strict();
}
const ownerRefSchema = z
  .object({ id: idSchema, email: z.string(), name: z.string(), slug: z.string() })
  .strict();

export const appContract = {
  config: query(
    "public",
    noInputSchema,
    z
      .object({
        signupEnabled: z.boolean(),
        adminBootstrapSignupEnabled: z.boolean(),
        emailEnabled: z.boolean(),
      })
      .strict(),
    "Public sign-in/up page configuration (was appConfig).",
  ),
  flags: query(
    "session",
    noInputSchema,
    z
      .object({
        cloudEnabled: z.boolean(),
        privateNetworksAllowed: z.boolean(),
        mcpEnabled: z.boolean(),
        agentTokenNoExpiryAllowed: z.boolean(),
      })
      .strict(),
    "Product switches of this server for a signed-in person (was deploymentFlags).",
  ),
  features: query(
    "admin",
    noInputSchema,
    z.record(z.string(), z.unknown()),
    "Admin inventory of server features (was deploymentFeatures; read-only).",
  ),
} as const;

export const authContract = {
  /** The sign-up page of an invite link (rate-limited like sign-in). */
  inviteInfo: query(
    "public",
    z.object({ token: z.string().regex(SHARE_INVITE_TOKEN_PATTERN) }).strict(),
    z
      .object({
        valid: z.boolean(),
        email: z.string().nullable(),
        ownerName: z.string().nullable(),
        /** What the invite shares: a pool's callable id or a runtime definition's name. */
        target: z
          .object({ kind: z.enum(["pool", "runtime"]), name: z.string() })
          .strict()
          .nullable(),
      })
      .strict(),
    "Public: who invited this e-mail to which pool or runtime definition (valid false for an unknown, used or expired link).",
  ),
  /** A signed-in person opening an invite link (rate-limited per user). */
  acceptInvite: mutation(
    "human",
    z.object({ token: z.string().regex(SHARE_INVITE_TOKEN_PATTERN) }).strict(),
    z.object({ result: z.enum(["accepted", "invalid", "own", "in_use"]) }).strict(),
    "Accept a pool or runtime invite link as the signed-in person, whatever their e-mail (the token is the proof). own: the invite is to something you own.",
  ),
  verifyEmailTransport: query(
    "public",
    noInputSchema,
    z.object({ ok: z.boolean() }).strict(),
    "Kept: whether email delivery works.",
  ),
  updateLocale: mutation(
    "session",
    z.object({ locale: localeSchema }).strict(),
    successSchema,
    "Kept: persist the UI locale.",
  ),
  passwordCapabilities: query(
    "session",
    noInputSchema,
    z.object({ canChangePassword: z.boolean() }).strict(),
    "Kept: whether this account can change its password.",
  ),
} as const;

export const userSettingsSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    slug: z.string(),
    locale: localeSchema,
    operationalAlerts: z.boolean(),
    twoFactorEnabled: z.boolean(),
    onboardingDoneAt: isoDateSchema.nullable(),
  })
  .strict();

export const settingsContract = {
  get: query("session", noInputSchema, userSettingsSchema, "Your profile and alerts."),
  update: mutation(
    "human",
    z
      .object({
        name: nameSchema.optional(),
        locale: localeSchema.optional(),
        operationalAlerts: z.boolean().optional(),
      })
      .strict(),
    userSettingsSchema,
    "Change your name, locale or alert e-mails.",
  ),
  onboarding: {
    complete: mutation(
      "human",
      noInputSchema,
      userSettingsSchema,
      "Dismiss or finish the getting-started checklist.",
    ),
  },
} as const;

export const adminUserSchema = z
  .object({
    id: idSchema,
    email: z.string(),
    slug: z.string(),
    name: z.string(),
    role: z.string(),
    emailVerified: z.boolean(),
    banned: z.boolean().nullable(),
    banReason: z.string().nullable(),
    banExpires: isoDateSchema.nullable(),
    deletionRequestedAt: isoDateSchema.nullable(),
    twoFactorEnabled: z.boolean().nullable(),
    createdAt: isoDateSchema,
  })
  .strict();

/** Kept from 0.3 (`archive`/`unarchive` are the spec's ban/unban). */
export const usersContract = {
  list: query(
    "admin",
    z
      .object({
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        search: z.string().trim().max(200).optional(),
      })
      .strict()
      .prefault({}),
    z
      .object({
        users: z.array(adminUserSchema),
        total: z.number().int(),
        limit: z.number().int(),
        offset: z.number().int(),
      })
      .strict(),
    "Admin: all accounts.",
  ),
  invite: mutation(
    "human_admin",
    z
      .object({
        email: emailSchema,
        name: nameSchema,
        slug: z
          .string()
          .regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/)
          .optional(),
        role: z.enum(["admin", "user"]).default("user"),
      })
      .strict(),
    z.object({ userId: idSchema, tempPassword: z.string(), emailSent: z.boolean() }).strict(),
    "Admin: invite a person (kept: the temporary password is shown once to the admin).",
  ),
  setRole: mutation(
    "human_admin",
    z.object({ userId: idSchema, role: z.enum(["admin", "user"]) }).strict(),
    successSchema,
    "Admin: change a role (never your own admin role).",
  ),
  archive: mutation(
    "human_admin",
    z.object({ userId: idSchema, reason: z.string().trim().max(500).optional() }).strict(),
    successSchema,
    "Admin: ban an account.",
  ),
  unarchive: mutation(
    "human_admin",
    z.object({ userId: idSchema }).strict(),
    successSchema,
    "Admin: lift a ban.",
  ),
  remove: mutation(
    "human_admin",
    z.object({ userId: idSchema }).strict(),
    z.object({ success: z.literal(true), pending: z.boolean() }).strict(),
    "Admin: delete an account (deletion sweeper finishes it).",
  ),
} as const;

export const adminObservabilityContract = {
  nodes: query(
    "admin",
    z.object(adminPageInput).strict().prefault({}),
    adminPageOf(
      z
        .object({
          id: idSchema,
          slug: z.string(),
          owner: ownerRefSchema,
          connection: z.enum(NODE_CONNECTION),
          trust: z.enum(NODE_TRUST),
          version: z.string().nullable(),
          lastHeartbeatAt: isoDateSchema.nullable(),
          runningInstances: z.number().int(),
        })
        .strict(),
    ),
    "Admin: every node.",
  ),
  runtimes: query(
    "admin",
    z.object(adminPageInput).strict().prefault({}),
    adminPageOf(
      z
        .object({
          id: idSchema,
          slug: z.string(),
          owner: ownerRefSchema,
          kind: z.enum(RUNTIME_KIND),
          /** Null for a service runtime (no served model type). */
          modelType: z.enum(MODEL_TYPE).nullable(),
          /** Instances that are not stopped, newest first (at most 20). */
          instances: z.array(z.object({ id: idSchema, phase: z.enum(INSTANCE_PHASE) }).strict()),
        })
        .strict(),
    ),
    "Admin: every runtime and its instances.",
  ),
  pools: query(
    "admin",
    z.object(adminPageInput).strict().prefault({}),
    adminPageOf(
      z
        .object({
          id: idSchema,
          callableId: z.string(),
          owner: ownerRefSchema,
          modelType: z.enum(MODEL_TYPE),
          members: z.number().int(),
          shares: z.number().int(),
        })
        .strict(),
    ),
    "Admin: every pool.",
  ),
  relay: query(
    "admin",
    z.object(adminPageInput).strict().prefault({}),
    adminPageOf(
      z
        .object({
          id: idSchema,
          createdAt: isoDateSchema,
          owner: ownerRefSchema,
          status: z.enum(REQUEST_STATUS),
          callableId: z.string().nullable(),
          durationMs: z.number().int().nullable(),
          errorClass: z.string().nullable(),
        })
        .strict(),
    ),
    "Admin: request log across accounts (prompt-free).",
  ),
} as const;

export const serverSettingsSchema = z
  .object({
    signupEnabled: z.boolean(),
    forceTwoFactor: z.boolean(),
    mediaAssetTtlHours: z.number().int().min(1).max(168),
    mediaAttachmentMaxBytes: z.number().int().min(0),
  })
  .strict();

export const adminSettingsContract = {
  get: query("admin", noInputSchema, serverSettingsSchema, "Admin: server settings."),
  update: mutation(
    "human_admin",
    serverSettingsSchema.partial().strict(),
    serverSettingsSchema,
    "Admin: sign-up, forced 2FA, media retention and attachment cap.",
  ),
} as const;

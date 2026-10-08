import { z } from "zod";
import {
  AGENT_LEVEL,
  API_KEY_SCOPE,
  currencySchema,
  emailSchema,
  idSchema,
  isoDateSchema,
  MODEL_TYPE,
  moneySchema,
  nameSchema,
  noInputSchema,
  okSchema,
  PRIORITY_CLASS,
} from "./common";
import { mutation, query } from "./procedure";

export const apiKeyViewSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    scope: z.enum(API_KEY_SCOPE),
    poolIds: z.array(idSchema),
    lookupPrefix: z.string(),
    createdAt: isoDateSchema,
    lastUsedAt: isoDateSchema.nullable(),
    expiresAt: isoDateSchema.nullable(),
    revokedAt: isoDateSchema.nullable(),
  })
  .strict();

export const agentTokenViewSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    level: z.enum(AGENT_LEVEL),
    lookupPrefix: z.string(),
    createdAt: isoDateSchema,
    lastUsedAt: isoDateSchema.nullable(),
    expiresAt: isoDateSchema.nullable(),
    revokedAt: isoDateSchema.nullable(),
  })
  .strict();

export const oauthConnectionViewSchema = z
  .object({
    grantId: idSchema,
    clientId: z.string(),
    clientName: z.string().nullable(),
    redirectHost: z.string().nullable(),
    level: z.enum(AGENT_LEVEL),
    /** The approval included `mcp:write`, so Full can apply (else Full is refused). */
    fullAvailable: z.boolean(),
    createdAt: isoDateSchema,
    revokedAt: isoDateSchema.nullable(),
  })
  .strict();

export const shareViewSchema = z
  .object({
    id: idSchema,
    poolId: idSchema,
    callableId: z.string(),
    ownerEmail: z.string(),
    granteeEmail: z.string(),
    canUse: z.boolean(),
    canContribute: z.boolean(),
    /** Null: the pool's class. */
    priorityClass: z.enum(PRIORITY_CLASS).nullable(),
    /** Null: the pool's protection rule. */
    protectionPercent: z.number().int().nullable(),
    monthlyCap: z
      .object({ limit: moneySchema, currency: currencySchema, spentThisMonth: moneySchema })
      .strict()
      .nullable(),
    /** The model the owner lets share holders use their own key for; null: not allowed. */
    ownKeyEquivalentModel: z.string().nullable(),
    /** The grantee's own-key choice (only while the pool owner consents). */
    ownKeyProviderModelId: idSchema.nullable(),
    ownKeyProtocolAdaptation: z.boolean(),
    contributedMembers: z.number().int(),
    createdAt: isoDateSchema,
  })
  .strict();

const shareSettings = {
  canUse: z.boolean(),
  canContribute: z.boolean(),
  priorityClass: z.enum(PRIORITY_CLASS).nullable(),
  protectionPercent: z.number().int().min(0).max(100).nullable(),
  /** Monthly cap on the owner's cloud money this person may spend via :external; null = none. */
  monthlyCap: z.object({ limit: moneySchema, currency: currencySchema }).strict().nullable(),
};

/** What an invite shares: a pool (its callable id) or a runtime definition (its name). */
export const shareInviteTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pool"), poolId: idSchema, callableId: z.string() }).strict(),
  z.object({ kind: z.literal("runtime"), runtimeId: idSchema, name: z.string() }).strict(),
]);

export const shareInviteViewSchema = z
  .object({
    id: idSchema,
    target: shareInviteTargetSchema,
    email: z.string(),
    /** Pool invites only; a runtime invite is can use, nothing else. */
    canUse: z.boolean(),
    canContribute: z.boolean(),
    priorityClass: z.enum(PRIORITY_CLASS).nullable(),
    createdAt: isoDateSchema,
    expiresAt: isoDateSchema,
    emailSentAt: isoDateSchema.nullable(),
  })
  .strict();

export const accessContract = {
  apiKeys: {
    list: query(
      "session",
      noInputSchema,
      z.object({ keys: z.array(apiKeyViewSchema), baseUrl: z.string().url() }).strict(),
      "Your API keys (pools only).",
    ),
    create: mutation(
      "human",
      z
        .object({
          name: nameSchema,
          scope: z.enum(API_KEY_SCOPE),
          poolIds: z.array(idSchema).max(256).default([]),
          expiresAt: isoDateSchema.nullable(),
        })
        .strict()
        .refine((input) => (input.scope === "SELECTED_POOLS") === input.poolIds.length > 0, {
          message: "Selected pools need at least one pool; all pools take none.",
          path: ["poolIds"],
        }),
      z.object({ key: apiKeyViewSchema, secret: z.string() }).strict(),
      "Create an API key; the secret is shown once.",
    ),
    revoke: mutation(
      "human",
      z.object({ apiKeyId: idSchema }).strict(),
      okSchema,
      "Revoke an API key.",
    ),
  },
  agentTokens: {
    list: query(
      "session",
      noInputSchema,
      z.object({ tokens: z.array(agentTokenViewSchema), mcpUrl: z.string().url() }).strict(),
      "Your agent tokens.",
    ),
    create: mutation(
      "human",
      z
        .object({
          name: nameSchema,
          level: z.enum(AGENT_LEVEL),
          /** Null only when the server allows tokens without expiry. */
          expiresAt: isoDateSchema.nullable(),
        })
        .strict(),
      z.object({ token: agentTokenViewSchema, secret: z.string() }).strict(),
      "Create an agent token (Read-only or Full); the secret is shown once.",
    ),
    revoke: mutation(
      "human",
      z.object({ agentTokenId: idSchema }).strict(),
      okSchema,
      "Revoke an agent token.",
    ),
  },
  oauthGrants: {
    list: query(
      "session",
      noInputSchema,
      z.object({ connections: z.array(oauthConnectionViewSchema) }).strict(),
      "Agents connected with OAuth.",
    ),
    revoke: mutation(
      "human",
      z.object({ grantId: idSchema }).strict(),
      okSchema,
      "Disconnect an OAuth agent.",
    ),
    setLevel: mutation(
      "human",
      z.object({ grantId: idSchema, level: z.enum(AGENT_LEVEL) }).strict(),
      z.object({ level: z.enum(AGENT_LEVEL) }).strict(),
      "Change an OAuth agent's access (Read-only or Full). Lowering ends its Full work now.",
    ),
  },
  shares: {
    list: query(
      "session",
      noInputSchema,
      z
        .object({
          byMe: z.array(shareViewSchema),
          withMe: z.array(shareViewSchema),
          /** Pending invites (pools and runtime definitions) to e-mails not proved yet. */
          invites: z.array(shareInviteViewSchema),
        })
        .strict(),
      "Shares of your pools, and pools shared with you.",
    ),
    create: mutation(
      "human",
      z
        .object({ poolId: idSchema, email: emailSchema, ...shareSettings })
        .strict()
        .refine((input) => input.canUse || input.canContribute, {
          message: "A share needs can use, can contribute, or both.",
        }),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("share"), share: shareViewSchema }).strict(),
        z
          .object({
            kind: z.literal("invite"),
            invite: shareInviteViewSchema,
            /** Shown once, only when no e-mail could be sent: copy it to the person. */
            link: z.string().nullable(),
          })
          .strict(),
      ]),
      "Share a pool with a person. Only an account whose mailbox the verify-email flow proved gets the share directly; any other e-mail (an unknown one included, answered alike) becomes an invite (e-mailed when SMTP is set up, otherwise a link to copy); the share starts when they sign up or sign in through the link, even with open sign-up off. Without the link an invite is accepted only by a proved e-mail address (inviteAcceptance; with verification off, only the link works: invite_needs_link).",
    ),
    update: mutation(
      "human",
      z
        .object({
          shareId: idSchema,
          canUse: shareSettings.canUse.optional(),
          canContribute: shareSettings.canContribute.optional(),
          priorityClass: shareSettings.priorityClass.optional(),
          protectionPercent: shareSettings.protectionPercent.optional(),
          monthlyCap: shareSettings.monthlyCap.optional(),
        })
        .strict(),
      shareViewSchema,
      "Change a share. Clearing can contribute removes that person's contributed members.",
    ),
    delete: mutation(
      "human",
      z.object({ shareId: idSchema }).strict(),
      okSchema,
      "Delete a share (and its contributed members and cap).",
    ),
    setOwnKey: mutation(
      "human",
      z
        .object({
          shareId: idSchema,
          /** One of your provider models; null clears the choice. */
          providerModelId: idSchema.nullable(),
          protocolAdaptation: z.boolean().optional(),
        })
        .strict(),
      shareViewSchema,
      "As the share holder: use your own provider key for this pool's cloud fallback.",
    ),
  },
  invites: {
    resend: mutation(
      "human",
      z.object({ inviteId: idSchema }).strict(),
      z.object({ invite: shareInviteViewSchema, link: z.string().nullable() }).strict(),
      "Send a pool or runtime invite again with a new link and expiry (the old link stops working; pending invites only). A revoked or accepted e-mail can be invited again with shares.create.",
    ),
    revoke: mutation(
      "human",
      z.object({ inviteId: idSchema }).strict(),
      okSchema,
      "Withdraw a pool or runtime invite.",
    ),
  },
  contributing: {
    pools: query(
      "session",
      noInputSchema,
      z
        .object({
          pools: z.array(
            z
              .object({
                shareId: idSchema,
                poolId: idSchema,
                callableId: z.string(),
                ownerEmail: z.string(),
                modelType: z.enum(MODEL_TYPE),
                ownHardwareOnly: z.boolean(),
                yourMembers: z.array(
                  z
                    .object({
                      memberId: idSchema,
                      runtimeModelId: idSchema,
                      upstreamModelId: z.string(),
                    })
                    .strict(),
                ),
              })
              .strict(),
          ),
          /** Your served models (not retired), to pick a contribution from. */
          servedModels: z.array(
            z
              .object({
                runtimeModelId: idSchema,
                upstreamModelId: z.string(),
                type: z.enum(MODEL_TYPE),
                runtimeId: idSchema,
                runtimeName: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
      "Pools you may contribute to, what you contribute now, and your served models.",
    ),
  },
} as const;

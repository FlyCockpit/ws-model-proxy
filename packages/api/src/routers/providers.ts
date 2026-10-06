/**
 * Provider accounts, keys, models, prices and monthly caps. Every write is `human` in the
 * contract (cloud spend and provider keys), so the contract binding refuses agents, OAuth
 * tokens, API keys and cookies without the verified CSRF header before any handler runs.
 */
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { fences } from "@ws-model-proxy/db/capacity-lock-order";
import { env } from "@ws-model-proxy/env/server";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { providersContract as c } from "../contracts/providers";
import { callerActor, isUniqueViolation, notFound } from "../lib/caller-actor";
import { cloudEgressEnabled } from "../lib/cloud-egress";
import { graphWrite, modelTargetFences } from "../lib/graph-write";
import { createProviderCatalog, fetchOpenRouterCatalogJson } from "../lib/provider-catalog";
import {
  CATALOG_SEARCH_MAX_LIMIT,
  type CatalogModel,
  searchCatalog,
} from "../lib/provider-catalog-model";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  parseProviderCredentialKeyring,
  providerCredentialNeedsRotation,
} from "../lib/provider-credential-crypto";
import { providerHttpsRequest, validateProviderBaseUrl } from "../lib/provider-egress";
import {
  classifyCredentialProbeStatus,
  providerCredentialProbe,
  providerProtocolForType,
} from "../lib/provider-protocol";
import {
  ACCOUNT_SELECT,
  accountView,
  MODEL_SELECT,
  modelView,
  moneyString,
  spendFor,
} from "../lib/provider-views";
import type { Tx } from "../lib/runtime-store";

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

function keyring() {
  const value = env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  if (!value || value.trim() === "")
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Provider keys cannot be stored: the credential keyring is not configured.",
    });
  return parseProviderCredentialKeyring(value);
}

function normalizedBaseUrl(raw: string): string {
  try {
    const url = validateProviderBaseUrl(raw, {
      allowPrivateNetworks: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS === true,
    });
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "The base URL must be an https URL without credentials, query or fragment.",
    });
  }
}

async function ownedAccount(userId: string, accountId: string) {
  const account = await prisma.providerAccount.findFirst({
    where: { id: accountId, userId, deletedAt: null },
    select: ACCOUNT_SELECT,
  });
  if (!account) throw notFound("That provider account does not exist.");
  return account;
}

async function accountViewOf(userId: string, accountId: string) {
  return accountView(await ownedAccount(userId, accountId));
}

async function audit(
  db: Tx,
  context: SignedInContext,
  input: { accountId: string; action: string; after?: unknown },
) {
  const userId = userIdOf(context);
  const actor = callerActor(context.auth, userId);
  await db.auditEvent.create({
    data: {
      userId,
      actor: actor.actor,
      actorUserId: actor.actorUserId,
      agentTokenId: actor.agentTokenId,
      action: input.action,
      resourceType: "provider_account",
      resourceId: input.accountId,
      after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Encrypts `secret` for a new credential row of this account (id chosen here: it is in the AAD). */
function sealCredential(
  userId: string,
  account: { id: string; authType: "API_KEY" | "BEARER" },
  secret: string,
) {
  const id = randomUUID();
  const sealed = encryptProviderCredential(
    secret,
    {
      userId,
      providerAccountId: account.id,
      credentialId: id,
      credentialType: account.authType,
      aadVersion: 1,
    },
    keyring(),
  );
  return {
    id,
    userId,
    providerAccountId: account.id,
    credentialType: account.authType,
    aadVersion: 1,
    algorithm: sealed.algorithm,
    keyVersion: sealed.keyVersion,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    authTag: sealed.authTag,
    displaySuffix: sealed.displaySuffix,
  };
}

/** Removes the cloud pool members of these provider models (their admission views change). */
async function dropCloudMembers(tx: Tx, providerModelIds: string[]) {
  if (providerModelIds.length === 0) return;
  await tx.poolMember.deleteMany({ where: { providerModelId: { in: providerModelIds } } });
}

let catalog: ReturnType<typeof createProviderCatalog> | null = null;
function openRouterCatalog() {
  catalog ??= createProviderCatalog({
    egressEnabled: () => env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED === true,
    fetchJson: (signal) =>
      fetchOpenRouterCatalogJson(signal, {
        egressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED === true,
      }),
  });
  return catalog;
}

function catalogType(model: CatalogModel): "LLM" | "EMBEDDINGS" | "TRANSCRIPTION" {
  if (/embed/i.test(model.id)) return "EMBEDDINGS";
  if (!model.outputModalities.includes("text") && model.inputModalities.includes("audio"))
    return "TRANSCRIPTION";
  return "LLM";
}

export const providersRouter = {
  accounts: {
    list: contractProcedure(c.accounts.list).handler(async ({ context }) => {
      const rows = await prisma.providerAccount.findMany({
        where: { userId: userIdOf(context), deletedAt: null },
        select: ACCOUNT_SELECT,
        orderBy: { createdAt: "asc" },
      });
      return { accounts: await Promise.all(rows.map(accountView)) };
    }),
    get: contractProcedure(c.accounts.get).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await accountViewOf(userId, input.accountId);
      const models = await prisma.providerModel.findMany({
        where: { providerAccountId: input.accountId, userId, deletedAt: null },
        select: MODEL_SELECT,
        orderBy: { createdAt: "asc" },
      });
      return { ...account, models: models.map(modelView) };
    }),
    create: contractProcedure(c.accounts.create).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const baseUrl = normalizedBaseUrl(input.baseUrl);
      keyring();
      let accountId: string;
      try {
        accountId = await graphWrite([userId], async (tx) => {
          const account = await tx.providerAccount.create({
            data: {
              userId,
              providerType: input.providerType,
              label: input.label,
              baseUrl,
              endpointIdentity: baseUrl,
              endpointVersion: 1,
              authType: input.authType,
              enabled: false,
              allowDataCollection: input.allowDataCollection,
            },
            select: { id: true, authType: true },
          });
          const credential = await tx.providerCredential.create({
            data: sealCredential(userId, account, input.secret),
            select: { id: true },
          });
          await tx.providerAccount.update({
            where: { id: account.id },
            data: { currentCredentialId: credential.id },
          });
          await audit(tx, context, { accountId: account.id, action: "provider.account.create" });
          return account.id;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new ORPCError("CONFLICT", {
            message: "You already have an account with this label.",
          });
        throw error;
      }
      return accountViewOf(userId, accountId);
    }),
    update: contractProcedure(c.accounts.update).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await prisma.providerAccount.findFirst({
        where: { id: input.accountId, userId, deletedAt: null },
        select: { id: true, baseUrl: true, endpointVersion: true },
      });
      if (!account) throw notFound("That provider account does not exist.");
      const baseUrl = input.baseUrl === undefined ? undefined : normalizedBaseUrl(input.baseUrl);
      await graphWrite([userId], async (tx) => {
        await tx.providerAccount.update({
          where: { id: account.id },
          data: {
            ...(input.label !== undefined ? { label: input.label } : {}),
            // A new endpoint is a new identity (hardening: atomically bump its version).
            ...(baseUrl !== undefined && baseUrl !== account.baseUrl
              ? { baseUrl, endpointIdentity: baseUrl, endpointVersion: account.endpointVersion + 1 }
              : {}),
          },
        });
        await audit(tx, context, {
          accountId: account.id,
          action: "provider.account.update",
          after: { label: input.label ?? null, baseUrl: baseUrl ?? null },
        });
      });
      return accountViewOf(userId, account.id);
    }),
    delete: contractProcedure(c.accounts.delete).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await ownedAccount(userId, input.accountId);
      const models = await prisma.providerModel.findMany({
        where: { providerAccountId: account.id, userId },
        select: { id: true },
      });
      const modelIds = models.map((model) => model.id);
      // Soft delete: usage and pricing history keep pointing at it.
      await graphWrite(
        [userId],
        async (tx) => {
          await dropCloudMembers(tx, modelIds);
          await tx.providerModel.updateMany({
            where: { providerAccountId: account.id, userId },
            data: { enabled: false, deletedAt: new Date() },
          });
          await tx.providerAccount.update({
            where: { id: account.id },
            data: { enabled: false, currentCredentialId: null, deletedAt: new Date() },
          });
          await tx.providerCredential.updateMany({
            where: { providerAccountId: account.id, userId, status: "ACTIVE" },
            data: { status: "REVOKED", revokedAt: new Date() },
          });
          await audit(tx, context, { accountId: account.id, action: "provider.account.delete" });
        },
        (tx) => modelTargetFences(tx, { providerModelIds: modelIds }),
      );
      return { ok: true as const };
    }),
    setEnabled: contractProcedure(c.accounts.setEnabled).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await ownedAccount(userId, input.accountId);
      if (input.enabled && !account.CurrentCredential)
        throw new ORPCError("BAD_REQUEST", { message: "Add a key before turning the account on." });
      await graphWrite([userId], async (tx) => {
        await tx.providerAccount.update({
          where: { id: account.id },
          data: { enabled: input.enabled },
        });
        await audit(tx, context, {
          accountId: account.id,
          action: "provider.account.enabled",
          after: { enabled: input.enabled },
        });
      });
      return accountViewOf(userId, account.id);
    }),
    setDataCollection: contractProcedure(c.accounts.setDataCollection).handler(
      async ({ input, context }) => {
        const userId = userIdOf(context);
        const account = await ownedAccount(userId, input.accountId);
        await graphWrite([userId], async (tx) => {
          await tx.providerAccount.update({
            where: { id: account.id },
            data: { allowDataCollection: input.allow },
          });
          await audit(tx, context, {
            accountId: account.id,
            action: "provider.account.data_collection",
            after: { allow: input.allow },
          });
        });
        return accountViewOf(userId, account.id);
      },
    ),
  },

  credentials: {
    replace: contractProcedure(c.credentials.replace).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await prisma.providerAccount.findFirst({
        where: { id: input.accountId, userId, deletedAt: null },
        select: { id: true, authType: true, currentCredentialId: true },
      });
      if (!account) throw notFound("That provider account does not exist.");
      const sealed = sealCredential(userId, account, input.secret);
      await graphWrite([userId], async (tx) => {
        // One ACTIVE key per account: retire the old one first, then point at the new one.
        const previous = account.currentCredentialId;
        if (previous)
          await tx.providerCredential.updateMany({
            where: { id: previous, userId, status: "ACTIVE" },
            data: { status: "REVOKED", revokedAt: new Date() },
          });
        await tx.providerCredential.create({ data: sealed, select: { id: true } });
        if (previous)
          await tx.providerCredential.update({
            where: { id: previous },
            data: {
              status: "REPLACED",
              replacedAt: new Date(),
              replacedById: sealed.id,
              revokedAt: null,
            },
          });
        await tx.providerAccount.update({
          where: { id: account.id },
          data: { currentCredentialId: sealed.id },
        });
        await audit(tx, context, { accountId: account.id, action: "provider.credential.replace" });
      });
      return accountViewOf(userId, account.id);
    }),
    revoke: contractProcedure(c.credentials.revoke).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const credential = await prisma.providerCredential.findFirst({
        where: { id: input.credentialId, userId },
        select: { id: true, status: true, providerAccountId: true },
      });
      if (!credential) throw notFound("That key does not exist.");
      if (credential.status === "ACTIVE")
        await graphWrite([userId], async (tx) => {
          // The account stops working (and is turned off) until a new key is added.
          await tx.providerAccount.updateMany({
            where: { id: credential.providerAccountId, userId, currentCredentialId: credential.id },
            data: { currentCredentialId: null, enabled: false },
          });
          await tx.providerCredential.update({
            where: { id: credential.id },
            data: { status: "REVOKED", revokedAt: new Date() },
          });
          await audit(tx, context, {
            accountId: credential.providerAccountId,
            action: "provider.credential.revoke",
          });
        });
      return { ok: true as const };
    }),
    test: contractProcedure(c.credentials.test).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await prisma.providerAccount.findFirst({
        where: { id: input.accountId, userId, deletedAt: null },
        select: {
          id: true,
          providerType: true,
          baseUrl: true,
          authType: true,
          CurrentCredential: {
            select: {
              id: true,
              algorithm: true,
              keyVersion: true,
              ciphertext: true,
              nonce: true,
              authTag: true,
              aadVersion: true,
              credentialType: true,
            },
          },
        },
      });
      if (!account) throw notFound("That provider account does not exist.");
      const credential = account.CurrentCredential;
      if (!credential) return { ok: false, status: null, detail: "no_key" };
      const protocol = providerProtocolForType(account.providerType);
      if (!protocol) return { ok: false, status: null, detail: "unsupported_provider" };
      if (!cloudEgressEnabled()) return { ok: false, status: null, detail: "egress_disabled" };
      const secret = decryptProviderCredential(
        {
          algorithm: "AES-256-GCM",
          keyVersion: credential.keyVersion,
          ciphertext: Uint8Array.from(credential.ciphertext),
          nonce: Uint8Array.from(credential.nonce),
          authTag: Uint8Array.from(credential.authTag),
        },
        {
          userId,
          providerAccountId: account.id,
          credentialId: credential.id,
          credentialType: credential.credentialType,
          aadVersion: credential.aadVersion,
        },
        keyring(),
      );
      const probe = providerCredentialProbe(account.providerType, account.baseUrl);
      let status: number | null = null;
      try {
        const response = await providerHttpsRequest(
          probe.url,
          { method: "GET", headers: probe.headers, signal: context.services?.signal },
          {
            allowPrivateNetworks: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS === true,
            egressEnabled: true,
            timeoutMs: 10_000,
          },
          protocol,
          credential.credentialType === "BEARER"
            ? { type: "BEARER", token: secret }
            : { type: "API_KEY", apiKey: secret },
        );
        status = response.statusCode ?? null;
        response.resume();
      } catch {
        return { ok: false, status: null, detail: "unreachable" };
      }
      const result = classifyCredentialProbeStatus(status, probe.verifiesCredential);
      return {
        ok: result.ok,
        status,
        detail: result.reason === null ? null : result.reason.toLowerCase(),
      };
    }),
    reencrypt: contractProcedure(c.credentials.reencrypt).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const ring = keyring();
      const credentials = await prisma.providerCredential.findMany({
        where: {
          userId,
          status: { not: "REVOKED" },
          ...(input.accountId ? { providerAccountId: input.accountId } : {}),
        },
        select: {
          id: true,
          providerAccountId: true,
          credentialType: true,
          aadVersion: true,
          keyVersion: true,
          ciphertext: true,
          nonce: true,
          authTag: true,
        },
      });
      let reencrypted = 0;
      for (const credential of credentials) {
        if (!providerCredentialNeedsRotation(credential, ring)) continue;
        const identity = {
          userId,
          providerAccountId: credential.providerAccountId,
          credentialId: credential.id,
          credentialType: credential.credentialType,
          aadVersion: credential.aadVersion,
        };
        const plain = decryptProviderCredential(
          {
            algorithm: "AES-256-GCM",
            keyVersion: credential.keyVersion,
            ciphertext: Uint8Array.from(credential.ciphertext),
            nonce: Uint8Array.from(credential.nonce),
            authTag: Uint8Array.from(credential.authTag),
          },
          identity,
          ring,
        );
        const sealed = encryptProviderCredential(plain, identity, ring);
        await graphWrite([userId], (tx) =>
          tx.providerCredential.update({
            where: { id: credential.id },
            data: {
              keyVersion: sealed.keyVersion,
              ciphertext: sealed.ciphertext,
              nonce: sealed.nonce,
              authTag: sealed.authTag,
            },
          }),
        );
        reencrypted += 1;
      }
      return { reencrypted };
    }),
  },

  models: {
    list: contractProcedure(c.models.list).handler(async ({ input, context }) => {
      const rows = await prisma.providerModel.findMany({
        where: {
          userId: userIdOf(context),
          deletedAt: null,
          ...(input.accountId ? { providerAccountId: input.accountId } : {}),
        },
        select: MODEL_SELECT,
        orderBy: { createdAt: "asc" },
      });
      return { models: rows.map(modelView) };
    }),
    create: contractProcedure(c.models.create).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      await ownedAccount(userId, input.accountId);
      let modelId: string;
      try {
        modelId = await graphWrite([userId], async (tx) => {
          const model = await tx.providerModel.create({
            data: {
              userId,
              providerAccountId: input.accountId,
              upstreamModelId: input.upstreamModelId,
              displayName: input.displayName ?? null,
              type: input.type,
              contextWindow: input.contextWindow ?? null,
              maxOutputTokens: input.maxOutputTokens ?? null,
              enabled: false,
            },
            select: { id: true },
          });
          await audit(tx, context, {
            accountId: input.accountId,
            action: "provider.model.create",
            after: { modelId: model.id, upstreamModelId: input.upstreamModelId },
          });
          return model.id;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new ORPCError("CONFLICT", { message: "This model is already on the account." });
        throw error;
      }
      return modelView(
        await prisma.providerModel.findUniqueOrThrow({
          where: { id: modelId },
          select: MODEL_SELECT,
        }),
      );
    }),
    update: contractProcedure(c.models.update).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const model = await prisma.providerModel.findFirst({
        where: { id: input.modelId, userId, deletedAt: null },
        select: { id: true, providerAccountId: true },
      });
      if (!model) throw notFound("That provider model does not exist.");
      await graphWrite(
        [userId],
        async (tx) => {
          await tx.providerModel.update({
            where: { id: model.id },
            data: {
              ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
              ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
              ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
              ...(input.maxOutputTokens !== undefined
                ? { maxOutputTokens: input.maxOutputTokens }
                : {}),
            },
          });
          // A disabled model leaves the pools that try it.
          if (input.enabled === false) await dropCloudMembers(tx, [model.id]);
          await audit(tx, context, {
            accountId: model.providerAccountId,
            action: "provider.model.update",
            after: { modelId: model.id, enabled: input.enabled ?? null },
          });
        },
        (tx) =>
          input.enabled === false
            ? modelTargetFences(tx, { providerModelIds: [model.id] })
            : Promise.resolve([]),
      );
      return modelView(
        await prisma.providerModel.findUniqueOrThrow({
          where: { id: model.id },
          select: MODEL_SELECT,
        }),
      );
    }),
    delete: contractProcedure(c.models.delete).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const model = await prisma.providerModel.findFirst({
        where: { id: input.modelId, userId, deletedAt: null },
        select: { id: true, providerAccountId: true },
      });
      if (!model) throw notFound("That provider model does not exist.");
      await graphWrite(
        [userId],
        async (tx) => {
          await dropCloudMembers(tx, [model.id]);
          await tx.providerModel.update({
            where: { id: model.id },
            data: { enabled: false, deletedAt: new Date() },
          });
          await audit(tx, context, {
            accountId: model.providerAccountId,
            action: "provider.model.delete",
            after: { modelId: model.id },
          });
        },
        (tx) => modelTargetFences(tx, { providerModelIds: [model.id] }),
      );
      return { ok: true as const };
    }),
  },

  pricing: {
    list: contractProcedure(c.pricing.list).handler(async ({ input, context }) => {
      const rows = await prisma.providerPricingVersion.findMany({
        where: { providerModelId: input.modelId, userId: userIdOf(context) },
        orderBy: { createdAt: "desc" },
      });
      return { versions: rows.map(pricingView) };
    }),
    create: contractProcedure(c.pricing.create).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const model = await prisma.providerModel.findFirst({
        where: { id: input.modelId, userId, deletedAt: null },
        select: { id: true, providerAccountId: true },
      });
      if (!model) throw notFound("That provider model does not exist.");
      const row = await graphWrite([userId], async (tx) => {
        const count = await tx.providerPricingVersion.count({
          where: { providerModelId: model.id },
        });
        return tx.providerPricingVersion.create({
          data: {
            userId,
            providerAccountId: model.providerAccountId,
            providerModelId: model.id,
            version: `v${count + 1}`,
            currency: input.currency,
            status: "DRAFT",
            activatedAt: null,
            confidence: "CALCULATED",
            pricing: input.pricing,
            ...(input.effectiveAt
              ? { effectiveAt: new Date(input.effectiveAt) }
              : { effectiveAt: new Date() }),
          },
        });
      });
      return pricingView(row);
    }),
    activate: contractProcedure(c.pricing.activate).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const draft = await prisma.providerPricingVersion.findFirst({
        where: { id: input.versionId, userId, status: "DRAFT" },
        select: { id: true, providerModelId: true },
      });
      if (!draft) throw notFound("That draft price does not exist.");
      const row = await graphWrite(
        [userId],
        async (tx) => {
          const now = new Date();
          // One active price per model: the previous one retires as this one starts.
          await tx.providerPricingVersion.updateMany({
            where: {
              providerModelId: draft.providerModelId,
              userId,
              status: "ACTIVE",
              effectiveAt: { lt: now },
            },
            data: { status: "RETIRED", retiredAt: now },
          });
          return tx.providerPricingVersion.update({
            where: { id: draft.id },
            data: { status: "ACTIVE", activatedAt: now },
          });
        },
        async () => [fences.pricing(userId, draft.providerModelId)],
      );
      return pricingView(row);
    }),
    retire: contractProcedure(c.pricing.retire).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const active = await prisma.providerPricingVersion.findFirst({
        where: { id: input.versionId, userId, status: "ACTIVE" },
        select: { id: true, providerModelId: true, effectiveAt: true },
      });
      if (!active) throw notFound("That active price does not exist.");
      const now = new Date();
      if (now <= active.effectiveAt)
        throw new ORPCError("BAD_REQUEST", { message: "A price retires after it took effect." });
      const row = await graphWrite(
        [userId],
        (tx) =>
          tx.providerPricingVersion.update({
            where: { id: active.id },
            data: { status: "RETIRED", retiredAt: now },
          }),
        async () => [fences.pricing(userId, active.providerModelId)],
      );
      return pricingView(row);
    }),
    delete: contractProcedure(c.pricing.delete).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const draft = await prisma.providerPricingVersion.findFirst({
        where: { id: input.versionId, userId, status: "DRAFT" },
        select: { id: true },
      });
      if (!draft) throw notFound("That draft price does not exist.");
      await graphWrite([userId], (tx) =>
        tx.providerPricingVersion.delete({ where: { id: draft.id } }),
      );
      return { ok: true as const };
    }),
  },

  catalog: {
    search: contractProcedure(c.catalog.search).handler(async ({ input }) => {
      const result = await openRouterCatalog().get();
      if (result.status !== "ok") return { models: [] };
      const found = searchCatalog(result.models, {
        query: input.query,
        limit: CATALOG_SEARCH_MAX_LIMIT,
      }).items.filter((model) => !input.type || catalogType(model) === input.type);
      return {
        models: found.map((model) => ({
          id: model.id,
          name: model.name,
          type: catalogType(model),
          contextWindow: model.contextLength,
        })),
      };
    }),
  },

  usage: {
    list: contractProcedure(c.usage.list).handler(async ({ input, context }) => {
      const rows = await prisma.usageLedger.findMany({
        where: {
          userId: userIdOf(context),
          ...(input.accountId ? { providerAccountId: input.accountId } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          createdAt: true,
          providerModelId: true,
          poolId: true,
          inputTokens: true,
          outputTokens: true,
          settledCost: true,
          currency: true,
          confidence: true,
        },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          providerModelId: row.providerModelId,
          poolId: row.poolId,
          inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
          outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
          cost: row.settledCost === null ? null : moneyString(row.settledCost),
          currency: row.currency,
          confidence: row.confidence,
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      };
    }),
  },

  attempts: {
    list: contractProcedure(c.attempts.list).handler(async ({ input, context }) => {
      const rows = await prisma.attempt.findMany({
        where: {
          userId: userIdOf(context),
          kind: "CLOUD",
          ...(input.accountId ? { providerAccountId: input.accountId } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          requestId: true,
          createdAt: true,
          state: true,
          providerModelId: true,
          httpStatusCode: true,
          errorClass: true,
        },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      };
    }),
  },

  spendCaps: {
    set: contractProcedure(c.spendCaps.set).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await ownedAccount(userId, input.accountId);
      const cap = account.SpendCap;
      await graphWrite(
        [userId],
        async (tx) => {
          if (cap) {
            const current = await tx.spendCap.findUniqueOrThrow({
              where: { id: cap.id },
              select: { version: true },
            });
            // Reservations snapshot the cap version; every limit change bumps it.
            await tx.spendCap.update({
              where: { id: cap.id },
              data: {
                monthlyLimit: input.monthlyLimit,
                currency: input.currency,
                version: current.version + 1,
              },
            });
          } else
            await tx.spendCap.create({
              data: {
                userId,
                scope: "PROVIDER_ACCOUNT",
                providerAccountId: account.id,
                monthlyLimit: input.monthlyLimit,
                currency: input.currency,
              },
            });
          await audit(tx, context, {
            accountId: account.id,
            action: "spend_cap.update",
            after: { monthlyLimit: input.monthlyLimit, currency: input.currency },
          });
        },
        async () => (cap ? [fences.spendCap(cap.id)] : []),
      );
      return spendFor(await ownedAccount(userId, account.id));
    }),
    clear: contractProcedure(c.spendCaps.clear).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const account = await ownedAccount(userId, input.accountId);
      const cap = account.SpendCap;
      if (cap)
        await graphWrite(
          [userId],
          async (tx) => {
            await tx.spendCap.delete({ where: { id: cap.id } });
            await audit(tx, context, { accountId: account.id, action: "spend_cap.clear" });
          },
          async () => [fences.spendCap(cap.id)],
        );
      return spendFor(await ownedAccount(userId, account.id));
    }),
  },
};

function pricingView(row: {
  id: string;
  providerModelId: string;
  version: string;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  currency: string;
  confidence: "REPORTED" | "CALCULATED" | "ESTIMATED";
  pricing: Prisma.JsonValue;
  effectiveAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}) {
  const pricing =
    typeof row.pricing === "object" && row.pricing !== null && !Array.isArray(row.pricing)
      ? row.pricing
      : {};
  return {
    id: row.id,
    providerModelId: row.providerModelId,
    version: row.version,
    status: row.status,
    currency: row.currency,
    confidence: row.confidence,
    pricing: Object.fromEntries(
      Object.entries(pricing).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, moneyString(value)]] : [],
      ),
    ),
    effectiveAt: row.effectiveAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

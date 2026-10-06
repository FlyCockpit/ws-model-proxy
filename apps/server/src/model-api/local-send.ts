import { embeddingContractsMatch } from "@ws-model-proxy/api/lib/embedding-contract";
import { resolveEffectiveCapabilityMetadata } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { poolOwnerActive } from "@ws-model-proxy/db/user-deletion-access";
import type { RelayFailure } from "../relay/protocol.js";
import { type RelayAttempt, startRelayAttempt } from "./relay-executor.js";

export type LocalSendDenial =
  | "OWNER_INACTIVE"
  | "REQUESTER_BLOCKED"
  | "ACCESS_REVOKED"
  | "MEMBER_UNAVAILABLE"
  | "CHECK_FAILED";
export const LOCAL_SEND_DENIAL_FAILURE: Record<LocalSendDenial, RelayFailure> = {
  OWNER_INACTIVE: "not_found",
  REQUESTER_BLOCKED: "access_denied",
  ACCESS_REVOKED: "not_found",
  MEMBER_UNAVAILABLE: "not_found",
  CHECK_FAILED: "unknown",
};
export class LocalSendRefused extends Error {
  readonly failure: RelayFailure;
  constructor(readonly denial: LocalSendDenial) {
    super(`local send refused: ${denial}`);
    this.failure = LOCAL_SEND_DENIAL_FAILURE[denial];
  }
}

/** Snapshot of the EXACT destination used to construct the request body. */
export type LocalSendBinding = {
  requesterUserId: string;
  modelApiTokenId?: string | null;
  engineOwnerUserId: string;
  discoveredModelId: string;
  executionTargetId: string | undefined;
  capacityId: string | null | undefined;
  endpointId: string;
  cliDeviceId: string;
  endpointSlug: string;
  upstreamModelId: string;
  pool?: {
    id: string;
    ownerUserId: string;
    accessGrantId: string | null;
    memberId: string | null;
    contributionId?: string | null;
    /** A transformer is owner-owned, and must still be the configured transformer. */
    transformer?: boolean;
    embeddingContract?: unknown;
  };
};

const modelSelect = {
  id: true,
  userId: true,
  upstreamModelId: true,
  published: true,
  capabilityOverrideMode: true,
  capabilityOverrideMetadata: true,
  ExecutionTarget: { select: { id: true, inferenceCapacityId: true } },
  Endpoint: {
    select: {
      id: true,
      slug: true,
      cliDeviceId: true,
      published: true,
      status: true,
      capabilityMetadata: true,
      CliDevice: { select: { status: true, userId: true } },
    },
  },
} satisfies Prisma.DiscoveredModelSelect;

async function checkPermission(tx: Prisma.TransactionClient, input: LocalSendBinding) {
  const deny = (reason: LocalSendDenial): never => {
    throw new LocalSendRefused(reason);
  };
  const pool = input.pool;
  if (
    !input.executionTargetId ||
    !input.capacityId ||
    !input.endpointId ||
    !input.engineOwnerUserId
  )
    deny("MEMBER_UNAVAILABLE");
  // All fences precede graph rows. Management writers cannot acquire a fence
  // while this permission transaction holds a row they need. Never acquire
  // capacity/admission rows here: admission has already finished.
  await fenceOwners(tx, [
    input.requesterUserId,
    input.engineOwnerUserId,
    ...(pool ? [pool.ownerUserId] : []),
  ]);
  await acquireFences(tx, [fences.capacityPolicy(input.executionTargetId!)]);
  if (pool) {
    await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${pool.id} FOR SHARE`;
    const current = await tx.modelPool.findUnique({
      where: { id: pool.id },
      select: {
        userId: true,
        transformerDiscoveredModelId: true,
        embeddingContract: true,
      },
    });
    if (!current || current.userId !== pool.ownerUserId) deny("ACCESS_REVOKED");
    if ((input.requesterUserId === pool.ownerUserId) !== (pool.accessGrantId === null))
      deny("ACCESS_REVOKED");
    if (pool.accessGrantId !== null) {
      await tx.$queryRaw`SELECT id FROM pool_grant WHERE id = ${pool.accessGrantId} FOR SHARE`;
      const grant = await tx.poolGrant.findFirst({
        where: {
          id: pool.accessGrantId,
          poolId: pool.id,
          ownerUserId: pool.ownerUserId,
          granteeUserId: input.requesterUserId,
        },
        select: { id: true },
      });
      if (!grant) deny("ACCESS_REVOKED");
    }
    if (
      pool.transformer &&
      (input.engineOwnerUserId !== pool.ownerUserId ||
        current!.transformerDiscoveredModelId !== input.discoveredModelId)
    )
      deny("MEMBER_UNAVAILABLE");
    if (
      pool.embeddingContract &&
      !embeddingContractsMatch(pool.embeddingContract, current!.embeddingContract)
    )
      deny("MEMBER_UNAVAILABLE");
  } else if (input.requesterUserId !== input.engineOwnerUserId) deny("ACCESS_REVOKED");

  // Registration takes device -> endpoint -> model -> member. Operational
  // writers without owner fences can change these rows; SHARE catches them.
  await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${input.cliDeviceId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM endpoint WHERE id = ${input.endpointId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM discovered_model WHERE id = ${input.discoveredModelId} FOR SHARE`;
  let model: Prisma.DiscoveredModelGetPayload<{ select: typeof modelSelect }> | null;
  if (pool?.memberId) {
    await tx.$queryRaw`SELECT id FROM pool_member WHERE id = ${pool.memberId} FOR SHARE`;
    const member = await tx.poolMember.findFirst({
      where: { id: pool.memberId, poolId: pool.id },
      select: {
        executionTargetId: true,
        discoveredModelId: true,
        tier: true,
        routingStatus: true,
        instanceGate: true,
        ExecutionTarget: {
          select: { id: true, inferenceCapacityId: true, DiscoveredModel: { select: modelSelect } },
        },
        DiscoveredModel: { select: modelSelect },
        inferenceContributionId: true,
        InferenceContribution: {
          select: {
            id: true,
            state: true,
            poolId: true,
            poolOwnerUserId: true,
            contributorUserId: true,
            discoveredModelId: true,
          },
        },
      },
    });
    if (
      !member ||
      member.ExecutionTarget?.id !== input.executionTargetId ||
      member.ExecutionTarget?.inferenceCapacityId !== input.capacityId ||
      member.tier !== "PRIMARY" ||
      member.routingStatus === "DISABLED" ||
      member.instanceGate !== "OPEN"
    )
      deny("MEMBER_UNAVAILABLE");
    model = member!.ExecutionTarget?.DiscoveredModel ?? member!.DiscoveredModel;
    const consent = member!.InferenceContribution;
    if ((member!.inferenceContributionId ?? null) !== (pool.contributionId ?? null))
      deny("MEMBER_UNAVAILABLE");
    if (member!.inferenceContributionId) {
      if (
        !consent ||
        consent.id !== member!.inferenceContributionId ||
        consent.state !== "ACTIVE" ||
        consent.poolId !== pool.id ||
        consent.poolOwnerUserId !== pool.ownerUserId ||
        consent.contributorUserId !== input.engineOwnerUserId ||
        consent.discoveredModelId !== input.discoveredModelId
      )
        deny("MEMBER_UNAVAILABLE");
    } else if (input.engineOwnerUserId !== pool.ownerUserId) deny("MEMBER_UNAVAILABLE");
  } else {
    if (pool && !pool.transformer) deny("MEMBER_UNAVAILABLE");
    model = await tx.discoveredModel.findUnique({
      where: { id: input.discoveredModelId },
      select: modelSelect,
    });
    if (
      model?.ExecutionTarget?.id !== input.executionTargetId ||
      model?.ExecutionTarget?.inferenceCapacityId !== input.capacityId
    )
      deny("MEMBER_UNAVAILABLE");
  }
  if (
    !model ||
    model.id !== input.discoveredModelId ||
    model.userId !== input.engineOwnerUserId ||
    !model.published ||
    model.upstreamModelId !== input.upstreamModelId ||
    model.Endpoint.id !== input.endpointId ||
    model.Endpoint.slug !== input.endpointSlug ||
    model.Endpoint.cliDeviceId !== input.cliDeviceId ||
    !model.Endpoint.published ||
    model.Endpoint.status === "OFFLINE" ||
    model.Endpoint.CliDevice.status !== "CONNECTED" ||
    model.Endpoint.CliDevice.userId !== input.engineOwnerUserId
  )
    deny("MEMBER_UNAVAILABLE");
  if (pool?.embeddingContract) {
    const caps = resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: model!.capabilityOverrideMode,
      capabilityOverrideMetadata: model!.capabilityOverrideMetadata,
      endpointCapabilityMetadata: model!.Endpoint.capabilityMetadata,
    });
    if (!embeddingContractsMatch(pool.embeddingContract, caps?.embeddings?.contract))
      deny("MEMBER_UNAVAILABLE");
  }
  let expiresAt: Date | null = null;
  if (input.modelApiTokenId) {
    await tx.$queryRaw`SELECT id FROM model_api_token WHERE id = ${input.modelApiTokenId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM model_api_token_allowlist_entry WHERE "modelApiTokenId" = ${input.modelApiTokenId} ORDER BY id FOR SHARE`;
    const token = await tx.modelApiToken.findUnique({
      where: { id: input.modelApiTokenId },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        scopeMode: true,
        AllowlistEntries: {
          where: pool
            ? { modelPoolId: pool.id }
            : {
                OR: [
                  { discoveredModelId: input.discoveredModelId },
                  { executionTargetId: input.executionTargetId },
                ],
              },
          select: { id: true },
        },
      },
    });
    if (
      !token ||
      token.userId !== input.requesterUserId ||
      token.revokedAt ||
      (token.expiresAt && token.expiresAt.getTime() <= Date.now()) ||
      (token.scopeMode === "ALLOWLIST" && token.AllowlistEntries.length === 0)
    )
      deny("ACCESS_REVOKED");
    expiresAt = token!.expiresAt;
  }
  // A Better Auth ban is an unfenced user UPDATE. Explicit row locks are
  // required; sorted identity order also bounds multi-account lock ordering.
  const users = [
    ...new Set([
      input.requesterUserId,
      input.engineOwnerUserId,
      ...(pool ? [pool.ownerUserId] : []),
    ]),
  ].sort();
  await tx.$queryRaw`SELECT id FROM "user" WHERE id IN (${Prisma.join(users)}) ORDER BY id FOR SHARE`;
  for (const id of users) {
    const user = await tx.user.findUnique({
      where: { id },
      select: { banned: true, banExpires: true, deletionRequestedAt: true },
    });
    if (!user || !poolOwnerActive(user, new Date()))
      deny(
        id === pool?.ownerUserId || (pool && id === input.engineOwnerUserId)
          ? "OWNER_INACTIVE"
          : "REQUESTER_BLOCKED",
      );
  }
  return expiresAt;
}

const PERMISSION_TRANSACTION = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 2_000,
  timeout: 5_000,
};

/**
 * The send claim shared by every local send (HTTP relay attempts and live
 * transcription opens): the permission check of {@link checkPermission}
 * under its row locks, then `send` — a SYNCHRONOUS external effect (a relay
 * CONTROL enqueue) — inside the same transaction, so a management write that
 * commits before the claim can never be followed by the send. Never await
 * inside `send`; never retry (the send is an external effect). When the
 * transaction fails after `send` ran, `onCommitFailure` undoes it, and the
 * send is refused (`CHECK_FAILED` unless a denial was decided).
 */
export async function withAuthorizedLocalSend<T>(
  binding: LocalSendBinding,
  send: () => T,
  {
    abortSignal,
    onCommitFailure,
    db = prisma,
  }: {
    abortSignal?: AbortSignal;
    onCommitFailure?: (sent: T) => void;
    db?: Pick<typeof prisma, "$transaction">;
  } = {},
): Promise<T> {
  let sent: { value: T } | undefined;
  try {
    return await db.$transaction(async (tx) => {
      const permissionDeadline = Date.now() + 4_000;
      await tx.$executeRaw`SELECT set_config('lock_timeout', '1500ms', true), set_config('statement_timeout', '2000ms', true)`;
      const expiresAt = await checkPermission(tx, binding);
      if (
        abortSignal?.aborted ||
        Date.now() >= permissionDeadline ||
        (expiresAt && expiresAt.getTime() <= Date.now())
      )
        throw new LocalSendRefused("CHECK_FAILED");
      // No await after this point until the transaction ends.
      sent = { value: send() };
      return sent.value;
    }, PERMISSION_TRANSACTION);
  } catch (error) {
    if (sent) onCommitFailure?.(sent.value);
    if (error instanceof LocalSendRefused) throw error;
    throw new LocalSendRefused("CHECK_FAILED");
  }
}

/**
 * The same permission check without a send: for rechecks of a long-lived
 * send (a live transcription session every 60 s). Null when the binding is
 * still authorized; the denial otherwise. A transaction or lock failure
 * throws (the caller decides; it is never a pass).
 */
export async function checkLocalSendPermission(
  binding: LocalSendBinding,
  db: Pick<typeof prisma, "$transaction"> = prisma,
): Promise<LocalSendDenial | null> {
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', '1500ms', true), set_config('statement_timeout', '2000ms', true)`;
      const expiresAt = await checkPermission(tx, binding);
      if (expiresAt && expiresAt.getTime() <= Date.now())
        throw new LocalSendRefused("ACCESS_REVOKED");
    }, PERMISSION_TRANSACTION);
    return null;
  } catch (error) {
    if (error instanceof LocalSendRefused) return error.denial;
    throw error;
  }
}

/**
 * Send acceptance linearizes at the synchronous relay.request CONTROL enqueue
 * inside startRelayAttempt -> RelaySessionManager.sendRelayRequest. Subsequent
 * ordered body chunks belong to this accepted attempt. Never await body,
 * upstream response, or caller consumption while holding permissions. Never
 * retry this transaction: enqueue is an external effect. A commit failure
 * cancels the possibly accepted attempt and denies further work.
 */
export async function startAuthorizedLocalRelayAttempt(
  binding: LocalSendBinding,
  args: Parameters<typeof startRelayAttempt>[0],
  db: Pick<typeof prisma, "$transaction"> = prisma,
): Promise<RelayAttempt> {
  if (binding.cliDeviceId !== args.cliDeviceId || binding.endpointSlug !== args.endpointSlug) {
    throw new LocalSendRefused("MEMBER_UNAVAILABLE");
  }
  return withAuthorizedLocalSend(
    binding,
    () => {
      // The real manager queues CONTROL synchronously before starting its
      // async body pump.
      const attempt = startRelayAttempt(args);
      // Ensure commit failure cleanup cannot create an unhandled rejection.
      void attempt.started.catch(() => {});
      return attempt;
    },
    {
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      onCommitFailure: (attempt) => attempt.cancel("cancelled"),
      db,
    },
  );
}

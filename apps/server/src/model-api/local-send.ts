import { embeddingContractsMatch } from "@ws-model-proxy/api/lib/embedding-contract";
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
  apiKeyId?: string | null;
  /** The owner of the served model (the pool owner, or a contributor). */
  engineOwnerUserId: string;
  runtimeModelId: string;
  executionTargetId: string | undefined;
  /** The instance (capacityId). */
  capacityId: string | null | undefined;
  /** The head node the request is relayed to. */
  nodeId: string;
  /** The instance handle the node routes by. */
  handle: string;
  upstreamModelId: string;
  pool?: {
    id: string;
    ownerUserId: string;
    /** The share the requester reached the pool through; null for the owner. */
    shareId: string | null;
    memberId: string | null;
    /** The contributing share of a contributed member (null for the owner's own). */
    contributedShareId?: string | null;
    embeddingContract?: unknown;
  };
};

async function checkPermission(tx: Prisma.TransactionClient, input: LocalSendBinding) {
  const deny = (reason: LocalSendDenial): never => {
    throw new LocalSendRefused(reason);
  };
  const pool = input.pool;
  if (!input.executionTargetId || !input.capacityId || !input.nodeId || !input.engineOwnerUserId)
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
    await tx.$queryRaw`SELECT id FROM pool WHERE id = ${pool.id} FOR SHARE`;
    const current = await tx.pool.findUnique({
      where: { id: pool.id },
      select: { userId: true, Fallback: { select: { embeddingContract: true } } },
    });
    if (!current || current.userId !== pool.ownerUserId) deny("ACCESS_REVOKED");
    if ((input.requesterUserId === pool.ownerUserId) !== (pool.shareId === null))
      deny("ACCESS_REVOKED");
    if (pool.shareId !== null) {
      await tx.$queryRaw`SELECT id FROM share WHERE id = ${pool.shareId} FOR SHARE`;
      const share = await tx.share.findFirst({
        where: {
          id: pool.shareId,
          poolId: pool.id,
          ownerUserId: pool.ownerUserId,
          granteeUserId: input.requesterUserId,
          canUse: true,
        },
        select: { id: true },
      });
      if (!share) deny("ACCESS_REVOKED");
    }
    if (
      pool.embeddingContract &&
      !embeddingContractsMatch(pool.embeddingContract, current!.Fallback?.embeddingContract)
    )
      deny("MEMBER_UNAVAILABLE");
  } else if (input.requesterUserId !== input.engineOwnerUserId) deny("ACCESS_REVOKED");

  // Registration and lifecycle writers change the node and instance rows without the owner
  // fence for status columns; SHARE locks catch them.
  await tx.$queryRaw`SELECT id FROM node WHERE id = ${input.nodeId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM runtime_instance WHERE id = ${input.capacityId} FOR SHARE`;
  // KEY SHARE: the target's identity columns are immutable and only its deletion matters here;
  // health writers (FOR NO KEY UPDATE) must not queue behind every send.
  await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${input.executionTargetId} FOR KEY SHARE`;
  if (pool?.memberId) {
    await tx.$queryRaw`SELECT id FROM pool_member WHERE id = ${pool.memberId} FOR SHARE`;
    const member = await tx.poolMember.findFirst({
      where: { id: pool.memberId, poolId: pool.id },
      select: {
        kind: true,
        state: true,
        runtimeModelId: true,
        shareId: true,
        Share: { select: { canContribute: true, granteeUserId: true, poolId: true } },
      },
    });
    if (
      !member ||
      member.kind !== "LOCAL" ||
      member.state !== "ACTIVE" ||
      member.runtimeModelId !== input.runtimeModelId ||
      (member.shareId ?? null) !== (pool.contributedShareId ?? null)
    )
      deny("MEMBER_UNAVAILABLE");
    if (member!.shareId) {
      const share = member!.Share;
      if (
        !share ||
        !share.canContribute ||
        share.poolId !== pool.id ||
        share.granteeUserId !== input.engineOwnerUserId
      )
        deny("MEMBER_UNAVAILABLE");
    } else if (input.engineOwnerUserId !== pool.ownerUserId) deny("MEMBER_UNAVAILABLE");
  } else if (pool) deny("MEMBER_UNAVAILABLE");
  const target = await tx.executionTarget.findUnique({
    where: { id: input.executionTargetId! },
    select: {
      userId: true,
      instanceId: true,
      runtimeModelId: true,
      RuntimeModel: { select: { upstreamModelId: true, embeddingContract: true } },
      Instance: {
        select: {
          handle: true,
          phase: true,
          Runtime: { select: { kind: true, nodeId: true } },
          Ranks: { where: { rank: 0 }, select: { nodeId: true } },
        },
      },
    },
  });
  const headNodeId =
    target?.Instance?.Runtime.kind === "ALWAYS_ON"
      ? target.Instance.Runtime.nodeId
      : (target?.Instance?.Ranks[0]?.nodeId ?? null);
  const node = headNodeId
    ? await tx.node.findUnique({
        where: { id: headNodeId },
        select: { userId: true, connection: true },
      })
    : null;
  if (
    !target ||
    target.userId !== input.engineOwnerUserId ||
    target.instanceId !== input.capacityId ||
    target.runtimeModelId !== input.runtimeModelId ||
    target.RuntimeModel?.upstreamModelId !== input.upstreamModelId ||
    target.Instance?.handle !== input.handle ||
    target.Instance.phase !== "READY" ||
    headNodeId !== input.nodeId ||
    node?.connection !== "ONLINE" ||
    node.userId !== input.engineOwnerUserId
  )
    deny("MEMBER_UNAVAILABLE");
  if (
    pool?.embeddingContract &&
    !embeddingContractsMatch(pool.embeddingContract, target!.RuntimeModel?.embeddingContract)
  )
    deny("MEMBER_UNAVAILABLE");
  let expiresAt: Date | null = null;
  if (input.apiKeyId) {
    await tx.$queryRaw`SELECT id FROM api_key WHERE id = ${input.apiKeyId} FOR SHARE`;
    const key = await tx.apiKey.findUnique({
      where: { id: input.apiKeyId },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        scope: true,
        Pools: pool ? { where: { poolId: pool.id }, select: { poolId: true } } : false,
      },
    });
    if (
      !key ||
      !pool ||
      key.userId !== input.requesterUserId ||
      key.revokedAt ||
      (key.expiresAt && key.expiresAt.getTime() <= Date.now()) ||
      (key.scope === "SELECTED_POOLS" && (key.Pools?.length ?? 0) === 0)
    )
      deny("ACCESS_REVOKED");
    expiresAt = key!.expiresAt;
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
/** Relay attempt arguments (head node and instance handle). */
export type LocalRelayAttemptArgs = Parameters<typeof startRelayAttempt>[0];

export async function startAuthorizedLocalRelayAttempt(
  binding: LocalSendBinding,
  args: LocalRelayAttemptArgs,
  db: Pick<typeof prisma, "$transaction"> = prisma,
): Promise<RelayAttempt> {
  if (binding.nodeId !== args.nodeId || binding.handle !== args.handle) {
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

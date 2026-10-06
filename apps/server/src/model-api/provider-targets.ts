/**
 * The execution target of a provider model (`execution_target` kind PROVIDER_MODEL): the
 * immutable identity routes, stickiness bindings and attempts name a cloud member by.
 *
 * Provider model creation creates it in the same transaction (`providers.models.create`); this
 * fallback creates any still missing (models created before that) on first use, once per model. Writer class M: the owner fence, then the target
 * identity fences, before any row; then the account and model rows FOR KEY SHARE (the insert's
 * foreign key re-enters them), then the insert. Idempotent: a concurrent creator is a no-op.
 */
import prisma from "@ws-model-proxy/db";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";

export async function ensureProviderExecutionTargets(
  userId: string,
  models: ReadonlyArray<{ id: string; providerAccountId: string }>,
): Promise<Map<string, string>> {
  const unique = [...new Map(models.map((model) => [model.id, model])).values()].sort(
    (left, right) => (left.id < right.id ? -1 : 1),
  );
  if (unique.length === 0) return new Map();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', '2000ms', true)`;
      await fenceOwners(tx, [userId]);
      await acquireFences(
        tx,
        unique.map((model) => fences.targetIdentity(`provider-model:${model.id}`)),
      );
      const accounts = [...new Set(unique.map((model) => model.providerAccountId))].sort();
      for (const accountId of accounts)
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${accountId} AND "userId" = ${userId} FOR KEY SHARE`;
      for (const model of unique)
        await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${model.id} AND "userId" = ${userId} FOR KEY SHARE`;
      const live = await tx.providerModel.findMany({
        where: {
          id: { in: unique.map((model) => model.id) },
          userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (live.length > 0)
        await tx.executionTarget.createMany({
          data: live.map((model) => ({
            userId,
            kind: "PROVIDER_MODEL",
            providerModelId: model.id,
          })),
          skipDuplicates: true,
        });
      const targets = await tx.executionTarget.findMany({
        where: { userId, providerModelId: { in: live.map((model) => model.id) } },
        select: { id: true, providerModelId: true },
      });
      return new Map(
        targets.flatMap((target) =>
          target.providerModelId ? [[target.providerModelId, target.id] as const] : [],
        ),
      );
    },
    { isolationLevel: "ReadCommitted", maxWait: 2_000, timeout: 5_000 },
  );
}

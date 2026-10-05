import { createStatementBoundedPrismaClient } from "@ws-model-proxy/db/client-factory";
import { reclaimClearedAffinity } from "@ws-model-proxy/db/hot-path-sweeps";
import { env } from "@ws-model-proxy/env/server";
import { recoverAffinityObservers } from "./cache-affinity-observers.js";

/** Durable logical-clear reclamation is independent of any HTTP caller or relay observer. */
export function startAffinityAuthorityMaintenance() {
  const owned = createStatementBoundedPrismaClient(env.DATABASE_URL, {
    statementTimeoutMs: 1000,
    connectTimeoutMs: 100,
    applicationName: "wsmp-affinity-authority",
    maxConnections: 1,
    minIdleConnections: 0,
    keepAliveInitialDelayMs: 1000,
  });
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      await recoverAffinityObservers().catch(() => {});
      for (let page = 0; page < 4 && !stopped; page++) {
        try {
          const [scope] = await owned.prisma.$queryRaw<Array<{ poolId: string; userId: string }>>`
            UPDATE cache_affinity_scope SET "reclaimAfter" = clock_timestamp() + interval '2 seconds'
            WHERE "poolId" = (SELECT "poolId" FROM cache_affinity_scope
              WHERE "reclaimPending" AND "reclaimAfter" <= clock_timestamp()
              ORDER BY "reclaimAfter", "poolId" LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING "poolId", "userId"`;
          if (!scope) break;
          await reclaimClearedAffinity(owned.prisma, {
            poolId: scope.poolId,
            ownerUserId: scope.userId,
          });
        } catch {
          // Durable delay rotates busy scopes. No unbounded retry inside a tick.
        }
      }
      if (!stopped) {
        await owned.prisma.$executeRaw`DELETE FROM cache_affinity_observer WHERE ctid = ANY(ARRAY(
          SELECT o.ctid FROM cache_affinity_observer o WHERE NOT EXISTS (
            SELECT 1 FROM inference_capacity c WHERE c.id = o."capacityId")
          OR (o.retired AND NOT EXISTS (
            SELECT 1 FROM execution_target t JOIN discovered_model m ON m.id = t."discoveredModelId"
            JOIN endpoint e ON e.id = m."endpointId" JOIN cli_device d ON d.id = e."cliDeviceId"
            WHERE t."inferenceCapacityId" = o."capacityId" AND e."cliDeviceId" = o."cliDeviceId"
              AND e.slug = o."endpointSlug" AND d."connectionGeneration" = o."connectionGeneration"))
          LIMIT 64 FOR UPDATE SKIP LOCKED))`;
        await owned.prisma.$executeRaw`DELETE FROM cache_affinity_scope WHERE "poolId" IN (
          SELECT s."poolId" FROM cache_affinity_scope s WHERE NOT s."reclaimPending" AND NOT EXISTS (
            SELECT 1 FROM model_pool p WHERE p.id = s."poolId") LIMIT 64 FOR UPDATE SKIP LOCKED)`;
      }
    })()
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 500);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    owned.quarantine();
    await running;
    await owned.prisma.$disconnect();
  };
}

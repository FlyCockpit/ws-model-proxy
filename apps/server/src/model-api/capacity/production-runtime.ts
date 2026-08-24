import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { PostgresCapacityAdmissionStore } from "./postgres-store.js";
import { PostgresCapacityWakeSource } from "./postgres-wake-source.js";
import { StoreCapacityAdmissionRuntime } from "./runtime.js";

export function createProductionCapacityRuntime() {
  const wakeSource = PostgresCapacityWakeSource.production(env.DATABASE_URL);
  const notifier = {
    async notify(capacityIds: readonly string[]) {
      // Payloads are opaque capacity IDs only: never prompt/request content.
      for (const capacityId of new Set(capacityIds)) {
        await prisma.$executeRaw`SELECT pg_notify('wsmp_capacity', ${capacityId})`;
      }
    },
  };
  const store = new PostgresCapacityAdmissionStore(prisma, crypto.randomUUID(), notifier);
  return {
    runtime: new StoreCapacityAdmissionRuntime(store, 100, 5_000, wakeSource),
    close: () => wakeSource.close(),
  };
}

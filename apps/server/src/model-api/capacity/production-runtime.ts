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
  const runtime = new StoreCapacityAdmissionRuntime(store, 100, 5_000, wakeSource);
  let inFlight: Promise<void> | undefined;
  const runMaintenance = () => {
    if (inFlight) return;
    inFlight = (async () => {
      try {
        await runtime.maintain();
      } catch (error) {
        // Prisma failures may contain SQL and parameters. Log only the class.
        console.error(
          "[capacity] maintenance sweep failed:",
          error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
        );
      }
    })().finally(() => {
      inFlight = undefined;
    });
  };
  const maintenanceTimer = setInterval(runMaintenance, 5_000);
  maintenanceTimer.unref?.();
  const stopMaintenance = async () => {
    clearInterval(maintenanceTimer);
    await inFlight;
    await wakeSource.close();
  };
  return {
    runtime,
    // Stop background work before HTTP drain, retaining admissions and owners.
    stopMaintenance,
    async close() {
      await stopMaintenance();
      await runtime.close();
    },
  };
}

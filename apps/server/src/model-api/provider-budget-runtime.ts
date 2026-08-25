import { repairExpiredProviderBudgets } from "./provider-budget.js";

const REPAIR_INTERVAL_MS = 60_000;

/** Starts bounded conservative crash reconciliation. Safe on every replica. */
export function startProviderBudgetRepair(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await repairExpiredProviderBudgets();
    } catch {
      console.warn("[provider-budget] expired-attempt repair failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), REPAIR_INTERVAL_MS);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

import { backfillDiscoveredInferenceCapacities } from "@ws-model-proxy/api/lib/discovered-inference-capacity";
import { sweepOrphanAutoCapacities } from "@ws-model-proxy/api/lib/engine-process-capacity";

/** Complete graph repairs before listen; index.ts owns the fatal error contract. */
export async function runStartupCapacityRepairs(): Promise<void> {
  await backfillDiscoveredInferenceCapacities();
  await sweepOrphanAutoCapacities();
}

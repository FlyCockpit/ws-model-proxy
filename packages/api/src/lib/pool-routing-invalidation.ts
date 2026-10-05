import type { Context } from "../context";

/** A committed mutation is successful even if an advisory relay nudge fails. */
export async function invalidatePoolRouting(
  services: Context["services"],
  poolIds: readonly string[],
): Promise<void> {
  for (const id of new Set(poolIds)) {
    try {
      await services?.onPoolRoutingRulesChanged?.(id);
    } catch {
      // The evaluator refreshes the rules independently; never expose payloads.
    }
  }
}

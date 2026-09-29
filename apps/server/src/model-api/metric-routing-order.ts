/**
 * Candidate build side of metric routing rules (S-B part 2).
 *
 * Runs after compatibility and cache affinity ordering:
 * - a member with a fresh `full` verdict is dropped (it is FULL), unless
 *   every candidate is metric-FULL: then all are kept and admission decides
 *   (fail open for plain callers; an `:external` caller's shortened local
 *   phase waits and goes external instead);
 * - a member with a fresh `avoid` verdict moves after every other member,
 *   keeping relative order (ordering only; never ineligible).
 *
 * The verdict read is a plain SELECT of the H-class verdict table. Any
 * failure leaves the candidates unchanged: metrics never make a route
 * unavailable.
 */
import prisma from "@ws-model-proxy/db";

type VerdictDb = Pick<typeof prisma, "poolMemberRoutingVerdict">;

export type MetricOrderResult<T> = {
  candidates: T[];
  /** Members dropped because they are metric-FULL. */
  droppedFull: string[];
  /** Every candidate was metric-FULL, so none was dropped. */
  allFull: boolean;
};

export async function applyMetricRoutingVerdicts<T extends { poolMemberId: string }>(
  candidates: readonly T[],
  { db = prisma, now = new Date() }: { db?: VerdictDb; now?: Date } = {},
): Promise<MetricOrderResult<T>> {
  const unchanged = { candidates: [...candidates], droppedFull: [], allFull: false };
  if (candidates.length === 0) return unchanged;
  let rows: Array<{ poolMemberId: string; verdict: "NONE" | "AVOID" | "FULL" }>;
  try {
    rows = await db.poolMemberRoutingVerdict.findMany({
      where: {
        poolMemberId: { in: candidates.map((candidate) => candidate.poolMemberId) },
        verdict: { in: ["FULL", "AVOID"] },
        expiresAt: { gt: now },
      },
      select: { poolMemberId: true, verdict: true },
    });
  } catch (error) {
    console.warn(
      "[model-api] metric routing verdict read failed; ignoring rules",
      error instanceof Error ? error.name : typeof error,
    );
    return unchanged;
  }
  if (!Array.isArray(rows) || rows.length === 0) return unchanged;
  const verdicts = new Map(rows.map((row) => [row.poolMemberId, row.verdict]));
  const full = candidates.filter((candidate) => verdicts.get(candidate.poolMemberId) === "FULL");
  const allFull = full.length === candidates.length;
  const kept = allFull
    ? [...candidates]
    : candidates.filter((candidate) => verdicts.get(candidate.poolMemberId) !== "FULL");
  const avoided = kept.filter((candidate) => verdicts.get(candidate.poolMemberId) === "AVOID");
  const preferred = kept.filter((candidate) => verdicts.get(candidate.poolMemberId) !== "AVOID");
  return {
    candidates: [...preferred, ...avoided],
    droppedFull: allFull ? [] : full.map((candidate) => candidate.poolMemberId),
    allFull,
  };
}

/**
 * Candidate build side of metric routing rules (S-B part 2), per route (member × target):
 *
 * Runs after compatibility and cache affinity ordering:
 * - a route with a fresh `FULL` verdict is dropped (it is FULL), unless every candidate is
 *   metric-FULL: then all are kept and admission decides (fail open for plain callers; an
 *   `:external` caller's shortened local phase waits and goes external instead);
 * - a route with a fresh `AVOID` verdict moves after every other route, keeping relative
 *   order (ordering only; never ineligible).
 *
 * The verdict read is a plain SELECT of the H-class `routing_verdict` table. Any failure leaves
 * the candidates unchanged: metrics never make a route unavailable.
 */
import prisma from "@ws-model-proxy/db";

type VerdictDb = Pick<typeof prisma, "routingVerdict">;

type RouteRef = { poolMemberId: string; executionTargetId: string };

export type MetricOrderResult<T> = {
  candidates: T[];
  /** Routes dropped because they are metric-FULL, as `member:target` keys. */
  droppedFull: string[];
  /** Every candidate was metric-FULL, so none was dropped. */
  allFull: boolean;
};

function key(route: RouteRef): string {
  return `${route.poolMemberId}:${route.executionTargetId}`;
}

export async function applyMetricRoutingVerdicts<T extends RouteRef>(
  candidates: readonly T[],
  {
    db = prisma,
    now = new Date(),
    memberIdOf = (candidate) => candidate.poolMemberId,
  }: {
    db?: VerdictDb;
    now?: Date;
    /** The PoolMember of a candidate, when `poolMemberId` holds an in-memory route key. */
    memberIdOf?: (candidate: T) => string;
  } = {},
): Promise<MetricOrderResult<T>> {
  const unchanged = { candidates: [...candidates], droppedFull: [], allFull: false };
  if (candidates.length === 0) return unchanged;
  const candidateKey = (candidate: T) =>
    key({ poolMemberId: memberIdOf(candidate), executionTargetId: candidate.executionTargetId });
  let rows: Array<RouteRef & { verdict: "NONE" | "AVOID" | "FULL" }>;
  try {
    rows = await db.routingVerdict.findMany({
      where: {
        poolMemberId: { in: [...new Set(candidates.map(memberIdOf))] },
        verdict: { in: ["FULL", "AVOID"] },
        expiresAt: { gt: now },
      },
      select: { poolMemberId: true, executionTargetId: true, verdict: true },
    });
  } catch (error) {
    console.warn(
      "[model-api] metric routing verdict read failed; ignoring rules",
      error instanceof Error ? error.name : typeof error,
    );
    return unchanged;
  }
  if (!Array.isArray(rows) || rows.length === 0) return unchanged;
  const verdicts = new Map(rows.map((row) => [key(row), row.verdict]));
  const full = candidates.filter((candidate) => verdicts.get(candidateKey(candidate)) === "FULL");
  const allFull = full.length === candidates.length;
  const kept = allFull
    ? [...candidates]
    : candidates.filter((candidate) => verdicts.get(candidateKey(candidate)) !== "FULL");
  const avoided = kept.filter((candidate) => verdicts.get(candidateKey(candidate)) === "AVOID");
  const preferred = kept.filter((candidate) => verdicts.get(candidateKey(candidate)) !== "AVOID");
  return {
    candidates: [...preferred, ...avoided],
    droppedFull: allFull ? [] : full.map(candidateKey),
    allFull,
  };
}

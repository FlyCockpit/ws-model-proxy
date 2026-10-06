/**
 * Hold lines on a profile save (owner decision round 3, security). Pure: the save procedure
 * passes the stored lines and the requested ones and writes what this returns.
 *
 * Hold lines are people's. An agent's save (any caller for whom `agentRulesApply`) keeps the
 * stored lines when it sends none, and is refused `human_only` when it would change any line
 * (add, remove, change a note) or drop an owned node that has a hold line. Without this an
 * agent could drop a person's hold line and then release that hold on its next apply.
 */

export type HoldLine = { nodeId: string; note: string | null };

export type ProfileSavePlan =
  | { ok: true; holds: HoldLine[] }
  | { ok: false; reason: "human_only" | "duplicate_hold" | "hold_not_owned"; nodeIds: string[] };

function key(line: HoldLine): string {
  return `${line.nodeId}\u0000${line.note ?? ""}`;
}

export function planProfileSave(input: {
  caller: "person" | "agent";
  /** The stored hold lines (none for a new profile). */
  before: readonly HoldLine[];
  after: {
    /** The nodes the profile will own. */
    nodeIds: readonly string[];
    /** The requested hold lines; undefined keeps the stored ones. */
    holds: readonly HoldLine[] | undefined;
  };
}): ProfileSavePlan {
  const holds = [...(input.after.holds ?? input.before)].map((line) => ({
    nodeId: line.nodeId,
    note: line.note ?? null,
  }));
  if (input.caller === "agent") {
    const before = new Set(input.before.map(key));
    const after = new Set(holds.map(key));
    const changed = [
      ...input.before.filter((line) => !after.has(key(line))),
      ...holds.filter((line) => !before.has(key(line))),
    ].map((line) => line.nodeId);
    if (changed.length > 0)
      return { ok: false, reason: "human_only", nodeIds: [...new Set(changed)] };
    const owned = new Set(input.after.nodeIds);
    const dropped = input.before.filter((line) => !owned.has(line.nodeId)).map((l) => l.nodeId);
    if (dropped.length > 0) return { ok: false, reason: "human_only", nodeIds: dropped };
  }
  const seen = new Set<string>();
  const duplicates = holds.filter((line) => seen.has(line.nodeId) || !seen.add(line.nodeId));
  if (duplicates.length > 0)
    return { ok: false, reason: "duplicate_hold", nodeIds: duplicates.map((line) => line.nodeId) };
  const owned = new Set(input.after.nodeIds);
  const stray = holds.filter((line) => !owned.has(line.nodeId)).map((line) => line.nodeId);
  if (stray.length > 0) return { ok: false, reason: "hold_not_owned", nodeIds: stray };
  return { ok: true, holds };
}

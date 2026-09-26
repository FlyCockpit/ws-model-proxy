/**
 * Stable reasons the oRPC API attaches (as ORPCError `data.reason`) to
 * deletion-related CONFLICT responses the dashboard consumes. MCP tool errors
 * currently expose only `{ code: "CONFLICT" }` (reason not forwarded yet).
 * Better Auth delete/restore routes return Better Auth's own `{ code, message
 * }` body, not these reasons. The HTTP/oRPC code stays CONFLICT.
 *
 * - `retained_history`: capacity or provider history must be kept, so the
 *   item (or user) can never be deleted; archive or disable it instead.
 * - `delete_pending`: requests are still in flight on the item; nothing was
 *   deleted, retry once they finish.
 * - `delete_contended`: the ordered delete kept losing its locks to live
 *   traffic; nothing was deleted, retry.
 * - `still_attached`: a capacity is still attached to a pool member.
 * - `not_stale`: a stale-only delete found the item reporting recently.
 * - `deletion_in_progress`: the user is being deleted and cannot be restored.
 */
export const DELETION_CONFLICT_REASONS = [
  "retained_history",
  "delete_pending",
  "delete_contended",
  "still_attached",
  "not_stale",
  "deletion_in_progress",
] as const;

export type DeletionConflictReason = (typeof DELETION_CONFLICT_REASONS)[number];

const reasons: ReadonlySet<string> = new Set(DELETION_CONFLICT_REASONS);

export function isDeletionConflictReason(value: unknown): value is DeletionConflictReason {
  return typeof value === "string" && reasons.has(value);
}

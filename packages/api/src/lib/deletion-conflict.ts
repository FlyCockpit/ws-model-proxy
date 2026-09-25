import { ORPCError } from "@orpc/server";
import type { DeletionConflictReason } from "@ws-model-proxy/config/deletion-conflict";

/**
 * oRPC deletion refusals the dashboard reads via `data.reason`. The message
 * stays human-readable for oRPC clients. MCP tools currently answer with
 * `{ error: { code: "CONFLICT" } }` only (reason not forwarded yet). Better
 * Auth delete/restore routes return Better Auth's own APIError body.
 */
export function deletionConflict(
  reason: DeletionConflictReason,
  message: string,
): ORPCError<"CONFLICT", { reason: DeletionConflictReason }> {
  return new ORPCError("CONFLICT", { message, data: { reason } });
}

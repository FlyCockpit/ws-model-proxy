/**
 * The end of a node command, recorded once: the `NodeCommand` row leaves RUNNING and its
 * `NodeAuditEvent` is appended in the same transaction. Shared by the procedures (a poll that
 * saw the end) and apps/server (an `exec.status` the node sent on its own, after a cancel or
 * at the end of a command nobody was polling).
 */
import prisma from "@ws-model-proxy/db";
import type { NodeCommandLiveStatus } from "../context";
import type { NodeCommandStateWire } from "./runtime-spec";

export type NodeCommandState = NodeCommandLiveStatus["state"];
export type NodeCommandEndState = Exclude<NodeCommandState, "RUNNING">;

export const nodeCommandSelect = {
  id: true,
  nodeId: true,
  userId: true,
  actor: true,
  agentTokenId: true,
  mcpGrantId: true,
  subject: true,
  state: true,
  exitCode: true,
  startedAt: true,
  endsBy: true,
  finishedAt: true,
} as const;

export type NodeCommandRow = {
  id: string;
  nodeId: string;
  userId: string;
  actor: "USER" | "AGENT" | "SYSTEM";
  agentTokenId: string | null;
  mcpGrantId: string | null;
  subject: string;
  state: NodeCommandState;
  exitCode: number | null;
  startedAt: Date;
  endsBy: Date;
  finishedAt: Date | null;
};

const WIRE_STATE: Record<NodeCommandStateWire, NodeCommandState> = {
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "TIMED_OUT",
  interrupted: "INTERRUPTED",
  unknown: "UNKNOWN",
};

/** `exec.status.state` (relay wire) as the stored state. */
export function nodeCommandStateFromWire(state: NodeCommandStateWire): NodeCommandState {
  return WIRE_STATE[state];
}

const AUDIT_OUTCOME: Record<
  NodeCommandEndState,
  { outcome: "completed" | "cancelled" | "unknown"; reason: string | null }
> = {
  SUCCEEDED: { outcome: "completed", reason: null },
  FAILED: { outcome: "completed", reason: "exit_nonzero" },
  CANCELLED: { outcome: "cancelled", reason: "cancelled" },
  TIMED_OUT: { outcome: "cancelled", reason: "timeout" },
  INTERRUPTED: { outcome: "unknown", reason: "interrupted" },
  UNKNOWN: { outcome: "unknown", reason: "unknown_to_node" },
};

/**
 * Records a command's end once: the row leaves RUNNING (guarded, so concurrent settlers
 * record it exactly once) and the audit event is appended by whoever settled it. Answers the
 * row as stored afterwards.
 */
export async function settleNodeCommand(
  row: NodeCommandRow,
  state: NodeCommandEndState,
  exitCode: number | null | undefined,
  finishedAtHint: Date | undefined,
  audit?: { outcome: "failed"; reason: string },
): Promise<NodeCommandRow> {
  const finishedAt = new Date(
    Math.max(row.startedAt.getTime(), (finishedAtHint ?? new Date()).getTime()),
  );
  const storedExit =
    (state === "SUCCEEDED" || state === "FAILED") &&
    typeof exitCode === "number" &&
    Number.isInteger(exitCode) &&
    exitCode >= 0 &&
    exitCode <= 255
      ? exitCode
      : null;
  // The state change and its audit event commit together, exactly once.
  const settledHere = await prisma.$transaction(async (tx) => {
    const settled = await tx.nodeCommand.updateMany({
      where: { id: row.id, state: "RUNNING" },
      data: { state, exitCode: storedExit, finishedAt },
    });
    if (settled.count !== 1) return false;
    const { outcome, reason } = audit ?? AUDIT_OUTCOME[state];
    await tx.nodeAuditEvent.create({
      data: {
        userId: row.userId,
        nodeId: row.nodeId,
        actor: row.actor,
        agentTokenId: row.agentTokenId,
        mcpGrantId: row.mcpGrantId,
        kind: "command",
        subject: row.subject,
        exitCode: storedExit,
        outcome,
        reason,
        startedAt: row.startedAt,
        finishedAt,
      },
    });
    return true;
  });
  if (settledHere) return { ...row, state, exitCode: storedExit, finishedAt };
  const current = await prisma.nodeCommand.findUnique({
    where: { id: row.id },
    select: nodeCommandSelect,
  });
  return current ?? row;
}

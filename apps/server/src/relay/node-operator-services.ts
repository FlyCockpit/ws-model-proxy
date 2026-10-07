/**
 * The relay side of `Context.services.nodeOperator` (lane D): node commands over relay 3.0
 * (`exec.start` / `exec.poll` / `exec.cancel`, answered by `exec.started` / `exec.status` /
 * `exec.rejected`) and the browser terminal tickets.
 *
 * Every exchange is pinned to the node's live session when it is sent: only that session may
 * answer it, and only that session's loss fails it. `exec.start` also needs that session at
 * Full control; `exec.poll` and `exec.cancel` do not (a node at Relay still answers them: it
 * reads and stops, contract 0.4.0 §17 item 9).
 *
 * A command's end the node reports on its own (a cancel, the time limit, an interrupted
 * daemon) is recorded here when no poll is waiting for it, so the row does not stay RUNNING
 * until someone asks.
 *
 * Command text and output are never logged, kept or put into an error.
 */
import { ORPCError } from "@orpc/server";
import type { NodeCommandLiveStatus, NodeOperatorServices } from "@ws-model-proxy/api/context";
import {
  nodeCommandSelect,
  nodeCommandStateFromWire,
  settleNodeCommand,
} from "@ws-model-proxy/api/lib/node-command-settle";
import {
  NODE_COMMAND_MAX_MS,
  NODE_COMMAND_TAIL_MAX_BYTES,
} from "@ws-model-proxy/api/lib/runtime-spec";
import prisma from "@ws-model-proxy/db";
import type {
  NodeToServerControlFrame,
  NodeTrustWire,
  ServerToNodeControlFrame,
} from "./frames.js";
import type { NodeCommandTracker } from "./node-command-tracker.js";
import { nodeOwnerMatches } from "./node-owner.js";
import type { NodeFrameHandlers, NodeSessionRef, SendGuard } from "./session-manager.js";
import type { TerminalTicketStore } from "./terminal-tickets.js";

type NodeFrame<T extends NodeToServerControlFrame["type"]> = Extract<
  NodeToServerControlFrame,
  { type: T }
>;
type ExecStatusFrame = NodeFrame<"exec.status">;

/** How long a start waits for `exec.started` / `exec.rejected`. */
export const EXEC_START_TIMEOUT_MS = 15_000;
/** How long a poll waits for the node's answer to one `exec.poll`. */
export const EXEC_POLL_ANSWER_TIMEOUT_MS = 5_000;

export class NodeCommandStartError extends Error {
  constructor(readonly code: "not_delivered" | "rejected" | "no_answer" | "disconnected") {
    super(`The node did not start the command (${code}).`);
    this.name = "NodeCommandStartError";
  }
}

export type NodeOperatorRelayPort = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(
    nodeId: string,
  ): { userId: string; connectionGeneration: number; trust: NodeTrustWire } | null;
};

export type NodeOperatorHandlers = Pick<
  NodeFrameHandlers,
  "exec.started" | "exec.status" | "exec.rejected" | "nodeDisconnected" | "nodeReady"
>;

type PendingStart = {
  nodeId: string;
  userId: string;
  connectionGeneration: number;
  resolve: (value: { startedAt: Date; endsBy: Date }) => void;
  reject: (error: NodeCommandStartError) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PollWaiter = {
  nodeId: string;
  userId: string;
  connectionGeneration: number;
  /** Still waiting for the command's end (until the caller's `waitMs`). */
  wantEnd: boolean;
  latest: ExecStatusFrame | null;
  onStatus: (frame: ExecStatusFrame) => void;
  /** Answer now with the latest status (null: none arrived). */
  finish: () => void;
};

function liveStatus(frame: ExecStatusFrame): NodeCommandLiveStatus {
  return {
    state: nodeCommandStateFromWire(frame.state),
    ...(frame.exitCode !== undefined ? { exitCode: frame.exitCode } : {}),
    output: frame.tail ?? "",
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.finishedAt !== undefined ? { finishedAt: new Date(frame.finishedAt) } : {}),
  };
}

/** The class only: an error message could carry frame content. */
function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export function createNodeOperatorServices(
  relay: NodeOperatorRelayPort,
  options: {
    tickets: TerminalTicketStore;
    tracker: NodeCommandTracker;
    startTimeoutMs?: number;
    pollAnswerTimeoutMs?: number;
  },
): { services: NodeOperatorServices; handlers: NodeOperatorHandlers } {
  const { tickets, tracker } = options;
  const startTimeoutMs = options.startTimeoutMs ?? EXEC_START_TIMEOUT_MS;
  const pollAnswerTimeoutMs = options.pollAnswerTimeoutMs ?? EXEC_POLL_ANSWER_TIMEOUT_MS;
  const pendingStarts = new Map<string, PendingStart>();
  const pollWaiters = new Map<string, Set<PollWaiter>>();

  const settleStart = (commandId: string) => {
    const entry = pendingStarts.get(commandId);
    if (!entry) return null;
    pendingStarts.delete(commandId);
    clearTimeout(entry.timer);
    return entry;
  };

  /** Whether a frame from `node` may answer an exchange sent to that node and session. */
  const sameSession = (
    node: NodeSessionRef,
    entry: { nodeId: string; userId: string; connectionGeneration: number },
  ) =>
    entry.nodeId === node.nodeId &&
    entry.userId === node.userId &&
    entry.connectionGeneration === node.connectionGeneration;

  const startCommand: NodeOperatorServices["startCommand"] = (args) =>
    new Promise((resolve, reject) => {
      const session = relay.nodeSession(args.nodeId);
      if (
        session?.trust !== "full" ||
        pendingStarts.has(args.commandId) ||
        // Defence in depth: the command's owner must own the node it runs on.
        !nodeOwnerMatches(session, args.userId, "command")
      ) {
        reject(new NodeCommandStartError("not_delivered"));
        return;
      }
      const { connectionGeneration } = session;
      const timer = setTimeout(() => {
        if (!settleStart(args.commandId)) return;
        // It may still start late: end it rather than leave it running unrecorded.
        const entry = tracker.get(args.commandId);
        if (entry) tracker.cancel(entry);
        reject(new NodeCommandStartError("no_answer"));
      }, startTimeoutMs);
      timer.unref?.();
      pendingStarts.set(args.commandId, {
        nodeId: args.nodeId,
        userId: args.userId,
        connectionGeneration,
        resolve,
        reject,
        timer,
      });
      // Tracked before the frame leaves, so a ban landing from here on finds it.
      tracker.track({
        commandId: args.commandId,
        nodeId: args.nodeId,
        userId: args.userId,
        endsBy: Date.now() + args.timeoutMs,
      });
      const sent = relay.sendToNode(
        args.nodeId,
        {
          type: "exec.start",
          commandId: args.commandId,
          command: args.command,
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          timeoutMs: args.timeoutMs,
        },
        {
          connectionGeneration,
          requireFullTrust: true,
          userId: args.userId,
          ownerCheck: "command",
        },
      );
      if (!sent) {
        tracker.forget(args.commandId, args.nodeId);
        settleStart(args.commandId)?.reject(new NodeCommandStartError("not_delivered"));
      }
    });

  const pollCommand: NodeOperatorServices["pollCommand"] = (args) =>
    new Promise((resolve) => {
      if (args.cancel) {
        // Recorded before anything else: a node offline now gets the cancel when it is back
        // (`nodeReady`); an online one gets it at once, ahead of the poll below.
        const tracked = tracker.get(args.commandId);
        tracker.cancel({
          commandId: args.commandId,
          nodeId: args.nodeId,
          userId: args.userId,
          endsBy: tracked?.endsBy ?? args.endsBy?.getTime() ?? Date.now() + NODE_COMMAND_MAX_MS,
        });
      }
      const session = relay.nodeSession(args.nodeId);
      // Offline, or (defence in depth) a node of another owner: nothing is asked of it.
      if (!session || !nodeOwnerMatches(session, args.userId, "command_poll")) {
        resolve(null);
        return;
      }
      const { connectionGeneration } = session;
      const guard: SendGuard = {
        connectionGeneration,
        userId: args.userId,
        ownerCheck: "command_poll",
      };
      const poll = () =>
        relay.sendToNode(
          args.nodeId,
          { type: "exec.poll", commandId: args.commandId, tailBytes: NODE_COMMAND_TAIL_MAX_BYTES },
          guard,
        );
      let endTimer: ReturnType<typeof setTimeout> | null = null;
      let answerTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (status: ExecStatusFrame | null) => {
        const set = pollWaiters.get(args.commandId);
        if (!set?.delete(waiter)) return;
        if (set.size === 0) pollWaiters.delete(args.commandId);
        if (endTimer) clearTimeout(endTimer);
        if (answerTimer) clearTimeout(answerTimer);
        resolve(status ? liveStatus(status) : null);
      };
      /** One `exec.poll` sent: its answer is due within the answer timeout. */
      const armAnswerTimer = () => {
        if (answerTimer) clearTimeout(answerTimer);
        answerTimer = setTimeout(() => finish(waiter.latest), pollAnswerTimeoutMs);
        answerTimer.unref?.();
      };
      const waiter: PollWaiter = {
        nodeId: args.nodeId,
        userId: args.userId,
        connectionGeneration,
        wantEnd: args.waitMs > 0,
        latest: null,
        onStatus: (frame) => {
          waiter.latest = frame;
          if (answerTimer) clearTimeout(answerTimer);
          answerTimer = null;
          // An end answers at once, also before `waitMs`; a running state answers only
          // once the caller stopped waiting for the end.
          if (frame.state !== "running" || !waiter.wantEnd) finish(frame);
        },
        finish: () => finish(waiter.latest),
      };
      const set = pollWaiters.get(args.commandId) ?? new Set<PollWaiter>();
      set.add(waiter);
      pollWaiters.set(args.commandId, set);
      // A cancel is answered by the command's end (`exec.status`); the poll behind it answers
      // also when the command had already ended (the node ignores a cancel for it).
      if (!poll()) {
        finish(null);
        return;
      }
      armAnswerTimer();
      if (waiter.wantEnd) {
        endTimer = setTimeout(() => {
          waiter.wantEnd = false;
          // The first answer is still due: it answers now, whatever its state.
          if (!waiter.latest) return;
          // Still running at the deadline: one fresh poll for the latest output.
          if (poll()) armAnswerTimer();
          else finish(waiter.latest);
        }, args.waitMs);
        endTimer.unref?.();
      }
    });

  const openTerminalTicket: NodeOperatorServices["openTerminalTicket"] = async (args) => {
    const session = relay.nodeSession(args.nodeId);
    if (!session) {
      throw new ORPCError("CONFLICT", {
        message: "The node is offline.",
        data: { reason: "node_offline", subjectId: args.nodeId },
      });
    }
    // Defence in depth: a ticket is only ever minted for a node of the caller's.
    if (!nodeOwnerMatches(session, args.userId, "terminal_ticket")) {
      throw new ORPCError("NOT_FOUND", { message: "That node does not exist." });
    }
    if (session.trust !== "full") {
      throw new ORPCError("FORBIDDEN", {
        message: "Browser terminals need the node at Full control.",
        data: { reason: "trust_relay", subjectId: args.nodeId },
      });
    }
    // The size and any typed command stay with the browser: it opens at its own fitted size
    // and types the command itself (terminal I/O is sealed end to end; the server cannot).
    return tickets.mint({
      userId: args.userId,
      sessionId: args.sessionId,
      impersonatedBy: args.impersonatedBy ?? null,
      nodeId: args.nodeId,
    });
  };

  /** An end the node reported with no poll waiting: record it (the row leaves RUNNING). */
  const recordUnpolledEnd = async (node: NodeSessionRef, frame: ExecStatusFrame) => {
    const state = nodeCommandStateFromWire(frame.state);
    if (state === "RUNNING") return;
    const row = await prisma.nodeCommand.findFirst({
      where: { id: frame.commandId, nodeId: node.nodeId, userId: node.userId, state: "RUNNING" },
      select: nodeCommandSelect,
    });
    if (!row) return;
    await settleNodeCommand(
      row,
      state,
      frame.exitCode,
      frame.finishedAt !== undefined ? new Date(frame.finishedAt) : undefined,
    );
  };

  const handlers: NodeOperatorHandlers = {
    "exec.started": (node, frame) => {
      const entry = pendingStarts.get(frame.commandId);
      if (!entry) {
        // A start that answered after its timeout: the row is already failed and a cancel
        // was asked for; the node registered it only now, so send the cancel again.
        const tracked = tracker.get(frame.commandId);
        if (
          tracked?.nodeId === node.nodeId &&
          tracked.userId === node.userId &&
          tracked.cancelRequested
        )
          relay.sendToNode(
            node.nodeId,
            { type: "exec.cancel", commandId: frame.commandId },
            {
              connectionGeneration: node.connectionGeneration,
              userId: tracked.userId,
              ownerCheck: "command_cancel",
            },
          );
        return;
      }
      if (!sameSession(node, entry)) return;
      settleStart(frame.commandId);
      const endsBy = new Date(frame.endsBy);
      tracker.started(frame.commandId, endsBy.getTime());
      // A cancel (a ban, a revoked credential) that reached the node before its exec.start
      // was ignored there: send it again now that the command exists, to the same session.
      if (tracker.get(frame.commandId)?.cancelRequested) {
        relay.sendToNode(
          node.nodeId,
          { type: "exec.cancel", commandId: frame.commandId },
          {
            connectionGeneration: node.connectionGeneration,
            userId: entry.userId,
            ownerCheck: "command_cancel",
          },
        );
      }
      entry.resolve({ startedAt: new Date(frame.startedAt), endsBy });
    },
    "exec.rejected": (node, frame) => {
      const entry = pendingStarts.get(frame.commandId);
      if (!entry || !sameSession(node, entry)) return;
      settleStart(frame.commandId);
      tracker.forget(frame.commandId, node.nodeId);
      entry.reject(new NodeCommandStartError("rejected"));
    },
    "exec.status": async (node, frame) => {
      const ended = frame.state !== "running";
      // A status names a command of this node only; another node's frame changes nothing.
      const tracked = tracker.get(frame.commandId);
      if (ended && tracked?.nodeId === node.nodeId && tracked.userId === node.userId) {
        tracker.forget(frame.commandId, node.nodeId);
      }
      let answered = false;
      for (const waiter of [...(pollWaiters.get(frame.commandId) ?? [])]) {
        if (!sameSession(node, waiter)) continue;
        answered = true;
        waiter.onStatus(frame);
      }
      if (!ended || answered) return;
      try {
        await recordUnpolledEnd(node, frame);
      } catch (error) {
        console.error("[relay] recording a node command end failed", errorName(error));
      }
    },
    nodeReady: (node) => {
      tracker.nodeReady(node.nodeId);
    },
    nodeDisconnected: (node) => {
      for (const [commandId, entry] of pendingStarts) {
        // A late notice about an earlier session leaves exchanges with the new one alone.
        if (!sameSession(node, entry)) continue;
        settleStart(commandId);
        // The node may have started it: end it when the node is back.
        const tracked = tracker.get(commandId);
        if (tracked) tracker.cancel(tracked);
        entry.reject(new NodeCommandStartError("disconnected"));
      }
      for (const set of [...pollWaiters.values()]) {
        for (const waiter of [...set]) {
          if (sameSession(node, waiter)) waiter.finish();
        }
      }
    },
  };

  return { services: { openTerminalTicket, startCommand, pollCommand }, handlers };
}

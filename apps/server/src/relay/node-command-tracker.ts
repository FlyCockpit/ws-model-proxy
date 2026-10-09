/**
 * The node commands this server knows are running, per node, so a ban, a revoked or expired
 * agent credential, or a start nobody heard back from can find them and end them with
 * `exec.cancel` (answered at Relay too: contract 0.4.0 §17 item 9).
 *
 * In memory: a command is tracked from the moment its `exec.start` is sent until the node
 * reports its end. Commands started before a server restart are found through their
 * `NodeCommand` rows instead (the credential and ban passes read RUNNING rows). A cancel the
 * node could not get (offline) is sent again when the node is back (`nodeReady`).
 *
 * Holds ids only: never a command's text or output.
 */
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { ServerToNodeControlFrame } from "./frames.js";
import type { SendGuard } from "./session-manager.js";

/** A tracked command is dropped this long after its end time if the node never reported it. */
export const NODE_COMMAND_TRACK_GRACE_MS = 10 * 60_000;
/** RUNNING rows read per query by the sweep and the ban / revocation passes. */
export const NODE_COMMAND_SWEEP_PAGE = 500;

export type TrackedNodeCommand = {
  commandId: string;
  nodeId: string;
  userId: string;
  /** Wall-clock ms; the node's `endsBy` once it answered `exec.started`. */
  endsBy: number;
  /** An `exec.cancel` was asked for; sent again on the node's next session until it ends. */
  cancelRequested: boolean;
};

export type NodeCommandSendPort = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
};

type RunningRow = { id: string; nodeId: string; userId: string; endsBy: Date };

const runningRowSelect = { id: true, nodeId: true, userId: true, endsBy: true } as const;

/** The class only: an error message could carry query content. */
function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export class NodeCommandTracker {
  private byId = new Map<string, TrackedNodeCommand>();

  constructor(
    private readonly relay: NodeCommandSendPort,
    private readonly now: () => number = Date.now,
  ) {}

  track(entry: Omit<TrackedNodeCommand, "cancelRequested">): void {
    const existing = this.byId.get(entry.commandId);
    this.byId.set(entry.commandId, {
      ...entry,
      cancelRequested: existing?.cancelRequested ?? false,
    });
  }

  /** The node answered `exec.started`: keep its end time. */
  started(commandId: string, endsBy: number): void {
    const entry = this.byId.get(commandId);
    // The node's end time, never later than the server's own cap.
    if (entry) entry.endsBy = Math.min(endsBy, entry.endsBy);
  }

  /** The node reported the command's end (or refused to start it). */
  forget(commandId: string, nodeId: string): void {
    if (this.byId.get(commandId)?.nodeId === nodeId) this.byId.delete(commandId);
  }

  get(commandId: string): TrackedNodeCommand | undefined {
    return this.byId.get(commandId);
  }

  /** The commands known to run on a node. */
  commandsOnNode(nodeId: string): TrackedNodeCommand[] {
    return [...this.byId.values()].filter((entry) => entry.nodeId === nodeId);
  }

  get size(): number {
    return this.byId.size;
  }

  /**
   * Ends one command: `exec.cancel` to the node's live session, whichever it is (the node
   * keeps its commands across reconnects). Remembered, so an offline node gets it again when
   * it is back. True when a frame went out now.
   */
  cancel(entry: { commandId: string; nodeId: string; userId: string; endsBy: number }): boolean {
    const tracked = this.byId.get(entry.commandId);
    if (tracked && (tracked.nodeId !== entry.nodeId || tracked.userId !== entry.userId))
      return false;
    if (tracked) tracked.cancelRequested = true;
    else this.byId.set(entry.commandId, { ...entry, cancelRequested: true });
    return this.relay.sendToNode(
      entry.nodeId,
      { type: "exec.cancel", commandId: entry.commandId },
      // Only to a node of the command's owner.
      { userId: entry.userId, ownerCheck: "command_cancel" },
    );
  }

  /** A node session is ready: cancels it could not get before go out now. */
  nodeReady(nodeId: string): void {
    for (const entry of this.byId.values()) {
      if (entry.nodeId !== nodeId || !entry.cancelRequested) continue;
      this.relay.sendToNode(
        nodeId,
        { type: "exec.cancel", commandId: entry.commandId },
        { userId: entry.userId, ownerCheck: "command_cancel" },
      );
    }
  }

  /**
   * A user was banned: ends every tracked command they own at once (synchronously, before
   * the ban path returns), then the RUNNING rows this process does not track (started before
   * a restart) in the background.
   */
  cancelForUser(userId: string): number {
    let cancelled = 0;
    for (const entry of [...this.byId.values()]) {
      if (entry.userId !== userId) continue;
      this.cancel(entry);
      cancelled += 1;
    }
    void this.cancelRows({ userId, state: "RUNNING" }).catch((error) => {
      console.error("[relay] node command ban sweep failed", errorName(error));
    });
    return cancelled;
  }

  /** An agent token or OAuth grant was revoked: ends the commands it started. */
  async cancelForCredentials(input: {
    userId: string;
    credentialIds: readonly string[];
  }): Promise<number> {
    const ids = [...new Set(input.credentialIds)];
    if (ids.length === 0) return 0;
    return this.cancelRows({
      userId: input.userId,
      state: "RUNNING",
      OR: [{ agentTokenId: { in: ids } }, { mcpGrantId: { in: ids } }],
    });
  }

  /**
   * The 60 s pass: ends running commands whose agent credential is no longer live (revoked,
   * expired or below Full) or whose owner is banned or marked for deletion, and drops tracked
   * entries well past their end time that the node never reported.
   */
  async sweep(now = this.now()): Promise<number> {
    for (const [commandId, entry] of this.byId) {
      if (entry.endsBy + NODE_COMMAND_TRACK_GRACE_MS < now) this.byId.delete(commandId);
    }
    let cancelled = 0;
    let cursor: string | undefined;
    // Paged by id, so a large backlog never loads at once.
    for (;;) {
      const rows = await prisma.nodeCommand.findMany({
        where: { state: "RUNNING", endsBy: { gt: new Date(now) } },
        select: { ...runningRowSelect, agentTokenId: true, mcpGrantId: true },
        orderBy: { id: "asc" },
        take: NODE_COMMAND_SWEEP_PAGE,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      cancelled += await this.sweepPage(rows, now);
      if (rows.length < NODE_COMMAND_SWEEP_PAGE) return cancelled;
      cursor = rows[rows.length - 1]?.id;
    }
  }

  /** One page of RUNNING rows: those whose credential or owner is no longer live end. */
  private async sweepPage(
    rows: Array<RunningRow & { agentTokenId: string | null; mcpGrantId: string | null }>,
    now: number,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const tokenIds = [...new Set(rows.flatMap((row) => row.agentTokenId ?? []))];
    const grantIds = [...new Set(rows.flatMap((row) => row.mcpGrantId ?? []))];
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const at = new Date(now);
    const [liveTokens, liveGrants, users] = await Promise.all([
      tokenIds.length === 0
        ? []
        : prisma.agentToken.findMany({
            where: {
              id: { in: tokenIds },
              level: "FULL",
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
            },
            select: { id: true },
          }),
      grantIds.length === 0
        ? []
        : prisma.mcpGrant.findMany({
            where: { id: { in: grantIds }, level: "FULL", revokedAt: null },
            select: { id: true },
          }),
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, banned: true, banExpires: true, deletionRequestedAt: true },
      }),
    ]);
    const tokenLive = new Set(liveTokens.map((token) => token.id));
    const grantLive = new Set(liveGrants.map((grant) => grant.id));
    const blocked = new Set(
      users.filter((user) => userCredentialAccessBlocked(user, at)).map((user) => user.id),
    );
    const known = new Set(users.map((user) => user.id));
    let cancelled = 0;
    for (const row of rows) {
      const ended =
        blocked.has(row.userId) ||
        !known.has(row.userId) ||
        (row.agentTokenId !== null && !tokenLive.has(row.agentTokenId)) ||
        (row.mcpGrantId !== null && !grantLive.has(row.mcpGrantId));
      if (!ended) continue;
      // Sent again on every pass while the row runs: a repeat is a no-op on the node.
      this.cancel(this.entryOf(row));
      cancelled += 1;
    }
    return cancelled;
  }

  /** Test isolation. */
  clear(): void {
    this.byId.clear();
  }

  private entryOf(row: RunningRow) {
    return {
      commandId: row.id,
      nodeId: row.nodeId,
      userId: row.userId,
      endsBy: row.endsBy.getTime(),
    };
  }

  private async cancelRows(where: {
    userId: string;
    state: "RUNNING";
    OR?: Array<{ agentTokenId: { in: string[] } } | { mcpGrantId: { in: string[] } }>;
  }): Promise<number> {
    let cancelled = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.nodeCommand.findMany({
        where,
        select: runningRowSelect,
        orderBy: { id: "asc" },
        take: NODE_COMMAND_SWEEP_PAGE,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) this.cancel(this.entryOf(row));
      cancelled += rows.length;
      if (rows.length < NODE_COMMAND_SWEEP_PAGE) return cancelled;
      cursor = rows[rows.length - 1]?.id;
    }
  }
}

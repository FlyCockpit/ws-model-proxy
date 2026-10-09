/**
 * Browser terminals, commands agents queue for a person, and node commands (lane D). Bound into
 * `nodes.terminals`, `nodes.queued` and `nodes.commands` (routers/nodes.ts).
 *
 * Everything here needs a Full-control node (trust FULL and no pending lower), for people and
 * agents alike (`trust_relay`). The relay work goes through `context.services.nodeOperator`
 * (apps/server); without it the procedures answer SERVICE_UNAVAILABLE and change nothing.
 *
 * The server stores a command's state and timing (`NodeCommand`, no text, no output) and its
 * outcome in the append-only `NodeAuditEvent` (subject `hmac-sha256:<hex> <program>`); the
 * output tail comes live from the node and is null while it is offline.
 */
import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { z } from "zod";
import type { Context, NodeCommandLiveStatus, NodeOperatorServices } from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import type { CallerAuth } from "../contracts/auth-context";
import {
  nodesContract as c,
  type nodeCommandViewSchema,
  type queuedCommandStatusSchema,
  type queuedCommandViewSchema,
} from "../contracts/nodes";
import { callerActor } from "../lib/caller-actor";
import { commandAuditSubject } from "../lib/command-audit";
import { notifyQueuedCommand } from "../lib/needs-you-mail";
import {
  type NodeCommandRow,
  nodeCommandSelect,
  settleNodeCommand,
} from "../lib/node-command-settle";
import { notFound, refuse, refuseAbout } from "../lib/refuse";
import { NODE_COMMAND_GET_WAIT_MAX_MS, runtimeTextIssue } from "../lib/runtime-spec";

/** How long `commands.run` waits for a quick command before answering `running`. */
export const COMMAND_RUN_ANSWER_MS = 15_000;
/** Commands one person may have waiting in the queue at once. */
export const QUEUED_COMMANDS_MAX_PER_USER = 50;

type NodeCommandView = z.infer<typeof nodeCommandViewSchema>;
type QueuedCommandView = z.infer<typeof queuedCommandViewSchema>;
type QueuedCommandStatus = z.infer<typeof queuedCommandStatusSchema>;

function services(context: Context): NodeOperatorServices {
  const operator = context.services?.nodeOperator;
  if (!operator) {
    // apps/server provides it (`relay/node-operator-services.ts`); a server without it (tests,
    // or a build that does not wire it) changes nothing.
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Terminals and node commands are not available on this server yet.",
    });
  }
  return operator;
}

/**
 * Agents need a Full token for anything that runs or queues a command, and a browser call must
 * carry the verified CSRF header: a cookie without it is not a person (`agentRulesApply`) and
 * could be a cross-site form post. The RPC layer refuses those first
 * (`CSRF_REQUIRED_PROCEDURES`); this is the procedure's own check.
 */
function assertAgentMayWrite(auth: CallerAuth | { kind: "anonymous" }): void {
  if (auth.kind === "cookie_session" && !auth.csrfVerified) {
    throw new ORPCError("FORBIDDEN", { message: "This request is missing its CSRF header." });
  }
  if (
    (auth.kind === "agent_token" || auth.kind === "oauth_access_token") &&
    auth.level !== "FULL"
  ) {
    throw new ORPCError("FORBIDDEN", { message: "This needs a Full agent token." });
  }
}

type OperatorNode = {
  id: string;
  slug: string;
  connection: "ONLINE" | "OFFLINE";
  commandMaxMs: number;
};

/** The caller's node, at Full control (and online unless `allowOffline`). */
async function fullControlNode(
  userId: string,
  nodeId: string,
  { allowOffline = false }: { allowOffline?: boolean } = {},
): Promise<OperatorNode> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: {
      id: true,
      slug: true,
      trust: true,
      trustLowerRequestedAt: true,
      connection: true,
      commandMaxMs: true,
    },
  });
  if (!node) throw notFound("That node or command does not exist.");
  if (node.trust !== "FULL" || node.trustLowerRequestedAt) {
    throw refuseAbout(
      "trust_relay",
      node.id,
      `Node ${node.slug} is Relay only: commands, files and browser terminals need Full control.`,
      "FORBIDDEN",
    );
  }
  if (!allowOffline && node.connection !== "ONLINE") {
    throw refuseAbout("node_offline", node.id, `Node ${node.slug} is offline.`, "CONFLICT");
  }
  return node;
}

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

// ── Node commands ──

function commandView(
  row: NodeCommandRow,
  live: NodeCommandLiveStatus | null,
  cancelRequested = false,
): NodeCommandView {
  const exitCode = live?.exitCode ?? row.exitCode;
  const finishedAt = row.finishedAt ?? live?.finishedAt ?? null;
  return {
    commandId: row.id,
    ...(cancelRequested ? { cancelRequested: true } : {}),
    state: row.state === "RUNNING" && live ? live.state : row.state,
    ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
    output: live ? live.output : null,
    ...(live?.truncated !== undefined ? { truncated: live.truncated } : {}),
    startedAt: row.startedAt.toISOString(),
    endsBy: row.endsBy.toISOString(),
    ...(finishedAt ? { finishedAt: finishedAt.toISOString() } : {}),
  };
}

async function pollAndSettle(
  operator: NodeOperatorServices,
  row: NodeCommandRow,
  waitMs: number,
  cancel: boolean,
): Promise<NodeCommandView> {
  const live = await operator.pollCommand({
    userId: row.userId,
    nodeId: row.nodeId,
    commandId: row.id,
    waitMs,
    cancel,
    endsBy: row.endsBy,
  });
  if (live && live.state !== "RUNNING" && row.state === "RUNNING") {
    const settled = await settleNodeCommand(row, live.state, live.exitCode, live.finishedAt);
    return commandView(settled, live);
  }
  // The node has not reported the end yet (or is offline: it gets the cancel when it is back).
  return commandView(row, live, cancel);
}

/**
 * Read again once the command's row exists: the caller's credential (an agent's token or grant,
 * still Full) and its owner (not banned or marked for deletion). A revocation or ban committed
 * before this read refuses here; one committed after it finds the row and cancels it
 * (`apps/server` relay/node-commands.ts), even before the node started it.
 */
async function callerStillLive(auth: CallerAuth | { kind: "anonymous" }, userId: string) {
  const now = new Date();
  const [owner, credential] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { banned: true, banExpires: true, deletionRequestedAt: true },
    }),
    auth.kind === "agent_token"
      ? prisma.agentToken.findFirst({
          where: {
            id: auth.agentTokenId,
            userId,
            level: "FULL",
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        })
      : auth.kind === "oauth_access_token"
        ? prisma.mcpGrant.findFirst({
            where: { id: auth.grantId, userId, level: "FULL", revokedAt: null },
            select: { id: true },
          })
        : Promise.resolve({ id: userId }),
  ]);
  return owner !== null && !userCredentialAccessBlocked(owner, now) && credential !== null;
}

const commands = {
  run: contractProcedure(c.commands.run).handler(async ({ context, input }) => {
    assertAgentMayWrite(context.auth);
    const userId = userIdOf(context);
    const node = await fullControlNode(userId, input.nodeId);
    const operator = services(context);
    const issue = runtimeTextIssue(input.command);
    if (issue) throw new ORPCError("BAD_REQUEST", { message: issue });
    const { actor, agentTokenId, mcpGrantId } = callerActor(context.auth, userId);
    const commandId = randomBytes(16).toString("base64url");
    const timeoutMs = Math.min(input.timeoutMs, node.commandMaxMs);
    const startedAt = new Date();
    const row = await prisma.nodeCommand.create({
      data: {
        id: commandId,
        userId,
        nodeId: node.id,
        actor,
        agentTokenId,
        mcpGrantId,
        subject: commandAuditSubject(input.command),
        startedAt,
        endsBy: new Date(startedAt.getTime() + timeoutMs),
      },
      select: nodeCommandSelect,
    });
    if (!(await callerStillLive(context.auth, userId))) {
      await settleNodeCommand(row, "FAILED", null, undefined, {
        outcome: "failed",
        reason: "token_inactive",
      });
      throw new ORPCError("FORBIDDEN", {
        message: "This credential was revoked or expired, or its account is blocked.",
      });
    }
    try {
      await operator.startCommand({
        userId,
        nodeId: node.id,
        commandId,
        command: input.command,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        timeoutMs,
      });
    } catch (error) {
      await settleNodeCommand(row, "FAILED", null, undefined, {
        outcome: "failed",
        reason: "start_failed",
      });
      throw error instanceof ORPCError
        ? error
        : refuseAbout(
            "node_offline",
            node.id,
            `Node ${node.slug} did not start the command.`,
            "CONFLICT",
          );
    }
    return pollAndSettle(operator, row, COMMAND_RUN_ANSWER_MS, false);
  }),

  get: contractProcedure(c.commands.get).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    if (input.cancel) assertAgentMayWrite(context.auth);
    const row = await prisma.nodeCommand.findFirst({
      where: { id: input.commandId, userId },
      select: nodeCommandSelect,
    });
    if (!row) return queuedCommandStatus(context, userId, input.commandId, input.cancel === true);
    if (input.cancel && row.state !== "RUNNING") {
      throw refuseAbout(
        "command_not_running",
        row.id,
        `Command ${row.id} is not running; there is nothing to cancel.`,
        "CONFLICT",
      );
    }
    const operator = context.services?.nodeOperator;
    if (!operator) {
      if (input.cancel) services(context);
      return commandView(row, null);
    }
    const waitMs = Math.min(input.waitMs ?? 0, NODE_COMMAND_GET_WAIT_MAX_MS);
    return pollAndSettle(operator, row, waitMs, input.cancel === true);
  }),
};

/**
 * `node_command_get` on a `node_command_queue_for_user` id: its state, never output (a person
 * types it into a browser terminal). Only that person runs or dismisses it; `cancel` withdraws it
 * (WITHDRAWN), and only for the agent credential that queued it while it is still QUEUED.
 */
async function queuedCommandStatus(
  context: SignedInContext,
  userId: string,
  queuedCommandId: string,
  cancel: boolean,
): Promise<QueuedCommandStatus> {
  const queuedRow = await prisma.queuedNodeCommand.findFirst({
    where: { id: queuedCommandId, userId },
    select: queuedSelect,
  });
  if (!queuedRow) throw notFound("That node or command does not exist.");
  const view = queuedView(cancel ? await withdrawQueued(context, userId, queuedRow) : queuedRow);
  return {
    commandId: view.id,
    queuedForUser: true,
    state: view.state,
    nodeId: view.nodeId,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    decidedAt: view.decidedAt,
    outcome: view.outcome,
  };
}

/**
 * The agent takes back a command it queued for a person. The credential match and the QUEUED,
 * unexpired state are part of the guarded update, so a person's Run or Dismiss (or the expiry
 * sweep) racing it wins or loses as a whole: a decided command is never changed.
 */
async function withdrawQueued(
  context: SignedInContext,
  userId: string,
  row: QueuedRow,
): Promise<QueuedRow> {
  const { actor, agentTokenId, mcpGrantId } = callerActor(context.auth, userId);
  if (actor !== "AGENT") {
    throw refuseAbout(
      "not_your_command",
      row.id,
      `Command ${row.id} is queued for you: run or dismiss it on the Terminals page.`,
      "FORBIDDEN",
    );
  }
  if (row.agentTokenId !== agentTokenId || row.mcpGrantId !== mcpGrantId) {
    throw refuseAbout(
      "not_your_command",
      row.id,
      `Command ${row.id} was queued by another agent credential; only that one withdraws it.`,
      "FORBIDDEN",
    );
  }
  const now = new Date();
  const state = queuedView(row, now).state;
  if (state !== "QUEUED") {
    throw refuseAbout(
      "command_not_running",
      row.id,
      `Command ${row.id} is already ${state}; there is nothing to withdraw.`,
      "CONFLICT",
    );
  }
  const credentialId = agentTokenId ?? mcpGrantId;
  // The withdrawal and its audit row commit together.
  const withdrawn = await prisma.$transaction(async (tx) => {
    const decided = await tx.queuedNodeCommand.updateMany({
      where: {
        id: row.id,
        userId,
        state: "QUEUED",
        expiresAt: { gt: now },
        agentTokenId,
        mcpGrantId,
      },
      data: { state: "WITHDRAWN", decidedAt: now, decidedBy: credentialId, outcome: null },
    });
    if (decided.count !== 1) return false;
    await tx.nodeAuditEvent.create({
      data: {
        userId,
        nodeId: row.nodeId,
        actor: "AGENT",
        agentTokenId,
        mcpGrantId,
        kind: "command_queued_for_user",
        subject: commandAuditSubject(row.command),
        outcome: "cancelled",
        reason: "withdrawn",
        startedAt: now,
        finishedAt: now,
      },
    });
    return true;
  });
  const after = await reloadQueued(row.id);
  if (!withdrawn) {
    throw refuseAbout(
      "command_not_running",
      row.id,
      `Command ${row.id} is already ${queuedView(after).state}; there is nothing to withdraw.`,
      "CONFLICT",
    );
  }
  return after;
}

// ── Browser terminals ──

async function appendTerminalAudit(args: {
  userId: string;
  nodeId: string;
  terminalId: string;
  kind: "browser_terminal" | "command_queued_for_user";
  outcome: "opened" | "accepted" | "declined" | "refused" | "expired";
  subject?: string;
  reason?: string;
  agentTokenId?: string | null;
}): Promise<void> {
  const now = new Date();
  await prisma.nodeAuditEvent.create({
    data: {
      userId: args.userId,
      nodeId: args.nodeId,
      actor: "USER",
      agentTokenId: null,
      kind: args.kind,
      subject: args.subject ?? `terminal:${args.terminalId}`,
      outcome: args.outcome,
      reason: args.reason ?? null,
      startedAt: now,
      finishedAt: now,
    },
  });
}

const terminals = {
  openTicket: contractProcedure(c.terminals.openTicket).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const node = await fullControlNode(userId, input.nodeId);
    const ticket = await services(context).openTerminalTicket({
      userId,
      sessionId: context.session.session.id,
      impersonatedBy: context.session.session.impersonatedBy ?? null,
      nodeId: node.id,
      cols: input.cols,
      rows: input.rows,
    });
    // Audited as `opened` when the terminal socket redeems the ticket and the node is asked to
    // open it (apps/server relay/terminal-websocket.ts), not here: a ticket may go unused.
    return {
      ticket: ticket.ticket,
      terminalId: ticket.terminalId,
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }),
};

// ── Commands queued for a person ──

const queuedSelect = {
  id: true,
  nodeId: true,
  command: true,
  note: true,
  state: true,
  agentTokenId: true,
  mcpGrantId: true,
  createdAt: true,
  expiresAt: true,
  decidedAt: true,
  outcome: true,
} as const;

type QueuedRow = {
  id: string;
  nodeId: string;
  command: string;
  note: string | null;
  state: QueuedCommandView["state"];
  agentTokenId: string | null;
  mcpGrantId: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  outcome: string | null;
};

function queuedView(row: QueuedRow, now = new Date()): QueuedCommandView {
  return {
    id: row.id,
    nodeId: row.nodeId,
    command: row.command,
    note: row.note,
    // A queued item past its expiry is shown as expired before the retention sweep stores it.
    state: row.state === "QUEUED" && row.expiresAt <= now ? "EXPIRED" : row.state,
    agentTokenId: row.agentTokenId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    outcome: row.outcome,
  };
}

/** Settles a QUEUED row once; false when someone else decided it first. */
async function decideQueued(
  id: string,
  userId: string,
  state: "RUN" | "DISMISSED" | "EXPIRED" | "REFUSED",
  outcome: string | null,
): Promise<boolean> {
  const decided = await prisma.queuedNodeCommand.updateMany({
    where: { id, userId, state: "QUEUED" },
    data: {
      state,
      decidedAt: new Date(),
      decidedBy: state === "EXPIRED" ? null : userId,
      outcome,
    },
  });
  return decided.count === 1;
}

async function pendingQueued(userId: string, queuedCommandId: string): Promise<QueuedRow> {
  const row = await prisma.queuedNodeCommand.findFirst({
    where: { id: queuedCommandId, userId },
    select: queuedSelect,
  });
  if (!row) throw notFound("That node or command does not exist.");
  if (row.state !== "QUEUED") {
    throw new ORPCError("CONFLICT", { message: "This command was already decided." });
  }
  if (row.expiresAt <= new Date()) {
    await decideQueued(row.id, userId, "EXPIRED", null);
    throw new ORPCError("CONFLICT", { message: "This queued command expired." });
  }
  return row;
}

async function reloadQueued(id: string): Promise<QueuedRow> {
  const row = await prisma.queuedNodeCommand.findUnique({ where: { id }, select: queuedSelect });
  if (!row) throw notFound("That node or command does not exist.");
  return row;
}

const queued = {
  list: contractProcedure(c.queued.list).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const now = new Date();
    const rows = await prisma.queuedNodeCommand.findMany({
      where: {
        userId,
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.state === "QUEUED"
          ? { state: "QUEUED", expiresAt: { gt: now } }
          : input.state === "EXPIRED"
            ? { OR: [{ state: "EXPIRED" }, { state: "QUEUED", expiresAt: { lte: now } }] }
            : input.state
              ? { state: input.state }
              : {}),
      },
      // Waiting first (newest first), then the most recently decided: a command decided just
      // now stays inside the limit however long ago it was queued.
      orderBy: [{ decidedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
      take: 200,
      select: queuedSelect,
    });
    return { items: rows.map((row) => queuedView(row, now)) };
  }),

  enqueue: contractProcedure(c.queued.enqueue).handler(async ({ context, input }) => {
    assertAgentMayWrite(context.auth);
    const userId = userIdOf(context);
    // A queued command is always an agent's (one credential per row, hardening CHECK): a person
    // runs the command in a terminal instead.
    const { actor, agentTokenId, mcpGrantId } = callerActor(context.auth, userId);
    if (actor !== "AGENT") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only an agent queues a command for a person. Open a terminal to run it.",
      });
    }
    const node = await fullControlNode(userId, input.nodeId, { allowOffline: true });
    for (const text of [input.command, input.note]) {
      const issue = runtimeTextIssue(text);
      if (issue) throw new ORPCError("BAD_REQUEST", { message: issue });
    }
    const now = new Date();
    const waiting = await prisma.queuedNodeCommand.count({
      where: { userId, state: "QUEUED", expiresAt: { gt: now } },
    });
    if (waiting >= QUEUED_COMMANDS_MAX_PER_USER) {
      throw refuse(
        "rate_limited",
        "Too many commands are waiting for a person. Let them decide some first.",
        "CONFLICT",
      );
    }
    const row = await prisma.queuedNodeCommand.create({
      data: {
        userId,
        nodeId: node.id,
        agentTokenId,
        mcpGrantId,
        command: input.command,
        note: input.note,
        expiresAt: new Date(now.getTime() + input.expiresInHours * 3_600_000),
      },
      select: queuedSelect,
    });
    // Needs you: e-mail the person (when SMTP and their alerts are on). Never awaited, never
    // throws: the agent's call does not wait on SMTP.
    void notifyQueuedCommand({ userId, nodeSlug: node.slug, now });
    return queuedView(row, now);
  }),

  run: contractProcedure(c.queued.run).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const row = await pendingQueued(userId, input.queuedCommandId);
    let node: OperatorNode;
    try {
      node = await fullControlNode(userId, row.nodeId);
    } catch (error) {
      const reason =
        error instanceof ORPCError &&
        typeof error.data === "object" &&
        error.data !== null &&
        "reason" in error.data &&
        typeof error.data.reason === "string"
          ? error.data.reason
          : null;
      if (reason === "trust_relay" || reason === "node_offline") {
        if (await decideQueued(row.id, userId, "REFUSED", reason)) {
          await appendTerminalAudit({
            userId,
            nodeId: row.nodeId,
            terminalId: "none",
            kind: "command_queued_for_user",
            outcome: "refused",
            subject: commandAuditSubject(row.command),
            reason,
          });
        }
      }
      throw error;
    }
    const ticket = await services(context).openTerminalTicket({
      userId,
      sessionId: context.session.session.id,
      impersonatedBy: context.session.session.impersonatedBy ?? null,
      nodeId: node.id,
      cols: input.cols,
      rows: input.rows,
      typedCommand: row.command,
    });
    if (!(await decideQueued(row.id, userId, "RUN", ticket.terminalId))) {
      throw new ORPCError("CONFLICT", { message: "This command was already decided." });
    }
    await appendTerminalAudit({
      userId,
      nodeId: node.id,
      terminalId: ticket.terminalId,
      kind: "command_queued_for_user",
      outcome: "accepted",
      subject: commandAuditSubject(row.command),
    });
    return {
      item: queuedView(await reloadQueued(row.id), new Date()),
      ticket: ticket.ticket,
      terminalId: ticket.terminalId,
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }),

  dismiss: contractProcedure(c.queued.dismiss).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    const row = await pendingQueued(userId, input.queuedCommandId);
    if (!(await decideQueued(row.id, userId, "DISMISSED", null))) {
      throw new ORPCError("CONFLICT", { message: "This command was already decided." });
    }
    await appendTerminalAudit({
      userId,
      nodeId: row.nodeId,
      terminalId: "none",
      kind: "command_queued_for_user",
      outcome: "declined",
      subject: commandAuditSubject(row.command),
    });
    return queuedView(await reloadQueued(row.id), new Date());
  }),
};

export const nodeOperatorRouters = { terminals, queued, commands };

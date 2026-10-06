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
import type { z } from "zod";
import type { Context, NodeCommandLiveStatus, NodeOperatorServices } from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import type { CallerAuth } from "../contracts/auth-context";
import {
  nodesContract as c,
  type nodeCommandViewSchema,
  type queuedCommandViewSchema,
} from "../contracts/nodes";
import type { RefusalReason } from "../contracts/refusals";
import { commandAuditSubject } from "../lib/command-audit";
import { NODE_COMMAND_GET_WAIT_MAX_MS, runtimeTextIssue } from "../lib/runtime-spec";

/** How long `commands.run` waits for a quick command before answering `running`. */
export const COMMAND_RUN_ANSWER_MS = 15_000;
/** Commands one person may have waiting in the queue at once. */
export const QUEUED_COMMANDS_MAX_PER_USER = 50;

type NodeCommandView = z.infer<typeof nodeCommandViewSchema>;
type QueuedCommandView = z.infer<typeof queuedCommandViewSchema>;
type CommandState = NodeCommandLiveStatus["state"];

function refuse(
  code: "FORBIDDEN" | "CONFLICT",
  reason: RefusalReason,
  message: string,
  subjectId: string | null,
): ORPCError<string, unknown> {
  return new ORPCError(code, { message, data: { reason, subjectId } });
}

function notFound(): ORPCError<"NOT_FOUND", unknown> {
  return new ORPCError("NOT_FOUND", { message: "Not found" });
}

function services(context: Context): NodeOperatorServices {
  const operator = context.services?.nodeOperator;
  if (!operator) {
    // TODO(server): apps/server provides `services.nodeOperator` (relay 3.0 exec.* and the
    // terminal ticket store) once its rekey lands.
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Terminals and node commands are not available on this server yet.",
    });
  }
  return operator;
}

/** Who acts: a person, or an agent (its token id; an OAuth agent is recorded by its grant). */
function actorOf(auth: CallerAuth | { kind: "anonymous" }): {
  actor: "USER" | "AGENT";
  agentTokenId: string | null;
} {
  if (auth.kind === "agent_token") return { actor: "AGENT", agentTokenId: auth.agentTokenId };
  // TODO(contract): NodeCommand/NodeAuditEvent have no column for an OAuth grant; its id
  // stands in for the token id (plain ids, no foreign key).
  if (auth.kind === "oauth_access_token") return { actor: "AGENT", agentTokenId: auth.grantId };
  return { actor: "USER", agentTokenId: null };
}

/**
 * Agents need a Full token for anything that runs or queues a command, and a browser call must
 * carry the verified CSRF header: a cookie without it is not a person (`agentRulesApply`) and
 * could be a cross-site form post. TODO(contract): list these agent mutations in
 * CSRF_REQUIRED_PROCEDURES so the RPC layer refuses them first.
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
  if (!node) throw notFound();
  if (node.trust !== "FULL" || node.trustLowerRequestedAt) {
    throw refuse(
      "FORBIDDEN",
      "trust_relay",
      `Node ${node.slug} is Relay only: commands, files and browser terminals need Full control.`,
      node.id,
    );
  }
  if (!allowOffline && node.connection !== "ONLINE") {
    throw refuse("CONFLICT", "node_offline", `Node ${node.slug} is offline.`, node.id);
  }
  return node;
}

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

// ── Node commands ──

type CommandRow = {
  id: string;
  nodeId: string;
  state: CommandState;
  exitCode: number | null;
  startedAt: Date;
  endsBy: Date;
  finishedAt: Date | null;
};

const commandSelect = {
  id: true,
  nodeId: true,
  userId: true,
  actor: true,
  agentTokenId: true,
  subject: true,
  state: true,
  exitCode: true,
  startedAt: true,
  endsBy: true,
  finishedAt: true,
} as const;

function commandView(row: CommandRow, live: NodeCommandLiveStatus | null): NodeCommandView {
  const exitCode = live?.exitCode ?? row.exitCode;
  const finishedAt = row.finishedAt ?? live?.finishedAt ?? null;
  return {
    commandId: row.id,
    state: row.state === "RUNNING" && live ? live.state : row.state,
    ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
    output: live ? live.output : null,
    ...(live?.truncated !== undefined ? { truncated: live.truncated } : {}),
    startedAt: row.startedAt.toISOString(),
    endsBy: row.endsBy.toISOString(),
    ...(finishedAt ? { finishedAt: finishedAt.toISOString() } : {}),
  };
}

const AUDIT_OUTCOME: Record<
  Exclude<CommandState, "RUNNING">,
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
 * Records a command's end once: the row leaves RUNNING (guarded, so concurrent pollers settle
 * it exactly once) and the audit event is appended by whoever settled it.
 */
async function settleCommand(
  row: CommandRow & {
    userId: string;
    actor: "USER" | "AGENT" | "SYSTEM";
    agentTokenId: string | null;
    subject: string;
  },
  state: Exclude<CommandState, "RUNNING">,
  exitCode: number | null | undefined,
  finishedAtHint: Date | undefined,
  audit?: { outcome: "failed"; reason: string },
): Promise<CommandRow> {
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
    select: commandSelect,
  });
  return current ?? row;
}

async function pollAndSettle(
  operator: NodeOperatorServices,
  row: CommandRow & {
    userId: string;
    actor: "USER" | "AGENT" | "SYSTEM";
    agentTokenId: string | null;
    subject: string;
  },
  waitMs: number,
  cancel: boolean,
): Promise<NodeCommandView> {
  const live = await operator.pollCommand({
    userId: row.userId,
    nodeId: row.nodeId,
    commandId: row.id,
    waitMs,
    cancel,
  });
  if (live && live.state !== "RUNNING" && row.state === "RUNNING") {
    const settled = await settleCommand(row, live.state, live.exitCode, live.finishedAt);
    return commandView(settled, live);
  }
  return commandView(row, live);
}

const commands = {
  run: contractProcedure(c.commands.run).handler(async ({ context, input }) => {
    assertAgentMayWrite(context.auth);
    const userId = userIdOf(context);
    const node = await fullControlNode(userId, input.nodeId);
    const operator = services(context);
    const issue = runtimeTextIssue(input.command);
    if (issue) throw new ORPCError("BAD_REQUEST", { message: issue });
    const { actor, agentTokenId } = actorOf(context.auth);
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
        subject: commandAuditSubject(input.command),
        startedAt,
        endsBy: new Date(startedAt.getTime() + timeoutMs),
      },
      select: commandSelect,
    });
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
      await settleCommand(row, "FAILED", null, undefined, {
        outcome: "failed",
        reason: "start_failed",
      });
      throw error instanceof ORPCError
        ? error
        : refuse(
            "CONFLICT",
            "node_offline",
            `Node ${node.slug} did not start the command.`,
            node.id,
          );
    }
    return pollAndSettle(operator, row, COMMAND_RUN_ANSWER_MS, false);
  }),

  get: contractProcedure(c.commands.get).handler(async ({ context, input }) => {
    const userId = userIdOf(context);
    if (input.cancel) assertAgentMayWrite(context.auth);
    const row = await prisma.nodeCommand.findFirst({
      where: { id: input.commandId, userId },
      select: commandSelect,
    });
    if (!row) throw notFound();
    if (input.cancel && row.state !== "RUNNING") {
      throw refuse(
        "CONFLICT",
        "command_not_running",
        `Command ${row.id} is not running; there is nothing to cancel.`,
        row.id,
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
      nodeId: node.id,
      cols: input.cols,
      rows: input.rows,
    });
    await appendTerminalAudit({
      userId,
      nodeId: node.id,
      terminalId: ticket.terminalId,
      kind: "browser_terminal",
      outcome: "opened",
    });
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
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  outcome: string | null;
};

function queuedView(row: QueuedRow, now: Date): QueuedCommandView {
  return {
    id: row.id,
    nodeId: row.nodeId,
    command: row.command,
    note: row.note,
    // A queued item past its expiry is shown as expired before the sweeper settles it.
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
  if (!row) throw notFound();
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
  if (!row) throw notFound();
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
      orderBy: { createdAt: "desc" },
      take: 200,
      select: queuedSelect,
    });
    return { items: rows.map((row) => queuedView(row, now)) };
  }),

  enqueue: contractProcedure(c.queued.enqueue).handler(async ({ context, input }) => {
    assertAgentMayWrite(context.auth);
    const userId = userIdOf(context);
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
        "CONFLICT",
        "rate_limited",
        "Too many commands are waiting for a person. Let them decide some first.",
        null,
      );
    }
    const { agentTokenId } = actorOf(context.auth);
    const row = await prisma.queuedNodeCommand.create({
      data: {
        userId,
        nodeId: node.id,
        agentTokenId,
        command: input.command,
        note: input.note,
        expiresAt: new Date(now.getTime() + input.expiresInHours * 3_600_000),
      },
      select: queuedSelect,
    });
    // TODO(server): notify the person (Needs you / e-mail) that a command waits for them.
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

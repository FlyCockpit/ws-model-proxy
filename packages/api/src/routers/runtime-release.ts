/**
 * Releasing a claim whose stop cannot be proven ("I've checked, release it").
 *
 * A node part marked stopped (claim HELD_UNKNOWN) keeps its resources and ports counted until
 * the node proves the stop. When it never can (a status command that always says "alive", a node
 * that is gone), a person who checked the node may release the claim anyway:
 * `runtimes.instances.releaseUnproven`. The old process may still be running; if it holds the
 * ports, the next start there fails with the usual reasons.
 *
 * Agents never release: they may ask (`runtimes.releaseRequests.create`, MCP `runtime_stop` with
 * `requestRelease`), with what they found on the node, and take back their own request. A person
 * approves (the same release) or declines. People-only procedures are contract access `human`:
 * never on MCP, refused for agent tokens, OAuth tokens, API keys and cookies without CSRF.
 *
 * Every release runs under the instance's owner and capacity fences (like every stop write) and
 * through `releaseClaim`, the release a proven stop uses: a proof that arrives later changes
 * nothing.
 */
import { ORPCError } from "@orpc/server";
import { cleanText } from "@ws-model-proxy/config/cli-command-output";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import {
  runtimesContract as c,
  type releaseEvidenceSchema,
  type releaseRequestViewSchema,
} from "../contracts/runtimes";
import { loadAgentNames } from "../lib/agent-names";
import { type CallerActor, callerActor } from "../lib/caller-actor";
import { RELEASE_REQUEST_TTL_MS, releaseClaim } from "../lib/claim-release";
import { graphWrite, instanceCapacityFences } from "../lib/graph-write";
import { readLiveLoad } from "../lib/live-load";
import { isUniqueViolation, notFound, refuse, refuseAbout } from "../lib/refuse";
import { isHiddenCodePoint } from "../lib/runtime-spec";
import { effectiveTrust } from "../lib/runtime-store";
import { INSTANCE_INCLUDE, instanceView } from "../lib/runtime-views";
import {
  latestStopChecks,
  nodeConnectionView,
  stopCheckKey,
  stopUnprovenReason,
} from "../lib/stop-evidence";

type Tx = Prisma.TransactionClient;
type Evidence = z.infer<typeof releaseEvidenceSchema>;
type RequestView = z.infer<typeof releaseRequestViewSchema>;

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

/** Only a person releases (defense in depth behind the `human` contract access). */
function personOf(context: SignedInContext): CallerActor {
  const actor = callerActor(context.auth, userIdOf(context));
  if (actor.actor !== "USER")
    throw new ORPCError("FORBIDDEN", {
      message: "Only a person can release resources whose stop cannot be proven.",
    });
  return actor;
}

/** Only an agent asks (a person releases directly on the runtime page). */
function agentOf(context: SignedInContext): CallerActor {
  const actor = callerActor(context.auth, userIdOf(context));
  if (actor.actor !== "AGENT")
    throw new ORPCError("FORBIDDEN", {
      message: "Only an agent asks for a release. Release it on the runtime page instead.",
    });
  return actor;
}

/**
 * Agent text shown to a person: node-output cleaning (terminal sequences and controls removed,
 * product credentials redacted), CRLF as LF, and any other hidden or reordering character shown
 * as U+FFFD, so the text cannot display differently from what was sent.
 */
export function shownAgentText(value: string): string {
  let out = "";
  for (const char of cleanText(value.replace(/\r\n?/g, "\n"))) {
    const code = char.codePointAt(0) ?? 0;
    const lone = char.length === 1 && code >= 0xd800 && code <= 0xdfff;
    out += lone || isHiddenCodePoint(code) ? "\uFFFD" : char;
  }
  return out;
}

/** Stored and shown bounds (contract and `claim_release_request_shape`). */
const FINDINGS_MAX = 4_000;
const COMMAND_MAX = 2_000;
const OUTPUT_MAX = 4_000;

/**
 * At most `max` UTF-16 units, never splitting a surrogate pair: cleaning may lengthen text (a
 * redacted credential prefix), and what is stored must still fit its bound.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

/** The agent's evidence as stored: cleaned, clipped, and every command still non-empty. */
function storedEvidence(evidence: readonly Evidence[] | undefined): Evidence[] {
  return (evidence ?? []).map((entry) => {
    const command = clip(shownAgentText(entry.command).trim(), COMMAND_MAX);
    if (command.length === 0)
      throw new ORPCError("BAD_REQUEST", {
        message: "An evidence command is empty once control characters are removed.",
      });
    return { command, output: clip(shownAgentText(entry.output), OUTPUT_MAX) };
  });
}

/** Stored evidence read back; an entry that is not a well-formed pair is left out. */
function evidenceOf(value: Prisma.JsonValue | null): Evidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.command === "string" &&
    entry.command.length > 0 &&
    typeof entry.output === "string"
      ? [
          {
            command: clip(entry.command, COMMAND_MAX),
            output: clip(entry.output, OUTPUT_MAX),
          },
        ]
      : [],
  );
}

const RANK_SELECT = {
  id: true,
  rank: true,
  claim: true,
  markedStoppedAt: true,
  Node: {
    select: {
      id: true,
      trust: true,
      trustLowerRequestedAt: true,
      connection: true,
      lastConnectedAt: true,
      lastDisconnectedAt: true,
      lastHeartbeatAt: true,
    },
  },
} as const satisfies Prisma.InstanceRankSelect;

/** The instance's rank `nodeNumber` (1-based) as the caller owns it, under the fences. */
async function ownedRank(tx: Tx, userId: string, instanceId: string, nodeNumber: number) {
  const instance = await tx.runtimeInstance.findFirst({
    where: { id: instanceId, userId },
    select: {
      id: true,
      phase: true,
      phaseChangedAt: true,
      Ranks: { where: { rank: nodeNumber - 1 }, select: RANK_SELECT },
    },
  });
  if (!instance) throw notFound("That instance does not exist.");
  const rank = instance.Ranks[0];
  if (!rank) throw notFound("That instance has no such node.");
  return { instance, rank };
}

/** Why there is nothing to release: the claim is not marked stopped. */
function notMarkedStopped(claim: string): ORPCError<string, unknown> {
  if (claim === "RELEASED")
    return refuse("already_released", "These resources are already released.", "CONFLICT");
  return refuse(
    "not_marked_stopped",
    "This part still waits for its stop. Only a part marked stopped whose stop cannot be proven can be released.",
    "CONFLICT",
  );
}

/**
 * The person's release without proof, under the owner and capacity fences: the rank must be
 * marked stopped (HELD_UNKNOWN). With `requestId`, that pending request is approved first.
 * Records who, when and the stop check's reason on the rank, and a `claim_released` row in the
 * node's activity.
 */
async function releaseWithoutProof(input: {
  userId: string;
  instanceId: string;
  nodeNumber: number;
  note?: string;
  requestId?: string;
}): Promise<void> {
  const now = new Date();
  await graphWrite(
    [input.userId],
    async (tx) => {
      const { instance, rank } = await ownedRank(
        tx,
        input.userId,
        input.instanceId,
        input.nodeNumber,
      );
      if (rank.claim !== "HELD_UNKNOWN") throw notMarkedStopped(rank.claim);
      if (input.requestId) {
        const approved = await tx.claimReleaseRequest.updateMany({
          where: {
            id: input.requestId,
            userId: input.userId,
            rankId: rank.id,
            state: "PENDING",
            expiresAt: { gt: now },
          },
          data: {
            state: "APPROVED",
            pendingRankId: null,
            decidedAt: now,
            decidedBy: input.userId,
          },
        });
        if (approved.count === 0)
          throw new ORPCError("CONFLICT", {
            message: "This request was already decided, withdrawn or expired.",
          });
      }
      const checks = await latestStopChecks(tx, [{ ...instance, Ranks: [rank] }]);
      const reason = stopUnprovenReason(
        nodeConnectionView(rank.Node, now),
        checks.get(stopCheckKey(instance.id, rank.rank)),
      );
      if (!(await releaseClaim(tx, rank.id, now, { by: input.userId, reason })))
        throw notMarkedStopped("RELEASED");
      if (rank.Node)
        await tx.nodeAuditEvent.create({
          data: {
            userId: input.userId,
            nodeId: rank.Node.id,
            actor: "USER",
            agentTokenId: null,
            mcpGrantId: null,
            kind: "claim_released",
            subject: input.requestId
              ? `instance:${instance.id} rank:${rank.rank} request:${input.requestId}`
              : `instance:${instance.id} rank:${rank.rank}`,
            instanceId: instance.id,
            rank: rank.rank,
            outcome: "completed",
            reason: input.note ? `${reason}: ${input.note}` : reason,
            startedAt: now,
            finishedAt: now,
          },
        });
    },
    async () => instanceCapacityFences([input.instanceId]),
  );
}

async function instanceResult(context: SignedInContext, userId: string, instanceId: string) {
  const row = await prisma.runtimeInstance.findFirst({
    where: { id: instanceId, userId },
    include: INSTANCE_INCLUDE,
  });
  if (!row) throw notFound("That instance does not exist.");
  return instanceView(
    row,
    await latestStopChecks(prisma, [row]),
    readLiveLoad(context.services?.liveLoad, [row.id]),
  );
}

const REQUEST_SELECT = {
  id: true,
  state: true,
  agentTokenId: true,
  mcpGrantId: true,
  findings: true,
  evidence: true,
  createdAt: true,
  expiresAt: true,
  decidedAt: true,
  Rank: {
    select: {
      rank: true,
      nodeId: true,
      Node: { select: { slug: true } },
      Instance: { select: { id: true, runtimeId: true, Runtime: { select: { name: true } } } },
    },
  },
} as const satisfies Prisma.ClaimReleaseRequestSelect;

type RequestRow = Prisma.ClaimReleaseRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

async function requestViews(userId: string, rows: readonly RequestRow[]): Promise<RequestView[]> {
  const agentName = await loadAgentNames(userId, rows);
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    instanceId: row.Rank.Instance.id,
    runtimeId: row.Rank.Instance.runtimeId,
    runtimeName: row.Rank.Instance.Runtime.name,
    nodeNumber: row.Rank.rank + 1,
    nodeId: row.Rank.nodeId,
    nodeSlug: row.Rank.Node?.slug ?? null,
    // Past its expiry it is shown expired before the sweep settles it.
    state: row.state === "PENDING" && row.expiresAt <= now ? "EXPIRED" : row.state,
    agentName: agentName(row),
    findings: row.findings,
    evidence: evidenceOf(row.evidence),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  }));
}

function statusOf(row: { id: string; state: RequestView["state"]; expiresAt: Date }) {
  return { requestId: row.id, state: row.state, expiresAt: row.expiresAt.toISOString() };
}

export const runtimeReleaseUnproven = contractProcedure(c.instances.releaseUnproven).handler(
  async ({ input, context }) => {
    const userId = userIdOf(context);
    personOf(context);
    await releaseWithoutProof({
      userId,
      instanceId: input.instanceId,
      nodeNumber: input.nodeNumber,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    return instanceResult(context, userId, input.instanceId);
  },
);

export const runtimeReleaseRequests = {
  /** Pending requests (not expired), oldest first: the runtime page and Needs you. */
  list: contractProcedure(c.releaseRequests.list).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const rows = await prisma.claimReleaseRequest.findMany({
      where: {
        userId,
        state: "PENDING",
        expiresAt: { gt: new Date() },
        Rank: {
          claim: "HELD_UNKNOWN",
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        },
      },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: REQUEST_SELECT,
    });
    return { items: await requestViews(userId, rows) };
  }),

  create: contractProcedure(c.releaseRequests.create).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const actor = agentOf(context);
    const findings = clip(shownAgentText(input.findings).trim(), FINDINGS_MAX);
    if (findings.length === 0)
      throw new ORPCError("BAD_REQUEST", { message: "Say what you checked on the node." });
    const evidence = storedEvidence(input.evidence);
    const now = new Date();
    try {
      return await graphWrite(
        [userId],
        async (tx) => {
          const { rank } = await ownedRank(tx, userId, input.instanceId, input.nodeNumber);
          if (rank.claim !== "HELD_UNKNOWN") {
            if (rank.claim === "HELD")
              throw refuse(
                "not_marked_stopped",
                "Only a part marked stopped can be released. If its stop cannot be proven, mark it stopped first (runtime_stop markStopped).",
                "CONFLICT",
              );
            throw notMarkedStopped(rank.claim);
          }
          // Agents act on Full-control nodes only, as with marking it stopped (a removed node
          // counts as not Full).
          if (!rank.Node || effectiveTrust(rank.Node) !== "FULL")
            throw refuseAbout(
              "trust_relay",
              rank.Node?.id ?? input.instanceId,
              "Agents may only ask about parts on nodes at Full control. A person can release it in the browser.",
            );
          // A pending request past its expiry gives its slot back now.
          await tx.claimReleaseRequest.updateMany({
            where: { userId, pendingRankId: rank.id, state: "PENDING", expiresAt: { lte: now } },
            data: { state: "EXPIRED", pendingRankId: null, decidedAt: now },
          });
          const row = await tx.claimReleaseRequest.create({
            data: {
              userId,
              rankId: rank.id,
              pendingRankId: rank.id,
              agentTokenId: actor.agentTokenId,
              mcpGrantId: actor.mcpGrantId,
              findings,
              evidence: evidence.length > 0 ? evidence : undefined,
              expiresAt: new Date(now.getTime() + RELEASE_REQUEST_TTL_MS),
            },
            select: { id: true, state: true, expiresAt: true },
          });
          if (rank.Node)
            await tx.nodeAuditEvent.create({
              data: {
                userId,
                nodeId: rank.Node.id,
                actor: "AGENT",
                agentTokenId: actor.agentTokenId,
                mcpGrantId: actor.mcpGrantId,
                kind: "claim_release_request",
                subject: `instance:${input.instanceId} rank:${rank.rank} request:${row.id}`,
                instanceId: input.instanceId,
                rank: rank.rank,
                outcome: "opened",
                startedAt: now,
                finishedAt: now,
              },
            });
          return statusOf(row);
        },
        async () => instanceCapacityFences([input.instanceId]),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw refuse(
          "release_request_pending",
          "A release request for this part already waits for a person.",
          "CONFLICT",
        );
      throw error;
    }
  }),

  withdraw: contractProcedure(c.releaseRequests.withdraw).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const actor = agentOf(context);
    const now = new Date();
    return graphWrite(
      [userId],
      async (tx) => {
        const { rank } = await ownedRank(tx, userId, input.instanceId, input.nodeNumber);
        // Only the agent credential that asked takes its request back.
        const row = await tx.claimReleaseRequest.findFirst({
          where: {
            userId,
            pendingRankId: rank.id,
            state: "PENDING",
            agentTokenId: actor.agentTokenId,
            mcpGrantId: actor.mcpGrantId,
          },
          select: { id: true, expiresAt: true },
        });
        if (!row) throw notFound("You have no pending release request for this part.");
        // Conditional: the sweep or a credential revocation (outside these fences) may have
        // settled it since the read.
        const withdrawn = await tx.claimReleaseRequest.updateMany({
          where: {
            id: row.id,
            userId,
            state: "PENDING",
            agentTokenId: actor.agentTokenId,
            mcpGrantId: actor.mcpGrantId,
          },
          data: { state: "WITHDRAWN", pendingRankId: null, decidedAt: now },
        });
        if (withdrawn.count === 0)
          throw new ORPCError("CONFLICT", {
            message: "This request expired or was cleared meanwhile.",
          });
        if (rank.Node)
          await tx.nodeAuditEvent.create({
            data: {
              userId,
              nodeId: rank.Node.id,
              actor: "AGENT",
              agentTokenId: actor.agentTokenId,
              mcpGrantId: actor.mcpGrantId,
              kind: "claim_release_request",
              subject: `instance:${input.instanceId} rank:${rank.rank} request:${row.id}`,
              instanceId: input.instanceId,
              rank: rank.rank,
              outcome: "cancelled",
              startedAt: now,
              finishedAt: now,
            },
          });
        return statusOf({ id: row.id, state: "WITHDRAWN", expiresAt: row.expiresAt });
      },
      async () => instanceCapacityFences([input.instanceId]),
    );
  }),

  approve: contractProcedure(c.releaseRequests.approve).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    personOf(context);
    const request = await prisma.claimReleaseRequest.findFirst({
      where: { id: input.requestId, userId },
      select: { id: true, Rank: { select: { rank: true, instanceId: true } } },
    });
    if (!request) throw notFound("That release request does not exist.");
    await releaseWithoutProof({
      userId,
      instanceId: request.Rank.instanceId,
      nodeNumber: request.Rank.rank + 1,
      requestId: request.id,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    return instanceResult(context, userId, request.Rank.instanceId);
  }),

  decline: contractProcedure(c.releaseRequests.decline).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    personOf(context);
    const now = new Date();
    const request = await prisma.claimReleaseRequest.findFirst({
      where: { id: input.requestId, userId },
      select: { id: true, Rank: { select: { rank: true, nodeId: true, instanceId: true } } },
    });
    if (!request) throw notFound("That release request does not exist.");
    await graphWrite(
      [userId],
      async (tx) => {
        const declined = await tx.claimReleaseRequest.updateMany({
          where: { id: request.id, userId, state: "PENDING", expiresAt: { gt: now } },
          data: { state: "DECLINED", pendingRankId: null, decidedAt: now, decidedBy: userId },
        });
        if (declined.count === 0)
          throw new ORPCError("CONFLICT", {
            message: "This request was already decided, withdrawn or expired.",
          });
        if (request.Rank.nodeId)
          await tx.nodeAuditEvent.create({
            data: {
              userId,
              nodeId: request.Rank.nodeId,
              actor: "USER",
              agentTokenId: null,
              mcpGrantId: null,
              kind: "claim_release_request",
              subject: `instance:${request.Rank.instanceId} rank:${request.Rank.rank} request:${request.id}`,
              instanceId: request.Rank.instanceId,
              rank: request.Rank.rank,
              outcome: "declined",
              startedAt: now,
              finishedAt: now,
            },
          });
      },
      async () => instanceCapacityFences([request.Rank.instanceId]),
    );
    const row = await prisma.claimReleaseRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: REQUEST_SELECT,
    });
    const [view] = await requestViews(userId, [row]);
    if (!view) throw notFound("That release request does not exist.");
    return view;
  }),
};

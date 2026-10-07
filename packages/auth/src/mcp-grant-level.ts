/**
 * The level of an OAuth MCP grant (`McpGrant.level`): Read-only or Full, chosen by the person.
 *
 * Only a signed-in person sets it, in two places:
 * - the consent page, as part of approving the client (`mcp-consent-level.ts`);
 * - Access → Agents (`access.oauthGrants.setLevel`, a `human` procedure).
 * A client never sets it: no authorize parameter, scope or query value reaches these writes.
 * An OAuth request is Full only while its grant is Full AND its token carries `mcp:write`
 * (`apps/server/src/mcp/auth.ts`), so a client can ask for less, never for more.
 *
 * Every change is audited (`audit_event`, actor USER, resource `mcp_grant`). A lowering takes
 * effect at the next lookup (every `/mcp` request and every node admission reads the grant);
 * the work the grant's Full level already started is ended by the lowered listeners below
 * (the server cancels its in-flight write tool calls, node commands and file ops).
 */
import prisma, { type Prisma } from "@ws-model-proxy/db";

export const MCP_GRANT_LEVELS = ["READ", "FULL"] as const;
export type McpGrantLevel = (typeof MCP_GRANT_LEVELS)[number];

/** Audit actions (audit_event.action) of grant level writes. */
export const MCP_GRANT_LEVEL_AUDIT = {
  /** The person approved the client on the consent page with this level. */
  consent: "mcp_grant.consent",
  /** The person changed the level in Access → Agents. */
  level: "mcp_grant.level",
} as const;

type Tx = Prisma.TransactionClient;

export function isMcpGrantLevel(value: unknown): value is McpGrantLevel {
  return value === "READ" || value === "FULL";
}

/** Writes one audit row for a grant level write (the person acted; never an agent). */
export async function auditMcpGrantLevel(
  tx: Tx,
  input: {
    userId: string;
    grantId: string;
    action: (typeof MCP_GRANT_LEVEL_AUDIT)[keyof typeof MCP_GRANT_LEVEL_AUDIT];
    before: McpGrantLevel | null;
    after: McpGrantLevel;
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      userId: input.userId,
      actor: "USER",
      actorUserId: input.userId,
      action: input.action,
      resourceType: "mcp_grant",
      resourceId: input.grantId,
      before: input.before === null ? undefined : { level: input.before },
      after: { level: input.after },
    },
  });
}

export type McpGrantLevelChange = {
  grantId: string;
  before: McpGrantLevel | null;
  after: McpGrantLevel;
  /** FULL → READ: the grant's started Full work must end now. */
  lowered: boolean;
};

/**
 * Sets an ACTIVE grant's level inside `tx` and audits it when it changed. The update is
 * conditional on the level read (`expected`), so a concurrent change is never overwritten
 * silently: null when the grant is no longer active at `expected`.
 */
export async function setActiveMcpGrantLevel(
  tx: Tx,
  input: {
    grantId: string;
    userId: string;
    expected: McpGrantLevel;
    level: McpGrantLevel;
    action: (typeof MCP_GRANT_LEVEL_AUDIT)[keyof typeof MCP_GRANT_LEVEL_AUDIT];
  },
): Promise<McpGrantLevelChange | null> {
  if (input.expected === input.level) {
    return { grantId: input.grantId, before: input.expected, after: input.level, lowered: false };
  }
  const updated = await tx.mcpGrant.updateMany({
    where: { id: input.grantId, userId: input.userId, revokedAt: null, level: input.expected },
    data: { level: input.level },
  });
  if (updated.count !== 1) return null;
  await auditMcpGrantLevel(tx, {
    userId: input.userId,
    grantId: input.grantId,
    action: input.action,
    before: input.expected,
    after: input.level,
  });
  return {
    grantId: input.grantId,
    before: input.expected,
    after: input.level,
    lowered: input.expected === "FULL" && input.level === "READ",
  };
}

/**
 * Records the level the person chose on the consent page for the exact grant generation
 * (userId, clientId, referenceId) the approval's authorization code will exchange into. Runs
 * after Better Auth accepted the consent and before the response (and so the code) reaches
 * the browser. Creates the grant when absent (code exchange then reuses it), sets the level of
 * an active one, and leaves a tombstone alone (code exchange rejects it): null. A concurrent
 * write (a racing approval or an Access page change) is retried on the fresh row; the person's
 * choice is never dropped silently. Throws when it still cannot be recorded, or on a storage
 * failure: the caller then withholds the code.
 */
export async function recordConsentedMcpGrantLevel(input: {
  userId: string;
  clientId: string;
  referenceId: string;
  level: McpGrantLevel;
}): Promise<McpGrantLevelChange | null> {
  const key = {
    userId_clientId_referenceId: {
      userId: input.userId,
      clientId: input.clientId,
      referenceId: input.referenceId,
    },
  };
  const select = { id: true, level: true, revokedAt: true } as const;
  const attempt = () =>
    prisma.$transaction(async (tx): Promise<McpGrantLevelChange | "tombstone" | "conflict"> => {
      // Absent: create it at the chosen level. `skipDuplicates` (ON CONFLICT DO NOTHING) keeps
      // a racing create from aborting this transaction; the row is then read like any other.
      const inserted = await tx.mcpGrant.createMany({
        data: [
          {
            userId: input.userId,
            clientId: input.clientId,
            referenceId: input.referenceId,
            level: input.level,
          },
        ],
        skipDuplicates: true,
      });
      const row = await tx.mcpGrant.findUnique({ where: key, select });
      if (row === null) return "conflict";
      if (row.revokedAt !== null) return "tombstone";
      if (inserted.count === 1) {
        await auditMcpGrantLevel(tx, {
          userId: input.userId,
          grantId: row.id,
          action: MCP_GRANT_LEVEL_AUDIT.consent,
          before: null,
          after: row.level,
        });
        return { grantId: row.id, before: null, after: row.level, lowered: false };
      }
      const change = await setActiveMcpGrantLevel(tx, {
        grantId: row.id,
        userId: input.userId,
        expected: row.level,
        level: input.level,
        action: MCP_GRANT_LEVEL_AUDIT.consent,
      });
      return change ?? "conflict";
    });
  let result = await attempt();
  if (result === "conflict") result = await attempt();
  if (result === "conflict") throw new Error("MCP grant level changed concurrently");
  if (result === "tombstone") return null;
  if (result.lowered)
    await notifyMcpGrantLevelLowered({ userId: input.userId, grantId: result.grantId });
  return result;
}

// ── lowered listeners (post-commit, in process) ──

export type McpGrantLevelLoweredEvent = { userId: string; grantId: string };
export type McpGrantLevelLoweredListener = (
  event: McpGrantLevelLoweredEvent,
) => void | Promise<void>;

const loweredListeners = new Set<McpGrantLevelLoweredListener>();

/**
 * Subscribes to committed FULL → READ lowerings made by the consent page (the Access page
 * reports its own through `Context.services`). Returns the unsubscribe function.
 */
export function onMcpGrantLevelLowered(listener: McpGrantLevelLoweredListener): () => void {
  loweredListeners.add(listener);
  return () => {
    loweredListeners.delete(listener);
  };
}

/**
 * Runs every listener for a committed lowering. A failure is logged (class only) and never
 * thrown: the lowering is committed, and every later lookup already sees READ.
 */
export async function notifyMcpGrantLevelLowered(event: McpGrantLevelLoweredEvent): Promise<void> {
  for (const listener of [...loweredListeners]) {
    try {
      await listener(event);
    } catch (error) {
      console.error(
        "[auth] grant level lowered listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}

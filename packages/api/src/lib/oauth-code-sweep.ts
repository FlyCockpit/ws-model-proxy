import { ORPCError } from "@orpc/server";
import type { Prisma } from "@ws-model-proxy/db";

/**
 * Pending OAuth authorization codes for one person and one client, swept when the person
 * disconnects that client: a code minted just before the revoke could otherwise still be
 * exchanged for fresh tokens.
 *
 * The installed `@better-auth/oauth-provider` stores a code in the shared `verification`
 * table as `JSON.stringify({ type: "authorization_code", query, userId, ... })`, under a
 * type-free hash identifier (e-mail/OTP rows share the table). The column is a plain string,
 * so the database filter is two `contains` markers (type and user), and the exact check is a
 * parse: `type`, `userId` and `query.client_id` must all match. Both markers are LIKE-safe:
 * the type marker is a static literal, and the user marker is used only for ids whose JSON
 * form needs no escaping (a `\` would turn the LIKE into a silent miss). `_` / `%` in a marker
 * can only over-match, and the parse rejects those rows.
 *
 * Fail closed: a marker-matching row that cannot be parsed, or more candidates than the cap,
 * aborts the revoke (the transaction rolls back and the person retries) instead of reporting
 * a disconnect that may have missed a code.
 */

const BATCH = 200;
/** A person holds a handful of pending codes (each lives minutes and needs a consent). */
const TOTAL_CAP = 2_000;
/** Real code values are a few KiB; the unbounded `state` parameter is the only large part. */
const VALUE_MAX_LENGTH = 1024 * 1024;

const TYPE_MARKER = JSON.stringify({ type: "authorization_code" }).slice(1, -1);

function incomplete() {
  return new ORPCError("CONFLICT", {
    message: "Could not check every pending sign-in for this connection. Retry the request.",
  });
}

/** The markers selecting one person's codes; throws when the user id is not LIKE-safe. */
function authorizationCodeMarkers(userId: string): Prisma.VerificationWhereInput[] {
  if (JSON.stringify(userId) !== `"${userId}"`) throw incomplete();
  return [
    { value: { contains: TYPE_MARKER } },
    { value: { contains: JSON.stringify({ userId }).slice(1, -1) } },
  ];
}

/** "match" for this person's code for this client; "other" when provably not; else "unknown". */
function inspectAuthorizationCode(
  value: string,
  userId: string,
  clientId: string,
): "match" | "other" | "unknown" {
  if (value.length > VALUE_MAX_LENGTH) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "unknown";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorization_code" || record.userId !== userId) return "other";
  const query = record.query;
  if (query === null || typeof query !== "object" || Array.isArray(query)) return "other";
  return (query as Record<string, unknown>).client_id === clientId ? "match" : "other";
}

type SweepTx = { verification: Prisma.TransactionClient["verification"] };

/**
 * Deletes the person's pending codes for the client, inside the caller's transaction. The
 * delete names the exact rows found and repeats the person's markers, so it can only ever
 * remove that person's authorization codes. Returns how many it deleted.
 */
export async function sweepPendingAuthorizationCodes(
  tx: SweepTx,
  input: { userId: string; clientId: string; now: Date },
): Promise<number> {
  const markers = authorizationCodeMarkers(input.userId);
  const matched: string[] = [];
  let cursor: string | undefined;
  for (let scanned = 0; ; ) {
    const rows = await tx.verification.findMany({
      where: { expiresAt: { gt: input.now }, AND: markers },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select: { id: true, value: true },
    });
    for (const row of rows) {
      const verdict = inspectAuthorizationCode(row.value, input.userId, input.clientId);
      if (verdict === "unknown") throw incomplete();
      if (verdict === "match") matched.push(row.id);
    }
    scanned += rows.length;
    if (rows.length < BATCH) break;
    if (scanned >= TOTAL_CAP) throw incomplete();
    cursor = rows[rows.length - 1]?.id;
  }
  if (matched.length === 0) return 0;
  const deleted = await tx.verification.deleteMany({
    where: { id: { in: matched }, AND: markers },
  });
  return deleted.count;
}

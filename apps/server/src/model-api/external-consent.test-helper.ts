import { expect } from "vitest";

type ValidityDelegates = {
  modelApiToken: { findUnique: () => Promise<Record<string, unknown> | null> };
  user: { findUnique: () => Promise<Record<string, unknown> | null> };
  /**
   * The pool owner's user row when the owner is not the requester (#76).
   * Absent: an active owner account.
   */
  poolOwner?: { findUnique: () => Promise<Record<string, unknown> | null> };
};

function accountActive(row: Record<string, unknown> | null, now: Date): boolean {
  return Boolean(
    row &&
      !row.deletionRequestedAt &&
      (row.banned !== true || (row.banExpires instanceof Date && row.banExpires < now)),
  );
}

/** Model a DB statement snapshot and its clock, including delayed result delivery. */
export async function mockRequesterValidityQuery(
  strings: TemplateStringsArray,
  values: unknown[],
  db: ValidityDelegates,
): Promise<
  Array<{ tokenValid: boolean; scopeMode: unknown; requesterValid: boolean; ownerValid: boolean }>
> {
  const sql = strings.join("?");
  if (!sql.includes('AS "requesterValid"')) return [];
  expect(sql).toContain('t."expiresAt" > statement_timestamp()');
  expect(sql).toContain('u."banExpires" < statement_timestamp()');
  expect(sql).toContain('u."deletionRequestedAt" IS NULL');
  expect(sql).toContain('o."banExpires" < statement_timestamp()');
  expect(sql).toContain('o."deletionRequestedAt" IS NULL');
  const now = new Date();
  const ownerIsRequester = values[3] === values[2];
  const [token, user, owner] = await Promise.all([
    values[1] ? db.modelApiToken.findUnique() : null,
    db.user.findUnique(),
    ownerIsRequester || !db.poolOwner ? null : db.poolOwner.findUnique(),
  ]);
  return [
    {
      tokenValid: Boolean(
        token &&
          token.userId === values[0] &&
          !token.revokedAt &&
          token.allowExternal === true &&
          (!(token.expiresAt instanceof Date) || token.expiresAt > now),
      ),
      scopeMode: token?.scopeMode ?? null,
      requesterValid: accountActive(user, now),
      ownerValid: ownerIsRequester
        ? accountActive(user, now)
        : db.poolOwner
          ? accountActive(owner, now)
          : true,
    },
  ];
}

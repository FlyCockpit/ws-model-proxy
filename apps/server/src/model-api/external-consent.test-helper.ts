import { expect } from "vitest";

type ValidityDelegates = {
  modelApiToken: { findUnique: () => Promise<Record<string, unknown> | null> };
  user: { findUnique: () => Promise<Record<string, unknown> | null> };
};

/** Model a DB statement snapshot and its clock, including delayed result delivery. */
export async function mockRequesterValidityQuery(
  strings: TemplateStringsArray,
  values: unknown[],
  db: ValidityDelegates,
): Promise<Array<{ tokenValid: boolean; scopeMode: unknown; requesterValid: boolean }>> {
  const sql = strings.join("?");
  if (!sql.includes('AS "requesterValid"')) return [];
  expect(sql).toContain('t."expiresAt" > statement_timestamp()');
  expect(sql).toContain('u."banExpires" < statement_timestamp()');
  expect(sql).toContain('u."deletionRequestedAt" IS NULL');
  const now = new Date();
  const [token, user] = await Promise.all([
    values[1] ? db.modelApiToken.findUnique() : null,
    db.user.findUnique(),
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
      requesterValid: Boolean(
        user &&
          !user.deletionRequestedAt &&
          (user.banned !== true || (user.banExpires instanceof Date && user.banExpires < now)),
      ),
    },
  ];
}

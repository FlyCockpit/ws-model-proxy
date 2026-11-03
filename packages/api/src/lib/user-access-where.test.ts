import {
  isUserBanned,
  userAccessActiveWhere,
  userAccessBlockedWhere,
  userBanActiveWhere,
  userBanInactiveWhere,
  userCredentialAccessBlocked,
} from "@ws-model-proxy/db/user-deletion-access";
import { describe, expect, it } from "vitest";

type Row = { banned: boolean | null; banExpires: Date | null; deletionRequestedAt: Date | null };
type Where = Record<string, unknown>;

/** Evaluates the Prisma where subset these builders use (equality, not, gte, lt, OR, AND). */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((part) => matches(row, part));
    if (key === "AND") return (condition as Where[]).every((part) => matches(row, part));
    const value = row[key as keyof Row];
    if (condition === null || typeof condition === "boolean") return value === condition;
    const filter = condition as { not?: null; gte?: Date; lt?: Date };
    if ("not" in filter) return value !== filter.not;
    if (!(value instanceof Date)) return false;
    if (filter.gte) return value.getTime() >= filter.gte.getTime();
    if (filter.lt) return value.getTime() < filter.lt.getTime();
    throw new Error(`unsupported filter on ${key}`);
  });
}

const now = new Date("2026-11-03T12:00:00.000Z");
const before = new Date(now.getTime() - 1);
const after = new Date(now.getTime() + 1);

const rows: Row[] = [];
for (const banned of [null, false, true])
  for (const banExpires of [null, before, now, after])
    for (const deletionRequestedAt of [null, before])
      rows.push({ banned, banExpires, deletionRequestedAt });

describe("user access where-builders", () => {
  it("match isUserBanned exactly, boundary included (an expiry at now is still banned)", () => {
    for (const row of rows) {
      expect(matches(row, userBanActiveWhere(now))).toBe(isUserBanned(row, now));
      expect(matches(row, userBanInactiveWhere(now))).toBe(!isUserBanned(row, now));
    }
  });

  it("match userCredentialAccessBlocked and its negation", () => {
    for (const row of rows) {
      const blocked = userCredentialAccessBlocked(row, now);
      expect(matches(row, userAccessBlockedWhere(now))).toBe(blocked);
      expect(matches(row, userAccessActiveWhere(now))).toBe(!blocked);
    }
  });

  it("an expired temporary ban is active access; one expiring exactly now is not", () => {
    const expired = { banned: true, banExpires: before, deletionRequestedAt: null };
    const expiringNow = { banned: true, banExpires: now, deletionRequestedAt: null };
    expect(matches(expired, userAccessActiveWhere(now))).toBe(true);
    expect(matches(expiringNow, userAccessActiveWhere(now))).toBe(false);
    expect(matches(expiringNow, userAccessBlockedWhere(now))).toBe(true);
  });
});

import {
  type DeletedParents,
  drainParentDeletionHistory,
  PARENT_DELETION_DRAIN_BATCH,
  PARENT_DELETION_MAX_PASSED_ADMISSIONS,
  ParentDeletionDrainPendingError,
} from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";

// g1-M1 default bound: the PostgreSQL test passes a small `maxPassedAdmissions`
// so its scan stays cheap on a loaded host; this pins that a drain called
// WITHOUT the option (every production caller) still stops at
// PARENT_DELETION_MAX_PASSED_ADMISSIONS instead of carrying an unbounded
// exclusion list. A scripted client answers the admission scan as
// PostgreSQL would: at most LIMIT rows, excluding the passed ids, so the
// bound is crossed across batches (5 000 + 5 000 + 1 at the defaults) and a
// per-batch count cannot stand in for the running total. Every request is
// busy (one waiter, none lockable).

type Db = Parameters<typeof drainParentDeletionHistory>[0];

function scriptedDb(returned: number): { db: Db; scans: number[] } {
  const scans: number[] = [];
  const ids = Array.from({ length: returned }, (_, index) => `req-${index}`);
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      // The drain batch's owner check (a whole-user drain names its deletion
      // generation): the owner row is still marked.
      if (sql.includes('FROM "user"')) return [{ id: "user-1" }];
      if (sql.includes("SELECT r.id FROM admission_request r")) {
        // The scan's last two bound values: the passed ids, then the LIMIT.
        // Fail loudly if a refactor reorders them.
        const limit = values.at(-1);
        const passed = values.at(-2);
        if (typeof limit !== "number" || !Array.isArray(passed))
          throw new Error("admission scan bind order changed; update this script");
        const skip = new Set(passed);
        const rows = ids.filter((id) => !skip.has(id)).slice(0, limit);
        scans.push(rows.length);
        return rows.map((id) => ({ id }));
      }
      // The waiters this batch could lock: none (all busy).
      if (sql.includes("FOR UPDATE SKIP LOCKED")) return [];
      if (sql.includes("count(*) AS total")) {
        const batch = values[0];
        if (!Array.isArray(batch)) throw new Error("waiter count bind changed");
        return batch.map((admissionRequestId) => ({ admissionRequestId, total: 1n }));
      }
      // Later drain steps (relay keyset, requester rollup merge): nothing left.
      if (sql.includes("relay_request") || sql.includes("usage_rollup")) return [];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const db = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as Db;
  return { db, scans };
}

// DL-1 (d): only a whole-user delete drains history.
const userOnly = (): DeletedParents => ({
  user: ["user-1"],
  model_pool: [],
  pool_member: [],
  pool_grant: [],
  discovered_model: [],
  execution_target: [],
  inference_capacity: [],
  model_api_token: [],
  provider_account: [],
  provider_model: [],
});

const owner = { userId: "user-1", generation: "generation-1" };

describe("drainParentDeletionHistory passed-admission bound (g1-M1)", () => {
  it("defaults to PARENT_DELETION_MAX_PASSED_ADMISSIONS: one past it reports pending", async () => {
    const { db, scans } = scriptedDb(PARENT_DELETION_MAX_PASSED_ADMISSIONS + 1);
    const error = await drainParentDeletionHistory(db, userOnly(), { owner }).catch(
      (caught) => caught,
    );
    expect(scans.length).toBeGreaterThan(1);
    expect(error).toBeInstanceOf(ParentDeletionDrainPendingError);
    expect((error as Error).message).toContain("passed too many busy admission");
    expect(error).toMatchObject({ timeout: undefined });
  });

  it("at the default bound itself the drain goes on (inverse)", async () => {
    const { db, scans } = scriptedDb(PARENT_DELETION_MAX_PASSED_ADMISSIONS);
    const report = await drainParentDeletionHistory(db, userOnly(), { owner });
    expect(report["admission_request.passed"]).toBe(PARENT_DELETION_MAX_PASSED_ADMISSIONS);
    // Batches of at most the drain batch, then the empty scan that ends the step.
    expect(scans.length).toBeGreaterThan(2);
    expect(scans.at(-1)).toBe(0);
    expect(Math.max(...scans)).toBeLessThanOrEqual(PARENT_DELETION_DRAIN_BATCH);
    expect(scans.reduce((sum, rows) => sum + rows, 0)).toBe(PARENT_DELETION_MAX_PASSED_ADMISSIONS);
  });
});

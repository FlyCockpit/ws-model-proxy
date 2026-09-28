import {
  type DeletedParents,
  drainParentDeletionHistory,
  PARENT_DELETION_MAX_PASSED_ADMISSIONS,
  ParentDeletionDrainPendingError,
} from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";

// g1-M1 default bound: the PostgreSQL test passes a small `maxPassedAdmissions`
// so its scan stays cheap on a loaded host; this pins that a drain called
// WITHOUT the option (every production caller) still stops at
// PARENT_DELETION_MAX_PASSED_ADMISSIONS instead of carrying an unbounded
// exclusion list. A scripted client answers the admission scan with
// `returned` busy requests (each has one waiter, none of them lockable).

type Db = Parameters<typeof drainParentDeletionHistory>[0];

function scriptedDb(returned: number): { db: Db; scans: () => number } {
  let scans = 0;
  const ids = Array.from({ length: returned }, (_, index) => `req-${index}`);
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("SELECT r.id FROM admission_request r")) {
        scans += 1;
        return scans === 1 ? ids.map((id) => ({ id })) : [];
      }
      // The waiters this batch could lock: none (all busy).
      if (sql.includes("FOR UPDATE SKIP LOCKED")) return [];
      if (sql.includes("count(*) AS total"))
        return ids.map((admissionRequestId) => ({ admissionRequestId, total: 1n }));
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const db = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as Db;
  return { db, scans: () => scans };
}

const poolOnly = (): DeletedParents => ({
  user: [],
  model_pool: ["pool-1"],
  pool_member: [],
  pool_grant: [],
  discovered_model: [],
  execution_target: [],
  inference_capacity: [],
  model_api_token: [],
  provider_account: [],
  provider_model: [],
});

describe("drainParentDeletionHistory passed-admission bound (g1-M1)", () => {
  it("defaults to PARENT_DELETION_MAX_PASSED_ADMISSIONS: one past it reports pending", async () => {
    const { db } = scriptedDb(PARENT_DELETION_MAX_PASSED_ADMISSIONS + 1);
    const error = await drainParentDeletionHistory(db, poolOnly()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ParentDeletionDrainPendingError);
    expect((error as Error).message).toContain("passed too many busy admission");
    expect(error).toMatchObject({ timeout: undefined });
  });

  it("at the default bound itself the drain goes on (inverse)", async () => {
    const { db, scans } = scriptedDb(PARENT_DELETION_MAX_PASSED_ADMISSIONS);
    const report = await drainParentDeletionHistory(db, poolOnly());
    expect(report["admission_request.passed"]).toBe(PARENT_DELETION_MAX_PASSED_ADMISSIONS);
    expect(scans()).toBe(2);
  });
});

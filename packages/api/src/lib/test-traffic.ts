/**
 * Test traffic is not load: a person's Test page (`TEST`) and an agent's `model_test`
 * (`AGENT_TEST`). The Overview and `metrics_query` leave it out of their request numbers by the
 * same rule (`metrics_query` counts it apart as `totals.tests`).
 */
import { Prisma } from "@ws-model-proxy/db";

/** Rollup rows of test traffic (built per query: modules importing this stay mockable). */
export const testTraffic = () =>
  Prisma.sql`source IN ('TEST'::"RequestSource", 'AGENT_TEST'::"RequestSource")`;
/** Rollup rows of real traffic (everything but tests). */
export const realTraffic = () =>
  Prisma.sql`source NOT IN ('TEST'::"RequestSource", 'AGENT_TEST'::"RequestSource")`;

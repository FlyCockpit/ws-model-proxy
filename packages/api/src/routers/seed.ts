import { ORPCError } from "@orpc/server";
import { runSeed } from "@ws-model-proxy/db/seed";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";

import { adminOr404Procedure } from "../index";

/**
 * Type-to-confirm phrase the operator must enter before a seed runs. The
 * server is the source of truth — never trust the client. Production uses a
 * deliberately loud phrase because seeding a live database is a foot-cannon
 * (the "Allow with extra confirm" policy chosen at design time; the safest
 * version of that is a stricter phrase + a loud UI warning, both below).
 *
 * Exported so it can be unit-tested directly without standing up the env.
 */
function requiredConfirmPhrase(nodeEnv: string): string {
  return nodeEnv === "production" ? "SEED PRODUCTION" : "seed";
}

export const seedRouter = {
  /**
   * Drives the admin page: which confirm phrase to require and whether to
   * show the production danger banner. Admin-gated so it leaks nothing.
   */
  info: adminOr404Procedure.handler(() => {
    const isProduction = env.NODE_ENV === "production";
    return {
      isProduction,
      requiredConfirmPhrase: requiredConfirmPhrase(env.NODE_ENV),
    };
  }),

  run: adminOr404Procedure.input(z.object({ confirm: z.string() })).handler(async ({ input }) => {
    const expected = requiredConfirmPhrase(env.NODE_ENV);
    if (input.confirm.trim() !== expected) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Confirmation phrase does not match. Type "${expected}" exactly to run the seed.`,
      });
    }

    const startedAt = Date.now();
    const result = await runSeed();
    return { result: { ...result, durationMs: Date.now() - startedAt } };
  }),
};

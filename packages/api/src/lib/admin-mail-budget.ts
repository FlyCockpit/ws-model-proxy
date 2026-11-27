import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";

const HOUR_MS = 60 * 60 * 1000;

/** Single-service procedure budget; synchronous charging also covers batched RPC. */
export function createAdminMailBudget({ now = Date.now, maxEntries = 10_000 } = {}) {
  const keyFor = (id: string) => createHash("sha256").update(id).digest("base64url");
  const entries = new Map<string, { count: number; expires: number }>();
  return {
    charge(adminId: string, resendTarget?: string): void {
      const time = now();
      for (const [key, entry] of entries) if (entry.expires <= time) entries.delete(key);
      const charges: [string, number][] = [[`rl:users-invite-mail:${keyFor(adminId)}`, 30]];
      if (resendTarget) charges.push([`rl:users-resend-invite:${keyFor(resendTarget)}`, 5]);
      const missing = charges.filter(([key]) => !entries.has(key)).length;
      if (
        !Number.isFinite(time) ||
        entries.size + missing > maxEntries ||
        charges.some(([key, limit]) => (entries.get(key)?.count ?? 0) >= limit)
      ) {
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "Too many invite requests. Try again later.",
        });
      }
      for (const [key] of charges) {
        const entry = entries.get(key) ?? { count: 0, expires: time + HOUR_MS };
        entry.count += 1;
        entries.set(key, entry);
      }
    },
  };
}

export const adminMailBudget = createAdminMailBudget();

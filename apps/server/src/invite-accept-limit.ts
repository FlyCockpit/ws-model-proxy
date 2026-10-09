import { RateLimiterMemory } from "rate-limiter-flexible";
import { scaledPoints } from "./rate-limit.js";

/**
 * `auth.acceptInvite` (a signed-in person opening an invite link): 10 attempts a minute per
 * user, then 15 minutes blocked, like the public invite lookup. In-memory, per server process.
 */
export const inviteAcceptLimiter = new RateLimiterMemory({
  keyPrefix: "rl:invite-accept",
  points: scaledPoints(10),
  duration: 60,
  blockDuration: 15 * 60,
});

/** Charges one signed-in invite acceptance to this user; false when over the budget. */
export async function consumeInviteAccept(userId: string): Promise<boolean> {
  try {
    await inviteAcceptLimiter.consume(userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Auth DB shutdown fence — COMPATIBILITY DELEGATION (Part G pass 2, G1).
 *
 * The fence implementation MOVED to the ONE seam that covers every
 * consumer of the shared Prisma client: `@ws-model-proxy/db/shutdown-fence`
 * (packages/db/src/shutdown-fence.ts), where the shared client itself is
 * wrapped at construction (packages/db/src/index.ts). That move extends the
 * Part F pass-5 fence (which covered only better-auth's prisma adapter) to
 * the DIRECT procedure calls the MCP tool dispatch makes through the same
 * client — closing the G1 probe (a parked procedure lookup resuming after
 * gate close and starting `modelApiToken.update`).
 *
 * This module keeps the Part F arm/disarm API surface alive as thin
 * delegations to the single db-seam fence state, so existing callers
 * (apps/server/src/app.ts wires `armAuthDbShutdownFence` into the MCP
 * admission gate's `onClosed`; fence tests) keep working against the ONE
 * arming seam. There is NO second wrapper and NO double-wrapping: the
 * shared client packages/db exports is already fenced, so
 * packages/auth/src/index.ts hands that client to better-auth's
 * prismaAdapter verbatim.
 */

export {
  armDbShutdownFence as armAuthDbShutdownFence,
  DbShutdownFenceError as AuthDbShutdownFenceError,
  disarmDbShutdownFence as disarmAuthDbShutdownFence,
  isDbShutdownFenceArmed as isAuthDbShutdownFenceArmed,
} from "@ws-model-proxy/db/shutdown-fence";

import { env } from "@ws-model-proxy/env/shared";

import { createPrismaClient } from "./client-factory";
import { configureLockSlots, withTransactionSlot } from "./lock-slots";
import { withDbShutdownFence } from "./shutdown-fence";

export { Prisma } from "../prisma/generated/client";

// DB-seam shutdown fence (Part G pass 2, G1): the ONE shared client every
// consumer of this package uses — better-auth's prisma adapter, the oRPC
// procedures the MCP tools dispatch to, the /mcp admission lookups, and
// the diagnostic cores — is wrapped ONCE here. While the fence is inactive
// the wrapper is fully transparent; when the MCP shutdown gate closes
// (apps/server/src/app.ts wires armDbShutdownFence into the gate's
// onClosed), any NEW database operation started by any continuation of any
// consumer rejects immediately. See ./shutdown-fence.ts for the rationale.
configureLockSlots(env.DATABASE_POOL_MAX);
const client = createPrismaClient(env.DATABASE_URL, { maxConnections: env.DATABASE_POOL_MAX });
// Raw auth/setup transactions use this boundary too. Accounting begins before
// checkout, never from inside lockCredentialSetup after a connection is pinned.
const prisma = withDbShutdownFence(
  new Proxy(withDbShutdownFence(client), {
    get(target, key, receiver) {
      if (key === "$transaction") {
        return (...args: Parameters<typeof client.$transaction>) =>
          withTransactionSlot(() => Reflect.apply(target.$transaction, target, args));
      }
      return Reflect.get(target, key, receiver);
    },
  }),
);

export default prisma;

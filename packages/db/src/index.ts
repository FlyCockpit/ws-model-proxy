import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@ws-model-proxy/env/shared";

import { PrismaClient } from "../prisma/generated/client";
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
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = withDbShutdownFence(new PrismaClient({ adapter }));

export default prisma;

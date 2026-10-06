/**
 * The 0.4.0 API contract (S0 first deliverable): every oRPC procedure (spec §8.1a) with its
 * input/output zod and access level, the 25 MCP tools, the plain-HTTP node endpoints, and the
 * metrics vocabulary. Overview: `docs/contracts/0.4.0.md`.
 *
 * S0c binds each leaf to its base procedure (see `procedure.ts`) with a NOT_IMPLEMENTED
 * handler; the lanes then implement them without changing these shapes (a shape change is a
 * contract change and is reviewed as one).
 */

import { accessContract } from "./access";
import {
  adminObservabilityContract,
  adminSettingsContract,
  appContract,
  authContract,
  settingsContract,
  usersContract,
} from "./account";
import { activityContract } from "./activity";
import { modelsContract } from "./models";
import { nodesContract } from "./nodes";
import { poolsContract } from "./pools";
import type { RouterContract } from "./procedure";
import { profilesContract } from "./profiles";
import { providersContract } from "./providers";
import { runtimesContract } from "./runtimes";

export const apiContract = {
  app: appContract,
  auth: authContract,
  settings: settingsContract,
  users: usersContract,
  adminObservability: adminObservabilityContract,
  adminSettings: adminSettingsContract,
  nodes: nodesContract,
  runtimes: runtimesContract,
  profiles: profilesContract,
  pools: poolsContract,
  models: modelsContract,
  access: accessContract,
  providers: providersContract,
  activity: activityContract,
} as const satisfies RouterContract;

export { MCP_EXCLUDED_SESSION_PROCEDURES, MCP_TOOLS, type McpToolContract } from "./mcp-tools";
export * from "./procedure";
export * from "./tool-names";

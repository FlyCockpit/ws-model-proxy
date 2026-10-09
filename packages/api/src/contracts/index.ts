/**
 * The 0.4.0 API contract (S0 first deliverable): every oRPC procedure (spec §8.1a) with its
 * input/output zod and access level, the 28 MCP tools, the plain-HTTP node endpoints, and the
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
import { flattenContract, type RouterContract } from "./procedure";
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

/**
 * Procedures whose `/rpc` call must carry a validated `x-csrf-token` header on every deployment
 * shape (the source of `CallerAuth.csrfVerified`): every human and human_admin procedure, and
 * every agent-level mutation (a cookie caller reaches those as a person, so a cross-site page
 * must not be able to fire one).
 */
export const CSRF_REQUIRED_PROCEDURES: ReadonlySet<string> = new Set(
  flattenContract(apiContract)
    .filter(
      ([, procedure]) =>
        procedure.access === "human" ||
        procedure.access === "human_admin" ||
        (procedure.access === "agent" && procedure.kind === "mutation"),
    )
    .map(([path]) => path),
);

/**
 * Procedures whose input carries a secret value (node secrets). The server never logs, audits
 * or echoes their input: errors name the field only, the audit records the secret's name.
 */
export const SENSITIVE_INPUT_PROCEDURES: ReadonlySet<string> = new Set(["nodes.secrets.set"]);

export * from "./auth-context";
export * from "./http";
export {
  advertisedInputSchema,
  MCP_EXCLUDED_SESSION_PROCEDURES,
  MCP_TOOLS,
  type McpToolContract,
} from "./mcp-tools";
export * from "./procedure";
export { REFUSAL_REASONS, type RefusalReason } from "./refusals";
export * from "./tool-names";

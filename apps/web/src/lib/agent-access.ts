import { AGENT_SCOPES, type AgentScope } from "@ws-model-proxy/api/contracts";
import z from "zod";

export const agentAccessSchema = z.object({
  scopes: z.array(z.enum(AGENT_SCOPES)).refine((scopes) => scopes.includes("read")),
  nodeIds: z.array(z.string()).nullable(),
});

export type EditableAgentAccess = z.infer<typeof agentAccessSchema>;
export const defaultAgentAccess = (): EditableAgentAccess => ({ scopes: ["read"], nodeIds: null });

/** OAuth wire names contain colons, which i18next treats as namespace separators. */
export const agentScopeLabelKey = {
  read: "read",
  pools: "pools",
  runtimes: "runtimes",
  "nodes:manage": "nodes_manage",
  commands: "commands",
  files: "files",
  "models:test": "models_test",
} as const satisfies Record<AgentScope, string>;

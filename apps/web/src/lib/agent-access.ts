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

/**
 * Access presets, the quick path before the permission grid:
 * - `readOnly`: look, change nothing (always included `read`).
 * - `models`: run models: pools, runtimes (start/stop, profiles) and test requests, but nothing
 *   that acts on a node itself (no node changes, commands or files).
 * - `full`: every permission offered (all seven, or the ceiling an OAuth agent asked for).
 */
export const AGENT_ACCESS_PRESETS = ["readOnly", "models", "full"] as const;
export type AgentAccessPreset = (typeof AGENT_ACCESS_PRESETS)[number];

const MODELS_PRESET: readonly AgentScope[] = ["read", "pools", "runtimes", "models:test"];

/** The scopes of each preset that fits within `selectable`, in `AGENT_SCOPES` order. */
export function agentAccessPresets(
  selectable: readonly AgentScope[],
): Array<{ id: AgentAccessPreset; scopes: AgentScope[] }> {
  if (selectable.length <= 1) return [];
  const ordered = (scopes: readonly AgentScope[]) =>
    AGENT_SCOPES.filter((scope) => scope === "read" || scopes.includes(scope));
  const full = ordered(selectable);
  const presets: Array<{ id: AgentAccessPreset; scopes: AgentScope[] }> = [
    { id: "readOnly", scopes: ["read"] },
  ];
  // "Run models" only when every scope it needs is offered and it differs from Full access.
  if (
    MODELS_PRESET.every((scope) => selectable.includes(scope)) &&
    full.length !== MODELS_PRESET.length
  )
    presets.push({ id: "models", scopes: ordered(MODELS_PRESET) });
  presets.push({ id: "full", scopes: full });
  return presets;
}

/** The preset whose scopes are exactly `scopes`, or null (custom). */
export function matchAgentAccessPreset(
  scopes: readonly AgentScope[],
  selectable: readonly AgentScope[],
): AgentAccessPreset | null {
  const chosen = new Set<AgentScope>(["read", ...scopes]);
  return (
    agentAccessPresets(selectable).find(
      (preset) =>
        preset.scopes.length === chosen.size && preset.scopes.every((scope) => chosen.has(scope)),
    )?.id ?? null
  );
}

/**
 * Machine-readable refusal reasons (`ORPCError` `data.reason`, preview `refusals[].reason`,
 * `needsRestart[].reason`). Every reason has a fixed, developer-written message that may name
 * ids but never caller free text, so MCP may copy it to agents. Never rename or reuse a value;
 * add new ones at the end. (Continues 0.4-dev `deployment-refusal-reasons.ts`, renamed to the
 * 0.4.0 nouns.)
 */
import { z } from "zod";

export const REFUSAL_REASONS = [
  // Who may do it.
  "human_only",
  /** An agent touched a Relay-only node (start/stop/restart/preempt/define/command/file). */
  "trust_relay",
  /** A person applied without echoing a preview fingerprint, or the preview changed since. */
  "preview_required",
  "preview_stale",
  // Definitions on nodes.
  "definition_frozen",
  "definition_missing",
  "launch_change_on_relay_only",
  "no_frozen_peer_set",
  // Lifecycle and deletion.
  "instances_running",
  "pinned_by_profile",
  "interactive_needs_person",
  "launch_changed",
  // Placement (0.4-dev planner reasons, renamed).
  "invalid_node_count",
  "unknown_node",
  "label_mismatch",
  "head_address_unavailable",
  "unknown_placeholder",
  "unsafe_placeholder_value",
  "command_too_large",
  "not_enough_nodes",
  "node_offline",
  "upgrade_wsmp",
  "operator_terminals_unavailable",
  "not_enough_memory",
  "resources_held",
  "no_free_ports",
  "port_in_use",
  // Pools, access and spend.
  "contribute_not_allowed",
  "own_hardware_only",
  "model_type_mismatch",
  "sidecar_chain",
  "cloud_cap_reached",
  "slug_taken",
  "rate_limited",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export const refusalReasonSchema = z.enum(REFUSAL_REASONS);

export const refusalSchema = z
  .object({
    reason: refusalReasonSchema,
    /** The node, instance or member it is about, when there is one. */
    subjectId: z.string().nullable(),
    message: z.string(),
  })
  .strict();

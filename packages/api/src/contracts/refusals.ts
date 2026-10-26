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
  "launch_change_on_node_origin",
  /** Retired with fabrics (owner decision round 3); kept so the value is never reused. */
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
  // Owner decisions round 3.
  /** Not enough free nodes share one fabric (a multi-node instance stays inside one). */
  "no_shared_fabric",
  /** Relay only: the head is not in this node's frozen membership of the instance's fabric. */
  "head_not_in_frozen_fabric",
  /** A person put the node on hold: nothing is placed there until it is released. */
  "node_held",
  /** Agents may only contribute and withdraw their own served models. */
  "not_your_runtime",
  /** A node secret is set at Full control remotely, or with `wsmp secret set` on the node. */
  "secret_needs_node",
  /** A command finished or is unknown to the node; there is nothing to cancel. */
  "command_not_running",
  // Contract review fixes (round 3).
  /** A running multi-node instance uses this fabric, or this node's address on it. */
  "fabric_in_use",
  /**
   * An invite is accepted by its link, or by e-mail match only for a verified address (with
   * e-mail verification off, only the link works).
   */
  "invite_needs_link",
  // Lane B contract gaps.
  /** A new node port range leaves out a port a running instance on the node uses. */
  "port_range_in_use",
  // Lane E integration.
  /** A cap's currency changes only while its subject has no spend or reservation this month. */
  "cap_currency_has_spend",
  // E2E fixes.
  /** An agent deletes only an offline node (people delete any in the browser). */
  "node_online",
  // Request compatibility.
  /** A new alias named like a callable ID the caller can call now. */
  "alias_shadowed",
  /** At most MODEL_ALIASES_MAX_PER_USER aliases per user. */
  "alias_limit",
  /** A key-scoped alias for a pool the key cannot call. */
  "alias_key_not_allowed",
  // E2E findings (round 2).
  /**
   * runtime_start on an always-on runtime: it runs on its own and the proxy only connects to
   * it, so there is nothing to start or restart (health is re-checked automatically).
   */
  "always_on_runtime",
  /**
   * A multi-node instance needs one dist port inside every node's port range; these nodes'
   * ranges have none in common (the message names them).
   */
  "fabric_port_ranges_disjoint",
  // Pool sharing tab.
  /** shares.create for a person who already has a share of the pool: change that share. */
  "already_shared",
  /** An invite to this e-mail and pool (or runtime) is pending: resend it instead. */
  "invite_pending",
  /** The owner has SHARE_INVITE_MAX_PENDING_PER_OWNER pending invites. */
  "too_many_invites",
  /** invites.revoke lost to an acceptance: it is a share now. */
  "invite_accepted",
  // Model-name collisions (packages/api/src/lib/model-names.ts).
  /** A new callable ID of the caller's own pools (pool or account slug) equals their alias. */
  "name_aliased",
  // Queued command expiry and withdrawal.
  /** An agent withdraws only a command its own credential queued for a person. */
  "not_your_command",
  // Releasing a claim whose stop cannot be proven.
  /** Only a node part marked stopped (its stop not proven) can be released or asked about. */
  "not_marked_stopped",
  /** The resources are already released. */
  "already_released",
  /** A release request for this node part already waits for a person. */
  "release_request_pending",
  // Placement work budget (packages/api/src/lib/placement.ts PLACEMENT_WORK_BUDGET).
  /**
   * Placing a start took more work than one plan may do (many nodes, reservations or stops to
   * try): pin the nodes, or start fewer at once.
   */
  "placement_too_complex",
  // Restart holds (a replaced run's claims stay held until its stop is proven).
  /**
   * A restart needs more room beside the running instance's claims (which stay held until its
   * stop is proven) than the node has; it would fit once they are released: stop it first.
   */
  "restart_overlap_no_room",
  // Definition slots on a node (RUNTIME_DEFINITIONS_MAX, which the node enforces).
  /**
   * A Full-control node already requires as many runtime definitions as it can hold (what runs
   * or is stopping there): a start or restart of another version would push one out. Stop an
   * instance there, or wait for a restart to finish.
   */
  "definition_slots_full",
  // Windows terminals.
  /** A browser terminal named a shell the node did not advertise (or no longer does). */
  "shell_unavailable",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export const refusalReasonSchema = z.enum(REFUSAL_REASONS);

/** The `launch.reservations` entry a placement refusal is about (`data.reservation` too). */
export const refusalReservationSchema = z
  .object({
    /** 0-based position in `launch.reservations`. */
    index: z.number().int().min(0),
    labels: z.array(z.string()),
    /** The node the reason names (`subjectId`), when there is one. */
    nodeSlug: z.string().nullable(),
  })
  .strict();

export const refusalSchema = z
  .object({
    reason: refusalReasonSchema,
    /** The node, instance or member it is about, when there is one. */
    subjectId: z.string().nullable(),
    message: z.string(),
    /** A reservation that cannot be placed: which one (clients show it with the reason). */
    reservation: refusalReservationSchema.optional(),
  })
  .strict();

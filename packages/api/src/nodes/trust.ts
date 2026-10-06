import type { z } from "zod";
import type { nodeTrustViewSchema } from "../contracts/nodes";

export type NodeTrustView = z.infer<typeof nodeTrustViewSchema>;

export type NodeTrustColumns = {
  trust: "RELAY" | "FULL" | null;
  trustChangedAt: Date | null;
  trustLowerRequestedAt: Date | null;
};

/**
 * Trust as the server applies it (§3.2): the node's value rules, a node that never said hello
 * is Relay only, and a person's lower request makes it Relay only at once (before the node
 * confirms).
 */
export function nodeTrustView(node: NodeTrustColumns): NodeTrustView {
  const lowerPending = node.trustLowerRequestedAt !== null && node.trust !== "RELAY";
  const effective = node.trust === "FULL" && !lowerPending ? "FULL" : "RELAY";
  return {
    reported: node.trust,
    effective,
    lowerPending,
    // Frozen ⇔ Relay only (review cut: no separate flag). A node that never said hello holds
    // nothing yet, so nothing is frozen.
    frozen: node.trust === "RELAY" || lowerPending,
    changedAt: node.trustChangedAt?.toISOString() ?? null,
  };
}

export function isFullControl(node: NodeTrustColumns): boolean {
  return nodeTrustView(node).effective === "FULL";
}

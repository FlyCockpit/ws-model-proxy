import type { z } from "zod";
import type { nodeTrustViewSchema } from "../contracts/nodes";

export type NodeTrustView = z.infer<typeof nodeTrustViewSchema>;

export type NodeTrustColumns = {
  trust: "RELAY" | "FULL" | null;
  trustChangedAt: Date | null;
  trustLowerRequestedAt: Date | null;
};

/** What the trust card also needs: who lowered it, fenced to the node's owner. */
export type NodeTrustViewColumns = NodeTrustColumns & {
  userId: string;
  trustLowerRequestedBy: string | null;
  User: { name: string };
};

/**
 * Trust as the server applies it (§3.2): the node's value rules, a node that never said hello
 * is Relay only, and a person's lower request makes it Relay only at once (before the node
 * confirms).
 */
export function effectiveTrust(node: NodeTrustColumns): "RELAY" | "FULL" {
  const lowerPending = node.trustLowerRequestedAt !== null && node.trust !== "RELAY";
  return node.trust === "FULL" && !lowerPending ? "FULL" : "RELAY";
}

export function nodeTrustView(node: NodeTrustViewColumns): NodeTrustView {
  const lowerPending = node.trustLowerRequestedAt !== null && node.trust !== "RELAY";
  const effective = effectiveTrust(node);
  // `trustLowerRequestedBy` stays set while the node is Relay only because of that person's
  // lowering (the relay clears it on any other trust change), so it names who changed it.
  // Only the owner can lower a node (human-only, owner session): any other id shows nothing.
  const loweredBy =
    effective === "RELAY" && node.trustLowerRequestedBy === node.userId ? node.userId : null;
  return {
    reported: node.trust,
    effective,
    lowerPending,
    // Frozen ⇔ Relay only (review cut: no separate flag). A node that never said hello holds
    // nothing yet, so nothing is frozen.
    frozen: node.trust === "RELAY" || lowerPending,
    // A pending lowering applies from the request; otherwise the node's last reported change.
    changedAt:
      (lowerPending ? node.trustLowerRequestedAt : node.trustChangedAt)?.toISOString() ?? null,
    changedBy: loweredBy
      ? { actor: "USER", userId: loweredBy, agentTokenId: null, label: node.User.name }
      : null,
  };
}

export function isFullControl(node: NodeTrustColumns): boolean {
  return effectiveTrust(node) === "FULL";
}

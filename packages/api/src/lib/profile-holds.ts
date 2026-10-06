/**
 * Node holds when a profile is applied (owner decision round 3, review fix). Pure: the apply
 * procedure reads the profile's owned nodes and each node's current hold, then writes what
 * this returns in the same transaction.
 *
 * - A node with a hold line in this profile is held by this profile (`holdProfileId` = it),
 *   unless it is already held: a person's hold or another profile's hold stays as it is (so a
 *   later apply can never release a hold this profile did not set).
 * - An owned node without a hold line is released only when this profile set its hold.
 * - A hold set by a person or another profile on an owned node without a hold line:
 *   an agent's apply is refused whole (`node_held`: an agent never releases it, and nothing
 *   may be placed there); a person's apply (confirmed through the preview) releases it.
 */

export type NodeHoldState = {
  holdAt: Date | null;
  /** The profile that set the hold; null for a person's hold. */
  holdProfileId: string | null;
};

export type ProfileHoldLine = { nodeId: string; hold: boolean; holdNote: string | null };

export type ProfileHoldPlan =
  | {
      ok: true;
      /** Set holdAt/holdNote/holdProfileId = profileId. */
      hold: Array<{ nodeId: string; note: string | null }>;
      /** Clear holdAt/holdNote/holdProfileId. */
      release: string[];
      /** Held by someone else; this apply leaves the hold alone. */
      keep: string[];
    }
  | { ok: false; reason: "node_held"; nodeIds: string[] };

export function planProfileHolds(input: {
  profileId: string;
  caller: "person" | "agent";
  nodes: readonly ProfileHoldLine[];
  current: ReadonlyMap<string, NodeHoldState>;
}): ProfileHoldPlan {
  const hold: Array<{ nodeId: string; note: string | null }> = [];
  const release: string[] = [];
  const keep: string[] = [];
  const refused: string[] = [];
  for (const line of input.nodes) {
    const state = input.current.get(line.nodeId);
    const held = state?.holdAt != null;
    const ours = held && state?.holdProfileId === input.profileId;
    if (line.hold) {
      if (!held || ours) hold.push({ nodeId: line.nodeId, note: line.holdNote });
      else keep.push(line.nodeId);
      continue;
    }
    if (!held) continue;
    if (ours || input.caller === "person") release.push(line.nodeId);
    else refused.push(line.nodeId);
  }
  if (refused.length > 0) return { ok: false, reason: "node_held", nodeIds: refused };
  return { ok: true, hold, release, keep };
}

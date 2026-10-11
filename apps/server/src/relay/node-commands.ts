/**
 * The process's node command tracker and the entry points that end commands from outside the
 * procedures: a ban (`user-ban.ts`), a revoked agent credential (`access-revocation.ts`
 * `endAgentWork`) and the 60 s maintenance sweep (expired or narrowed credentials).
 *
 * Commands are started by `nodes.commands.run` through `node-operator-services.ts`, which
 * tracks each one here from the moment its `exec.start` is sent.
 */
import { NodeCommandTracker } from "./node-command-tracker.js";
import { relaySessionManager } from "./session-manager.js";

export const nodeCommandTracker = new NodeCommandTracker({
  sendToNode: (nodeId, frame, guard) => relaySessionManager.sendToNode(nodeId, frame, guard),
});

/** The class only: an error message could carry query content. */
function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

/**
 * Agent tokens or OAuth grants were revoked (or narrowed) and committed: end the node
 * commands they started.
 */
export function cancelNodeCommandsForCredentials(input: {
  userId: string;
  credentialIds: readonly string[];
}): Promise<number> {
  return nodeCommandTracker.cancelForCredentials(input);
}

/**
 * A user was banned: the commands they own end now. Synchronous for every command this
 * process tracks; rows from before a restart follow in the background (and at the next sweep).
 */
export function cancelNodeCommandsForUser(userId: string): void {
  nodeCommandTracker.cancelForUser(userId);
}

/**
 * The 60 s pass: commands whose credential is no longer live or whose owner is blocked end.
 * Never rejects (the maintenance loop does not await it).
 */
export function sweepExpiredNodeCommands(now = Date.now()): Promise<number> {
  return nodeCommandTracker.sweep(now).catch((error: unknown) => {
    console.error("[relay] node command sweep failed", errorName(error));
    return 0;
  });
}

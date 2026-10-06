/**
 * Agent commands on a node (`exec.start` / `exec.poll` / `exec.cancel`, results through
 * `exec.started` / `exec.status` / `exec.rejected`). STUB for lane D3: 0.4.0 commands are
 * output-to-file, admitted by `node-access.ts` (FULL token, node at Full control) and audited
 * as `NodeAuditEvent` kind `command`. Until D3 lands every start is refused before anything is
 * sent, so no command record ever exists and the cancel/sweep entry points only end open
 * admissions. The exec.* node frames go to the session manager's node frame handlers.
 */
import { revokeOpenNodeAgentAccess, revokeOpenNodeAgentAccessForUser } from "./node-access.js";

export type StartNodeCommandInput = {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  nodeId: string;
  command: string;
  timeoutMs?: number;
};

export type StartNodeCommandResult = { ok: false; error: "not_implemented" };

/** Lane D3. Refuses: no frame is sent and nothing is recorded. */
export async function startNodeCommand(
  _input: StartNodeCommandInput,
): Promise<StartNodeCommandResult> {
  return { ok: false, error: "not_implemented" };
}

/** A token was revoked or narrowed: refuse its commands still in admission. */
export function cancelNodeCommandsForToken(tokenId: string): void {
  revokeOpenNodeAgentAccess(tokenId);
}

/** A user was banned: refuse their commands still in admission. */
export function cancelNodeCommandsForUser(userId: string): void {
  revokeOpenNodeAgentAccessForUser(userId);
}

/** Expired tokens end their running commands. No command records exist before lane D3. */
export function sweepExpiredNodeCommands(_now = Date.now()): number {
  return 0;
}

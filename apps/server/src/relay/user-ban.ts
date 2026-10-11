import { cancelNodeCommandsForUser } from "./node-commands.js";
import { cancelFileOpsForUser } from "./node-file-ops.js";
import { relaySessionManager } from "./session-manager.js";

/**
 * The ban fence: a user was banned, so nothing they started may keep running. Ends their
 * node commands, in-flight file ops and operator terminals (the engine opens no new one for a
 * banned or deleting owner, and its drain cancels their waiting interactive steps) and refuses
 * admissions still reading (the per-user twin of the token revoke). Their relay sockets stay
 * open; a ban already refuses reauthentication and every new admission re-reads the owner's
 * ban state. Browser terminals end at the terminal hub's session recheck.
 *
 * Synchronous, so the work has ended before `notifyUserBanned`
 * (`@ws-model-proxy/auth/user-ban-listeners`) returns to the ban path. Every sweep runs even
 * if an earlier one throws. Subscribed once in `../app.ts`.
 */
export function cancelRelayWorkForBannedUser(userId: string): void {
  try {
    cancelNodeCommandsForUser(userId);
  } finally {
    try {
      cancelFileOpsForUser(userId);
    } finally {
      relaySessionManager.cancelOperatorTerminalsForUser(userId);
    }
  }
}

import { cancelNodeCommandsForUser } from "./node-commands.js";
import { cancelFileOpsForUser } from "./node-file-ops.js";

/**
 * The ban fence: a user was banned, so nothing they started may keep running. Ends their
 * node commands and in-flight file ops and refuses admissions still reading (the per-user twin
 * of the token revoke). Their relay sockets stay open; a ban already refuses
 * reauthentication and every new admission re-reads the owner's ban state. Browser terminals
 * end at the terminal hub's session recheck. (Operator terminals of runtime jobs are lane A4.)
 *
 * Synchronous, so the work has ended before `notifyUserBanned`
 * (`@ws-model-proxy/auth/user-ban-listeners`) returns to the ban path. The file-op sweep runs
 * even if the command sweep throws. Subscribed once in `../app.ts`.
 */
export function cancelRelayWorkForBannedUser(userId: string): void {
  try {
    cancelNodeCommandsForUser(userId);
  } finally {
    cancelFileOpsForUser(userId);
  }
}

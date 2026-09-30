import { cancelCommandsForUser } from "./cli-commands.js";
import { cancelFileOpsForUser } from "./cli-file-ops.js";

/**
 * The ban fence (#159): a user was banned, so nothing they started may keep
 * running. Ends their running and supervised commands, their in-flight file
 * ops, and refuses admissions still reading (the per-user twin of the token
 * revoke that `cancelMcpTokenCommands` does). Their relay sockets stay open; a
 * ban already refuses reauthentication and every new admission re-reads the
 * owner's ban state.
 *
 * Synchronous, so the work has ended before `notifyUserBanned`
 * (`@ws-model-proxy/auth/user-ban-listeners`) returns to the ban path: file ops,
 * supervised requests and headless commands are settled on the server at once
 * (a headless command is also asked to stop and keeps only its execution slot
 * until the CLI answers; see `endExecFromServer` in `./cli-commands.ts`). The
 * file-op sweep runs even if the command sweep throws. Subscribed once in
 * `./app.ts`.
 */
export function cancelRelayWorkForBannedUser(userId: string): void {
  try {
    cancelCommandsForUser(userId);
  } finally {
    cancelFileOpsForUser(userId);
  }
}

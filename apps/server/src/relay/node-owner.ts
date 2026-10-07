/**
 * The relay's last owner check (defence in depth): before anything goes to a node, the node's
 * owner (the live session's user, or `node.userId`) must be the owner of what is sent: the
 * command's, the secret's, the terminal's, the instance's or the definitions'. The procedures
 * and the lifecycle engine already scope every lookup by owner; this catches a slip there.
 *
 * A refusal is logged by its class only (never an id, a command or a value).
 */

/** What was about to reach the node when the check refused it (the log line's class). */
export type NodeOwnerCheck =
  | "command"
  | "command_poll"
  | "command_cancel"
  | "secret"
  | "terminal_ticket"
  | "terminal_open"
  | "terminal_attach"
  | "operator_attach"
  | "runtime_step"
  | "definition_sync"
  | "file_op"
  | "frame";

/**
 * Whether the node's owner is `ownerUserId`. `node` is the live session (or the node row); a
 * missing one is not a match (and not logged: the node is offline or gone). A mismatch is
 * logged by `check` and refused.
 */
export function nodeOwnerMatches(
  node: { userId: string } | null | undefined,
  ownerUserId: string,
  check: NodeOwnerCheck,
): boolean {
  if (!node) return false;
  // An owner that is not a real id (a slip upstream) never matches, even an equal one.
  if (typeof ownerUserId === "string" && ownerUserId !== "" && node.userId === ownerUserId)
    return true;
  console.warn("[relay] refused a send to a node of another owner", check);
  return false;
}

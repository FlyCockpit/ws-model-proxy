/**
 * Shapes shared by the server's in-memory supervised-command records and the
 * dashboard procedures that read them (`supervisedCommands.*`). The records
 * live in the server process; the API reaches them through context services.
 */

export type SupervisedCommandStatus =
  | "awaiting_user"
  | "running"
  | "awaiting_output_review"
  | "exited"
  | "declined"
  | "expired"
  | "cancelled"
  | "rejected";

/** How the agent's result was produced. `private`: output was never requested. */
export type SupervisedOutputMode = "shared" | "reviewed" | "redacted" | "private";

/** A request a person still has to act on (confirm, or review output). */
export type PendingSupervisedRequest = {
  commandId: string;
  terminalId: string;
  cliDeviceId: string;
  status: "awaiting_user" | "running" | "awaiting_output_review";
  requester: string;
  reason: string | null;
  command: string;
  cwd: string | null;
  shareOutput: boolean;
  createdAt: string;
  /** Deadline of the current wait (confirm or review); null while running. */
  expiresAt: string | null;
};

export type SubmitSupervisedOutputResult =
  | { ok: true; outputMode: "reviewed" | "redacted" }
  | { ok: false; error: "not_found" | "conflict" };

/** Longest reviewed output a person may submit, in UTF-16 code units. */
export const SUPERVISED_REVIEW_OUTPUT_MAX_CHARS = 200_000;

export type SupervisedCommandServices = {
  listPending(userId: string): PendingSupervisedRequest[];
  submitOutput(input: {
    userId: string;
    commandId: string;
    output: string | null;
    edited: boolean;
  }): SubmitSupervisedOutputResult;
};

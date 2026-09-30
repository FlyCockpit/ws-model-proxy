import {
  type CliCommandSnapshot,
  snapshotCliCommand,
  snapshotSupervisedCommand,
  startCliCommand,
  startSupervisedCommand,
  waitCliCommand,
} from "../relay/cli-commands.js";
import {
  parseCliCommandSnapshot,
  presentCliCommand,
  presentSupervisedCommand,
} from "./cli-command-output.js";
import { FILE_ERROR_MESSAGES, projectFileToolOutput } from "./cli-file-tools.js";
import type { McpRequestCredential } from "./cli-tool-access.js";

type CliCommandDeps = {
  userId: string;
  signal?: AbortSignal;
  credential: McpRequestCredential;
};

// All command-tool descriptions share the CLI's masking and server scrubbing notice.
export { CLI_COMMAND_OUTPUT_NOTICE } from "@ws-model-proxy/config/cli-command-output";

/**
 * Three switches gate a CLI command (docs/cli-command-switches.md): 1 the
 * token, 2 the device's dashboard grant, 3 the CLI's own
 * `wsmp config set-mcp-commands`. Each rejection names the switch that
 * refused, and what to change, so a person can fix the right one.
 */
const CLI_REJECTION_MESSAGES = {
  not_found: "Not found",
  grant_disabled:
    "CLI commands are disabled for this device (switch 2 of 3: its MCP commands grant on the dashboard CLIs page is Off; a person must set it to Supervised or Unsupervised)",
  offline:
    "CLI is offline or does not support this protocol (the device must be connected and running a wsmp version that supports MCP commands)",
  feature_disabled:
    "CLI has MCP commands disabled in wsmp config (switch 3 of 3: on that machine run `wsmp config set-mcp-commands supervised` or `unsupervised`, then restart wsmp; the dashboard grant already allows commands)",
  supervised_only:
    "This device allows only supervised commands (its dashboard MCP commands grant or `wsmp config set-mcp-commands` on that machine is Supervised, whichever is stricter); use forwarder_cli_supervised_command_start so a person confirms the command",
  unsupported: "Supervised commands need a CLI with terminal support (Unix)",
  limit: "too many commands",
  invalid_command:
    "command and cwd must be well-formed Unicode text (no unpaired surrogates), 1..=4096 UTF-8 bytes, and contain no NUL",
  invalid_reason:
    "reason must be well-formed Unicode text (no unpaired surrogates) of at most 500 characters (Unicode code points) and contain no NUL",
  token_inactive:
    "This MCP token was revoked, has expired, or no longer allows CLI commands, or the account no longer allows CLI effects (switch 1 of 3: mcp:write and CLI commands are required; edit the token in Settings > MCP, or check the account)",
} as const;

/** Shown on `forwarder_cli_activity_list`: what the audit log holds. */
export const CLI_AGENT_ACTIVITY_NOTICE =
  "Lists what agents did on the caller's CLI devices (commands, supervised commands and file operations) newest first, as metadata only: kind, outcome, path (for commands a keyed HMAC-SHA256 of the command text plus the program name, never the command text itself), sizes and timestamps. Supervised file audit reasons use <op>:<code> (for example write:completed or edit:conflict); headless file reasons use <code>. File content, diffs and command output are never stored. Rows are kept for 90 days. Optional cliDeviceId, limit (1-100) and cursor (the previous nextCursor).";

/** Shown on the supervised tool: what the agent can and cannot learn. */
export const CLI_SUPERVISED_COMMAND_NOTICE =
  "Opens a terminal on the CLI that shows the person your reason and the exact command; nothing runs until they press Enter there, and they may decline. Poll forwarder_cli_command_result with the commandId (statuses: awaiting_user, running, awaiting_output_review, exited, declined, expired, cancelled, rejected; declined, expired and rejected never ran, and an ended request reports started: true, false, or null when not known yet). Output is returned only with shareOutput: true, and the person may review, edit, or redact it first; output.mode says which (shared, reviewed, redacted, private). Waiting for the person expires after 15 minutes.";

export type CliCommandRejectionCode = keyof typeof CLI_REJECTION_MESSAGES;

const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 15_000;

/**
 * Stable CLI-command rejection. `message` is the text the model sees.
 * `reason` is the runtime code (safe to log; never command text or output).
 */
export class McpCliCommandRejectedError extends Error {
  readonly code: "NOT_FOUND" | "CLI_COMMAND_REJECTED";
  readonly reason: CliCommandRejectionCode;

  constructor(reason: CliCommandRejectionCode) {
    super(CLI_REJECTION_MESSAGES[reason]);
    this.name = "McpCliCommandRejectedError";
    this.reason = reason;
    this.code = reason === "not_found" ? "NOT_FOUND" : "CLI_COMMAND_REJECTED";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isRejection(value: unknown): value is CliCommandRejectionCode {
  return typeof value === "string" && Object.hasOwn(CLI_REJECTION_MESSAGES, value);
}

/** Default 15000. Finite numbers are clamped to 0..15000; anything else defaults. */
export function clampWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WAIT_MS;
  const truncated = Math.trunc(value);
  if (truncated < 0) return 0;
  if (truncated > MAX_WAIT_MS) return MAX_WAIT_MS;
  return truncated;
}

function requireCliPat(credential: McpRequestCredential): {
  tokenId: string;
  expiresAt: Date | null;
} {
  if (credential.kind === "pat" && credential.allowCliCommands === true) {
    return { tokenId: credential.tokenId, expiresAt: credential.expiresAt };
  }
  throw new McpCliCommandRejectedError("not_found");
}

type StartResult = { ok: true; commandId: string } | { ok: false; error: CliCommandRejectionCode };

function parseStartResult(value: unknown): StartResult {
  const record = asRecord(value);
  if (
    record !== null &&
    record.ok === true &&
    typeof record.commandId === "string" &&
    record.commandId.length > 0
  ) {
    return { ok: true, commandId: record.commandId };
  }
  if (record !== null && record.ok === false && isRejection(record.error)) {
    return { ok: false, error: record.error };
  }
  throw new Error("cli command start returned an unexpected result");
}

function readWaited(snapshot: CliCommandSnapshot, commandId: string) {
  return parseCliCommandSnapshot(snapshot, commandId);
}

export function adaptCliCommandRunInput(input: unknown): {
  cliDeviceId: string;
  command: string;
  cwd?: string;
  waitMs: number;
} {
  const record = asRecord(input) ?? {};
  const cwd = record.cwd;
  return {
    cliDeviceId: typeof record.cliDeviceId === "string" ? record.cliDeviceId : "",
    command: typeof record.command === "string" ? record.command : "",
    ...(typeof cwd === "string" ? { cwd } : {}),
    waitMs: clampWaitMs(record.waitMs),
  };
}

export async function runForwarderCliCommand(
  input: unknown,
  deps: CliCommandDeps,
): Promise<unknown> {
  const pat = requireCliPat(deps.credential);
  const adapted = adaptCliCommandRunInput(input);
  const started = parseStartResult(
    await startCliCommand({
      userId: deps.userId,
      tokenId: pat.tokenId,
      expiresAt: pat.expiresAt,
      cliDeviceId: adapted.cliDeviceId,
      command: adapted.command,
      ...(adapted.cwd !== undefined ? { cwd: adapted.cwd } : {}),
    }),
  );
  if (!started.ok) throw new McpCliCommandRejectedError(started.error);
  const waited = await waitCliCommand(
    started.commandId,
    deps.userId,
    pat.tokenId,
    adapted.waitMs,
    deps.signal,
  );
  if (waited == null) {
    return { commandId: started.commandId, status: "running" };
  }
  const parsed = readWaited(waited, started.commandId);
  if (parsed === null) {
    return { commandId: started.commandId, status: "running" };
  }
  return presentCliCommand(parsed, undefined);
}

export function adaptCliSupervisedStartInput(input: unknown): {
  cliDeviceId: string;
  command: string;
  cwd?: string;
  reason?: string;
  shareOutput: boolean;
} {
  const record = asRecord(input) ?? {};
  const cwd = record.cwd;
  const reason = record.reason;
  return {
    cliDeviceId: typeof record.cliDeviceId === "string" ? record.cliDeviceId : "",
    command: typeof record.command === "string" ? record.command : "",
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
    shareOutput: record.shareOutput === true,
  };
}

/**
 * Ask a person to run a command in a supervised terminal on their CLI. The
 * result is the request id; the outcome comes from forwarder_cli_command_result.
 */
export async function runForwarderCliSupervisedCommandStart(
  input: unknown,
  deps: CliCommandDeps,
): Promise<unknown> {
  const pat = requireCliPat(deps.credential);
  const adapted = adaptCliSupervisedStartInput(input);
  const started = await startSupervisedCommand({
    userId: deps.userId,
    tokenId: pat.tokenId,
    expiresAt: pat.expiresAt,
    cliDeviceId: adapted.cliDeviceId,
    command: adapted.command,
    ...(adapted.cwd !== undefined ? { cwd: adapted.cwd } : {}),
    ...(adapted.reason !== undefined ? { reason: adapted.reason } : {}),
    shareOutput: adapted.shareOutput,
  });
  if (!started.ok) throw new McpCliCommandRejectedError(started.error);
  return {
    commandId: started.commandId,
    kind: "supervised",
    status: "awaiting_user",
    waitingUntil: started.expiresAt,
    shareOutput: adapted.shareOutput,
    next: "Ask the user to open Terminals in the dashboard and answer the agent request; then poll forwarder_cli_command_result.",
  };
}

export function adaptCliCommandResultInput(input: unknown): {
  commandId: string;
  progress?: boolean;
} {
  const record = asRecord(input) ?? {};
  const progress = record.progress;
  return {
    commandId: typeof record.commandId === "string" ? record.commandId : "",
    ...(typeof progress === "boolean" ? { progress } : {}),
  };
}

export async function runForwarderCliCommandResult(
  input: unknown,
  deps: CliCommandDeps,
): Promise<unknown> {
  const pat = requireCliPat(deps.credential);
  const adapted = adaptCliCommandResultInput(input);
  const supervised = snapshotSupervisedCommand(adapted.commandId, deps.userId, pat.tokenId);
  if (supervised !== null) {
    if (supervised.requestKind === "file") {
      return {
        commandId: supervised.commandId,
        kind: "supervised",
        status: supervised.status,
        started: supervised.started,
        ...(supervised.waitDeadline !== null
          ? { waitingUntil: new Date(supervised.waitDeadline).toISOString() }
          : {}),
        ...(supervised.file
          ? { file: { op: supervised.file.op, result: projectFileToolOutput(supervised.file) } }
          : {}),
        ...(supervised.fileError
          ? {
              error: {
                ...supervised.fileError,
                message: FILE_ERROR_MESSAGES[supervised.fileError.code],
              },
            }
          : {}),
      };
    }
    return presentSupervisedCommand(supervised);
  }
  const raw = await snapshotCliCommand(adapted.commandId, deps.userId, pat.tokenId);
  if (raw == null) throw new McpCliCommandRejectedError("not_found");
  const parsed = parseCliCommandSnapshot(raw, adapted.commandId);
  if (parsed === null) throw new McpCliCommandRejectedError("not_found");
  return presentCliCommand(parsed, adapted.progress);
}

import {
  type CliCommandSnapshot,
  snapshotCliCommand,
  snapshotSupervisedCommand,
  startCliCommand,
  startSupervisedCommand,
  waitCliCommand,
} from "../relay/cli-commands.js";
import type { McpRequestCredential } from "./cli-command-access.js";
import {
  parseCliCommandSnapshot,
  presentCliCommand,
  presentSupervisedCommand,
} from "./cli-command-output.js";

type CliCommandDeps = {
  userId: string;
  signal?: AbortSignal;
  credential: McpRequestCredential;
};

/**
 * Shown on both CLI command tools. Only the wsmp_ credential substrings
 * are removed; other secrets in command output are NOT redacted.
 */
export const CLI_COMMAND_OUTPUT_NOTICE =
  "Other secrets in command output are NOT redacted. Only substrings matching wsmp_model_, wsmp_cli_, wsmp_device_, or wsmp_mcp_ followed by credential characters are removed.";

const CLI_REJECTION_MESSAGES = {
  not_found: "Not found",
  grant_disabled: "CLI commands are disabled for this device",
  offline: "CLI is offline or does not support this protocol",
  feature_disabled: "CLI has MCP commands disabled in wsmp config",
  supervised_only:
    "This device allows only supervised commands; use forwarder_cli_supervised_command_start so a person confirms the command",
  unsupported: "Supervised commands need a CLI with terminal support (Unix)",
  limit: "too many commands",
  invalid_command:
    "command and cwd must be well-formed Unicode text (no unpaired surrogates), 1..=4096 UTF-8 bytes, and contain no NUL",
  invalid_reason:
    "reason must be well-formed Unicode text (no unpaired surrogates) of at most 500 characters (Unicode code points) and contain no NUL",
  token_inactive:
    "This MCP token was revoked, has expired, or no longer allows CLI commands (mcp:write and CLI commands are required)",
} as const;

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
  if (supervised !== null) return presentSupervisedCommand(supervised);
  const raw = await snapshotCliCommand(adapted.commandId, deps.userId, pat.tokenId);
  if (raw == null) throw new McpCliCommandRejectedError("not_found");
  const parsed = parseCliCommandSnapshot(raw, adapted.commandId);
  if (parsed === null) throw new McpCliCommandRejectedError("not_found");
  return presentCliCommand(parsed, adapted.progress);
}

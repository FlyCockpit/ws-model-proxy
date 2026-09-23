import {
  type BoundedBytes,
  type CliCommandSnapshot,
  snapshotCliCommand,
  startCliCommand,
  waitCliCommand,
} from "../relay/cli-commands.js";
import type { McpRequestCredential } from "./cli-command-access.js";
import { parseCliCommandSnapshot, presentCliCommand } from "./cli-command-output.js";

type CliCommandDeps = {
  userId: string;
  signal?: AbortSignal;
  credential: McpRequestCredential;
};

export type { BoundedBytes, CliCommandSnapshot };

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
  limit: "too many commands",
  invalid_command: "command must be 1..=4096 bytes and contain no NUL",
} as const;

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
  const raw = await snapshotCliCommand(adapted.commandId, deps.userId, pat.tokenId);
  if (raw == null) throw new McpCliCommandRejectedError("not_found");
  const parsed = parseCliCommandSnapshot(raw, adapted.commandId);
  if (parsed === null) throw new McpCliCommandRejectedError("not_found");
  return presentCliCommand(parsed, adapted.progress);
}

import type { McpCommandModeName } from "./mcp-command-mode";

/** One file verdict for admission, dispatch, cancellation and summaries.
 * Read grants require both explicit opt-ins and live usable roots. The CLI
 * independently checks its startup snapshot at every operation.
 */
export type FileOpClass = "read" | "write";
export type FileToolAccess = "headless" | "supervised" | "off";

const MATRIX: Record<McpCommandModeName, Record<FileOpClass, FileToolAccess>> = {
  off: { read: "off", write: "off" },
  supervised: { read: "supervised", write: "supervised" },
  unsupervised: { read: "headless", write: "headless" },
};

export type FileReadGrant = {
  server: boolean;
  live: boolean;
  roots: boolean;
};

/** What a file op of `opClass` may do under `mode` (a missing mode counts as `off`). */
export function fileToolAccess(
  mode: McpCommandModeName | null | undefined,
  opClass: FileOpClass,
  readGrant?: FileReadGrant,
): FileToolAccess {
  if (
    opClass === "read" &&
    readGrant?.server === true &&
    readGrant.live === true &&
    readGrant.roots === true
  )
    return "headless";
  return MATRIX[mode ?? "off"][opClass];
}

/** `listCliDevices.fileTools`: what works on a device without trial calls. */
export function fileToolsSummary(
  mode: McpCommandModeName | null | undefined,
  readGrant?: FileReadGrant,
): {
  read: FileToolAccess;
  write: FileToolAccess;
} {
  return {
    read: fileToolAccess(mode, "read", readGrant),
    write: fileToolAccess(mode, "write", readGrant),
  };
}

export type FileAccessSource = "grant" | "live";

/**
 * The refusal code for a non-headless access, matching the command codes:
 * `off` is `grant_disabled` for the server grant and `feature_disabled` for
 * the CLI's own mode; `supervised` is `supervised_only`.
 */
export function fileAccessRefusal(
  access: Exclude<FileToolAccess, "headless">,
  source: FileAccessSource,
): "grant_disabled" | "feature_disabled" | "supervised_only" {
  if (access === "supervised") return "supervised_only";
  return source === "grant" ? "grant_disabled" : "feature_disabled";
}

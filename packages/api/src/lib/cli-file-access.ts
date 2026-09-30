import type { McpCommandModeName } from "./mcp-command-mode";

/**
 * The permission matrix of the MCP node file tools (#103). This is the ONE
 * place that turns a command mode into what a file tool may do; the server
 * admission, the dispatch gate, `listCliDevices.fileTools` and the downgrade
 * sweep all call it. The CLI re-checks the same table in Rust
 * (`apps/cli/src/file_relay.rs::admit`).
 *
 * The mode passed in is one source's mode: the server grant, the CLI's own
 * config (live hello), or their lowest (`lowestMcpCommandMode`).
 *
 * - `headless`: the op runs without a person.
 * - `supervised`: it needs a person's keypress on the CLI. Writes get that
 *   confirm screen in a later phase (P5) and reads need the read-only grant
 *   (P4); until then both are refused `supervised_only`.
 * - `off`: refused.
 *
 * Later phases edit their own rows: P4 the `read` row of `off`/`supervised`
 * (read grant), P5 the `write` row of `supervised`.
 */
export type FileOpClass = "read" | "write";
export type FileToolAccess = "headless" | "supervised" | "off";

const MATRIX: Record<McpCommandModeName, Record<FileOpClass, FileToolAccess>> = {
  off: { read: "off", write: "off" },
  supervised: { read: "supervised", write: "supervised" },
  unsupervised: { read: "headless", write: "headless" },
};

/** What a file op of `opClass` may do under `mode` (a missing mode counts as `off`). */
export function fileToolAccess(
  mode: McpCommandModeName | null | undefined,
  opClass: FileOpClass,
): FileToolAccess {
  return MATRIX[mode ?? "off"][opClass];
}

/** `listCliDevices.fileTools`: what works on a device without trial calls. */
export function fileToolsSummary(mode: McpCommandModeName | null | undefined): {
  read: FileToolAccess;
  write: FileToolAccess;
} {
  return { read: fileToolAccess(mode, "read"), write: fileToolAccess(mode, "write") };
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

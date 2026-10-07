/**
 * The command a runtime step runs, rendered for the person who authorizes it. Mirrors the
 * node's renderer (`apps/cli/src/runtimes/render.rs` `render`, `typed_values`, `substitute`):
 * the same `{{name}}` syntax, raw substitution (no quoting or escaping: every value is typed
 * first), the same value checks and the same refusals. The shared vectors in
 * `apps/cli/tests/fixtures/relay-3.0/rules/command-render.json` are checked by both sides
 * (`command-render.test.ts`, `render/tests.rs`).
 *
 * What only the node knows is never guessed: `fabric_ip`, `fabric_iface` and
 * `fabric_rdma_device` (from the node's own address on the fabric) stay visible as
 * `{{name}}` and are listed in `nodeFills`. Checks that need the node's own state (its port
 * range, its frozen fabric set) are left to the node: a job they refuse runs nothing. Secrets
 * reach the command as environment variables and are never substituted.
 *
 * Pure: contracts are also bundled for the browser.
 */
import { isFabricIp } from "./ip-literal";
import { RUNTIME_COMMAND_MAX_BYTES, type RuntimeCommands, type RuntimeSpec } from "./runtime-spec";
import type { StepIntent, StepJobPlaceholders } from "./step-intent";

/** Values the node derives itself on a multi-node job (never sent by the server). */
export const NODE_LOCAL_PLACEHOLDERS = ["fabric_ip", "fabric_iface", "fabric_rdma_device"] as const;
export type NodeLocalPlaceholder = (typeof NODE_LOCAL_PLACEHOLDERS)[number];

/** The shortest text the node can put in for each node-local value (for the size check). */
const NODE_LOCAL_MIN_BYTES: Record<NodeLocalPlaceholder, number> = {
  // A canonical IPv6 literal can be 3 bytes (`1::`).
  fabric_ip: 3,
  fabric_iface: 1,
  fabric_rdma_device: 1,
};

export type SubstituteResult =
  /** `kept`: one entry per node-local placeholder left as `{{name}}`, in order. */
  | { ok: true; text: string; nodeFills: NodeLocalPlaceholder[]; kept: NodeLocalPlaceholder[] }
  | { ok: false; missing: string };

function isNodeLocal(name: string): name is NodeLocalPlaceholder {
  return (NODE_LOCAL_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * Replace every `{{name}}` (`name` = one or more of `a-z` and `_`) with its value, exactly as
 * `render.rs` `substitute` does: an unterminated `{{` is kept with the rest of the text, a
 * `{{` whose name has other characters is kept and scanning resumes right after it, and a
 * placeholder without a value fails naming itself. Names in `nodeLocal` stay as `{{name}}`.
 */
export function substitute(
  text: string,
  values: ReadonlyMap<string, string>,
  nodeLocal: ReadonlySet<NodeLocalPlaceholder> = new Set(),
): SubstituteResult {
  let out = "";
  let rest = text;
  const kept: NodeLocalPlaceholder[] = [];
  const done = (tail: string): SubstituteResult => ({
    ok: true,
    text: out + tail,
    nodeFills: [...new Set(kept)],
    kept,
  });
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) return done(rest.slice(start));
    const name = after.slice(0, end);
    if (/^[a-z_]+$/.test(name)) {
      const value = values.get(name);
      if (value !== undefined) out += value;
      else if (isNodeLocal(name) && nodeLocal.has(name)) {
        out += `{{${name}}}`;
        kept.push(name);
      } else return { ok: false, missing: name };
      rest = after.slice(end + 2);
    } else {
      out += "{{";
      rest = after;
    }
  }
  return done(rest);
}

/** `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`, at most 24 characters (`render.rs` `canonical_decimal`). */
export function canonicalDecimal(value: string): boolean {
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value) && value.length <= 24;
}

export function positiveDecimal(value: string): boolean {
  return canonicalDecimal(value) && /[1-9]/.test(value);
}

/** `(0, 1]` as a canonical decimal. */
export function fraction(value: string): boolean {
  return (
    positiveDecimal(value) && (value.startsWith("0.") || value === "1" || /^1\.0+$/.test(value))
  );
}

/** A comma list of GPU indices (0–255), unique, at most 64. */
export function gpuIds(value: string): boolean {
  if (value === "") return false;
  const parts = value.split(",");
  if (parts.length > 64) return false;
  const seen = new Set<string>();
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255 || seen.has(part)) return false;
    seen.add(part);
  }
  return true;
}

export type StepCommandPhase = "PREPARE" | "START" | "AFTER_JOIN" | "STOP" | "STATUS" | "HEALTH";

/** The commands of `rank`, as the node picks them: its own entry, or the only one. */
export function rankCommands(
  launch: { commands: readonly RuntimeCommands[] },
  rank: number,
): RuntimeCommands | undefined {
  return launch.commands[rank] ?? (launch.commands.length === 1 ? launch.commands[0] : undefined);
}

/** Whether `phase` runs in an operator terminal (`render.rs` `phase_interactive`). */
function phaseInteractive(commands: RuntimeCommands, phase: StepCommandPhase): boolean {
  const flags = commands.interactive;
  if (!flags) return false;
  if (phase === "PREPARE") return flags.prepare === true;
  if (phase === "START") return flags.start === true;
  if (phase === "AFTER_JOIN") return flags.afterJoin === true;
  if (phase === "STOP") return flags.stop === true;
  return false;
}

function phaseCommand(commands: RuntimeCommands, phase: StepCommandPhase): string | undefined {
  switch (phase) {
    case "PREPARE":
      return commands.prepare;
    case "START":
      return commands.start;
    case "AFTER_JOIN":
      return commands.afterJoin;
    case "STOP":
      return commands.stop;
    case "STATUS":
      return commands.status;
    case "HEALTH":
      return commands.health;
  }
}

export type RenderedStepCommand =
  /** What the node runs; `nodeFills` are still `{{name}}` in `text` (the node fills them). */
  | { state: "ready"; text: string; nodeFills: NodeLocalPlaceholder[] }
  /** The node is expected to refuse this job (`bad_job` with this field): nothing runs. */
  | { state: "refused"; field: string }
  /**
   * The text has a `{{fabric_*}}` the node does not fill (e.g. inside `{{{fabric_ip}}`) next
   * to one it does: shown filled in, the two would look alike, so it is not shown.
   */
  | { state: "unavailable"; reason: "node_fill_ambiguous" };

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Render the command of `phase` for the job the server sends for `intent`, as the node does.
 * `fabricName` is the name of the job's fabric (`intent.fabricId`); `placeholders` are the
 * job frame's values (`stepJobPlaceholders`, with the dispatch's `head_addr`).
 */
export function renderStepCommand(input: {
  spec: RuntimeSpec;
  phase: StepCommandPhase;
  intent: StepIntent;
  placeholders: StepJobPlaceholders;
  fabricName: string | null;
}): RenderedStepCommand {
  const { spec, intent, placeholders: p } = input;
  const refused = (field: string): RenderedStepCommand => ({ state: "refused", field });
  const launch = spec.launch;
  if (!launch) return refused("runtimeId");
  // check_identity
  if (intent.nnodes !== launch.groupSize) return refused("nnodes");
  if (intent.rank >= intent.nnodes) return refused("rank");
  const commands = rankCommands(launch, intent.rank);
  if (!commands) return refused("rank");
  // Dispatch sends an operator terminal exactly for an interactive intent.
  if (phaseInteractive(commands, input.phase) !== intent.interactive) return refused("operator");

  // typed_values
  const values = new Map<string, string>();
  values.set("node_rank", String(intent.rank));
  values.set("nnodes", String(intent.nnodes));
  // The node also checks the port against its own range (unless the definition fixes it).
  const fixed = launch.port?.fixed;
  if (!(p.port >= 1024 && p.port <= 65_535 && (fixed === undefined || p.port === fixed)))
    return refused("placeholders.port");
  values.set("port", String(p.port));
  if (p.dist_port !== undefined) {
    if (p.dist_port < 1024 || p.dist_port > 65_535 || p.dist_port === p.port)
      return refused("placeholders.dist_port");
    values.set("dist_port", String(p.dist_port));
  }
  if (p.gpu_ids !== undefined) {
    if (!gpuIds(p.gpu_ids)) return refused("placeholders.gpu_ids");
    values.set("gpu_ids", p.gpu_ids);
  }
  for (const name of ["memory_gb", "vram_gb"] as const) {
    const value = p[name];
    if (value === undefined) continue;
    if (!positiveDecimal(value)) return refused(`placeholders.${name}`);
    values.set(name, value);
  }
  if (p.memory_fraction !== undefined) {
    if (!fraction(p.memory_fraction)) return refused("placeholders.memory_fraction");
    values.set("memory_fraction", p.memory_fraction);
  }
  const nodeLocal = new Set<NodeLocalPlaceholder>();
  if (intent.nnodes > 1) {
    if (!intent.fabricId || p.head_addr === undefined) return refused("fabricId");
    // The node also checks the head is a member of its (frozen) copy of the fabric.
    if (!isFabricIp(p.head_addr)) return refused("placeholders.head_addr");
    if (launch.fabric !== undefined && launch.fabric !== input.fabricName)
      return refused("fabricId");
    values.set("head_addr", p.head_addr);
    for (const name of NODE_LOCAL_PLACEHOLDERS) nodeLocal.add(name);
  } else if (p.head_addr !== undefined) {
    // A single-node job names no fabric (`stepJobFabricId`) and has no head.
    return refused("fabricId");
  }

  // render: the phase's command, then stop, status and health (each must render).
  const renderOne = (
    text: string,
    field: string,
  ):
    | { ok: true; text: string; fills: NodeLocalPlaceholder[]; ambiguous: boolean }
    | RenderedStepCommand => {
    const result = substitute(text, values, nodeLocal);
    if (!result.ok) return refused(`placeholders.${result.missing}`);
    // Smallest size the node's text can have: each kept node-local value at its shortest.
    let bytes = utf8Bytes(result.text);
    for (const name of result.kept) bytes -= utf8Bytes(`{{${name}}}`) - NODE_LOCAL_MIN_BYTES[name];
    if (bytes > RUNTIME_COMMAND_MAX_BYTES) return refused(field);
    // Shown with values the node fills, a `{{fabric_*}}` it leaves alone (literal text) would
    // look like one more: any such name with more occurrences than were kept.
    const ambiguous =
      result.kept.length > 0 &&
      NODE_LOCAL_PLACEHOLDERS.some(
        (name) =>
          result.text.split(`{{${name}}}`).length - 1 !==
          result.kept.filter((kept) => kept === name).length,
      );
    return { ok: true, text: result.text, fills: result.nodeFills, ambiguous };
  };
  const text = phaseCommand(commands, input.phase);
  const command =
    text === undefined
      ? { ok: true as const, text: "", fills: [], ambiguous: false }
      : renderOne(text, "command");
  if (!("ok" in command)) return command;
  for (const [other, field] of [
    [commands.stop, "stop"],
    [commands.status, "status"],
    [commands.health, "health"],
  ] as const) {
    if (other === undefined) continue;
    const result = renderOne(other, field);
    if (!("ok" in result)) return result;
  }
  if (command.ambiguous) return { state: "unavailable", reason: "node_fill_ambiguous" };
  return { state: "ready", text: command.text, nodeFills: command.fills };
}

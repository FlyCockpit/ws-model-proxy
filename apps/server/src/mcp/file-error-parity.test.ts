import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FILE_ERROR_CODES, FILE_WIRE_REASONS } from "../relay/file-protocol.js";

/**
 * TS/Rust file error-code parity (#159, R1B-8). Nothing here is a hand-copied
 * list: the Rust side is PARSED from its source (`apps/cli/src/file_ops/error.rs`
 * and `apps/cli/src/file_relay.rs`) and compared with the server's
 * `FILE_ERROR_CODES` / `FILE_WIRE_REASONS`, with the MCP error mapping
 * (`McpCliFileError`) and with the documented code list (`docs/mcp.md`). A code
 * added, renamed or removed on one side fails here until the other side follows.
 */

vi.mock("../relay/cli-file-ops.js", () => ({
  runFileOp: vi.fn(),
  cancelFileOpsForToken: vi.fn(),
  sweepExpiredFileOps: vi.fn(),
}));

const { McpCliFileError } = await import("./cli-file-tools.js");

const RUST_ERROR = readFileSync(
  new URL("../../../cli/src/file_ops/error.rs", import.meta.url),
  "utf8",
);
const RUST_RELAY = readFileSync(new URL("../../../cli/src/file_relay.rs", import.meta.url), "utf8");
const MCP_DOC = readFileSync(new URL("../../../../docs/mcp.md", import.meta.url), "utf8");

/** The text between the first `open` after `anchor` and its matching `close`. */
function blockAfter(source: string, anchor: string, open: string, close: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found: ${anchor}`);
  const from = source.indexOf(open, start) + open.length;
  const to = source.indexOf(close, from);
  if (from < open.length || to < 0) throw new Error(`block not closed after: ${anchor}`);
  return source.slice(from, to);
}

/** serde's `rename_all = "snake_case"` for a Rust variant name. */
function snakeCase(variant: string): string {
  return variant.replace(/[A-Z]/g, (letter, index: number) =>
    index === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`,
  );
}

const enumBody = blockAfter(RUST_ERROR, "pub enum ErrorCode", "{", "\n}");
const variants = [...enumBody.matchAll(/^\s*([A-Z][A-Za-z0-9]*),\s*$/gm)].map((match) => match[1]);
const asStrBody = blockAfter(RUST_ERROR, "pub fn as_str(self)", "match self {", "\n        }");
const arms = [...asStrBody.matchAll(/Self::([A-Za-z0-9]+)\s*=>\s*"([^"]+)"/g)].map((match) => ({
  variant: match[1],
  code: match[2],
}));

/** The string literals of a Rust `const NAME: [&str; N] = [ ... ];`. */
function rustStrArray(name: string): { declared: number; values: string[] } {
  const declaration = new RegExp(`${name}: \\[&str; (\\d+)\\] = \\[`).exec(RUST_RELAY);
  if (!declaration) throw new Error(`const not found: ${name}`);
  const body = blockAfter(RUST_RELAY, `${name}: [&str;`, "= [", "];");
  return {
    declared: Number(declaration[1]),
    values: [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string),
  };
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("file error-code parity between the Rust CLI and the TypeScript server", () => {
  it("parses a plausible Rust enum (the parser itself is not vacuous)", () => {
    expect(variants.length).toBeGreaterThanOrEqual(20);
    expect(arms.length).toBe(variants.length);
    expect(variants).toContain("UncertainOutcome");
    expect(RUST_ERROR).toMatch(/#\[serde\(rename_all = "snake_case"\)\]\s*pub enum ErrorCode/);
  });

  it("gives every Rust variant exactly one wire spelling, equal to its serde snake_case name", () => {
    expect(sorted(arms.map((arm) => arm.variant ?? ""))).toEqual(sorted(variants as string[]));
    for (const arm of arms) {
      expect(arm.code, `Rust ${arm.variant}`).toBe(snakeCase(arm.variant ?? ""));
    }
  });

  it("FILE_ERROR_CODES is exactly the Rust ErrorCode set, with no duplicates", () => {
    const rust = arms.map((arm) => arm.code);
    expect(new Set(rust).size).toBe(rust.length);
    expect(new Set(FILE_ERROR_CODES).size).toBe(FILE_ERROR_CODES.length);
    expect(sorted(FILE_ERROR_CODES)).toEqual(sorted(rust as string[]));
  });

  it("FILE_WIRE_REASONS is exactly the CLI dispatcher's wire refusal set", () => {
    const wire = rustStrArray("WIRE_REFUSAL_REASONS");
    expect(wire.values).toHaveLength(wire.declared);
    expect(sorted(FILE_WIRE_REASONS)).toEqual(sorted(wire.values));
  });

  it("every reason the CLI's refuse() can pass is a wire reason or a file error code", () => {
    const refuse = rustStrArray("REFUSE_REASONS");
    expect(refuse.values).toHaveLength(refuse.declared);
    const accepted = new Set<string>([...FILE_ERROR_CODES, ...FILE_WIRE_REASONS]);
    for (const reason of refuse.values) expect(accepted.has(reason), reason).toBe(true);
  });

  it("the wire and file code sets do not overlap", () => {
    const codes = new Set<string>(FILE_ERROR_CODES);
    for (const reason of FILE_WIRE_REASONS) expect(codes.has(reason), reason).toBe(false);
  });

  it("the MCP mapping has a distinct, non-empty message for every file error code", () => {
    const messages = new Map<string, string>();
    for (const code of FILE_ERROR_CODES) {
      const error = new McpCliFileError({ ok: false, code });
      expect(error.code).toBe(code);
      expect(error.message.length, code).toBeGreaterThan(0);
      messages.set(code, error.message);
    }
    expect(new Set(messages.values()).size).toBe(messages.size);
    // Wire refusals that pass through as `error.code` (bad_frame settles as io_error).
    for (const reason of FILE_WIRE_REASONS) {
      if (reason === "bad_frame") continue;
      const error = new McpCliFileError({ ok: false, code: reason });
      expect(error.message.length, reason).toBeGreaterThan(0);
    }
  });

  it("docs/mcp.md documents every file error code and wire refusal it lists as error.code", () => {
    for (const code of [...FILE_ERROR_CODES, ...FILE_WIRE_REASONS]) {
      expect(MCP_DOC.includes(`\`${code}\``), `docs/mcp.md is missing \`${code}\``).toBe(true);
    }
  });
});

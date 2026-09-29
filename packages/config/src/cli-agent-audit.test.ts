import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_AGENT_REJECTION_FALLBACK,
  CLI_AGENT_WIRE_REASONS,
  cliAgentWireReason,
  commandAuditPath,
  commandProgram,
  CLI_AGENT_ACTION_UNKNOWN_PROGRAM as UNKNOWN,
} from "./cli-agent-audit";

describe("cliAgentWireReason", () => {
  it("accepts every reason the CLI may put on the wire, unchanged", () => {
    for (const code of CLI_AGENT_WIRE_REASONS) {
      expect(cliAgentWireReason(code)).toBe(code);
    }
  });

  // The list above iterates itself, so any edit to it passes the test above.
  // This guard derives the expected set from the Rust source, the only place
  // that constructs these codes: a conforming CLI's reason must survive the
  // whitelist, and the Rust constants are the ground truth for which codes
  // exist. Mutating one side without the other fails here.
  it("matches the CLI's REASON_* constants exactly", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../apps/cli/src/sessions.rs", import.meta.url)),
      "utf8",
    );
    const declared = [...source.matchAll(/^const REASON_[A-Z0-9_]+: &str = "([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(10);
    expect([...CLI_AGENT_WIRE_REASONS].sort()).toEqual(declared.sort());
  });

  it.each([
    // Adversarial: the wire accepts any 1..64-character string.
    ["an unknown wire string", "unknown-code-9f3a"],
    ["free text", "no shell!"],
    ["a case-mismatched code", "BAD_COMMAND"],
    ["a code with surrounding spaces", " bad_command"],
    ["a path", "/etc/shadow"],
    ["an empty string", ""],
    ["a NUL-bearing string", "bad_command\0"],
    ["a very long string", "x".repeat(64)],
    ["the fallback itself", CLI_AGENT_REJECTION_FALLBACK],
  ])("maps %s to the fallback", (_name, reason) => {
    expect(cliAgentWireReason(reason)).toBe(CLI_AGENT_REJECTION_FALLBACK);
  });

  it("keeps the fallback inside the machine-code charset", () => {
    expect(CLI_AGENT_REJECTION_FALLBACK).toMatch(/^[A-Za-z0-9_:.-]+$/);
  });
});

describe("commandProgram", () => {
  // Adversarial table: every row must yield exactly the program, never any
  // argument text, a secret, a quote or an unparsable fragment.
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["a leading secret assignment is skipped", "FOO=secret curl https://x", "curl"],
    ["an absolute path is reduced to its basename", "/usr/bin/git push", "git"],
    ["a wrapper is stored by its own name", "sudo rm -rf x", "sudo"],
    ["env is not unwrapped", "env A=1 ls", "env"],
    ["a plain command", "echo hf_abc", "echo"],
    [
      "an sk- token arg is not the program",
      "curl -H 'Authorization: Bearer sk-abc123' https://x",
      "curl",
    ],
    ["nothing at all", "", UNKNOWN],
    ["whitespace only", "   \t\n  ", UNKNOWN],
    ["only assignments", "A=b", UNKNOWN],
    ["two assignments then a program", "A=b C=d prog", "prog"],
    ["a NUL in the program", "bad\0cmd", UNKNOWN],
    ["a control char in the program", "bad\u0007cmd", UNKNOWN],
    ["unicode in the program", "\u00e9cho hi", UNKNOWN],
    ["an overlong name (65)", `${"a".repeat(65)} x`, UNKNOWN],
    ["a name of exactly 64", `${"a".repeat(64)} x`, "a".repeat(64)],
    ["leading whitespace and tabs", "\t  /bin/ls", "ls"],
    ["a newline before the program", "\n\npython -c x", "python"],
    ["single quotes around the program", "'/bin/ls' x", "ls"],
    ["a quoted program containing a space", "'my tool' x", UNKNOWN],
    ["a relative script", "./run.sh", "run.sh"],
    ["a path with a trailing slash", "/usr/bin/", UNKNOWN],
    ["a quoted assignment value with a space does not leak", 'FOO="a b" curl', "curl"],
    ["an assignment-looking invalid name is a candidate", "1A=b", UNKNOWN],
    ["a dashed assignment-looking name is a candidate", "a-b=c", UNKNOWN],
    ["a leading long flag is not a program", "--api-key x", UNKNOWN],
    ["a here-string first line", "<<< hello", UNKNOWN],
    ["a heredoc marker first line", "cat <<EOF", "cat"],
    ["the unknown sentinel itself as input", "?", UNKNOWN],
    ["exec is stored as a wrapper", "exec ls", "exec"],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(commandProgram(input)).toBe(expected);
  });

  it("returns the unknown program for non-string and non-well-formed input", () => {
    expect(commandProgram(undefined)).toBe(UNKNOWN);
    expect(commandProgram(null)).toBe(UNKNOWN);
    expect(commandProgram(42)).toBe(UNKNOWN);
    // A lone surrogate cannot match the ASCII program charset.
    expect(commandProgram("\uD800")).toBe(UNKNOWN);
  });

  it("never returns anything outside the accepted shape for adversarial rows", () => {
    for (const [, input, expected] of rows) {
      expect(expected).toMatch(/^(?:\?|[A-Za-z0-9._+-]{1,64})$/);
      expect(commandProgram(input)).toMatch(/^(?:\?|[A-Za-z0-9._+-]{1,64})$/);
    }
  });
});

describe("commandAuditPath", () => {
  const hex = (text: string) => `H<${[...text].length}>`;

  it("hashes the well-formed command text, not a mask, plus the program", () => {
    expect(commandAuditPath("curl --api-key sk-secret-9 https://x", hex)).toMatch(
      /^sha256:H<36> curl$/,
    );
  });

  it("hashes the command text as given and fails the program closed on NUL", () => {
    expect(commandAuditPath("ls\0x", hex)).toBe("sha256:H<4> ?");
  });

  it("stores no argument text for any adversarial command", () => {
    const commands = [
      "FOO=secret curl https://x",
      "curl -H 'Authorization: Bearer sk-abc123' https://secret.example",
      "mysqldump --password hunter2 production",
    ];
    for (const command of commands) {
      const path = commandAuditPath(command, hex);
      for (const secret of ["secret", "hunter2", "sk-abc123", "https://x", "secret.example"]) {
        if (command.includes(secret) && !command.startsWith(secret))
          expect(path, `${command} leaks ${secret}`).not.toContain(secret);
      }
      expect(path.split(" ").slice(1).join(" ")).toMatch(/^(?:\?|[A-Za-z0-9._+-]{1,64})$/);
    }
  });
});

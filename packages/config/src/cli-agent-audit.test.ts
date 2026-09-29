import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_AGENT_REJECTION_FALLBACK,
  CLI_AGENT_WIRE_REASONS,
  cliAgentSignalReason,
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

describe("cliAgentSignalReason", () => {
  it.each([
    ["SIGKILL", "signal:SIGKILL"],
    ["SIGTERM", "signal:SIGTERM"],
    ["kill", "signal:kill"],
    ["9", "signal:9"],
    ["64", "signal:64"],
    ["AUDIT_MARKER", "signal:unknown"],
    ["sk-abc123secret", "signal:unknown"],
    ["0", "signal:unknown"],
    ["65", "signal:unknown"],
    ["09", "signal:unknown"],
    ["SIG", "signal:unknown"],
    ["", "signal:unknown"],
    ["SIGKILL.x", "signal:unknown"],
  ])("maps %s to %s", (input, expected) => {
    expect(cliAgentSignalReason(input)).toBe(expected);
  });
});

describe("commandProgram", () => {
  // Adversarial table: every row must yield exactly the program, never any
  // argument text, a secret, a quote or an unparsable fragment.
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["a leading secret assignment is skipped", "FOO=secret curl https://x", "curl"],
    ["an underscore-leading assignment is skipped", "_TOKEN=abc tool arg", "tool"],
    ["a one-character program is accepted", "x arg", "x"],
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
    ["an unterminated double quote fails closed", '"echo', UNKNOWN],
    ["an unterminated single quote fails closed", "'ls", UNKNOWN],
    ["a quoted program containing a space", "'my tool' x", UNKNOWN],
    ["a relative script", "./run.sh", "run.sh"],
    ["a path with a trailing slash", "/usr/bin/", UNKNOWN],
    ["a quoted assignment value with a space fails closed", 'FOO="a b" curl', UNKNOWN],
    ["a plain assignment with path-ish value is skipped", "A=/x/y:z@1.2,3+4=5 prog", "prog"],
    ["an empty assignment value is skipped", "A= prog", "prog"],
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

  // C1b-1: a shell word can keep whitespace inside ONE assignment value, so a
  // later piece of the secret must never be stored as the program.
  const secretFragmentRows: ReadonlyArray<readonly [string, string, string]> = [
    ["escaped space", "PASSWORD=correct\\ horsebattery mysql", "horsebattery"],
    [
      "escaped quote in a double-quoted value",
      'PASSWORD="pa\\"ss secretword x" mysql',
      "secretword",
    ],
    ["parameter expansion default", "PASS=$" + "{D:-my secretpw x} mysql", "secretpw"],
    ["command substitution", "PASS=$(printf hunter2word x) mysql", "hunter2word"],
    ["backtick substitution", "PASS=`printf hunter2tick x` mysql", "hunter2tick"],
    ["array assignment", "KEYS=(aaakey bbbkey ccc) prog", "bbbkey"],
    ["carriage return in the value", "PASS=abc\rsecretcr prog", "secretcr"],
    ["backslash-newline in the value", "PASS=abc\\\nsecretnl prog", "secretnl"],
    ["single-quoted value with spaces", "PASS='top secretpiece x' prog", "secretpiece"],
    ["unicode space in the value", "PASS=abc\u00a0secretnb prog", "secretnb"],
    ["vertical tab in the value", "PASS=abc\vsecretvt prog", "secretvt"],
    ["semicolon then a word", "PASS=abc;secretsemi prog", "secretsemi"],
    ["arithmetic expansion", "PASS=$((1 + secretar)) prog", "secretar"],
  ];
  it.each(secretFragmentRows)(
    "never stores a fragment of an assignment value: %s",
    (_n, input, fragment) => {
      const program = commandProgram(input);
      expect(program).toBe(UNKNOWN);
      expect(program).not.toContain(fragment);
      expect(commandAuditPath(input, () => "H")).toBe("hmac-sha256:H ?");
    },
  );

  // C2b-1: a leading redirection or slash-bearing flag is not a program; its
  // last path segment must never be stored.
  const leadingWordRows: ReadonlyArray<readonly [string, string, string]> = [
    ["stderr redirection", "2>/tmp/hunter2 ls", "hunter2"],
    ["input redirection", "</run/secrets/ghp_notreal0000 psql", "ghp_notreal0000"],
    ["output redirection", ">/run/secrets/db_password cat", "db_password"],
    ["and-redirect", "&>/var/log/SeCrEt.txt make", "SeCrEt.txt"],
    ["append redirection", "1>>/x/y/token-abc cmd", "token-abc"],
    ["short flag with attached path", "-p/tmp/hunter2 x", "hunter2"],
    ["long flag with equals path", "--config=/etc/secretfile run", "secretfile"],
    ["invalid assignment name with path", "1FOO=/x/hunter2 cmd", "hunter2"],
    ["expansion prefix", "$HOME/bin/tool", "tool"],
    ["tilde prefix", "~/bin/tool", "tool"],
    ["braced expansion prefix", "$" + "{X}/tool", "tool"],
  ];
  it.each(leadingWordRows)(
    "never stores a fragment of a leading non-program word: %s",
    (_n, input, fragment) => {
      const program = commandProgram(input);
      expect(program).toBe(UNKNOWN);
      expect(program).not.toContain(fragment);
    },
  );

  // C3b-1: only sh's own leading blanks and newlines are trimmed; any other
  // leading whitespace character is part of the first shell word, so the word
  // after it is an argument.
  it.each([
    "\r",
    "\v",
    "\f",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u200a",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
  ])("does not trim leading %j: the next word is an argument", (character) => {
    expect(commandProgram(`${character} /home/u/hunter2Secret`)).toBe(UNKNOWN);
    expect(commandProgram(`${character}/home/u/hunter2Secret`)).toBe(UNKNOWN);
  });

  it("trims leading blanks and newlines like sh", () => {
    expect(commandProgram(" \t\n\n /usr/bin/git push")).toBe("git");
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

  it("uses the keyed-hash prefix and hashes the well-formed text plus the program", () => {
    expect(commandAuditPath("curl --api-key sk-secret-9 https://x", hex)).toMatch(
      /^hmac-sha256:H<36> curl$/,
    );
  });

  it("hashes the command text as given and fails the program closed on NUL", () => {
    expect(commandAuditPath("ls\0x", hex)).toBe("hmac-sha256:H<4> ?");
  });

  it("stores the injected digest verbatim, never a plain sha256 label", () => {
    const path = commandAuditPath("pwd", () => "unavailable");
    expect(path).toBe("hmac-sha256:unavailable pwd");
    expect(path.startsWith("sha256:")).toBe(false);
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

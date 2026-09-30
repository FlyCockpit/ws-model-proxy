import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_AGENT_PROGRAM_ALLOWLIST,
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
  // Table-driven and adversarial. Every result is an allowlist member or `?`;
  // no row may put argument text, an assignment or a fragment of one in the row.
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    // allowlisted, plain
    ["a plain allowlisted command", "git status", "git"],
    ["a hyphenated allowlisted name", "llama-server --port 1", "llama-server"],
    ["a digit name", "python3 x.py", "python3"],
    ["leading spaces and tabs are skipped", " \t  git push", "git"],
    ["case is folded", "GIT status", "git"],
    ["mixed case", "NvIdIa-Smi", "nvidia-smi"],
    // wrappers: the wrapper only
    ["sudo is stored, not unwrapped", "sudo rm -rf x", "sudo"],
    ["env is stored, not unwrapped", "env A=1 ls", "env"],
    ["nohup", "nohup make &", "nohup"],
    ["time", "time cargo build", "time"],
    ["exec", "exec ls", "exec"],
    // assignments skipped
    ["one assignment", "FOO=1 make", "make"],
    ["an underscore-led assignment", "_X=abc git push", "git"],
    ["several assignments", "A=1 B=two C=/x/y:z@1.2,3+4 cargo test", "cargo"],
    ["an equals sign inside a value is not plain", "A=b=c git", UNKNOWN],
    ["an empty value", "A= git status", "git"],
    ["a double-quoted value with a space", 'FOO="a b" curl x', "curl"],
    ["a single-quoted value with a space", "FOO='a b' curl x", "curl"],
    ["an assignment whose value equals an allowlisted name", "A=git make", "make"],
    ["an assignment carrying a token-shaped value", "TOKEN=abcdefghijklmnop0123 ls", "ls"],
    ["only assignments", "A=b", UNKNOWN],
    ["assignments then an unknown program", "A=b C=d prog", UNKNOWN],
    // paths and quotes
    ["an absolute path", "/usr/bin/git push", "git"],
    ["a relative path", "./git x", "git"],
    ["a parent-relative path", "../bin/make", "make"],
    ["a tilde path", "~/bin/rg pat", "rg"],
    ["double quotes", '"python3" x.py', "python3"],
    ["single quotes", "'git' status", "git"],
    ["a quoted path", '"/usr/bin/git" status', "git"],
    ["assignment, quotes and a path together", 'X=1 "/usr/local/bin/Cargo" build', "cargo"],
    ["a trailing slash", "/usr/bin/git/", UNKNOWN],
    ["a path to an unknown program", "/opt/x/tool run", UNKNOWN],
    ["two quote layers", `"'git'" x`, UNKNOWN],
    ["a mismatched quote", `"git' x`, UNKNOWN],
    ["an unterminated quote", '"git', UNKNOWN],
    ["a quote closing early", '"git"x status', UNKNOWN],
    ["a quoted word with a space", "'git status'", UNKNOWN],
    ["a Windows path", "C:\\bin\\git.exe status", UNKNOWN],
    ["an exe suffix is not the allowlisted name", "git.exe status", UNKNOWN],
    // adversarial leading words
    ["an unknown program", "mytool --x", UNKNOWN],
    ["a secret-looking first word", "abcdefghij0123456789 git", UNKNOWN],
    ["a token-looking word before an allowlisted one", "notasecret-abc123 git push", UNKNOWN],
    ["an allowlisted name in argument position", "mytool git", UNKNOWN],
    ["a flag", "--git x", UNKNOWN],
    ["a dashed path", "-x/bin/git run", UNKNOWN],
    ["a tab ends the word", "git\tstatus", "git"],
    ["a short flag", "-git x", UNKNOWN],
    ["a flag with a path", "--config=/etc/git run", UNKNOWN],
    ["an invalid assignment name with a path", "1FOO=/x/git cmd", UNKNOWN],
    ["a redirection prefix", "2>/tmp/git ls", UNKNOWN],
    ["an input redirection prefix", "</run/x/git psql", UNKNOWN],
    ["an and-redirect prefix", "&>/var/log/git make", UNKNOWN],
    ["an expansion prefix", "$HOME/bin/git", UNKNOWN],
    ["a braced expansion prefix", "$" + "{X}/git", UNKNOWN],
    ["a substitution", "$(git) x", UNKNOWN],
    ["a backtick", "`git` x", UNKNOWN],
    ["a here-string", "<<< git", UNKNOWN],
    ["a semicolon", "git;ls", UNKNOWN],
    ["a pipe glued on", "git|cat", UNKNOWN],
    ["an ampersand glued on", "git&", UNKNOWN],
    ["a plus", "g++ x", UNKNOWN],
    ["the sentinel as input", "?", UNKNOWN],
    // assignments that are not plain never get skipped
    ["an escaped space in a value", "P=a\\ git make", UNKNOWN],
    ["a command substitution value", "P=$(x y) git", UNKNOWN],
    ["a backtick value", "P=`x y` git", UNKNOWN],
    ["a parameter expansion value", "P=$" + "{D:-a b} git", UNKNOWN],
    ["an array value", "P=(a b) git", UNKNOWN],
    ["an escaped quote in a double-quoted value", 'P="a\\"b c" git', UNKNOWN],
    ["an expansion in a double-quoted value", 'P="$X y" git', UNKNOWN],
    ["a quote glued to a plain value", 'P=a"b c" git', UNKNOWN],
    ["an unterminated quoted value", 'P="a git', UNKNOWN],
    ["a digit-led assignment name", "1FOO=x git", UNKNOWN],
    ["a dashed assignment name", "a-b=c git", UNKNOWN],
    ["a bare dollar in an unquoted value", "P=$X git", UNKNOWN],
    ["a backtick in an unquoted value", "P=`x` git", UNKNOWN],
    ["a backslash in a single-quoted value", "P='a\\b' git", UNKNOWN],
    ["a backslash in a double-quoted value", 'P="a\\b" git', UNKNOWN],
    ["a backtick in a double-quoted value", 'P="a`b" git', UNKNOWN],
    ["a backslash in the program word", "a\\b/git x", UNKNOWN],
    ["a newline in a quoted value", 'P="a\nb" git', UNKNOWN],
    ["a carriage return in a value", "P=a\rgit git", UNKNOWN],
    ["a semicolon in a value", "P=a;git git", UNKNOWN],
    ["a unicode space in a value", "P=a\u00a0git git", UNKNOWN],
    // empty and whitespace
    ["nothing at all", "", UNKNOWN],
    ["whitespace only", "   \t  ", UNKNOWN],
    ["a leading newline", "\ngit status", UNKNOWN],
    ["a leading carriage return", "\rgit status", UNKNOWN],
    ["a leading vertical tab", "\vgit status", UNKNOWN],
    // charset attacks
    ["a NUL in the name", "gi\0t x", UNKNOWN],
    ["a control character in the name", "git\u0007 x", UNKNOWN],
    ["a NUL after the name", "git\0 x", UNKNOWN],
    ["a Cyrillic look-alike", "g\u0456t x", UNKNOWN],
    ["a fullwidth look-alike", "\uff47\uff49\uff54 x", UNKNOWN],
    ["a dotless-i look-alike lowercasing to ASCII", "G\u0130T x", UNKNOWN],
    ["the Kelvin sign lowercasing to k", "\u212Aubectl x", UNKNOWN],
    ["a long-s look-alike", "\u017Fh x", UNKNOWN],
    ["a zero-width joiner inside", "g\u200bit x", UNKNOWN],
    ["a soft hyphen inside", "g\u00adit x", UNKNOWN],
    ["a right-to-left override", "\u202egit x", UNKNOWN],
    ["a lone surrogate", "\uD800 x", UNKNOWN],
    // overlong
    ["an overlong word", `${"a".repeat(100_000)} git`, UNKNOWN],
    ["an overlong path ending in an allowlisted name", `/${"a/".repeat(5000)}git x`, UNKNOWN],
    ["an overlong assignment value", `A=${"b".repeat(100_000)} git`, "git"],
    ["an overlong quoted assignment value", `A="${"b ".repeat(50_000)}" git`, "git"],
    ["too many assignments", `${"A=1 ".repeat(33)}git`, UNKNOWN],
    ["exactly the assignment cap", `${"A=1 ".repeat(32)}git`, "git"],
    ["an overlong non-word", `${"\u00e9".repeat(100_000)} git`, UNKNOWN],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(commandProgram(input)).toBe(expected);
  });

  it("returns the unknown program for non-string input", () => {
    expect(commandProgram(undefined)).toBe(UNKNOWN);
    expect(commandProgram(null)).toBe(UNKNOWN);
    expect(commandProgram(42)).toBe(UNKNOWN);
    expect(commandProgram({})).toBe(UNKNOWN);
  });

  it("keeps the allowlist lowercase, charset-safe, and holding the owner's names", () => {
    for (const name of CLI_AGENT_PROGRAM_ALLOWLIST) {
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    for (const name of [
      "git",
      "curl",
      "wget",
      "make",
      "cmake",
      "cargo",
      "rustc",
      "go",
      "python",
      "python3",
      "pip",
      "pip3",
      "node",
      "npm",
      "npx",
      "pnpm",
      "yarn",
      "bun",
      "deno",
      "docker",
      "podman",
      "kubectl",
      "helm",
      "terraform",
      "ssh",
      "scp",
      "rsync",
      "tar",
      "zip",
      "unzip",
      "ls",
      "cat",
      "grep",
      "rg",
      "find",
      "sed",
      "awk",
      "jq",
      "systemctl",
      "journalctl",
      "sudo",
      "env",
      "bash",
      "sh",
      "zsh",
      "llama-server",
      "ollama",
      "vllm",
      "nvidia-smi",
      "nohup",
      "time",
      "exec",
    ]) {
      expect(CLI_AGENT_PROGRAM_ALLOWLIST.has(name), name).toBe(true);
    }
  });

  // Property-style: over every row and a generated corpus of hostile strings,
  // a stored program is an allowlist member or `?`, and the audit path ends
  // with exactly that, never any part of the input that is not the program.
  it("stores only an allowlist member or ? for every input", () => {
    const alphabet = [
      "git",
      "make",
      "sudo",
      "A=",
      "B=x",
      " ",
      "\t",
      "\n",
      "'",
      '"',
      "/",
      "\\",
      "$",
      "`",
      "(",
      ")",
      ";",
      "|",
      "&",
      "<",
      ">",
      "-",
      "=",
      ".",
      "~",
      "\0",
      "\u00e9",
      "\u212A",
      "secretvalue",
      "?",
    ];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const corpus = rows.map((row) => row[1]);
    for (let n = 0; n < 5000; n++) {
      let input = "";
      for (let k = 1 + (next() % 8); k > 0; k--) input += alphabet[next() % alphabet.length];
      corpus.push(input);
    }
    for (const input of corpus) {
      const program = commandProgram(input);
      expect(program === UNKNOWN || CLI_AGENT_PROGRAM_ALLOWLIST.has(program), input).toBe(true);
      const path = commandAuditPath(input, () => "H");
      expect(path).toBe(`hmac-sha256:H ${program}`);
      expect(program).not.toContain("secretvalue");
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

  it("stores ? as the program of a truncated command", () => {
    expect(commandAuditPath("git status", hex, { truncated: true })).toBe("hmac-sha256:H<10> ?");
    expect(commandAuditPath("git status", hex)).toBe("hmac-sha256:H<10> git");
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
      const program = path.split(" ").slice(1).join(" ");
      expect(program === UNKNOWN || CLI_AGENT_PROGRAM_ALLOWLIST.has(program)).toBe(true);
    }
  });
});

/**
 * `/install.ps1` rendering and behavior. The script parses under every PowerShell found here; on
 * Windows it also runs against a local fixture release, with `Invoke-WebRequest` replaced by a
 * function that copies from it, so nothing touches the network.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com", NODE_ENV: "test", WMP_RATE_LIMIT_SCALE: 1 },
}));
vi.mock("@ws-model-proxy/api/nodes/enroll-exchange", () => ({
  exchangeEnrollmentCode: vi.fn(),
  findEnrollmentCodeOwner: vi.fn(),
}));

const { CLI_PREVIEW_BRANCH, CLI_WINDOWS_TARGET, cliInstallSource, windowsInstallScript } =
  await import("./node-http.js");
const { SERVER_VERSION } = await import("./version.js");

const ORIGIN = "https://proxy.example.com";
const REV = "0123456789abcdef0123456789abcdef01234567";
const RELEASE = "https://releases.example.com/wsmp/v0.4.0";

/** The PowerShells on this machine. */
const shells = ["pwsh", "powershell"].filter(
  (shell) => spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0,
);
const windowsShells = process.platform === "win32" ? shells : [];
/** A small program that exits 0 on `--version`, standing in for the release's wsmp.exe. */
const stubExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");

function run(shell: string, script: string) {
  return spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
}

/** A single-quoted PowerShell string. */
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Each PowerShell start takes a second or more. */
const SLOW = { timeout: 120_000 };

describe("install.ps1 rendering", () => {
  it("installs the release, then builds this version's tag where it does not run", () => {
    const text = windowsInstallScript(ORIGIN, { kind: "release", baseUrl: `${RELEASE}/` });
    expect(text).toContain(`$WsmpReleaseUrl = '${RELEASE}'`);
    expect(text).toContain(`$WsmpTarget = '${CLI_WINDOWS_TARGET}'`);
    expect(text).toContain(`$WsmpSourceArgs = @('--tag', 'v${SERVER_VERSION}')`);
    expect(text).toContain(`irm ${ORIGIN}/install.ps1 | iex`);
    expect(text).not.toContain("--branch");
    // A failure never closes the window it runs in.
    expect(text).not.toMatch(/^\s*exit\b/m);
  });

  it("writes the install receipt into the state directory wsmp uses", () => {
    const text = windowsInstallScript(ORIGIN, { kind: "release", baseUrl: RELEASE });
    // apps/cli/src/paths.rs state_dir: WSMP_STATE_DIR, XDG_STATE_HOME, then %LOCALAPPDATA%.
    expect(text).toContain("$env:WSMP_STATE_DIR");
    expect(text).toContain("Join-Path $env:XDG_STATE_HOME 'ws-model-proxy'");
    expect(text).toContain("[Environment]::GetFolderPath('LocalApplicationData')");
    expect(text).toContain("$receiptMethod = 'script-ps1'");
    expect(text).toContain("Join-Path $state 'install.json'");
    expect(text).toContain("Write-WsmpReceipt $receiptMethod $receiptTarget $installed");
    const rev = "0123456789abcdef0123456789abcdef01234567";
    expect(windowsInstallScript(ORIGIN, { kind: "source", rev })).toContain(
      `$WsmpSourceRev = '${rev}'`,
    );
  });

  it("builds from source without a release", () => {
    expect(windowsInstallScript(ORIGIN, { kind: "source" })).toContain(
      `$WsmpSourceArgs = @('--branch', '${CLI_PREVIEW_BRANCH}')`,
    );
    const pinned = windowsInstallScript(ORIGIN, { kind: "source", rev: REV });
    expect(pinned).toContain("$WsmpReleaseUrl = ''");
    expect(pinned).toContain(`$WsmpSourceArgs = @('--rev', '${REV}')`);
  });

  it("downloads a target cargo-dist builds", () => {
    const dist = readFileSync(
      join(import.meta.dirname, "../../../apps/cli/dist-workspace.toml"),
      "utf8",
    );
    expect(/^targets = \[(.*)\]$/m.exec(dist)?.[1] ?? "").toContain(`"${CLI_WINDOWS_TARGET}"`);
  });

  it("refuses to embed a value that could leave its quotes", () => {
    for (const baseUrl of [
      "https://x.example/'; Remove-Item ~; '",
      "https://x.example/$(id)",
      "a b",
    ]) {
      expect(() => windowsInstallScript(ORIGIN, { kind: "release", baseUrl })).toThrow(/refusing/);
    }
  });

  it.skipIf(shells.length === 0)("parses in every PowerShell here", SLOW, () => {
    const dir = mkdtempSync(join(tmpdir(), "wsmp-ps1-"));
    for (const source of [
      cliInstallSource(undefined, undefined, true),
      cliInstallSource(undefined, undefined, false),
      cliInstallSource(REV, undefined),
    ]) {
      const file = join(dir, "install.ps1");
      writeFileSync(file, windowsInstallScript(ORIGIN, source));
      for (const shell of shells) {
        const parsed = run(
          shell,
          `$null = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath ${quoted(file)}))`,
        );
        expect(parsed.status, `${shell}: ${parsed.stderr}`).toBe(0);
      }
    }
  });
});

describe.each(existsSync(stubExe) ? windowsShells : [])(
  "install.ps1 on Windows (%s)",
  (windowsShell) => {
    /** A release directory holding the zip and its `sha256.sum`. */
    function release(sums: (sum: string, archive: string) => string): string {
      const dir = mkdtempSync(join(tmpdir(), "wsmp-ps1-release-"));
      const staged = join(dir, "staged");
      mkdirSync(staged);
      copyFileSync(stubExe, join(staged, "wsmp.exe"));
      const archive = `wsmp-${CLI_WINDOWS_TARGET}.zip`;
      const zipped = run(
        windowsShell,
        `Compress-Archive -Path ${quoted(join(staged, "wsmp.exe"))} -DestinationPath ${quoted(join(dir, archive))}`,
      );
      expect(zipped.status, zipped.stderr).toBe(0);
      const sum = createHash("sha256")
        .update(readFileSync(join(dir, archive)))
        .digest("hex");
      writeFileSync(join(dir, "sha256.sum"), sums(sum, archive));
      return dir;
    }

    /** Runs the script with downloads served from `fixture`, then `after` on the same line. */
    function install(fixture: string, after = "") {
      const home = mkdtempSync(join(tmpdir(), "wsmp-ps1-home-"));
      const file = join(home, "install.ps1");
      writeFileSync(
        file,
        windowsInstallScript(ORIGIN, {
          kind: "release",
          baseUrl: "https://releases.example.com/v",
        }),
      );
      const result = run(
        windowsShell,
        [
          "function Invoke-WebRequest { param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)",
          `  Copy-Item -LiteralPath (Join-Path ${quoted(fixture)} (Split-Path -Leaf $Uri)) -Destination $OutFile }`,
          `$env:CARGO_HOME = ${quoted(join(home, "cargo"))}`,
          `$env:PROCESSOR_ARCHITECTURE = 'AMD64'`,
          `Get-Content -Raw -LiteralPath ${quoted(file)} | iex; ${after}`,
        ].join("\n"),
      );
      return { result, installed: join(home, "cargo", "bin", "wsmp.exe") };
    }

    it("installs the checksummed binary into cargo's bin directory", SLOW, () => {
      const { result, installed } = install(
        release((sum, archive) => `${sum}  ${archive}\n`),
        "'after ran'",
      );
      expect(result.stdout).toContain("wsmp: checksum verified");
      expect(result.stdout).toContain(`wsmp: installed ${installed}.`);
      expect(result.stdout).toContain("after ran");
      expect(readFileSync(installed)).toEqual(readFileSync(stubExe));
    });

    it("refuses a mismatched or missing checksum, and stops the rest of the line", SLOW, () => {
      for (const sums of [
        (_sum: string, archive: string) => `${"0".repeat(64)}  ${archive}\n`,
        (sum: string) => `${sum}  wsmp-other.zip\n`,
      ]) {
        const { result, installed } = install(release(sums), "'after ran'");
        expect(result.stdout + result.stderr).toMatch(/checksum (mismatch|for)/);
        expect(result.stdout).not.toContain("after ran");
        expect(existsSync(installed)).toBe(false);
      }
    });
  },
);

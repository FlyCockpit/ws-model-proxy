/**
 * `/install.sh` rendering and behavior. The rendered script runs under `sh` (and `dash` where it
 * is installed) against stub `curl`, `uname`, `getconf` and `cargo` commands and a local fixture
 * release, so nothing touches the network or a real toolchain.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com", NODE_ENV: "test", WMP_RATE_LIMIT_SCALE: 1 },
}));
vi.mock("@ws-model-proxy/api/nodes/enroll-exchange", () => ({
  exchangeEnrollmentCode: vi.fn(),
  findEnrollmentCodeOwner: vi.fn(),
}));

const {
  CLI_RELEASE_TARGETS,
  CLI_REPOSITORY,
  SERVER_VERSION,
  cliInstallSource,
  defaultCliReleaseBaseUrl,
  installScript,
} = await import("./node-http.js");

const ORIGIN = "https://proxy.example.com";
const REV = "0123456789abcdef0123456789abcdef01234567";
const RELEASE = "https://releases.example.com/wsmp/v0.4.0";
const repoRoot = join(import.meta.dirname, "../../..");

function has(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

describe("install.sh rendering", () => {
  it("defaults to this version's GitHub Release and pins source builds to a commit", () => {
    expect(cliInstallSource(undefined, undefined)).toEqual({
      kind: "release",
      baseUrl: `${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}`,
    });
    expect(cliInstallSource(undefined, RELEASE)).toEqual({ kind: "release", baseUrl: RELEASE });
    // A pinned commit always builds from source, whatever the release URL says.
    expect(cliInstallSource(REV, RELEASE)).toEqual({ kind: "source", rev: REV });
  });

  it("renders a source-only script for a pinned commit", () => {
    const text = installScript(ORIGIN, { kind: "source", rev: REV });
    expect(text).toContain("WSMP_RELEASE_URL=''");
    expect(text).toContain(`install_source --rev '${REV}'`);
    expect(text).not.toContain("install_source --tag");
    expect(text).not.toContain("--branch");
  });

  it("falls back to this version's tag, never a branch, where no binary fits", () => {
    const text = installScript(ORIGIN, { kind: "release", baseUrl: `${RELEASE}/` });
    expect(text).toContain(`WSMP_RELEASE_URL='${RELEASE}'`);
    expect(text).toContain(`install_source --tag 'v${SERVER_VERSION}'`);
    expect(text).not.toContain("--branch");
  });

  it("refuses to embed a value that could leave its quotes", () => {
    for (const baseUrl of ["https://x.example/'; rm -rf ~; '", "https://x.example/$(id)", "a b"]) {
      expect(() => installScript(ORIGIN, { kind: "release", baseUrl })).toThrow(/refusing/);
    }
  });

  it("parses as POSIX sh", () => {
    for (const source of [
      cliInstallSource(undefined, undefined),
      cliInstallSource(REV, undefined),
    ]) {
      for (const [shell, ...args] of [["sh"], ["dash"], ["bash", "--posix"], ["busybox", "sh"]]) {
        if (shell && has(shell)) {
          execFileSync(shell, [...args, "-n"], { input: installScript(ORIGIN, source) });
        }
      }
    }
  });

  it("matches the CLI version and the targets cargo-dist builds", () => {
    const cargo = readFileSync(join(repoRoot, "apps/cli/Cargo.toml"), "utf8");
    expect(cargo).toMatch(
      new RegExp(`^version = "${SERVER_VERSION.replaceAll(".", "\\.")}"$`, "m"),
    );
    const dist = readFileSync(join(repoRoot, "apps/cli/dist-workspace.toml"), "utf8");
    const targets = /^targets = \[(.*)\]$/m.exec(dist)?.[1] ?? "";
    for (const target of CLI_RELEASE_TARGETS) expect(targets).toContain(`"${target}"`);
    expect(dist).not.toMatch(/unix-archive/); // the installer expects the default .tar.xz
    expect(defaultCliReleaseBaseUrl()).toBe(
      "https://github.com/FlyCockpit/ws-model-proxy/releases/download/v0.4.0",
    );
  });
});

type Machine = { os?: string; arch?: string; glibc?: string | null; appleSilicon?: boolean };
type Fixture = {
  sums?: (sum: string, archive: string) => string | null;
  corrupt?: boolean;
  /** The archive's target (default x86_64 Linux). */
  target?: string;
  /** What the archive holds at wsmp-<target>/wsmp. */
  binary?: "ok" | "missing";
};

const work = mkdtempSync(join(tmpdir(), "wsmp-install-test-"));
afterAll(() => {
  execFileSync("rm", ["-rf", work]);
});

let runs = 0;
/** Runs the rendered script in a fresh HOME with stub commands; returns output and what ran. */
function run(
  script: string,
  machine: Machine = {},
  fixture: Fixture = {},
  shell = "sh",
  prepare: (home: string) => void = () => {},
) {
  const dir = join(work, `run-${++runs}`);
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  const release = join(dir, "release");
  const log = join(dir, "log");
  for (const d of [home, stubs, release]) mkdirSync(d, { recursive: true });
  writeFileSync(log, "");
  prepare(home);

  const target = fixture.target ?? "x86_64-unknown-linux-gnu";
  const archive = `wsmp-${target}.tar.xz`;
  mkdirSync(join(release, `wsmp-${target}`));
  const inside = fixture.binary === "missing" ? "README.md" : "wsmp";
  writeFileSync(join(release, `wsmp-${target}/${inside}`), '#!/bin/sh\necho "wsmp 0.4.0"\n', {
    mode: 0o755,
  });
  execFileSync("tar", ["-cJf", archive, `wsmp-${target}`], { cwd: release });
  const sum = createHash("sha256")
    .update(readFileSync(join(release, archive)))
    .digest("hex");
  if (fixture.corrupt) writeFileSync(join(release, archive), "tampered");
  const sums = fixture.sums
    ? fixture.sums(sum, archive)
    : `${"0".repeat(64)} *source.tar.gz\n${sum} *${archive}\n`;
  if (sums !== null) writeFileSync(join(release, "sha256.sum"), sums);

  const stub = (name: string, body: string) =>
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // curl ... -o DEST URL: serve RELEASE/<name> from the fixture directory, 22 when missing.
  stub(
    "curl",
    `echo "curl $*" >> '${log}'
dest=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) dest=$2; shift ;; *) url=$1 ;; esac
  shift
done
case "$url" in '${RELEASE}/'*) ;; *) exit 22 ;; esac
src='${release}'/\${url##*/}
[ -f "$src" ] || exit 22
cp "$src" "$dest"`,
  );
  stub(
    "uname",
    `case "$1" in -s) echo '${machine.os ?? "Linux"}' ;; -m) echo '${machine.arch ?? "x86_64"}' ;; esac`,
  );
  const glibc = machine.glibc === undefined ? "2.35" : machine.glibc;
  stub("getconf", glibc === null ? "exit 1" : `echo 'glibc ${glibc}'`);
  stub("cargo", `echo "cargo $*" >> '${log}'`);
  // hw.optional.arm64: 1 on Apple silicon (also under Rosetta), missing on Intel.
  stub("sysctl", machine.appleSilicon ? "echo 1" : "exit 1");

  const result = spawnSync(shell, [], {
    input: script,
    encoding: "utf8",
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` },
  });
  const installed = join(home, ".cargo/bin/wsmp");
  return {
    home,
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: readFileSync(log, "utf8"),
    installed: existsSync(installed) ? installed : null,
  };
}

const releaseScript = installScript(ORIGIN, { kind: "release", baseUrl: RELEASE });
const canRun = has("xz") && has("tar") && has("awk");

describe.skipIf(!canRun)("install.sh behavior", () => {
  it("installs the verified binary into ~/.cargo/bin", () => {
    for (const shell of ["sh", "dash"].filter(has)) {
      const out = run(releaseScript, {}, {}, shell);
      expect(out.output).toContain("checksum verified");
      expect(out.status).toBe(0);
      expect(out.installed).not.toBeNull();
      expect(execFileSync(out.installed ?? "", ["--version"], { encoding: "utf8" })).toContain(
        "wsmp 0.4.0",
      );
      expect(out.calls).toContain(`${RELEASE}/sha256.sum`);
      expect(out.calls).toContain("curl --proto =https --tlsv1.2 ");
      expect(out.calls).not.toMatch(/^cargo /m);
      // ~/.cargo/bin is not on this PATH: the script says how to run it.
      expect(out.output).toContain("is not on your PATH");
    }
  });

  it("maps arm64 to the aarch64 archive", () => {
    const out = run(releaseScript, { arch: "arm64" });
    expect(out.calls).toContain(`${RELEASE}/wsmp-aarch64-unknown-linux-gnu.tar.xz`);
    // The fixture has only the x86_64 archive: a missing download stops the install.
    expect(out.status).not.toBe(0);
    expect(out.installed).toBeNull();
  });

  it("fails closed on a checksum mismatch", () => {
    const out = run(releaseScript, {}, { corrupt: true });
    expect(out.status).not.toBe(0);
    expect(out.output).toContain("checksum mismatch");
    expect(out.installed).toBeNull();
    expect(out.calls).not.toMatch(/^cargo /m);
  });

  it("fails closed when sha256.sum is missing, lacks the archive, or is malformed", () => {
    const cases: Fixture["sums"][] = [
      () => null,
      () => `${"a".repeat(64)} *wsmp-aarch64-unknown-linux-gnu.tar.xz\n`,
      (sum, archive) => `${sum.slice(1)} *${archive}\n`,
      (sum, archive) => `${sum.replace(/^./, "g")} *${archive}\n`,
      (sum, archive) => `${sum} *other-${archive}\n`,
    ];
    for (const sums of cases) {
      const out = run(releaseScript, {}, { sums });
      expect(out.status).not.toBe(0);
      expect(out.installed).toBeNull();
      expect(out.calls).not.toMatch(/^cargo /m);
    }
  });

  it("accepts a text-mode sha256.sum line", () => {
    const out = run(releaseScript, {}, { sums: (sum, archive) => `${sum}  ${archive}\n` });
    expect(out.status).toBe(0);
    expect(out.installed).not.toBeNull();
  });

  it("tolerates CRLF and upper-case hex in sha256.sum", () => {
    const out = run(
      releaseScript,
      {},
      {
        sums: (sum, archive) => `${sum.toUpperCase()} *${archive}\r\n`,
      },
    );
    expect(out.status).toBe(0);
    expect(out.installed).not.toBeNull();
  });

  it("stops, without building from source, when the release is not published", () => {
    const out = run(releaseScript, {}, { sums: () => null });
    expect(out.status).not.toBe(0);
    expect(out.output).toContain(`could not download ${RELEASE}/sha256.sum`);
    expect(out.calls).not.toMatch(/^cargo /m);
  });

  it("refuses an archive without wsmp in it", () => {
    const out = run(releaseScript, {}, { binary: "missing" });
    expect(out.status).not.toBe(0);
    expect(out.output).toContain("does not contain");
    expect(out.installed).toBeNull();
  });

  it("leaves no staging directory behind", () => {
    for (const fixture of [{}, { corrupt: true }, { binary: "missing" as const }]) {
      const out = run(releaseScript, {}, fixture);
      const bin = join(out.home, ".cargo/bin");
      const left = existsSync(bin) ? readdirSync(bin).filter((name) => name !== "wsmp") : [];
      expect(left).toEqual([]);
    }
  });

  it("refuses to install over a directory", () => {
    const out = run(releaseScript, {}, {}, "sh", (home) =>
      mkdirSync(join(home, ".cargo/bin/wsmp"), { recursive: true }),
    );
    expect(out.status).not.toBe(0);
    expect(out.output).toContain("is a directory");
    expect(existsSync(join(out.home, ".cargo/bin/wsmp/wsmp"))).toBe(false);
  });

  it("installs the native build on macOS, also from a Rosetta shell", () => {
    const machines: [Machine, string][] = [
      [{ os: "Darwin", arch: "arm64", appleSilicon: true }, "aarch64-apple-darwin"],
      [{ os: "Darwin", arch: "x86_64", appleSilicon: true }, "aarch64-apple-darwin"],
      [{ os: "Darwin", arch: "x86_64" }, "x86_64-apple-darwin"],
    ];
    for (const [machine, target] of machines) {
      const out = run(releaseScript, machine, { target });
      expect(out.calls).toContain(`${RELEASE}/wsmp-${target}.tar.xz`);
      expect(out.status).toBe(0);
      expect(out.installed).not.toBeNull();
    }
  });

  it("builds this version's tag from source where no binary fits", () => {
    const machines: Machine[] = [
      { arch: "riscv64" },
      { glibc: "2.31" }, // Ubuntu 20.04
      { glibc: null }, // musl (Alpine)
      { os: "FreeBSD" },
    ];
    for (const machine of machines) {
      const out = run(releaseScript, machine);
      expect(out.status).toBe(0);
      expect(out.output).toContain("building from source instead");
      expect(out.calls).toBe(
        `cargo install --git ${CLI_REPOSITORY} --tag v${SERVER_VERSION} --locked --force wsmp\n`,
      );
    }
  });

  it("builds the pinned commit and never downloads when WMP_CLI_SOURCE_REV is set", () => {
    const out = run(installScript(ORIGIN, cliInstallSource(REV, RELEASE)));
    expect(out.status).toBe(0);
    expect(out.calls).toBe(
      `cargo install --git ${CLI_REPOSITORY} --rev ${REV} --locked --force wsmp\n`,
    );
  });
});

/**
 * `/install.sh` rendering and behavior. The rendered script runs under `sh` (and `dash` where it
 * is installed) against stub `curl`, `uname`, `getconf`, `ldd` and `cargo` commands and a local fixture
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
  CLI_PREVIEW_BRANCH,
  CLI_RELEASE_BINARIES_BY_DEFAULT,
  CLI_RELEASE_MIN_GLIBC,
  CLI_RELEASE_TARGETS,
  CLI_REPOSITORY,
  cliInstallSource,
  defaultCliReleaseBaseUrl,
  installScript,
} = await import("./node-http.js");
const { SERVER_VERSION } = await import("./version.js");

const ORIGIN = "https://proxy.example.com";
const REV = "0123456789abcdef0123456789abcdef01234567";
const RELEASE = "https://releases.example.com/wsmp/v0.4.0";
const repoRoot = join(import.meta.dirname, "../../..");

function has(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

describe("install.sh rendering", () => {
  it("chooses a pinned commit, then the configured release, then the built-in default", () => {
    // Before the release flip, an unconfigured server builds the preview branch.
    expect(cliInstallSource(undefined, undefined, false)).toEqual({ kind: "source" });
    // After it, this version's GitHub Release.
    expect(cliInstallSource(undefined, undefined, true)).toEqual({
      kind: "release",
      baseUrl: `${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}`,
    });
    expect(cliInstallSource(undefined, undefined)).toEqual(
      cliInstallSource(undefined, undefined, CLI_RELEASE_BINARIES_BY_DEFAULT),
    );
    // Opted in before the flip, machines without a binary build the preview branch (no tag yet).
    expect(cliInstallSource(undefined, RELEASE, false)).toEqual({
      kind: "release",
      baseUrl: RELEASE,
      fallbackBranch: CLI_PREVIEW_BRANCH,
    });
    expect(cliInstallSource(undefined, RELEASE, true)).toEqual({
      kind: "release",
      baseUrl: RELEASE,
    });
    for (const byDefault of [false, true]) {
      // A pinned commit always builds from source, whatever the release URL says.
      expect(cliInstallSource(REV, RELEASE, byDefault)).toEqual({ kind: "source", rev: REV });
    }
  });

  it("renders the preview-branch source build", () => {
    const text = installScript(ORIGIN, { kind: "source" });
    expect(text).toContain("WSMP_RELEASE_URL=''");
    expect(text).toContain(`install_source --branch '${CLI_PREVIEW_BRANCH}'`);
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
      cliInstallSource(undefined, undefined, true),
      cliInstallSource(undefined, undefined, false),
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
      `${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}`,
    );
  });
});

type Machine = {
  os?: string;
  arch?: string;
  /** `getconf GNU_LIBC_VERSION` (default 2.35); null: getconf fails, as on musl. */
  glibc?: string | null;
  /** `ldd --version`'s first line; default: musl's ldd, which fails. */
  ldd?: string;
  appleSilicon?: boolean;
};
type Fixture = {
  sums?: (sum: string, archive: string) => string | null;
  corrupt?: boolean;
  /** The only archive's target: a release (or old mirror) with one Linux flavour. */
  target?: string;
  /** Every archive's target (default: both x86_64 Linux flavours, as a 1.x release). */
  targets?: string[];
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

  const targets = fixture.targets ?? [
    fixture.target ?? "x86_64-unknown-linux-gnu",
    ...(fixture.target ? [] : ["x86_64-unknown-linux-musl"]),
  ];
  const lines = [`${"0".repeat(64)} *source.tar.gz`];
  let sum = "";
  let archive = "";
  for (const target of targets) {
    const name = `wsmp-${target}.tar.xz`;
    mkdirSync(join(release, `wsmp-${target}`));
    const inside = fixture.binary === "missing" ? "README.md" : "wsmp";
    writeFileSync(join(release, `wsmp-${target}/${inside}`), '#!/bin/sh\necho "wsmp 0.4.0"\n', {
      mode: 0o755,
    });
    execFileSync("tar", ["-cJf", name, `wsmp-${target}`], { cwd: release });
    const digest = createHash("sha256")
      .update(readFileSync(join(release, name)))
      .digest("hex");
    if (fixture.corrupt) writeFileSync(join(release, name), "tampered");
    lines.push(`${digest} *${name}`);
    if (!archive) {
      sum = digest;
      archive = name;
    }
  }
  const sums = fixture.sums ? fixture.sums(sum, archive) : `${lines.join("\n")}\n`;
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
  stub(
    "getconf",
    `echo "getconf $*" >> '${log}'\n${glibc === null ? "exit 1" : `echo 'glibc ${glibc}'`}`,
  );
  stub(
    "ldd",
    machine.ldd === undefined
      ? `echo "ldd $*" >> '${log}'\necho 'musl libc (x86_64)' >&2\nexit 1`
      : `echo "ldd $*" >> '${log}'\necho '${machine.ldd}'`,
  );
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

  const floor = `${CLI_RELEASE_MIN_GLIBC.major}.${CLI_RELEASE_MIN_GLIBC.minor}`;
  const receiptTarget = (home: string) =>
    JSON.parse(readFileSync(join(home, ".local/state/ws-model-proxy/install.json"), "utf8")).target;
  const both = (arch: string) => [`${arch}-unknown-linux-gnu`, `${arch}-unknown-linux-musl`];

  it("installs the GNU build on glibc at or above the floor, as 0.4.x did", () => {
    expect(floor).toBe("2.34");
    for (const glibc of [floor, "2.35", "2.39", "2.100", "3.0"]) {
      for (const arch of ["x86_64", "aarch64"]) {
        const out = run(releaseScript, { arch, glibc }, { targets: both(arch) });
        const target = `${arch}-unknown-linux-gnu`;
        expect(out.status).toBe(0);
        expect(out.output).toContain("checksum verified");
        expect(out.installed).not.toBeNull();
        expect(out.calls).toContain(`${RELEASE}/wsmp-${target}.tar.xz`);
        expect(out.calls).not.toContain("-unknown-linux-musl.tar.xz");
        expect(out.calls).not.toMatch(/^cargo /m);
        expect(receiptTarget(out.home)).toBe(target);
      }
    }
  });

  it("installs the static musl build on musl (Alpine) and on glibc below the floor", () => {
    for (const glibc of [null, "2.17", "2.31", "2.33", "invalid", "musl 1.2"]) {
      for (const arch of ["x86_64", "aarch64"]) {
        const out = run(releaseScript, { arch, glibc }, { targets: both(arch) });
        const target = `${arch}-unknown-linux-musl`;
        expect(out.status).toBe(0);
        expect(out.installed).not.toBeNull();
        expect(out.calls).toContain(`${RELEASE}/wsmp-${target}.tar.xz`);
        expect(out.calls).not.toContain("-unknown-linux-gnu.tar.xz");
        expect(out.calls).not.toMatch(/^cargo /m);
        expect(receiptTarget(out.home)).toBe(target);
      }
    }
  });

  it("reads glibc from ldd where getconf cannot tell", () => {
    const gnu = run(
      releaseScript,
      { glibc: null, ldd: "ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35" },
      { targets: both("x86_64") },
    );
    expect(gnu.status).toBe(0);
    expect(receiptTarget(gnu.home)).toBe("x86_64-unknown-linux-gnu");
    for (const ldd of ["ldd (GNU libc) 2.31", "ldd (GNU libc) 2.33"]) {
      const old = run(releaseScript, { glibc: null, ldd }, { targets: both("x86_64") });
      expect(old.status).toBe(0);
      expect(receiptTarget(old.home)).toBe("x86_64-unknown-linux-musl");
    }
  });

  it("maps arm64 to the aarch64 archive", () => {
    const out = run(releaseScript, { arch: "arm64" }, { targets: both("aarch64") });
    expect(out.calls).toContain(`${RELEASE}/wsmp-aarch64-unknown-linux-gnu.tar.xz`);
    expect(out.status).toBe(0);
    expect(out.installed).not.toBeNull();
  });

  it("installs a GNU-only mirror (pre-1.0 releases) on new glibc and builds from source on old", () => {
    const fits = run(releaseScript, { glibc: "2.35" }, { target: "x86_64-unknown-linux-gnu" });
    expect(fits.status).toBe(0);
    expect(receiptTarget(fits.home)).toBe("x86_64-unknown-linux-gnu");
    for (const glibc of [null, "2.17", "2.33", "invalid"]) {
      const out = run(releaseScript, { glibc }, { target: "x86_64-unknown-linux-gnu" });
      expect(out.status).toBe(0);
      expect(out.output).toContain(
        `only GNU Linux binaries, which need glibc ${floor} or newer; building from source instead`,
      );
      expect(out.calls).toContain(`cargo install --git ${CLI_REPOSITORY} --tag v${SERVER_VERSION}`);
      expect(out.calls).not.toContain(`${RELEASE}/wsmp-x86_64-unknown-linux-gnu.tar.xz`);
    }
  });

  it("installs the musl build when a release lists no GNU archive", () => {
    const out = run(releaseScript, { glibc: "2.35" }, { target: "x86_64-unknown-linux-musl" });
    expect(out.status).toBe(0);
    expect(out.output).toContain("has no wsmp-x86_64-unknown-linux-gnu.tar.xz; installing");
    expect(receiptTarget(out.home)).toBe("x86_64-unknown-linux-musl");
  });

  it("fails closed on a checksum mismatch of either flavour", () => {
    for (const glibc of ["2.35", null]) {
      const out = run(releaseScript, { glibc }, { corrupt: true });
      expect(out.status).not.toBe(0);
      expect(out.output).toContain("checksum mismatch");
      expect(out.installed).toBeNull();
      expect(out.calls).not.toMatch(/^cargo /m);
    }
  });

  it("never falls back past a listed archive with a malformed checksum", () => {
    for (const [glibc, listed, other, line] of [
      ["2.35", "gnu", "musl", "bad *"],
      [null, "musl", "gnu", "bad *"],
      // A digest-less line: the file name is the first field.
      ["2.35", "gnu", "musl", "*"],
      ["2.35", "gnu", "musl", ""],
    ] as const) {
      const out = run(
        releaseScript,
        { glibc },
        {
          targets: [`x86_64-unknown-linux-${other}`],
          sums: (sum, archive) =>
            `${line}wsmp-x86_64-unknown-linux-${listed}.tar.xz\n${sum} *${archive}\n`,
        },
      );
      expect(out.status).not.toBe(0);
      expect(out.installed).toBeNull();
      expect(out.calls).not.toContain(`wsmp-x86_64-unknown-linux-${other}.tar.xz`);
      expect(out.calls).not.toMatch(/^cargo /m);
    }
  });

  it("keeps the glibc floor in step with the release gate", () => {
    const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const ci = readFileSync(join(repoRoot, ".github/workflows/cli-ci.yml"), "utf8");
    for (const workflow of [release, ci]) {
      const floors = [...workflow.matchAll(/check-glibc-floor\.sh \S+ (\S+)/g)].map((m) => m[1]);
      expect(floors.length).toBeGreaterThan(0);
      for (const found of floors) expect(found).toBe(floor);
    }
    const dist = readFileSync(join(repoRoot, "apps/cli/dist-workspace.toml"), "utf8");
    expect(dist).toMatch(/^x86_64-unknown-linux-gnu = "ubuntu-22\.04"$/m);
    expect(dist).toMatch(/^aarch64-unknown-linux-gnu = "ubuntu-22\.04-arm"$/m);
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
      () => `${"a".repeat(64)} *wsmp-aarch64-unknown-linux-musl.tar.xz\n`,
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
    const machines: Machine[] = [{ arch: "riscv64" }, { os: "FreeBSD" }];
    for (const machine of machines) {
      const out = run(releaseScript, machine);
      expect(out.status).toBe(0);
      expect(out.output).toContain("building from source instead");
      expect(out.calls).toBe(
        `cargo install --git ${CLI_REPOSITORY} --tag v${SERVER_VERSION} --locked --force wsmp\n`,
      );
    }
  });

  it("builds the preview branch where no binary fits, when opted in before the flip", () => {
    const script = installScript(ORIGIN, cliInstallSource(undefined, RELEASE, false));
    const out = run(script, { arch: "riscv64" });
    expect(out.status).toBe(0);
    expect(out.calls).toBe(
      `cargo install --git ${CLI_REPOSITORY} --branch ${CLI_PREVIEW_BRANCH} --locked --force wsmp\n`,
    );
    // Machines with a binary still get the verified download.
    expect(run(script).installed).not.toBeNull();
  });

  it("builds the preview branch and never downloads before the release flip", () => {
    const out = run(installScript(ORIGIN, { kind: "source" }));
    expect(out.status).toBe(0);
    expect(out.calls).toBe(
      `cargo install --git ${CLI_REPOSITORY} --branch ${CLI_PREVIEW_BRANCH} --locked --force wsmp\n`,
    );
  });

  it("writes the install receipt where wsmp reads its state", () => {
    const out = run(releaseScript);
    expect(out.status).toBe(0);
    const receipt = JSON.parse(
      readFileSync(join(out.home, ".local/state/ws-model-proxy/install.json"), "utf8"),
    );
    expect(receipt).toMatchObject({
      method: "script",
      version: "0.4.0",
      commit: null,
      target: "x86_64-unknown-linux-gnu",
      binary: join(out.home, ".cargo/bin/wsmp"),
    });
    expect(receipt.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("records a pinned source build as method source with its commit", () => {
    const out = run(installScript(ORIGIN, cliInstallSource(REV, RELEASE)));
    expect(out.status).toBe(0);
    const receipt = JSON.parse(
      readFileSync(join(out.home, ".local/state/ws-model-proxy/install.json"), "utf8"),
    );
    expect(receipt).toMatchObject({ method: "source", commit: REV });
  });

  it("builds the pinned commit and never downloads when WMP_CLI_SOURCE_REV is set", () => {
    const out = run(installScript(ORIGIN, cliInstallSource(REV, RELEASE)));
    expect(out.status).toBe(0);
    expect(out.calls).toBe(
      `cargo install --git ${CLI_REPOSITORY} --rev ${REV} --locked --force wsmp\n`,
    );
  });
});

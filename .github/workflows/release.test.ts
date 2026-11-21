import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Exercise the actual workflow step so repackaging cannot silently leave stale
// cargo-dist hashes (global installers and sha256.sum consume that manifest).
const workflow = readFileSync(join(import.meta.dirname, "release.yml"), "utf8");
const step = workflow.split(
  "      - name: Verify static musl binaries and include their licence notice\n",
)[1];
if (!step) throw new Error("missing musl packaging step");
const script = step
  // The step ends at the next step (or the comment above it), at six spaces.
  .split(/\n {6}(?=- |# )/)[0]
  .split("        run: |\n")[1]
  ?.replace(/^ {10}/gm, "");
if (!script) throw new Error("missing musl packaging script");

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const target = "x86_64-unknown-linux-musl";
const archiveName = `wsmp-${target}.tar.xz`;
const checksumName = `${archiveName}.sha256`;
const notice = "fixture musl copyright and permission notice\n";
const canRun =
  process.platform === "linux" &&
  ["bash", "tar", "xz", "python3"].every(
    (command) => spawnSync("sh", ["-c", `command -v ${command}`]).status === 0,
  );

function fixture(
  readelf: string,
  check: (root: string, archive: string, run: SpawnSyncReturns<string>) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "wsmp-musl-release-"));
  try {
    const dist = join(root, "target/distrib");
    const source = join(root, "source");
    const stubs = join(root, "stubs");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(source, `wsmp-${target}`), { recursive: true });
    mkdirSync(stubs);
    writeFileSync(join(source, `wsmp-${target}/wsmp`), "fixture binary");
    const archive = join(dist, archiveName);
    execFileSync("tar", ["-cJf", archive, "-C", source, `wsmp-${target}`]);
    writeFileSync(join(dist, checksumName), "old checksum\n");
    writeFileSync(
      join(root, "dist-manifest.json"),
      JSON.stringify({
        artifacts: {
          [archiveName]: { checksum: checksumName, checksums: { sha256: "old" }, assets: [] },
          [checksumName]: { kind: "checksum" },
          "wsmp-x86_64-unknown-linux-gnu.tar.xz": { checksums: { sha256: "gnu-unchanged" } },
        },
      }),
    );
    const stub = (name: string, body: string) =>
      writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("file", "exit 0");
    stub("readelf", readelf);
    // Only the system licence source is replaced; tar/python/hash work is real.
    stub("cp", `printf '%s\\n' 'fixture musl copyright and permission notice' > "$2"`);
    const run = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: `${stubs}:/usr/bin:/bin`, RELEASE_TARGETS: target, TMPDIR: root },
    });
    check(root, archive, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("musl release packaging", () => {
  it("ships the musl notice and refreshes archive and manifest checksums", () => {
    fixture("echo 'no dynamic linkage'", (root, archive, run) => {
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      expect(
        execFileSync("tar", ["-xOJf", archive, `wsmp-${target}/musl-COPYRIGHT.txt`], {
          encoding: "utf8",
        }),
      ).toBe(notice);
      const checksum = join(root, "target/distrib", checksumName);
      expect(readFileSync(checksum, "utf8")).toBe(`${hash(archive)} *${archiveName}\n`);
      const manifest = JSON.parse(readFileSync(join(root, "dist-manifest.json"), "utf8"));
      expect(manifest.artifacts[archiveName].checksums.sha256).toBe(hash(archive));
      expect(manifest.artifacts[checksumName].checksums.sha256).toBe(hash(checksum));
      expect(manifest.artifacts[archiveName].assets).toContainEqual({
        name: "musl-COPYRIGHT.txt",
        path: "musl-COPYRIGHT.txt",
        kind: "license",
      });
      expect(manifest.artifacts["wsmp-x86_64-unknown-linux-gnu.tar.xz"].checksums.sha256).toBe(
        "gnu-unchanged",
      );
    });
  });

  it.each([
    ["an ELF interpreter", '[ "$1" != -lW ] || echo INTERP'],
    ["a shared-library dependency", "[ \"$1\" != -dW ] || echo '(NEEDED)'"],
    ["unreadable ELF headers", "exit 1"],
    ["an unreadable dynamic section", '[ "$1" != -dW ]'],
  ])("rejects %s before repackaging or changing checksums", (_name, readelf) => {
    fixture(readelf, (root, archive, run) => {
      expect(run.status).not.toBe(0);
      expect(readFileSync(join(root, "target/distrib", checksumName), "utf8")).toBe(
        "old checksum\n",
      );
      expect(execFileSync("tar", ["-tJf", archive], { encoding: "utf8" })).not.toContain(
        "musl-COPYRIGHT.txt",
      );
      const manifest = JSON.parse(readFileSync(join(root, "dist-manifest.json"), "utf8"));
      expect(manifest.artifacts[archiveName].checksums.sha256).toBe("old");
    });
  });
});

describe.skipIf(process.platform !== "linux")("GNU glibc floor check", () => {
  const checker = join(import.meta.dirname, "../../apps/cli/scripts/check-glibc-floor.sh");
  function check(readelf: string, floor = "2.34") {
    const root = mkdtempSync(join(tmpdir(), "wsmp-glibc-floor-"));
    try {
      const stubs = join(root, "stubs");
      mkdirSync(stubs);
      writeFileSync(join(stubs, "readelf"), `#!/bin/sh\n${readelf}\n`, { mode: 0o755 });
      return spawnSync("bash", [checker, join(root, "wsmp"), floor], {
        encoding: "utf8",
        env: { PATH: `${stubs}:/usr/bin:/bin` },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const needs = (...versions: string[]) =>
    `printf '%s\\n' 'Version needs section' ${versions
      .map((v) => `'  0x0010:   Name: ${v}  Flags: none  Version: 2'`)
      .join(" ")}`;

  it("passes a binary whose newest GLIBC_ need is at or below the floor", () => {
    const run = check(needs("GLIBC_2.2.5", "GLIBC_2.17", "GLIBC_2.34", "GLIBC_PRIVATE"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("newest glibc symbol version 2.34 (floor 2.34)");
  });

  it("fails a binary that needs a newer glibc, comparing versions numerically", () => {
    for (const newest of ["GLIBC_2.35", "GLIBC_2.100", "GLIBC_3.0"]) {
      const run = check(needs("GLIBC_2.9", newest));
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("above the 2.34 floor");
    }
  });

  it("fails without glibc needs, when readelf fails, or on a malformed floor", () => {
    expect(check(needs()).status).toBe(1);
    expect(check("exit 1").status).not.toBe(0);
    expect(check(needs("GLIBC_2.17"), "2").status).toBe(2);
  });
});

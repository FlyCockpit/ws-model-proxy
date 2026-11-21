import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxOnlyTest } from "./linux-only.mjs";

// pre-migrate.sh is Linux-only (the app image): see linux-only.mjs.
const test = linuxOnlyTest(import.meta.url);

// Exercise the real shell hook with a private, unmounted placeholder directory
// (so /backups never counts as a destination). No inherited database
// credentials, provider settings or external IO.
function hookIn(dir) {
  const hook = path.join(dir, "pre-migrate.sh");
  const source = readFileSync(new URL("./pre-migrate.sh", import.meta.url), "utf8");
  writeFileSync(hook, source.replace('LOCAL_DIR="/backups"', `LOCAL_DIR="${dir}"`));
  // s3.mjs (and lib.mjs) are resolved next to the hook; a node_modules link
  // lets their package imports (the S3 SDK) resolve from the repo.
  for (const name of ["s3.mjs", "lib.mjs"])
    writeFileSync(path.join(dir, name), readFileSync(new URL(`./${name}`, import.meta.url)));
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    path.join(dir, "node_modules"),
  );
  return (args, extra = {}) =>
    spawnSync("bash", [hook, ...args], {
      env: { PATH: process.env.PATH, ...extra },
      encoding: "utf8",
    });
}

const S3 = {
  BACKUP_S3_BUCKET: "test-bucket",
  BACKUP_S3_ACCESS_KEY_ID: "test-backup-key",
  BACKUP_S3_SECRET_ACCESS_KEY: "test-backup-secret",
  BACKUP_S3_ENDPOINT: "http://127.0.0.1:9",
};

test("BACKUP_ENABLED off (default): silent at startup, but warns when a destination is configured", () => {
  // The general backups-off notice is the server's own startup log
  // (apps/server/src/index.ts); the hook adds only the upgrade warning.
  const dir = mkdtempSync(path.join(tmpdir(), "backup-defaults-"));
  try {
    const run = hookIn(dir);
    for (const extra of [{}, { BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "" }, S3]) {
      const startup = run(["--startup-notice"], extra);
      assert.equal(startup.status, 0, startup.stderr);
      assert.equal(startup.stdout, "");
      const withDestination = extra === S3;
      if (!withDestination) assert.equal(startup.stderr, "");
      else {
        assert.equal(startup.stderr.trim().split("\n").length, 1);
        assert.match(
          startup.stderr,
          /WARNING: \[backup\] A backup destination is configured but BACKUP_ENABLED is not true/,
        );
      }
      assert.doesNotMatch(startup.stderr, /test-backup-secret|test-backup-key/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BACKUP_ENABLED=true: startup fails clearly without a destination, passes with one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-enabled-"));
  try {
    const run = hookIn(dir);
    const none = run(["--startup-notice"], { BACKUP_ENABLED: "true" });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /BACKUP_ENABLED=true but no backup destination is configured/);
    const badS3 = run(["--startup-notice"], {
      BACKUP_ENABLED: "true",
      BACKUP_S3_BUCKET: "test-bucket",
    });
    assert.equal(badS3.status, 1);
    assert.match(
      badS3.stderr,
      /BACKUP_S3_ACCESS_KEY_ID \/ BACKUP_S3_SECRET_ACCESS_KEY are missing/,
    );
    const ok = run(["--startup-notice"], { BACKUP_ENABLED: "true", ...S3 });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /Backups are ON \(BACKUP_ENABLED=true\).*BACKUP_S3_BUCKET/);
    assert.doesNotMatch(ok.stdout + ok.stderr, /test-backup-secret|test-backup-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BACKUP_ENABLED is parsed strictly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-strict-"));
  try {
    const run = hookIn(dir);
    for (const value of ["TRUE", "1", "yes", "on"]) {
      for (const args of [["--startup-notice"], ["--required"]]) {
        const result = run(args, { BACKUP_ENABLED: value });
        assert.equal(result.status, 1, `${value} ${args}`);
        assert.match(result.stderr, /BACKUP_ENABLED must be true or false/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit calls: --required fails without a destination; a configured one dumps whatever BACKUP_ENABLED says", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-explicit-"));
  try {
    const run = hookIn(dir);
    for (const enabled of [{}, { BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "true" }]) {
      const manual = run(["--required"], enabled);
      assert.equal(manual.status, 1);
      assert.match(manual.stderr, /no backup destination/);
      // Configured: it goes on to dump (and stops at the missing DATABASE_URL here).
      const configured = run(["--label", "manual", "--required"], { ...enabled, ...S3 });
      assert.equal(configured.status, 1);
      assert.match(configured.stderr, /DATABASE_URL is not set/);
    }
    // Without --required and without a destination the hook is a silent no-op.
    for (const args of [[], ["--label", "pre-drop", "--keep", "5"]]) {
      const quiet = run(args);
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.equal(quiet.stdout + quiet.stderr, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incomplete BACKUP_S3_* settings fail the hook before it dumps (inert database tools)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-upload-"));
  try {
    // The real hook (its imports resolve in the repo). Every database
    // executable is inert; the mountpoint stub makes /backups an unmounted
    // placeholder, so only the (incomplete) S3 destination is configured.
    const bin = path.join(dir, "bin");
    const dumped = path.join(dir, "dumped");
    mkdirSync(bin);
    for (const [name, body] of Object.entries({
      mountpoint: "exit 1",
      psql: "printf '180000\\n'",
      pg_dump: `touch "${dumped}"; exit 1`,
      pg_restore: "exit 0",
    })) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    for (const enabled of [{ BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "true" }]) {
      const result = spawnSync(
        "bash",
        [fileURLToPath(new URL("./pre-migrate.sh", import.meta.url)), "--required"],
        {
          env: {
            PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            DATABASE_URL: "postgresql://localhost/disposable_fixture",
            BACKUP_S3_BUCKET: "inert-backups",
            BACKUP_S3_REGION: "us-east-1",
            ...enabled,
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /BACKUP_S3_ACCESS_KEY_ID.*missing/);
      assert.doesNotMatch(output, /\[backup\] Verified/);
      assert.equal(spawnSync("test", ["-e", dumped]).status, 1, "pg_dump must not run");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

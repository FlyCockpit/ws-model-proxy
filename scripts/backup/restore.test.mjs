import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const restore = fileURLToPath(new URL("./restore.mjs", import.meta.url));

/**
 * Inert Postgres executables for the restore CLI and its lock handover.
 * RESTORE_FIXTURE_MODE:
 *   exit:<n>         the restore session exits <n> after it reads COMMIT
 *   commit-unconfirmed the session reads COMMIT and exits 0 without confirming
 *                    it (the \echo marker after COMMIT never prints)
 *   dump-fail        pg_restore fails while producing the SQL (COMMIT never sent)
 *   hang-after-commit the restore session reads COMMIT, then never exits
 *   hang-after-confirm the session confirms COMMIT, marks <receipt>.confirmed
 *                    1 s later, then never exits
 *   confirm-then-exit:<n> the session confirms COMMIT, then exits <n>
 *   confirm-with-output the session confirms COMMIT and, in the same write,
 *                    prints 200 more bytes after the marker, then exits 0
 *   hang-summary     the post-COMMIT migration summary query never returns
 *   dump-hang        pg_restore writes its SQL, marks <receipt>.dump, then hangs
 *                    (COMMIT is never sent)
 *   psql-gone:<n>    the restore session exits <n> as soon as it reads BEGIN,
 *                    while a grandchild keeps its stdout/stderr open (its exit
 *                    is visible before its "close"). The grandchild marks
 *                    <receipt>.gone once the session has been reaped; only
 *                    then does pg_restore end successfully (<receipt>.dump-done),
 *                    writing no SQL, and the grandchild lets go 3 s after that.
 *   dump-spawn-fail  pg_restore deletes itself at the re-check under the lock, so the
 *                    restore's own pg_restore cannot be spawned (ENOENT)
 *   lock-spawn-fail  psql deletes itself after the target check, so the lock
 *                    session cannot be spawned (ENOENT)
 * Every mode writes the receipt file once the session has read COMMIT, and
 * confirms it (prints the \echo marker) except commit-unconfirmed,
 * hang-after-commit and exit:<n> with n > 0 (like psql with ON_ERROR_STOP,
 * whose COMMIT failed). Every mode that reads COMMIT first prints the
 * transaction id line (xid 777) that restore asks for right after BEGIN.
 * RESTORE_FIXTURE_XACT is what pg_xact_status('777') returns: committed,
 * aborted, unknown (the default), fail (the query fails),
 * in-progress-then-aborted ("in progress" twice, then "aborted"),
 * in-progress (always) or hang (the query never returns). Every
 * status query appends a line to <receipt>.xact. The spawn-fail modes run with only the fixture directory
 * (with a `node` link) on PATH, so no installed psql/pg_restore can stand in.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "backup-restore-cli-test-"));
  const archive = join(dir, "manual-20261113T000000Z.dump");
  const receipt = join(dir, "commit-observed.txt");
  writeFileSync(archive, "PGDMP-inert-test-archive");
  // The spawn-fail modes put only this directory on PATH; node must be in it
  // (the fixtures' `#!/usr/bin/env node`), and its real directory may also
  // hold an installed psql/pg_restore (/usr/bin).
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(
    join(dir, "pg_restore"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("pg_restore (PostgreSQL) 18.0");
  // The second version check (the re-check under the lock) is the last
  // pg_restore run before the restore's own.
  if (process.env.RESTORE_FIXTURE_MODE === "dump-spawn-fail") {
    const fs = require("node:fs");
    const seen = process.env.RESTORE_FIXTURE_RECEIPT + ".version";
    if (fs.existsSync(seen)) fs.unlinkSync(__filename);
    else fs.writeFileSync(seen, "first version check");
  }
}
else if (args.includes("--list")) {
  console.log("; Dbname: restore_fixture\\n1; 1 1 TABLE DATA public Fixture postgres");
  if (process.env.RESTORE_FIXTURE_MODE === "blob") console.log("2; 2613 16397 BLOB - 16397 postgres");
}
else if (args.includes("--file=-")) {
  const mode = process.env.RESTORE_FIXTURE_MODE;
  // psql-gone writes no SQL: a write into the exited session would be an EPIPE,
  // which makes restore stop pg_restore (a failed dump), not the case tested.
  if (!mode.startsWith("psql-gone:")) console.log("SELECT 1;");
  if (mode === "dump-fail") process.exitCode = 1;
  else if (mode === "dump-hang") {
    require("node:fs").writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT + ".dump", "dump hanging");
    setInterval(() => {}, 1000);
  } else if (mode.startsWith("psql-gone:")) {
    const fs = require("node:fs");
    const receipt = process.env.RESTORE_FIXTURE_RECEIPT;
    const deadline = Date.now() + 10000;
    const poll = setInterval(() => {
      if (fs.existsSync(receipt + ".gone") || Date.now() > deadline) {
        clearInterval(poll);
        fs.writeFileSync(receipt + ".dump-done", "dump done");
      }
    }, 20);
  }
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "psql"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.RESTORE_FIXTURE_MODE ?? "exit:0";
const args = process.argv.slice(2);
const queryIndex = args.indexOf("-c");
if (queryIndex !== -1) {
  const sql = args[queryIndex + 1];
  if (sql.includes("pg_xact_status")) {
    const log = process.env.RESTORE_FIXTURE_RECEIPT + ".xact";
    fs.appendFileSync(log, sql + "\\n");
    const xact = process.env.RESTORE_FIXTURE_XACT ?? "unknown";
    if (xact === "fail") process.exit(2);
    if (xact === "hang") setInterval(() => {}, 1000);
    else if (xact === "in-progress") console.log("in progress");
    else {
    const asked = fs.readFileSync(log, "utf8").trim().split("\\n").length;
    console.log(xact === "in-progress-then-aborted" ? (asked <= 2 ? "in progress" : "aborted") : xact);
    }
  } else if (mode === "hang-summary" && sql.includes("_prisma_migrations") && fs.existsSync(process.env.RESTORE_FIXTURE_RECEIPT)) {
    fs.writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT + ".summary", "summary started");
    setInterval(() => {}, 1000);
  } else if (sql === "SHOW server_version_num") console.log("180000");
  else if (sql.includes("pg_stat_activity")) console.log("0|");
  else if (sql.startsWith("SELECT count(*)")) {
    console.log("0");
    if (mode === "lock-spawn-fail") fs.unlinkSync(__filename);
  }
  else console.log("f");
} else {
  let input = "";
  let locks = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!locks && input.includes("pg_try_advisory_lock")) {
      locks = true;
      process.stdout.write("t,t,t,4242\\n");
    }
    if (mode.startsWith("psql-gone:") && input.includes("BEGIN;")) {
      // Holds the session's stdout/stderr: marks .gone once the session is
      // reaped (its exit is then visible to restore), lets go 3 s after
      // pg_restore is done. Bounded to 10 s.
      const holder = [
        'const fs = require("node:fs");',
        "const receipt = process.env.RESTORE_FIXTURE_RECEIPT;",
        "const pid = Number(process.env.FIXTURE_SESSION_PID);",
        "const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };",
        "setTimeout(() => process.exit(0), 10000);",
        "const poll = setInterval(() => {",
        '  if (gone() && !fs.existsSync(receipt + ".gone")) fs.writeFileSync(receipt + ".gone", "reaped");',
        '  if (fs.existsSync(receipt + ".dump-done")) { clearInterval(poll); setTimeout(() => process.exit(0), 3000); }',
        "}, 20);",
      ].join("\\n");
      require("node:child_process").spawn(process.execPath, ["-e", holder], {
        env: { ...process.env, FIXTURE_SESSION_PID: String(process.pid) },
        stdio: ["ignore", "inherit", "inherit"],
      });
      process.exit(Number(mode.slice(10)));
    }
  });
  process.stdin.on("end", () => {
    if (!input.includes("COMMIT;")) {
      process.exitCode = input.includes("BEGIN;") ? 3 : 0;
      return;
    }
    fs.writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT, "commit observed");
    const xid = /SELECT '(wmp-restore-xid-[0-9a-f]+:)' \\|\\| pg_current_xact_id\\(\\);/.exec(input);
    if (xid) console.log(xid[1] + "777");
    const marker = /\\\\echo (wmp-restore-committed-[0-9a-f]+)\\n/.exec(input);
    const failedCommit = mode.startsWith("exit:") && mode !== "exit:0";
    if (marker && mode === "confirm-with-output") process.stdout.write(marker[1] + "\\n" + "x".repeat(200) + "\\n");
    else if (marker && mode !== "commit-unconfirmed" && mode !== "hang-after-commit" && !failedCommit) console.log(marker[1]);
    if (mode.startsWith("confirm-then-exit:")) process.exitCode = Number(mode.slice(18));
    if (mode === "hang-after-confirm") {
      setTimeout(() => fs.writeFileSync(process.env.RESTORE_FIXTURE_RECEIPT + ".confirmed", "confirmed"), 1000);
      setInterval(() => {}, 1000);
    }
    if (mode === "hang-after-commit") setInterval(() => {}, 1000);
    else if (mode.startsWith("exit:")) process.exitCode = Number(mode.slice(5));
  });
}
`,
    { mode: 0o755 },
  );
  const env = (mode, xact = "unknown") => ({
    PATH: mode.endsWith("-spawn-fail") ? dir : `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    DATABASE_URL: "postgresql://127.0.0.1/restore_fixture",
    RESTORE_FIXTURE_RECEIPT: receipt,
    RESTORE_FIXTURE_MODE: mode,
    RESTORE_FIXTURE_XACT: xact,
  });
  const xactQueries = () => {
    try {
      return readFileSync(`${receipt}.xact`, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const commit = () => {
    try {
      return readFileSync(receipt, "utf8");
    } catch {
      return null;
    }
  };
  return {
    dir,
    archive,
    receipt,
    env,
    commit,
    xactQueries,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runRestore({ mode = "exit:0", preview = false, xact = "unknown" } = {}) {
  const f = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [restore, f.archive, ...(preview ? [] : ["--confirm", "RESTORE:restore_fixture"])],
      // SIGKILL: a regression that traps SIGTERM cannot outlive the timeout.
      { env: f.env(mode, xact), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    assert.equal(result.error, undefined);
    return {
      ...result,
      commit: f.commit(),
      xactQueries: f.xactQueries(),
      output: result.stdout + result.stderr,
    };
  } finally {
    f.cleanup();
  }
}

/** Start a restore, wait until `marker` exists, send `signal`, collect the result. */
async function interruptRestore({ mode, marker, signal }) {
  const f = fixture();
  const child = spawn(
    process.execPath,
    [restore, f.archive, "--confirm", "RESTORE:restore_fixture"],
    {
      env: f.env(mode),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a hung run can be reaped with its fixtures.
      detached: true,
    },
  );
  const closed = once(child, "close").then(([code]) => code);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const path = marker(f);
    const deadline = Date.now() + 10_000;
    while (!existsSync(path) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(path), `the restore never reached the interrupt point:\n${output}`);
    child.kill(signal);
    // Bounded: a regression that ignores the signal fails instead of hanging.
    const code = await Promise.race([
      closed,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), 15_000);
      }),
    ]);
    assert.notEqual(code, "timeout", `the restore did not exit after ${signal}:\n${output}`);
    return { code, output, commit: f.commit() };
  } finally {
    clearTimeout(timer);
    // Reap the whole group, even when restore itself already exited: a
    // fixture left behind would hold the pipes and hang the suite.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone (ESRCH).
    }
    await closed;
    f.cleanup();
  }
}

test("restore preview is a refusal (exit 3) that never invokes a transaction", () => {
  const result = runRestore({ preview: true });
  // REFUSED_EXIT: nothing was changed, so host.sh may start the writers again.
  assert.equal(result.status, 3, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /preview only/);
  assert.match(result.output, /--confirm RESTORE:restore_fixture/);
});

test("a committed restore exits 0 and reports completion", () => {
  const result = runRestore();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /Restore complete/);
  assert.doesNotMatch(result.output, /REFUSED|FATAL/);
});

test("a psql failure after COMMIT was sent reports an uncertain outcome, never 'rolled back; unchanged'", () => {
  // psql exit 7 is not ON_ERROR_STOP's 3, and the server cannot say (unknown).
  const result = runRestore({ mode: "exit:7" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /restore failed after COMMIT was sent/);
  assert.match(result.output, /uncertain/);
  assert.doesNotMatch(result.output, /rolled back|is unchanged/);
  // It asked the server about the transaction id the session printed.
  assert.deepEqual(result.xactQueries, ["SELECT coalesce(pg_xact_status('777'::xid8), 'unknown')"]);
});

test("a psql that stopped on an SQL error (ON_ERROR_STOP, exit 3) without confirming COMMIT is rolled back: exit 4", () => {
  // COMMIT was written, but psql stopped at an earlier statement (or at a
  // failed COMMIT): nothing after COMMIT can fail, so nothing committed.
  const result = runRestore({ mode: "exit:3" });
  assert.equal(result.status, 4, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(
    result.output,
    /ROLLED BACK: restore failed \(psql exit 3, pg_restore exit 0\)\. psql stopped on an SQL error \(ON_ERROR_STOP\) before confirming COMMIT, so the transaction was rolled back; "restore_fixture" is unchanged/,
  );
  assert.doesNotMatch(result.output, /uncertain|Restore complete|FATAL/);
  // Provable from psql's status alone: the server is not asked.
  assert.deepEqual(result.xactQueries, []);
});

test("an unconfirmed COMMIT the server reports aborted is rolled back: exit 4", () => {
  for (const [mode, xact, asked] of [
    ["exit:7", "aborted", 1],
    ["commit-unconfirmed", "aborted", 1],
    // Still "in progress" at first (the backend is finishing): it waits.
    ["exit:2", "in-progress-then-aborted", 3],
  ]) {
    const result = runRestore({ mode, xact });
    const label = `${mode} + ${xact}`;
    assert.equal(result.status, 4, `${label}:\n${result.output}`);
    assert.match(
      result.output,
      /the server reports the restore transaction aborted, so the transaction was rolled back; "restore_fixture" is unchanged/,
      label,
    );
    assert.doesNotMatch(result.output, /uncertain|Restore complete/, label);
    assert.equal(result.xactQueries.length, asked, label);
  }
});

test("an unconfirmed COMMIT the server reports committed says the restore committed, exit 1", () => {
  const result = runRestore({ mode: "exit:7", xact: "committed" });
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /the restore session failed before confirming COMMIT, but the server reports the restore transaction committed \(psql exit 7\)\. "restore_fixture" is restored/,
  );
  assert.doesNotMatch(result.output, /rolled back|is uncertain|Restore complete\./);
});

test("an unconfirmed COMMIT whose status the server cannot give stays uncertain, exit 1", () => {
  const result = runRestore({ mode: "exit:7", xact: "fail" });
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /COMMIT not confirmed; the server reports the restore transaction as unavailable/,
  );
  assert.match(result.output, /is uncertain/);
  assert.doesNotMatch(result.output, /rolled back|is unchanged/);
});

test("a failure before COMMIT was sent is rolled back and says so: exit 4", () => {
  const result = runRestore({ mode: "dump-fail" });
  assert.equal(result.status, 4, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /COMMIT was never sent, so the transaction was rolled back/);
  assert.doesNotMatch(result.output, /uncertain/);
});

test("a signal while the restore transaction is open, before COMMIT was sent, is rolled back and says so: exit 4", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const result = await interruptRestore({
      mode: "dump-hang",
      marker: (f) => `${f.receipt}.dump`,
      signal,
    });
    assert.equal(result.code, 4, result.output);
    assert.equal(result.commit, null);
    assert.match(
      result.output,
      new RegExp(
        `ROLLED BACK: interrupted by ${signal} before COMMIT; the unfinished restore transaction is rolled back`,
      ),
    );
    assert.doesNotMatch(result.output, /uncertain|Restore complete/);
  }
});

test("a restore session that already exited is never sent COMMIT: rolled back, never 'uncertain' or 'complete'", () => {
  // The session's exit is visible before its "close" (a grandchild holds its
  // output open) when pg_restore finishes: COMMIT must not count as sent.
  for (const exit of ["3", "0"]) {
    const result = runRestore({ mode: `psql-gone:${exit}` });
    assert.equal(result.status, 4, result.output);
    assert.equal(result.commit, null);
    // pg_restore succeeded: only the session's early exit kept COMMIT back.
    assert.match(
      result.output,
      /psql exit \d+, pg_restore exit 0\)\. COMMIT was never sent, so the transaction was rolled back/,
    );
    assert.doesNotMatch(result.output, /uncertain|Restore complete/);
  }
});

test("a pg_restore that cannot be spawned sends no COMMIT: rolled back, exit 4, no crash", () => {
  const result = runRestore({ mode: "dump-spawn-fail" });
  assert.equal(result.status, 4, result.output);
  assert.equal(result.commit, null);
  assert.match(
    result.output,
    // -2 is ENOENT, the spawn failure itself (a real pg_restore would exit 1).
    /restore failed \(psql exit \d+, pg_restore exit -2\)\. COMMIT was never sent, so the transaction was rolled back/,
  );
  assert.doesNotMatch(result.output, /uncertain|Restore complete|Unhandled|\n\s+at /);
});

test("a lock session that cannot be spawned is a refusal (exit 3), not a crash", () => {
  const result = runRestore({ mode: "lock-spawn-fail" });
  assert.equal(result.status, 3, result.output);
  assert.equal(result.commit, null);
  // No stderr from a psql that ran: the spawn itself failed, and the refusal
  // names that cause.
  assert.match(result.output, /REFUSED: could not open the lock session: spawn psql ENOENT/);
  assert.doesNotMatch(result.output, /no reply from the database/);
  assert.doesNotMatch(result.output, /uncertain|rolled back|Unhandled|\n\s+at /);
});

test("a confirmation followed by more output in the same chunk still counts", () => {
  const result = runRestore({ mode: "confirm-with-output" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /Restore complete\./);
  assert.doesNotMatch(result.output, /COMMIT not confirmed|is uncertain|FATAL/);
});

test("the server status check is bounded: a stalled query or a transaction still in progress stays uncertain, exit 1", async () => {
  // Both run at once: each takes the whole 15 s status wait.
  const results = await Promise.all(
    ["hang", "in-progress"].map(async (xact) => {
      const f = fixture();
      try {
        const started = Date.now();
        const child = spawn(
          process.execPath,
          [restore, f.archive, "--confirm", "RESTORE:restore_fixture"],
          { env: f.env("exit:7", xact), stdio: ["ignore", "pipe", "pipe"], detached: true },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const closed = once(child, "close").then(([code]) => code);
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        const code = await Promise.race([
          closed,
          new Promise((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout("timeout"), 40_000);
          }),
        ]);
        clearTimeout(timer);
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone (ESRCH).
        }
        await closed;
        return { xact, code, output, seconds: (Date.now() - started) / 1000 };
      } finally {
        f.cleanup();
      }
    }),
  );
  for (const { xact, code, output, seconds } of results) {
    assert.equal(code, 1, `${xact}:\n${output}`);
    assert.match(
      output,
      xact === "hang"
        ? /COMMIT not confirmed; the server reports the restore transaction as unavailable \(the status query timed out\)/
        : /COMMIT not confirmed; the server reports the restore transaction as still in progress/,
      xact,
    );
    assert.match(output, /is uncertain/, xact);
    assert.doesNotMatch(output, /rolled back|is unchanged|Restore complete/, xact);
    // About the 15 s wait, never unbounded.
    assert.ok(seconds < 30, `${xact} took ${seconds} s`);
  }
});

test("a session that confirmed COMMIT and then failed says the restore committed, exit 1", () => {
  const result = runRestore({ mode: "confirm-then-exit:2" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(
    result.output,
    /the restore session confirmed COMMIT, then failed \(psql exit 2\)\. .* is restored \(the transaction committed\)/,
  );
  assert.doesNotMatch(result.output, /Restore complete\.|rolled back|is uncertain/);
});

test("a COMMIT the session never confirms is uncertain, never 'Restore complete'", () => {
  const result = runRestore({ mode: "commit-unconfirmed" });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(
    result.output,
    /restore failed after COMMIT was sent \(psql exit 0, COMMIT not confirmed; the server reports the restore transaction as unknown\)\. The outcome .* is uncertain/,
  );
  assert.doesNotMatch(result.output, /Restore complete|rolled back/);
});

test("a signal after COMMIT succeeded exits 0: restore completed; then interrupted", async () => {
  // The summary query after COMMIT hangs; SIGTERM arrives while it runs.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const result = await interruptRestore({
      mode: "hang-summary",
      marker: (f) => `${f.receipt}.summary`,
      signal,
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commit, "commit observed");
    assert.match(result.output, new RegExp(`Restore completed; then interrupted by ${signal}`));
    assert.doesNotMatch(result.output, /rolled back|uncertain|REFUSED/);
  }
});

test("a signal after the session confirmed COMMIT, before psql exits, exits 0: restore completed", async () => {
  const result = await interruptRestore({
    mode: "hang-after-confirm",
    marker: (f) => `${f.receipt}.confirmed`,
    signal: "SIGTERM",
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.commit, "commit observed");
  assert.match(result.output, /Restore completed; then interrupted by SIGTERM/);
  assert.doesNotMatch(result.output, /rolled back|is uncertain|REFUSED/);
});

test("a signal after COMMIT was sent but before it was confirmed is uncertain, never 'rolled back'", async () => {
  const result = await interruptRestore({
    mode: "hang-after-commit",
    marker: (f) => f.receipt,
    signal: "SIGTERM",
  });
  assert.equal(result.code, 143, result.output);
  assert.match(
    result.output,
    /interrupted by SIGTERM after COMMIT was sent; the outcome for the target is uncertain/,
  );
  assert.doesNotMatch(result.output, /rolled back|Restore completed/);
});

test("an archive with large objects is refused before anything changes (exit 3)", () => {
  const result = runRestore({ mode: "blob" });
  assert.equal(result.status, 3, result.output);
  assert.equal(result.commit, null);
  assert.match(result.output, /REFUSED: the archive contains large objects/);
});

test("a source the checks reject with an ordinary error (S3 bucket mismatch) is a refusal, exit 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "backup-restore-s3-refusal-"));
  try {
    const result = spawnSync(
      process.execPath,
      [restore, "s3://some-other-bucket/backups/manual-20261113T000000Z.dump", "--etag", "abc"],
      {
        env: {
          PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
          DATABASE_URL: "postgresql://127.0.0.1/restore_fixture",
          BACKUP_S3_BUCKET: "the-backup-bucket",
          BACKUP_S3_ACCESS_KEY_ID: "test-key",
          BACKUP_S3_SECRET_ACCESS_KEY: "test-secret",
          BACKUP_S3_ENDPOINT: "http://127.0.0.1:9",
          BACKUP_S3_REGION: "us-east-1",
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 3, output);
    assert.match(output, /REFUSED: /);
    assert.doesNotMatch(output, /Restoring into|test-secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signal while the source is still being verified is a refusal, exit 3 (nothing changed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backup-restore-signal-"));
  try {
    const archive = join(dir, "manual-20261113T000000Z.dump");
    writeFileSync(archive, "PGDMP-inert-test-archive");
    // pg_restore --list hangs, as a slow archive check would.
    writeFileSync(
      join(dir, "pg_restore"),
      `#!/bin/sh
if [ "$1" = --version ]; then echo "pg_restore (PostgreSQL) 18.0"; exit 0; fi
touch "${join(dir, "listing")}"
exec sleep 30
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "psql"), "#!/bin/sh\necho 180000\n", { mode: 0o755 });
    const child = spawn(
      process.execPath,
      [restore, archive, "--confirm", "RESTORE:restore_fixture"],
      {
        env: {
          PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
          DATABASE_URL: "postgresql://127.0.0.1/restore_fixture",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "listing")) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(join(dir, "listing")), `the archive check never started:\n${output}`);
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 3, output);
    assert.match(output, /cancelled by SIGINT before the restore started — nothing was changed/);
    assert.doesNotMatch(output, /rolled back|uncertain/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the signal handlers are installed before the --list and `latest` scans of /backups", () => {
  // /backups is a fixed path, so a stalled mount cannot be simulated here;
  // pin the order in the source instead.
  const source = readFileSync(restore, "utf8");
  const handlers = source.indexOf("process.once(signal, () => {");
  const scan = source.indexOf('if (args.source === "latest")');
  const list = source.indexOf("if (args.list) {");
  assert.ok(handlers > 0 && scan > 0 && list > 0, "all markers exist");
  assert.ok(handlers < scan, "signal handlers come before the latest scan");
  assert.ok(handlers < list, "signal handlers come before the --list scan");
});

test("a usage error is a refusal, exit 3", () => {
  const result = spawnSync(process.execPath, [restore, "--no-such-flag"], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /REFUSED: /);
});

test("a signal after a reported failure keeps its exit status (1 or 4) and prints no second outcome", async () => {
  // A test-only preload holds the process once at beforeExit (the failure is
  // reported, the exit code set) and marks it, so the signal lands while the
  // process winds down. Without the guard the handler would add a second,
  // contradictory outcome: "Restore completed" (exit 0) after a commit,
  // "interrupted ... rolled back" before COMMIT. The preload
  // can also inject a throw, to reach the two failure reports of the
  // top-level catch: after the commit (the closing summary's log throws) and
  // once the restore started, before COMMIT (spawning pg_restore throws).
  for (const [mode, inject, signal, reported, status] of [
    [
      "confirm-then-exit:2",
      "",
      "SIGTERM",
      /the restore session confirmed COMMIT, then failed \(psql exit 2\)/,
      1,
    ],
    ["dump-fail", "", "SIGHUP", /COMMIT was never sent, so the transaction was rolled back/, 4],
    [
      "exit:0",
      "after-commit",
      "SIGTERM",
      /FATAL: the restore was committed, then: injected after commit/,
      1,
    ],
    [
      "exit:0",
      "at-apply",
      "SIGINT",
      /ROLLED BACK: injected at apply\. COMMIT was never sent, so the restore transaction was rolled back; the target is unchanged/,
      4,
    ],
  ]) {
    const f = fixture();
    const held = join(f.dir, "held-at-exit");
    const hold = join(f.dir, "hold-at-exit.cjs");
    writeFileSync(
      hold,
      `const inject = ${JSON.stringify(inject)};
if (inject === "after-commit") {
  const log = console.log;
  console.log = (...args) => {
    if (String(args[0]).startsWith("\\nRestore complete.")) throw new Error("injected after commit");
    log(...args);
  };
} else if (inject === "at-apply") {
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, ...rest) => {
    if (command === "pg_restore" && args.includes("--file=-")) throw new Error("injected at apply");
    return spawn(command, args, ...rest);
  };
  require("node:module").syncBuiltinESMExports();
}
process.once("beforeExit", () => {
  require("node:fs").writeFileSync(${JSON.stringify(held)}, "held");
  setTimeout(() => {}, 5000);
});
`,
    );
    const child = spawn(
      process.execPath,
      ["--require", hold, restore, f.archive, "--confirm", "RESTORE:restore_fixture"],
      { env: f.env(mode), stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    const closed = once(child, "close").then(([code]) => code);
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    try {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const deadline = Date.now() + 10_000;
      while (!existsSync(held) && Date.now() < deadline) await delay(50);
      assert.ok(existsSync(held), `the restore never reached its exit:\n${output}`);
      child.kill(signal);
      const code = await Promise.race([
        closed,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), 15_000);
        }),
      ]);
      const label = `${mode}${inject ? ` + ${inject}` : ""} + ${signal}`;
      assert.equal(code, status, `${label}:\n${output}`);
      assert.match(output, reported, label);
      assert.doesNotMatch(output, /Restore completed|interrupted by|REFUSED/, label);
    } finally {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone (ESRCH).
      }
      await closed;
      f.cleanup();
    }
  }
});

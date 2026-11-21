import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  describeUrl,
  isLocalHost,
  localDatabaseNames,
  shadowName,
  withDatabase,
  worktreeName,
} from "./local-db-name.mjs";

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      stdio: "ignore",
    },
  );

test("main checkout uses ws-model-proxy (or EXPECTED_DB); a linked worktree gets its own exact name", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbname-"));
  try {
    git(dir, "init", "-q", "main");
    git(path.join(dir, "main"), "commit", "-q", "--allow-empty", "-m", "init");
    git(path.join(dir, "main"), "worktree", "add", "-q", path.join(dir, "wt"), "-b", "wt");
    const env = {};
    const main = localDatabaseNames({ cwd: path.join(dir, "main"), env });
    assert.deepEqual(
      [main.main, main.shadow, main.worktree],
      ["ws-model-proxy", "ws-model-proxy_shadow", false],
    );
    assert.equal(
      localDatabaseNames({ cwd: path.join(dir, "main"), env: { EXPECTED_DB: "myapp" } }).main,
      "myapp",
    );
    const wt = localDatabaseNames({ cwd: path.join(dir, "wt"), env: { EXPECTED_DB: "myapp" } });
    assert.match(wt.main, /^ws_model_proxy_wt_[0-9a-f]{10}$/);
    assert.equal(wt.shadow, `${wt.main}_shadow`);
    assert.equal(wt.worktree, true);
    assert.equal(localDatabaseNames({ cwd: path.join(dir, "wt"), env }).main, wt.main, "stable");
    assert.ok(wt.shadow.length < 63);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outside git behaves as the main checkout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbname-nogit-"));
  try {
    assert.equal(
      localDatabaseNames({ cwd: dir, env: { GIT_CEILING_DIRECTORIES: tmpdir() } }).main,
      "ws-model-proxy",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("helpers", () => {
  assert.notEqual(worktreeName("/a/.git/worktrees/x"), worktreeName("/b/.git/worktrees/x"));
  assert.equal(shadowName("ws-model-proxy"), "ws-model-proxy_shadow");
  assert.equal(
    describeUrl(withDatabase("postgresql://u:p@[::1]:5433/ws-model-proxy", "x")).database,
    "x",
  );
  assert.deepEqual(describeUrl("postgresql://u:p@[::1]/s"), {
    host: "::1",
    port: "5432",
    database: "s",
  });
  assert.equal(isLocalHost("host.docker.internal"), false);
});

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { applyLocal } from "./apply.mjs";
import {
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_ADVISORY_LOCK,
  readMigrationsFolder,
} from "./lib/migration-state.mjs";
import { MIGRATIONS_DIR } from "./lib/prisma.mjs";

const URL_ = `postgresql://${["u", "p"].join(":")}@localhost/db`;

/** A fake `pg` over one failed (unfinished) 0_init row and a set of held locks. */
function fakePg(checksum, held) {
  const calls = [];
  return {
    calls,
    pg: {
      Client: class {
        async connect() {}
        async end() {}
        escapeIdentifier(name) {
          return `"${name}"`;
        }
        async query(sql, params = []) {
          calls.push(sql);
          if (/pg_try_advisory_lock/.test(sql)) {
            if (held.has(MIGRATION_RUNNER_LOCK_KEY)) return { rows: [{ acquired: false }] };
            return { rows: [{ acquired: true }] };
          }
          if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
          if (/pg_locks/.test(sql)) return { rows: [{ held: held.has(params[0]) }] };
          if (/to_regclass/.test(sql)) return { rows: [{ t: "_prisma_migrations" }] };
          return {
            rows: [
              {
                migration_name: "0_init",
                checksum,
                finished_at: null,
                rolled_back_at: null,
                logs: null,
              },
            ],
          };
        }
      },
    },
  };
}

describe("db:migrate:apply never resolves a migration another session is applying", () => {
  let dir;
  let checksum;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "apply-"));
    mkdirSync(path.join(dir, "0_init"));
    // The shipped baseline: a real transactional migration with its commit marker.
    copyFileSync(
      path.join(MIGRATIONS_DIR, "0_init", "migration.sql"),
      path.join(dir, "0_init", "migration.sql"),
    );
    [{ checksum }] = readMigrationsFolder(dir);
    mock.method(console, "error", () => {});
    mock.method(console, "log", () => {});
  });
  afterEach(() => {
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (held) => {
    const { pg, calls } = fakePg(checksum, new Set(held));
    const prismaCalls = [];
    const code = await applyLocal({
      url: URL_,
      pg: /** @type {typeof import("pg")} */ (/** @type {unknown} */ (pg)),
      migrationsDir: dir,
      prisma: async (args) => {
        prismaCalls.push(args.join(" "));
        return { code: 0 };
      },
    });
    return { code, prismaCalls, calls };
  };

  test("Prisma's lock held (a deploy is mid-migration): refuses, runs no prisma command", async () => {
    const { code, prismaCalls } = await run([PRISMA_ADVISORY_LOCK]);
    assert.equal(code, 1);
    assert.deepEqual(prismaCalls, []);
  });

  test("runner lock held (a production runner or restore): refuses, runs no prisma command", async () => {
    const { code, prismaCalls } = await run([MIGRATION_RUNNER_LOCK_KEY]);
    assert.equal(code, 1);
    assert.deepEqual(prismaCalls, []);
  });

  test("nobody applying: takes the runner lock, resolves, deploys, releases", async () => {
    const { code, prismaCalls, calls } = await run([]);
    assert.equal(code, 0);
    assert.deepEqual(prismaCalls, [
      "migrate resolve --rolled-back 0_init",
      "migrate " + "deploy",
      "generate",
    ]);
    assert.ok(calls.some((sql) => /pg_try_advisory_lock\(72707370\)/.test(sql)));
    assert.ok(calls.some((sql) => /pg_advisory_unlock\(72707370\)/.test(sql)));
  });
});

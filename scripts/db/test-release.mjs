/**
 * Real-Postgres scenarios for release migrations (scripts/db/lib/replaces.mjs),
 * run by `pnpm db:test-migrations` against its DISPOSABLE server. The real
 * runner (migrate-runtime.mjs) and real Prisma apply hand-built folders:
 *
 *   0_init  t(id, a, z)
 *   P1      ADD COLUMN b + backfill b = upper(a)
 *   P2      ADD COLUMN c + copy c = a; contract.sql drops a   (a copy rename)
 *   P3      CREATE TABLE u; contract.sql drops z
 *   R       the release: P1..P3 squashed by buildRelease (release-squash.mjs)
 *   P4      after the release
 *
 * Every database, whichever prefix of P1..P3 it had applied, ends with the
 * fresh database's schema and its rows' values, and the runner refuses a
 * tampered replaced/ copy, a checksum mismatch and an unknown migration.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembled so policy greps never read the fixtures as live commands.
const DROP = "DROP";

/**
 * @param {{ step: (name: string, fn: () => Promise<void>) => Promise<void>,
 *   serverUrl: string, repo: string, pg: typeof import("pg") }} context
 */
export async function releaseScenarios({ step, serverUrl, repo, pg }) {
  const lib = (file) => import(path.join(repo, "scripts/db", file));
  const { run } = await lib("migrate-runtime.mjs");
  const { prisma, tempConfig } = await lib("lib/prisma.mjs");
  const { catalogFromSql, wrapTransactional } = await lib("lib/sql.mjs");
  const { buildRelease } = await lib("release-squash.mjs");
  const { FINGERPRINT_SQL } = await lib("check-migrations.mjs");
  const { applyLocal } = await lib("apply.mjs");

  const work = mkdtempSync(path.join(tmpdir(), "wmp-release-e2e-"));
  const urlFor = (db) => {
    const url = new URL(serverUrl);
    url.pathname = `/${db}`;
    return url.toString();
  };
  const q = async (db, text, params) => {
    const client = new pg.Client({ connectionString: urlFor(db) });
    await client.connect();
    try {
      return (await client.query(text, params)).rows;
    } finally {
      await client.end();
    }
  };
  // Unique per run, created and removed only through the scratch helper
  // (scripts/db/lib/scratch-db.mjs), and only the databases this run created.
  const { adminClient, createDatabase, removeDatabase } = await lib("lib/scratch-db.mjs");
  const admin = await adminClient(pg, serverUrl);
  const runId = randomBytes(4).toString("hex");
  const created = [];
  let dbs = 0;
  const createDb = async () => {
    const db = `wmp_test_rel${runId}${dbs++}`;
    if (!(await createDatabase(admin, db))) throw new Error(`${db} already exists`);
    created.push(db);
    return db;
  };
  const sha = (text) => createHash("sha256").update(text).digest("hex");

  const F0 = "0_init";
  const P1 = "20990101000000_add_b";
  const P2 = "20990102000000_copy_a_to_c";
  const P3 = "20990103000000_add_u";
  const P4 = "20990201000000_after_release";
  const R = "20990110000000_release_2_0_0";
  const FOLDERS = {
    [F0]: {
      sql: wrapTransactional(
        `CREATE TABLE "t" ("id" INTEGER NOT NULL, "a" TEXT, "z" TEXT, CONSTRAINT "t_pkey" PRIMARY KEY ("id"));`,
      ),
    },
    [P1]: {
      sql: wrapTransactional(
        `ALTER TABLE "t" ADD COLUMN "b" TEXT;\nUPDATE "t" SET "b" = upper("a") WHERE "b" IS NULL;`,
      ),
    },
    [P2]: {
      sql: wrapTransactional(
        `ALTER TABLE "t" ADD COLUMN "c" TEXT;\nUPDATE "t" SET "c" = "a" WHERE "c" IS NULL;`,
      ),
      contract: `-- intentional: drop and recreate\nALTER TABLE "t" ${DROP} COLUMN "a";\n`,
    },
    [P3]: {
      sql: wrapTransactional(
        `CREATE TABLE "u" ("id" INTEGER NOT NULL, "t_id" INTEGER NOT NULL, CONSTRAINT "u_pkey" PRIMARY KEY ("id"));\nCREATE INDEX "u_t_id_idx" ON "u"("t_id");`,
      ),
      contract: `ALTER TABLE "t" ${DROP} COLUMN "z";\n`,
    },
    [P4]: { sql: wrapTransactional(`ALTER TABLE "u" ADD COLUMN "label" TEXT;`) },
  };
  const asMigration = (name) => ({
    name,
    sql: FOLDERS[name].sql,
    checksum: sha(FOLDERS[name].sql),
    contract: FOLDERS[name].contract
      ? { sql: FOLDERS[name].contract, checksum: sha(FOLDERS[name].contract) }
      : null,
  });
  const built = buildRelease({ release: R, tag: "v1", migrations: [P1, P2, P3].map(asMigration) });
  assert.deepEqual(built.problems, []);
  const IMAGE = catalogFromSql(
    `CREATE TABLE "t" ("id" INTEGER NOT NULL, "b" TEXT, "c" TEXT, CONSTRAINT "t_pkey" PRIMARY KEY ("id"));\nCREATE TABLE "u" ("id" INTEGER NOT NULL, "t_id" INTEGER NOT NULL, "label" TEXT, CONSTRAINT "u_pkey" PRIMARY KEY ("id"));`,
  );

  /** A migrations dir: plain folders, the release (with or without its copies), edits. */
  const image = (names, { copies = true, tamper = false, edit = {} } = {}) => {
    const dir = mkdtempSync(path.join(work, "m-"));
    writeFileSync(path.join(dir, "migration_lock.toml"), 'provider = "postgresql"\n');
    for (const name of names) {
      const folder = path.join(dir, name);
      mkdirSync(folder);
      if (name === R) {
        writeFileSync(path.join(folder, "migration.sql"), built.migrationSql);
        writeFileSync(path.join(folder, "contract.sql"), built.contractSql);
        if (!copies) continue;
        writeFileSync(path.join(folder, "replaces.json"), JSON.stringify(built.manifest));
        for (const m of [P1, P2, P3]) {
          mkdirSync(path.join(folder, "replaced", m), { recursive: true });
          const sql = tamper && m === P2 ? `${FOLDERS[m].sql}-- tampered\n` : FOLDERS[m].sql;
          writeFileSync(path.join(folder, "replaced", m, "migration.sql"), sql);
          if (FOLDERS[m].contract)
            writeFileSync(path.join(folder, "replaced", m, "contract.sql"), FOLDERS[m].contract);
        }
        continue;
      }
      writeFileSync(path.join(folder, "migration.sql"), edit[name] ?? FOLDERS[name].sql);
      if (FOLDERS[name].contract)
        writeFileSync(path.join(folder, "contract.sql"), FOLDERS[name].contract);
    }
    return dir;
  };
  const deploy = async (db, dir, options = {}) => {
    const url = urlFor(db);
    const config = tempConfig({ url, migrations: dir });
    const lines = [];
    const original = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    let code;
    try {
      code = await run({
        mode: options.mode ?? "apply",
        env: { DATABASE_URL: url, ...(options.id ? { WMP_INSTANCE_ID: options.id } : {}) },
        migrationsDir: dir,
        runPrisma: (args, opts) =>
          prisma([...args, "--config", config], { ...opts, capture: true }).then((r) => {
            if (r.code !== 0) lines.push(r.stdout, r.stderr);
            return r;
          }),
        backupHook: path.join(work, "no-hook.sh"),
        connectRetryMs: 0,
        pollMs: 100,
        waitTimeoutMs: options.waitTimeoutMs ?? 20_000,
        contracts: { imageCatalog: async () => IMAGE },
      });
    } finally {
      Object.assign(console, original);
      rmSync(path.dirname(config), { recursive: true, force: true });
    }
    return { code, out: lines.join("\n") };
  };
  const ok = (r) => assert.equal(r.code, 0, r.out);
  const history = async (db) =>
    (
      await q(
        db,
        `SELECT migration_name FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY migration_name`,
      )
    ).map((r) => r.migration_name);
  const fingerprint = async (db) => (await q(db, FINGERPRINT_SQL)).map((r) => r.line);
  const seed = (db) =>
    q(
      db,
      `INSERT INTO "t" ("id", "a", "z") VALUES (1, 'one', 'z1'), (2, NULL, NULL), (3, 'Three', 'z3')`,
    );
  const rows = (db) => q(db, `SELECT "id", "b", "c" FROM "t" ORDER BY "id"`);
  const EXPECTED_ROWS = [
    { id: 1, b: "ONE", c: "one" },
    { id: 2, b: null, c: null },
    { id: 3, b: "THREE", c: "Three" },
  ];
  /** Every live instance's release has soaked: due contracts run on the next deploy. */
  const soakOver = async (db) => {
    await q(db, `UPDATE "_wmp_instance" SET last_seen_at = now() - interval '8 days'`);
    await q(
      db,
      `INSERT INTO "_wmp_instance" (id, role, schema_level, host, ready_at, contract_folders)
       VALUES ($1, 'server', $2, 'test', now() - interval '8 days', $3::text[])`,
      [randomUUID(), R, [R]],
    );
  };

  const at = (k) => [F0, P1, P2, P3].slice(0, k + 1);
  const RELEASE = [F0, R];
  try {
    // Reference: a fresh database at the release (every contract runs at once).
    const fresh = await createDb();
    await step("release: a fresh database applies 0_init and the release normally", async () => {
      ok(await deploy(fresh, image(RELEASE)));
      assert.deepEqual(await history(fresh), [F0, R]);
      const columns = await q(
        fresh,
        `SELECT column_name FROM information_schema.columns WHERE table_name = 't' ORDER BY 1`,
      );
      assert.deepEqual(
        columns.map((c) => c.column_name),
        ["b", "c", "id"],
      );
    });
    const reference = await fingerprint(fresh);

    for (let k = 0; k <= 3; k++) {
      await step(
        `release: a served database that applied ${k} of the 3 replaced migrations is reconciled, with its rows intact`,
        async () => {
          const db = await createDb();
          ok(await deploy(db, image([F0])));
          await seed(db);
          // Not fresh from here on: contracts wait for the soak.
          if (k) ok(await deploy(db, image(at(k))));
          const r = await deploy(db, image(RELEASE));
          ok(r);
          if (k === 3) assert.match(r.out, /had all 3 migration\(s\) it replaces/);
          else if (k > 0) assert.match(r.out, new RegExp(`had ${k} of the 3 migration\\(s\\)`));
          assert.deepEqual(await history(db), [F0, R]);
          assert.deepEqual(await rows(db), EXPECTED_ROWS);
          await soakOver(db);
          ok(await deploy(db, image(RELEASE)));
          assert.deepEqual(await fingerprint(db), reference);
        },
      );
    }

    await step(
      "release: replaced contracts that already ran are carried over (all → applied, some → only the rest runs)",
      async () => {
        // A fresh database at P2 runs P2's contract at once: "some" (P3's has not run).
        const some = await createDb();
        ok(await deploy(some, image(at(2))));
        const r = await deploy(some, image(RELEASE));
        ok(r);
        assert.match(r.out, /some replaced scheduled deletions already ran/);
        const row = (await q(some, `SELECT * FROM "_wmp_migration" WHERE name = $1`, [R]))[0];
        assert.deepEqual(row.contract_done_parts, [P2]);
        assert.equal(row.contract_applied_at, null);
        // Part of the data an older release needs is gone: no rollback admission.
        assert.equal(row.rollback_safe, false);
        assert.match(row.rollback_reasons, new RegExp(`scheduled deletions of ${P2} already ran`));
        await soakOver(some);
        ok(await deploy(some, image(RELEASE)));
        assert.deepEqual(await fingerprint(some), reference);
        // A fresh database at P3 ran every replaced contract: "all".
        const all = await createDb();
        ok(await deploy(all, image(at(3))));
        const r2 = await deploy(all, image(RELEASE));
        ok(r2);
        assert.match(r2.out, /every replaced scheduled deletion already ran/);
        const row2 = (await q(all, `SELECT * FROM "_wmp_migration" WHERE name = $1`, [R]))[0];
        assert.notEqual(row2.contract_applied_at, null);
        assert.equal(row2.rollback_safe, false);
        assert.deepEqual(await fingerprint(all), reference);
      },
    );

    await step(
      "release: a replaced deletion that ran with another contract.sql is refused",
      async () => {
        const db = await createDb();
        ok(await deploy(db, image(at(2))));
        await q(db, `UPDATE "_wmp_migration" SET contract_checksum = $2 WHERE name = $1`, [
          P2,
          "0".repeat(64),
        ]);
        const r = await deploy(db, image(RELEASE));
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /is not the one .*replaces\.json records \(checksum mismatch\)/);
        assert.deepEqual(await history(db), [F0, P1, P2]);
      },
    );

    await step(
      "release: a plan made stale by another session (it committed P2, then died before recording it) aborts before any SQL runs",
      async () => {
        const { planReconcile, readReleases, applyReconcile, READ_HISTORY_SQL, wrappedBody } =
          await lib("lib/replaces.mjs");
        const db = await createDb();
        ok(await deploy(db, image(at(1))));
        const { releases } = readReleases(image(RELEASE));
        const localNames = [F0, R];
        const plan = planReconcile({
          rows: await q(db, READ_HISTORY_SQL("public")),
          releases,
          localNames,
        });
        assert.deepEqual(
          plan.steps[0].missing.map((e) => e.name),
          [P2, P3],
        );
        // Meanwhile an operator's `prisma migrate deploy` ran P2: its transaction
        // committed (the commit marker is in `logs`), then it died before
        // Prisma recorded finished_at.
        await q(db, wrappedBody(FOLDERS[P2].sql));
        await q(
          db,
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, logs, started_at, applied_steps_count)
           VALUES ($1, $2, $3, 'wmp:committed', now(), 0)`,
          [randomUUID(), sha(FOLDERS[P2].sql), P2],
        );
        const client = new pg.Client({ connectionString: urlFor(db) });
        await client.connect();
        try {
          await assert.rejects(
            applyReconcile(client, { schema: "public", step: plan.steps[0], releases, localNames }),
            new RegExp(`${P2} of ${R} are recorded as failed`),
          );
        } finally {
          await client.end();
        }
        // Untouched: P2's unfinished row stays for a person (Recovery runbook).
        assert.deepEqual(await history(db), [F0, P1, P2]);
        assert.equal(
          (await q(db, `SELECT to_regclass('"u"')::text AS u`))[0].u,
          null,
          "P3 did not run",
        );
      },
    );

    await step("release: a tampered replaced/ copy refuses to start, nothing changed", async () => {
      const db = await createDb();
      ok(await deploy(db, image(at(1))));
      for (const mode of ["apply", "wait"]) {
        const r = await deploy(db, image(RELEASE, { tamper: true }), { mode, waitTimeoutMs: 500 });
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /release manifests are not intact/);
        assert.match(
          r.out,
          /does not match the checksum in replaces\.json \(edited or tampered with\)/,
        );
      }
      assert.deepEqual(await history(db), [F0, P1]);
    });

    await step(
      "release: an applied replaced migration with other contents is refused",
      async () => {
        const db = await createDb();
        const edited = image(at(2), {
          edit: { [P2]: wrapTransactional(`ALTER TABLE "t" ADD COLUMN "c" TEXT;`) },
        });
        ok(await deploy(db, edited));
        const r = await deploy(db, image(RELEASE));
        assert.equal(r.code, 1, r.out);
        assert.match(
          r.out,
          /were applied with different contents than .*replaces\.json records \(checksum mismatch\)/,
        );
        assert.deepEqual(await history(db), [F0, P1, P2]);
      },
    );

    await step(
      "release: an applied migration that is neither in the image nor replaced is refused",
      async () => {
        const db = await createDb();
        FOLDERS["20990105000000_other_branch"] = {
          sql: wrapTransactional(`CREATE TABLE "other" ("id" INTEGER);`),
        };
        ok(await deploy(db, image([...at(1), "20990105000000_other_branch"])));
        const r = await deploy(db, image(RELEASE));
        assert.equal(r.code, 1, r.out);
        assert.match(
          r.out,
          /neither in this image nor replaced by one of its releases: 20990105000000_other_branch/,
        );
        assert.deepEqual(await history(db), [F0, P1, "20990105000000_other_branch"]);
      },
    );

    await step("release: followers wait while the leader reconciles", async () => {
      const db = await createDb();
      ok(await deploy(db, image(at(3))));
      const waiting = await deploy(db, image(RELEASE), { mode: "wait", waitTimeoutMs: 400 });
      assert.equal(waiting.code, 1, waiting.out);
      assert.match(waiting.out, /timed out .* waiting for the database to be up to date/);
      assert.doesNotMatch(waiting.out, /older than the database/);
      ok(await deploy(db, image(RELEASE)));
      ok(await deploy(db, image(RELEASE), { mode: "wait" }));
    });

    await step(
      "release: one release later (replaced/ removed) a reconciled database deploys; one that never passed the release is refused",
      async () => {
        const later = [F0, R, P4];
        const passed = await createDb();
        ok(await deploy(passed, image(at(2))));
        ok(await deploy(passed, image(RELEASE)));
        ok(await deploy(passed, image(later, { copies: false })));
        assert.deepEqual(await history(passed), [F0, R, P4]);
        const stale = await createDb();
        ok(await deploy(stale, image(at(1))));
        const r = await deploy(stale, image(later, { copies: false }));
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /older than the database/);
        assert.deepEqual(await history(stale), [F0, P1]);
      },
    );

    await step("release: db:migrate:apply reconciles a local database the same way", async () => {
      const db = await createDb();
      ok(await deploy(db, image(at(2))));
      const dir = image(RELEASE);
      const url = urlFor(db);
      const config = tempConfig({ url, migrations: dir });
      const lines = [];
      const original = { log: console.log, error: console.error };
      console.log = (...a) => lines.push(a.join(" "));
      console.error = (...a) => lines.push(a.join(" "));
      let code;
      try {
        code = await applyLocal({
          url,
          pg,
          migrationsDir: dir,
          prisma: (args) =>
            args[0] === "generate"
              ? Promise.resolve({ code: 0 })
              : prisma([...args, "--config", config], { capture: true }),
        });
      } finally {
        Object.assign(console, original);
        rmSync(path.dirname(config), { recursive: true, force: true });
      }
      assert.equal(code, 0, lines.join("\n"));
      assert.match(
        lines.join("\n"),
        /reconciled the 2 replaced migration\(s\) you had applied \(applied the missing 20990103000000_add_u\)/,
      );
      assert.deepEqual(await history(db), [F0, R]);
    });
  } finally {
    for (const db of created) await removeDatabase(admin, db, { kind: "scratch" }).catch(() => {});
    await admin.end().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Standalone: `node scripts/db/test-release.mjs --server-url <superuser url>`
 * (a DISPOSABLE server; it creates its own uniquely named scratch databases
 * and removes exactly those at the end). `pnpm db:test-migrations` runs the
 * same scenarios.
 */
async function main() {
  const i = process.argv.indexOf("--server-url");
  const serverUrl = i >= 0 ? process.argv[i + 1] : undefined;
  if (!serverUrl) {
    console.error(
      "usage: node scripts/db/test-release.mjs --server-url <disposable superuser url>",
    );
    process.exit(2);
  }
  const { loadPg, ROOT } = await import("./lib/prisma.mjs");
  const pg = loadPg();
  const results = [];
  const step = async (name, fn) => {
    try {
      await fn();
      results.push(true);
      console.log(`ok   ${name}`);
    } catch (error) {
      results.push(false);
      console.log(`FAIL ${name}\n     ${error instanceof Error ? error.stack : String(error)}`);
    }
  };
  await releaseScenarios({ step, serverUrl, repo: ROOT, pg });
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

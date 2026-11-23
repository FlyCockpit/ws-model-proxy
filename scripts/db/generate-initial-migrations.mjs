#!/usr/bin/env node
/**
 * Regenerates 0_init, the baseline that replaces `prisma db push` +
 * schema-hardening.sql in 1.0 (see scripts/db/lib/baseline.mjs), and the
 * hardening section of the 1.0 upgrade migration:
 *
 *   0_init/migration.sql
 *     Prisma's from-empty SQL for the schema of the released BASELINE_RELEASE
 *     (git tag), then that release's packages/db/prisma/schema-hardening.sql
 *     without its BEGIN/COMMIT. A released 0.4.3 database holds exactly this
 *     schema, which is what lets the runner adopt it automatically.
 *
 * It gets the standard transactional wrapper (scripts/db/lib/sql.mjs).
 *
 *   <UPGRADE_MIGRATION>/migration.sql, `-- section hardening` only
 *     packages/db/prisma/schema-hardening.sql's body, its LOCK retried
 *     (`upgradeHardening`). The rest of that migration is no longer
 *     generated: it was Prisma's diff from the BASELINE_RELEASE schema, and
 *     the release cut folded the per-PR migrations after it into it verbatim
 *     and made its column adds IF NOT EXISTS for the 0.4.x build variant
 *     (BASELINE_VARIANTS); a fresh diff would lose both.
 *
 *   node scripts/db/generate-initial-migrations.mjs
 *     write both
 *   node scripts/db/generate-initial-migrations.mjs --check
 *     exit 1 when either differs from what would be generated
 *
 * Only before 1.0.0 is released. Once a release ships the folder it is
 * immutable like every released migration (CI check 3). Needs the
 * BASELINE_RELEASE tag in the local clone (`git fetch --tags`); no database.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardeningSqlBody } from "../../packages/db/scripts/hardening-sql.mjs";
import { BASELINE_MIGRATION, BASELINE_RELEASE, UPGRADE_MIGRATION } from "./lib/baseline.mjs";
import { MIGRATIONS_DIR, prisma, ROOT } from "./lib/prisma.mjs";
import { wrapTransactional } from "./lib/sql.mjs";

const RELEASE_SCHEMA_DIR = "packages/db/prisma/schema";
const RELEASE_HARDENING = "packages/db/prisma/schema-hardening.sql";
/** The 1.0 hardening: edited in this file, copied into the upgrade migration. */
export const CURRENT_HARDENING = "packages/db/prisma/schema-hardening.sql";
const SECTION_PREFIX = "-- section";

/** The body of a hardening file without its outer BEGIN/COMMIT (strict; see hardening-sql.mjs). */
export const hardeningBody = hardeningSqlBody;

export function section(name, sql) {
  return `${SECTION_PREFIX} ${name}\n${sql.trim()}\n${SECTION_PREFIX} end ${name}`;
}

/** `sql` with the body of its one section `name` replaced by `body`. */
export function replaceSection(sql, name, body) {
  readSection(sql, name);
  const start = `${SECTION_PREFIX} ${name}\n`;
  const end = `\n${SECTION_PREFIX} end ${name}`;
  const [before, rest] = sql.split(start);
  return `${before}${section(name, body)}${rest.slice(rest.indexOf(end) + end.length)}`;
}

export function readSection(sql, name) {
  const start = `${SECTION_PREFIX} ${name}\n`;
  const end = `\n${SECTION_PREFIX} end ${name}`;
  const parts = sql.split(start);
  if (parts.length !== 2 || parts[1].split(end).length !== 2)
    throw new Error(`missing or ambiguous section "${name}"`);
  return parts[1].split(end)[0];
}

/**
 * DL-1 (packages/db/src/capacity-lock-order.ts): the hardening takes every
 * table in one up-front `LOCK TABLE … NOWAIT`, so it never waits on a lock
 * while holding one. The former wrapper retried a busy table for up to 60 s;
 * a migration fails whole on the first 55P03 instead, and the runner retries
 * it only once. The upgrade runs while the 0.4.3 server may still be serving
 * (Dokploy starts the new container first), so its LOCK is retried in place:
 * each attempt is a subtransaction, which a failed NOWAIT rolls back together
 * with any table it had already locked, then a short random sleep. The body
 * keeps never waiting while it holds a lock; about 30 s of attempts fit the
 * wrapper's 60 s statement_timeout.
 */
export function upgradeHardening(body) {
  const locks = [...body.matchAll(/^LOCK TABLE ([\s\S]*?) IN ACCESS EXCLUSIVE MODE NOWAIT;$/gm)];
  if (locks.length !== 1)
    throw new Error(`expected exactly one LOCK ... NOWAIT in the hardening, found ${locks.length}`);
  const [statement] = locks[0];
  const retried = [
    "DO $wmp_lock$",
    "DECLARE",
    "  attempt integer := 0;",
    "BEGIN",
    "  LOOP",
    "    BEGIN",
    ...statement.split("\n").map((line) => `      ${line}`),
    "      EXIT;",
    "    EXCEPTION WHEN lock_not_available THEN",
    "      attempt := attempt + 1;",
    "      IF attempt >= 150 THEN",
    "        RAISE;",
    "      END IF;",
    "      PERFORM pg_sleep(0.05 + random() * 0.3);",
    "    END;",
    "  END LOOP;",
    "END",
    "$wmp_lock$;",
  ].join("\n");
  return body.replace(statement, retried);
}

export function initSql(ddl, hardening) {
  return wrapTransactional(
    [
      `-- The schema of the released ${BASELINE_RELEASE}, generated by scripts/db/generate-initial-migrations.mjs:`,
      "-- Prisma's from-empty SQL for its packages/db/prisma/schema, then its schema-hardening.sql.",
      "-- A 0.4.3 database already holds exactly this; the deploy runner adopts it (scripts/db/lib/baseline.mjs).",
      "",
      section("prisma", ddl),
      "",
      section(`hardening ${BASELINE_RELEASE}`, hardening),
    ].join("\n"),
  );
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

async function prismaScript(args) {
  const result = await prisma(["migrate", "diff", ...args, "--script"], { capture: true });
  if (result.code !== 0)
    throw new Error(`prisma migrate diff failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const initFile = path.join(MIGRATIONS_DIR, BASELINE_MIGRATION, "migration.sql");
  const upgradeFile = path.join(MIGRATIONS_DIR, UPGRADE_MIGRATION, "migration.sql");
  const currentHardening = upgradeHardening(
    hardeningBody(readFileSync(path.join(ROOT, CURRENT_HARDENING), "utf8")),
  );

  const work = mkdtempSync(path.join(tmpdir(), "wmp-initial-"));
  try {
    const releaseSchema = path.join(work, "schema");
    mkdirSync(releaseSchema);
    for (const file of git(["ls-tree", "--name-only", BASELINE_RELEASE, `${RELEASE_SCHEMA_DIR}/`])
      .split("\n")
      .filter((name) => name.endsWith(".prisma")))
      writeFileSync(
        path.join(releaseSchema, path.basename(file)),
        git(["show", `${BASELINE_RELEASE}:${file}`]),
      );
    const releaseHardening = hardeningBody(
      git(["show", `${BASELINE_RELEASE}:${RELEASE_HARDENING}`]),
    );
    const ddl = await prismaScript(["--from-empty", "--to-schema", releaseSchema]);
    if (!ddl.includes("CREATE TABLE")) throw new Error("Prisma returned no schema DDL.");

    const outputs = [
      [initFile, initSql(ddl, releaseHardening)],
      [
        upgradeFile,
        replaceSection(readFileSync(upgradeFile, "utf8"), "hardening", currentHardening),
      ],
      [path.join(MIGRATIONS_DIR, "migration_lock.toml"), MIGRATION_LOCK],
    ];
    if (check) {
      const stale = outputs.filter(([file, text]) => {
        try {
          return readFileSync(file, "utf8") !== text;
        } catch {
          return true;
        }
      });
      for (const [file] of stale) console.error(`stale: ${path.relative(ROOT, file)}`);
      if (stale.length) {
        console.error("Run `node scripts/db/generate-initial-migrations.mjs` and review the diff.");
        process.exitCode = 1;
      } else console.log("0_init and the 1.0 upgrade migration's hardening are up to date.");
      return;
    }
    for (const [file, text] of outputs) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`wrote ${path.relative(ROOT, file)}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const MIGRATION_LOCK =
  '# Please do not edit this file manually\n# It should be added in your version-control system (e.g., Git)\nprovider = "postgresql"\n';

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

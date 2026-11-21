# Schema Migrations

> How a schema change gets from `packages/db/prisma/schema/` into every database, how a released 0.4.x database is adopted, how deletions wait until no older release is running, and what to do when that goes wrong. Step-by-step change recipes (add a field, rename, backfill): [schema-changes-recipe.md](./schema-changes-recipe.md). Backups and restore: [backup-and-restore.md](./backup-and-restore.md).

## How it works

Since 1.0 this repo uses **Prisma Migrate** with committed SQL files. Releases up to 0.4.3 used `prisma db push` plus `schema-hardening.sql` under `APPLY_SCHEMA`; that path is gone ([§ Upgrading a 0.4.x database](#upgrading-a-04x-database)).

- `packages/db/prisma/schema/*.prisma` describes what the database should look like.
- `packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` is the exact SQL that gets it there, one folder per change. When the change deletes something, the same folder also holds a `contract.sql` ([§ Expand and contract](#expand-and-contract)). History starts at `0_init`.
- Each database records the migrations it has applied in its `_prisma_migrations` table. `prisma migrate deploy` applies only the ones not recorded yet, in folder order, so it is safe to run on every start: with nothing pending it does nothing.
- `packages/db/prisma/schema-hardening.sql` holds the invariants Prisma cannot express (CHECK constraints, triggers, functions, partial unique indexes, the graph-write fences). It is never applied directly: migrations carry it ([§ The hardening](#the-hardening)).

The SQL is committed and reviewed like code. That is what lets one PR backfill data: you edit the generated SQL before it is applied anywhere.

Three rules never bend:

1. **A migration on the default branch is immutable.** Never edit, rename, or delete it. Fix mistakes with a new migration. CI check 3 enforces this.
2. **Every schema change ships with its migration in the same PR.** A schema edit without SQL fails CI check 1.
3. **Agents never run `prisma migrate dev` or `prisma migrate reset`.** Use the wrappers below. They are guarded to touch only this checkout's own local database.

## Local commands

| Command | What it does |
|---|---|
| `pnpm db:worktree` | Creates this checkout's local database and shadow database if missing, marks each one it creates as a disposable local database, and writes `DATABASE_URL` into this checkout's `.env`. Run once per clone or git worktree (`pnpm setup` runs it). `pnpm db:worktree --adopt` marks databases created before the mark existed; it is for a person at a terminal (it asks for the database name), never an agent. |
| `pnpm db:migrate <name>` | **Generates only.** Diffs what production ends up with (every `migration.sql`, then every `contract.sql`) against the schema, using the shadow database, and writes a new `migrations/<timestamp>_<name>/migration.sql`, plus `contract.sql` when something is deleted. Applies nothing; on a refusal it writes nothing. `--remap 'Enum.OLD=NEW'` removes an enum value, `--recover 'table.old=new'` gets a field back before its deletion runs, `--empty` writes a hand-written migration (data fix, backfill), `--empty --no-transaction` one that cannot run in a transaction. |
| `pnpm db:migrate:apply` | Runs `prisma migrate deploy` against this checkout's local database, then `prisma generate`. Run it after reviewing the generated SQL, and after every pull. A failed local transactional migration is marked rolled back first so you can fix the SQL and apply again. It takes the migration runner lock first and refuses, changing nothing, while another session holds that lock or Prisma's migration lock: a failed-looking row may belong to a deploy that is still applying it. It never applies `contract.sql`. |
| `pnpm db:migrate:rebase` | After rebasing onto the default branch: re-timestamps your unmerged migration folders that no longer sort after the base's latest one, and re-checks consistency on a scratch database. |
| `pnpm db:reset:local` | Drops and recreates **this checkout's own local database** (exact name only, and only when it carries the disposable-local-database mark; `EXPECTED_DB` is refused for this command), applies all migrations and then every `contract.sql`, and regenerates the client. Explicit; nothing calls it for you. A local database created by the old `db:push` has no migration history: reset it once. |
| `pnpm db:check-migrations --base <git-ref>` | Runs the CI migration checks locally ([schema-changes-recipe.md § What CI checks](./schema-changes-recipe.md#what-ci-checks)). Needs `CHECK_DATABASE_URL` pointing at a disposable Postgres superuser URL. |
| `pnpm db:test-unit` | Unit tests of the runner, generator, analyzer and baseline (no database). |
| `pnpm db:test-migrations` | End-to-end test of the migration tooling and the runner against a throwaway `postgres:17` Docker container named `<prefix>-<hex>` (prefix `-- --container-prefix <name>`, else `TEST_CONTAINER_PREFIX`, else `wmp-test-migrations`), or `-- --server-url <superuser url>`. It works in a temporary repo copy that adds a test-only `project` model; nothing in this checkout is written. |
| `pnpm db:studio` / `pnpm db:generate` / `pnpm db:validate` | Browse, regenerate the client, validate the schema (`db:validate` also checks the hardening and the entrypoint, see [§ The hardening](#the-hardening)). |

The everyday loop for an agent:

```bash
# 1. edit packages/db/prisma/schema/*.prisma
pnpm db:migrate add_phone_number     # 2. generate SQL
# 3. read packages/db/prisma/migrations/<timestamp>_add_phone_number/migration.sql
#    (and contract.sql, if any) and edit it if needed (use @map for renames, add a backfill UPDATE)
pnpm db:migrate:apply                # 4. apply locally + regenerate the client
# 5. commit schema + migration folder together
```

**Local databases are per checkout.** The main checkout uses `ws-model-proxy` (or `$EXPECTED_DB`). A linked git worktree uses `ws_model_proxy_wt_<10 hex chars>`, derived from its git directory, so parallel agents in separate worktrees never overwrite each other's schema. Each has a `<name>_shadow` database that `db:migrate` uses for diffing. Every wrapper runs `scripts/assert-local-database.sh`, which refuses anything but the exact names computed for this checkout on `localhost` / `127.0.0.1` / `::1`, and any `DATABASE_URL` query parameter that could redirect the connection. If the guard refuses, it is working: never point a local command at a shared, staging, or production database.

**Reset drops only marked databases.** A localhost URL with the right name is not proof the database is local: an SSH tunnel or port-forward to production on `localhost:5432/ws-model-proxy` passes every name and host check. So `pnpm db:reset:local` also requires a database comment, the disposable-local-database mark, that only this tooling writes on databases it created itself (`pnpm db:worktree`, the shadow database, the scratch checks) and that the dev compose stack writes on a fresh volume (`scripts/db/dev-postgres-init/10-mark-local.sh`). It never marks a database that already existed. An unmarked database is refused and left as is; a person adopts a genuine older local database once with `pnpm db:worktree --adopt`. `EXPECTED_DB` never widens a reset: to rename the main checkout's database, change `DEFAULT_MAIN_DB` in `scripts/db/lib/local-db-name.mjs` together with `docker-compose.dev.yml`.

## Migration file markers

Markers are plain SQL comments in `migration.sql` and `contract.sql`. They are reviewable text, not env vars.

| Marker | Meaning |
|---|---|
| `-- wmp:transactional` | Written by the generator. The body is wrapped in `BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; … COMMIT;` so a failure leaves no partial change and a stuck lock fails fast. `-- wmp:history-capture` (right after the `SET LOCAL` lines) records which table is Prisma's history; `-- wmp:commit-marker` (the last statement before `COMMIT;`) writes, in the same transaction, that this attempt committed. Together they let the runner tell a committed-but-unrecorded attempt from a rolled-back one. Keep every wrapper line byte-for-byte and put your statements between the two blocks. CI rejects a body that uses `RESET`, `DISCARD ALL`, or the `wmp.history` setting. Statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`) go in their own migration without the wrapper and without this marker. |
| `contract.sql` (a file) | Written by the generator when the change deletes something; applied by the deploy runner later ([§ Expand and contract](#expand-and-contract)). Generated `DROP` statements and the enum template only; never hand-write one. |
| `-- wmp:relax v1 "t"."x"` | Generated in `migration.sql` for a dropped NOT NULL column: a placeholder default (or `DROP NOT NULL`) so the old release's inserts keep working until the drop. |
| `-- wmp:enum-remove v1 …` | Generated by `--remap`, same header in both files: the sync trigger and row remap at deploy, the enum rebuild later. The sync trigger is named `0_wmp_sync_<hash>`: BEFORE triggers on a table fire in name order (byte order), so it runs before every trigger with an unquoted name and every quoted one starting with a letter, and they see the new value, never the removed one. Only a quoted name starting with a space, punctuation below `0` (such as `!`, `#`, `-` or `.`), or `0` could sort earlier. |
| `-- wmp:recover v1 "t"."x" -> "y"` | Generated by `--recover`: copies a retired column into a new one while it still exists. |
| `-- wmp:reviewed <reason>` | On the line directly above one `migration.sql` statement the analyzer cannot read (`DO`, `EXECUTE`, a dollar-quoted body, …). An attestation by the author that the running release is unaffected; CI passes it and lists it as "Reviewed by hand", and the release counts as not rollback-safe. Ignored for anything that drops, renames, truncates or changes a type, and for anything naming a `wmp_` object. Never allowed in `contract.sql`. |
| `-- intentional: drop and recreate` | On the line immediately above a single statement. Tells CI check 5 that a drop-and-add on the same table is deliberate, not an accidental rename. |

The generated templates carry a version token (`v1`); CI regenerates each block from its header and compares the exact text. Never edit a released template: add `v2` and keep every earlier version's generator. An image that does not know a version refuses it.

## Released-image adoption test

`CHECK_DATABASE_URL=<disposable localhost Postgres URL> pnpm db:test-adopt-released` runs the published `v0.4.3` image with `APPLY_SCHEMA=safe`, adopts and upgrades that schema with the runtime runner, and compares its catalog with a fresh migration. It also installs `pgcrypto`, `pg_trgm`, and `pg_stat_statements` in the released database to verify provider extensions do not block adoption. CI runs this in the `migrations` job. Docker must support `--network host`; the Postgres port must be reachable on localhost. The URL is used only to create two randomly named scratch databases; the harness removes them, its release container (`<prefix>-fx-release-<hex>`, the prefix from `TEST_CONTAINER_PREFIX` or `-- --container-prefix <name>`), and its temporary secrets file afterwards. Remote hosts and routing overrides in the URL are refused.

Enum additions and their first use (including a column default) must be generated as two migrations: add the value first, then generate its use. PostgreSQL requires the addition to commit before use; the generator refuses a combined file.

## Test fixtures for migrations

CI check 4 applies migrations on top of realistic rows. Fixtures live in `packages/db/prisma/fixtures/`:

- `<migration_folder>.sql` — rows written against the schema **as of that migration**, loaded right after it in one transaction. An old fixture never needs rewriting.
- `<migration_folder>.check.sql` — assertions run after all migrations. Each statement must return **zero rows** ("select the rows that are wrong").

`0_init.sql` holds 0.4.3-shaped rows (instances with `runGeneration` 0, retired completion capability keys, a sidecar whose share lost `canUse`, node commands) and `0_init.check.sql` proves the 1.0 upgrade backfilled them. The hardening's graph-write fences refuse ordinary writes, so a fixture starts with `SELECT set_config('wsmp.fences', ',*,', true);`. When you add a migration that changes a table with data, add a fixture for the latest base migration and a `.check.sql` that proves the data survived.

## What happens at deploy

The same image runs migrations two ways (`scripts/docker-entrypoint.sh`):

- **Startup migration.** The server command runs `node scripts/db/migrate-runtime.mjs apply` before it starts. `MIGRATE_ON_START` defaults to `true` for the server command and `false` for every other command (`wait` mode).
- **`migrate` image command.** A one-shot job (`docker run … <image> migrate`) runs the same runner, applies, and exits 0 or non-zero without starting the server. App containers then run with `MIGRATE_ON_START=false`.

`APPLY_SCHEMA` (0.4.x) is accepted during 1.x as a deprecated alias with a startup warning: `off` → `MIGRATE_ON_START=false` (the container will **not** migrate; it waits for another runner), `safe` → `true`. `dangerous` is refused: migrations never drop data implicitly. Setting both to conflicting values is refused. Remove `APPLY_SCHEMA`.

The runner reads the database's migration history and decides one of these states:

| State | What it means | Leader (`apply`) does | Follower (`wait`) does |
|---|---|---|---|
| `up-to-date` | Every migration in the image is applied. | Registers, runs any due scheduled deletions, starts. | Registers, starts. |
| `pending` | The image has migrations the database lacks. | Refuses if one is unsafe for the running release (an in-place drop / rename / type change, unannotated SQL it cannot read) or reuses a name an earlier deletion removes, except on a brand-new database and for the one-time 1.0 upgrade ([§ Upgrading a 0.4.x database](#upgrading-a-04x-database)). Otherwise runs the pre-migration backup hook only with `BACKUP_ENABLED=true`, then `prisma migrate deploy`. | Waits. |
| `db-ahead` | The database has applied migrations this image does not contain (a rollback or stale deploy). | Starts only if every newer migration is rollback-safe and none of their deletions has run; otherwise refuses. | Same rule. |
| `failed` | A migration is recorded as failed. | Tries [automatic recovery](#automatic-recovery); otherwise refuses. | Waits while a runner works on it; otherwise refuses. |
| `no-history-nonempty` | Tables but no `_prisma_migrations`. | Adopts a released 0.4.3 schema, refuses anything else ([§ Upgrading a 0.4.x database](#upgrading-a-04x-database)). | Waits (the leader may be adopting it). |
| `unreachable` | Cannot connect. | Refuses (the platform retries). | Keeps waiting until timeout. |

Followers poll for at most 300 s (`WAIT_TIMEOUT_MS`), never run scheduled deletions, and refuse on timeout, `db-ahead`, or a `failed` migration nobody is working on.

**Pre-migration backup.** Off by default: with `BACKUP_ENABLED` unset or false, migrations and scheduled deletions proceed without calling the backup hook, even when backup storage is present. With `BACKUP_ENABLED=true` and state `pending`, the runner first calls `scripts/backup/pre-migrate.sh`. The runner passes `--required`, so no destination configured or a configured backup failing both stop the migration: it does not run ([backup-and-restore.md](./backup-and-restore.md)).

**Locking.** During the 1.0 transition, a leader also holds the 0.4.x schema-sync lock (`1145389648`) through adoption and upgrade, so a restarting released replica cannot push its schema concurrently. A leader holds a Postgres session advisory lock (key `72707370`, `MIGRATION_RUNNER_LOCK_KEY` in `scripts/db/lib/migration-state.mjs`) for its whole run: classify, adopt, recover, backup, `migrate deploy`, final check. A second leader waits for it, re-reads the state, and normally finds nothing to do. The lock belongs to the session, so a crashed runner never leaves it behind. Restore and `hold-deletions` take the same lock. Prisma's own lock (key `72707369`) covers `migrate deploy` itself; a leader that finds a migration in flight under someone else's Prisma lock waits, then refuses rather than resolve it. The 300 s wait must cover the other leader's backup plus migration; if it does not, the waiting container exits and the platform restarts it, which is expected. The image's HEALTHCHECK `--start-period` exceeds the whole gate (`pnpm docker:check-copy` checks it).

**Stop signals.** The entrypoint forwards TERM/INT/HUP to the runner and never starts the server after one. An interrupted wrapped migration rolls back; the next start recovers it.

## Automatic recovery

A failed or interrupted migration is recorded as failed, and Prisma refuses every later migration until someone runs `migrate resolve`. Automatic replay and resolution require the failed attempt’s recorded checksum to match the current file; a missing or different checksum stops for manual inspection. The runner handles two safe cases itself, only for a migration that starts with `-- wmp:transactional` and whose wrapper is intact:

- **Interrupted after `COMMIT`** (the commit marker is recorded): it runs `prisma migrate resolve --applied <name>` and never runs the migration again.
- **Failed before `COMMIT`** (no marker): PostgreSQL rolled the whole file back. It logs the name and the original error loudly, runs `prisma migrate resolve --rolled-back <name>`, and retries **once**. A second failure stops the deploy.
- Anything else stops the deploy and points at the [Recovery runbook](#recovery-runbook).

**Edited applied migrations are refused** in both modes (checksum mismatch). Restore the original file and put the change in a new migration. Automatic recovery does not fix the cause: a migration that failed on data fails again; write a corrective migration.

## Expand and contract

Every deploy can overlap: the old container may keep serving while the new one starts, or the old release serves while the `migrate` job runs. So every migration must be safe for the release that is still running, and anything that release reads can only be deleted once it is gone.

```
packages/db/prisma/migrations/<timestamp>_<name>/
  migration.sql   # applied at deploy by prisma migrate deploy (expand)
  contract.sql    # optional; applied by the deploy runner later (contract)
```

Prisma reads only `migration.sql`. CI check 3 hashes every file in a merged folder, so a `contract.sql` is immutable once merged. `pnpm db:migrate` splits a removal: `migration.sql` relaxes a dropped column (`-- wmp:relax`) and drops foreign keys that would block the old release's writes; `contract.sql` holds the `DROP`. It refuses a primary-key change, table / enum / enum value renames (use `@@map` / `@map`), and an enum value removal without `--remap`. **A deleted name is never reused.**

**When a deletion runs.** The runner (`apply`) runs due contracts after the database is up to date, in folder order. A `contract.sql` is due when a release containing its folder **first became ready** at least 7 days ago, no release lacking it was seen alive in the last 7 days, no hold is active ([§ Holding deletions by hand](#holding-deletions-by-hand)), and it passes validation against the live database. On a brand-new database every contract runs right after the deploy. At the moment of deletion the runner logs `[migrate] DATA DELETED: <what> (…; backup: <label|none configured>)` and records it in `_wmp_migration`; that log line is the only notice (there is no email). Every start logs one `[migrate] scheduled deletion` line per pending deletion.

**1.0 limitation: scheduled deletions never become due.** The runner registers each container start in `_wmp_instance` (under a fresh `WMP_INSTANCE_ID` set by the entrypoint), but this release does not port the template's instance heartbeat: the server never refreshes its row or records that it became ready. A deletion therefore never finds a release that "became ready 7 days ago", and every `contract.sql` waits indefinitely. Nothing is deleted; the data stays (fail-safe). No migration in 1.0 has a `contract.sql`.

**Runner-owned tables.** `_wmp_instance`, `_wmp_migration`, `_wmp_hold` and `_wmp_cluster` live next to `_prisma_migrations`. The production runner creates them (`CREATE TABLE IF NOT EXISTS`, under its lock); they are never created locally or in CI scratch databases, and the Prisma schema does not model them. Read them freely; never write to them by hand.

**Holds.** While any `_wmp_hold` row has `until` in the future, no deletion runs. Sources: `restore` (7 days, written in its transaction), `cluster-changed` (the runner detects a restored or moved database by its system identifier, timeline, database oid and the oid of `_wmp_cluster`), and `owner` ([below](#holding-deletions-by-hand)).

**Rollbacks.** An older image may start against a newer database only when every migration it lacks is rollback-safe (new tables, nullable or defaulted columns, non-unique indexes, `SET DEFAULT`, the generated templates, DML with a `WHERE`) and none of their deletions has run.

**Raw SQL is invisible to every check.** A `$queryRaw` naming a deleted column breaks when the deletion runs; grep for the name before merging a removal.

## No in-place breaking changes

An in-place drop, rename or type change in `migration.sql`, or unreadable SQL nobody attested, fails CI check 5, and the runner refuses it on any database that already has migrations applied. **There is no override.** Split the change ([schema-changes-recipe.md](./schema-changes-recipe.md)). A brand-new database applies everything (`new database: applying in-place breaking migration(s) …`). The only other exception is the one-time 1.0 upgrade below.

## The hardening

`packages/db/prisma/schema-hardening.sql` is the readable reference of the database invariants, and the file the tests and code comments cite. The newest migration with a `-- section hardening` block must hold exactly its body (the LOCK statement wrapped in a retry loop, below); `pnpm db:validate` (`packages/db/scripts/verify-schema-hardening.mjs`) fails otherwise, and with `SCHEMA_VALIDATION_DATABASE_URL` it applies the migrations into a throwaway schema and exercises every object. Today that migration is `20261112000000_upgrade_to_1_0_0`. After 1.0.0 ships, a hardening change is a new migration (`pnpm db:migrate <name> --empty`) holding the whole new body in a `-- section hardening` block; the body is idempotent, as the former deploy hardening was.

The hardening takes every table it touches in one up-front `LOCK TABLE … NOWAIT` (DL-1, `packages/db/src/capacity-lock-order.ts`), so it never waits on a lock while holding one. In a migration that statement is retried in a subtransaction loop (`upgradeHardening` in `scripts/db/generate-initial-migrations.mjs`): a busy table rolls back the attempt with whatever it had locked, sleeps briefly, and tries again, for about 30 s within the 60 s statement timeout.

## Upgrading a 0.4.x database

1.0 ships two migrations that replace `db push` + hardening:

- **`0_init`** — exactly the released **v0.4.3** schema: Prisma's from-empty SQL for the v0.4.3 `packages/db/prisma/schema`, then the v0.4.3 `schema-hardening.sql`. A 0.4.3 database already holds this.
- **`20261112000000_upgrade_to_1_0_0`** — Prisma's diff from v0.4.3 to the 1.0 schema, the 1.0 hardening with its one-time backfills (`runGeneration` 0 rows, retired completion capability keys, sidecars whose owner lost `canUse` on the target), and `DROP FUNCTION IF EXISTS wmp_schema_hardening_state();` (the 0.4.x hardening version gate).

A new database runs both in order. A 0.4.3 database has tables but no `_prisma_migrations`, so the runner adopts it (`adoptBaseline` in `scripts/db/migrate-runtime.mjs`, `scripts/db/lib/baseline.mjs`), under its advisory lock:

1. It applies `0_init`'s body inside a transaction that is **always rolled back**, in a temporary schema `_wmp_baseline_<hex>` of the same database, and compares that catalog with the live one: tables, columns (type, nullability, default, identity, generated, collation), constraints including CHECK, indexes, triggers, functions and procedures, enums, sequences, policies, extensions. It ignores column order, ownership, privileges, the `wmp_schema_hardening_state()` gate, `_prisma_migrations` and `_wmp_*`. Comparing on the same server means no catalog text is committed and the PostgreSQL version cannot cause a false difference. Bound: 30 s (`BASELINE_COMPARE_TIMEOUT_MS`). The database role needs the CREATE privilege on the database for the temporary schema.
2. **Equal** → `prisma migrate resolve --applied 0_init` (logged `adopted a v0.4.3 database: …`). The upgrade migration then runs like any pending migration, after the optional pre-migration backup (`BACKUP_ENABLED=true`). It changes the released hardening in place, so the runner admits it only while the applied history is exactly `[0_init]` (or empty); CI check 5 reports the two one-time migrations instead of failing them.
3. **Different** → `NOT ADOPTED`, up to 25 differences printed per side, and a refusal. Nothing is changed.

A fresh 1.0 database, an adopted 0.4.3 database, and a database built by the former 1.0 `db push` + hardening path end with identical catalogs.

**Operator steps.** Take a backup first. Stop the 0.4.x server if you can (it cannot serve 1.0 nodes anyway); the upgrade's LOCK retries if it cannot. Replace `APPLY_SCHEMA` with nothing (the server migrates by default) or `MIGRATE_ON_START=true`, then start 1.0.

**When it refuses:**

- `DATABASE_URL` names another app's database, or one created by hand → fix `DATABASE_URL`. A new install needs an empty database.
- A ws-model-proxy database **older than v0.4.3** → start the v0.4.3 image once with `APPLY_SCHEMA=safe` (that brings it to the 0.4.3 schema), stop it, then start 1.0.
- A 0.4.3 database whose schema was **changed by hand** (the listed differences) → undo exactly those changes, or restore the pre-upgrade backup, and start again.
- `could not compare the database with 0_init` → usually a missing CREATE privilege on the database; grant it to the app role for the upgrade.

**Regenerating (before 1.0.0 ships only).** `node scripts/db/generate-initial-migrations.mjs` rewrites both files from the `v0.4.3` git tag (`git fetch --tags`) and the current schema and `schema-hardening.sql`; `--check` exits 1 when they are stale. Once 1.0.0 is released both folders are immutable like every migration.

## A database with tables but no migration history

Outside the 0.4.3 adoption above, the runner refuses `no-history-nonempty`: it never adopts an unknown schema. The usual cause is a `DATABASE_URL` pointing at the wrong database. Check it first. Bringing a database something else created under this app's migrations is a one-time production change with no safe default: stop and ask the owner. Agents never hold production database credentials.

Locally, `pnpm db:migrate:apply` refuses such a database and tells you to run `pnpm db:reset:local` (disposable local data only).

## Holding deletions by hand

After a restore the runner cannot detect (a storage snapshot restored with crash recovery only, `pg_restore --data-only` into the existing tables, a provider restore not otherwise detected), pause scheduled deletions before the app starts: start only the database, run the image's `hold-deletions` command once, then start the app.

```bash
docker run --rm --network <db-network> -e DATABASE_URL=… <image> hold-deletions     # 7 days
docker run --rm --network <db-network> -e DATABASE_URL=… <image> hold-deletions 30  # 1 to 90 days
docker run --rm --network <db-network> -e DATABASE_URL=… <image> hold-deletions --clear
```

It writes the `owner` row in `_wmp_hold` (a longer existing hold is kept), prints until when deletions are paused, and never prints `DATABASE_URL`. `--clear` removes only the owner hold. It is not needed after the `restore` command, any `pg_restore --clean`, point-in-time recovery, or a dump into another server or database: those are detected.

## Recovery runbook

Use this when a deploy stops with `failed`, `db-ahead`, or a history mismatch, and automatic recovery did not apply, or when a scheduled deletion is stuck.

1. **Inspect.** From inside the target network:
   - `prisma migrate status` — which migrations are applied, pending, or failed.
   - `SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM _prisma_migrations ORDER BY started_at;` — `logs` holds the original error.
   - The live schema, read-only (`\d table_name` in `psql`), to see how much of a non-transactional migration ran.
2. **Repair.** The migration did nothing (rolled back): fix the cause with a **new** corrective migration or a data fix. It partly ran (non-transactional): finish or undo its statements by hand so the database matches "before" or "after".
3. **Resolve.** An operator step on the target database, never an agent's. Make sure no runner or deploy is still working on it first: no session may hold advisory lock 72707369 (Prisma) or 72707370 (the migration runner) in `pg_locks`. Then `prisma migrate resolve --rolled-back <migration_name>` (the "before" state; it runs again next deploy) or `prisma migrate resolve --applied <migration_name>` (the "after" state; Prisma skips it).
4. **Deploy again.**

**`db-ahead`** means the image is older than the database and the rollback was refused. Deploy a release that contains every applied migration. Do not delete rows from `_prisma_migrations` or `_wmp_migration` to make an old image start.

**The 1.0 upgrade failed after adoption.** The history is `[0_init]` with the upgrade failed or pending. The upgrade is wrapped, so it rolled back; the next start retries it (the in-place admission still applies). If it keeps failing, read the replayed error in the log and stop for the owner; restore the pre-upgrade backup to return to 0.4.3.

**A stuck scheduled deletion.** Read the `[migrate] scheduled deletion` lines; they say why each waits (`waiting for: …`, `held until …`, `needs a person: …`). Inspect `_wmp_migration`, `_wmp_instance` and `_wmp_hold` read-only. "Needs a person" means it failed 3 times in this release and nothing was deleted: ship a fix migration, or stop and ask the owner. In 1.0 every deletion waits ([§ Expand and contract](#expand-and-contract)).

Never edit an applied migration, and never run `prisma migrate reset`, `prisma migrate dev`, or drop the database to "start over" in any shared environment. Restoring a backup is a last resort: [backup-and-restore.md § Restore](./backup-and-restore.md#restore).

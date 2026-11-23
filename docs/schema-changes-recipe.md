# Schema Changes — Step-by-Step Recipes

How to change the database schema safely. Read this **before** touching `packages/db/prisma/schema/`. The mechanics behind these recipes (markers, deploy states, recovery, the 0.4.x upgrade) are in [schema-migrations.md](./schema-migrations.md).

If you only remember one thing: **edit the schema, run `pnpm db:migrate <name>`, read the SQL, run `pnpm db:migrate:apply`, commit the schema and the migration folder together.**

## How schema changes reach production

1. You change `packages/db/prisma/schema/*.prisma` and generate a migration: a folder under `packages/db/prisma/migrations/` holding the exact SQL.
2. You review (and if needed edit) that SQL, apply it to your local database, and commit both in one PR.
3. CI applies every migration to a fresh database and checks it matches the schema, keeps existing data, and does not look like an accidental data loss ([What CI checks](#what-ci-checks)). It writes a plain-English list of anything destructive to the job summary.
4. After merge, the deploy runs `prisma migrate deploy` through the image's migration runner, which applies only the migrations that database has not seen yet: the server applies them when it starts (`MIGRATE_ON_START`, default true), or a one-shot `migrate` job does before the rollout.

During a deploy the old container may keep serving while the new one starts, so for a while **old code can run against the new schema**. `pnpm db:migrate` keeps that safe: anything the old code still reads is never dropped at deploy. A removal is split into two files in the same folder: `migration.sql` changes only what the old code tolerates, and `contract.sql` deletes the data later, once no older release is running ([schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract); in 1.0 those deletions never become due, so the data stays). The exceptions are renames (use `@map`, Recipe 3) and type changes (two PRs, Recipe 5).

## The commands you need

| Command | When |
|---|---|
| `pnpm db:migrate <name>` | After editing the schema. Generates the SQL (`migration.sql`, plus `contract.sql` when something is deleted); applies nothing. Use a short snake_case name: `add_phone_number`. Flags: `--remap 'Enum.OLD=NEW'`, `--recover 'table.old=new'`, `--empty`, `--no-transaction`. |
| `pnpm db:migrate:apply` | After reviewing the SQL, and after every pull or rebase. Applies `migration.sql` to your local DB and regenerates the Prisma client. |
| `pnpm db:migrate:rebase` | After rebasing a branch that has migrations onto the default branch. |
| `pnpm db:reset:local` | Your local DB is in a mess, or was created by the old `db:push` (this checkout's DB only). |
| `pnpm db:studio` | Look at local data in the browser. |

Never run `prisma migrate dev`, `prisma migrate reset`, or `prisma db push` (see AGENTS.md, Data and Schema). All the wrappers refuse to touch anything but this checkout's own local database.

---

## Recipe 1 — Add a field to an existing model

**Goal:** add `phoneNumber` to `User`.

1. Add the field in `packages/db/prisma/schema/auth.prisma`. Make it optional (`?`) or give it a `@default(...)` — a required column with no default fails on a table that already has rows.

   ```prisma
   model User {
     // ... existing fields
     phoneNumber String?
   }
   ```

2. `pnpm db:migrate add_user_phone_number`
3. Open the new `migration.sql`. Expect one `ALTER TABLE "user" ADD COLUMN "phoneNumber" TEXT;` inside the generated `BEGIN … COMMIT;` wrapper. Nothing should be dropped.
4. `pnpm db:migrate:apply`
5. Commit the schema file and the new migration folder.

## Recipe 2 — Add a new model

1. Add the model to the `<domain>.prisma` file it belongs to, with `@@map("<snake_case_table>")` like the existing models. Every foreign key needs a relation and an index. Add the back-relation on the parent.
2. `pnpm db:migrate add_<thing>`, read the SQL (a `CREATE TABLE`, indexes, foreign keys — nothing dropped), `pnpm db:migrate:apply`, commit.
3. If the table needs invariants Prisma cannot express (a CHECK, a trigger, a graph-write fence), they belong in `packages/db/prisma/schema-hardening.sql` and in a migration ([schema-migrations.md § The hardening](./schema-migrations.md#the-hardening)).

## Recipe 3 — Rename a field

**Use `@map`. No SQL changes, no deploy coordination, one PR.** Keep the column as it is in the database and tell Prisma about it:

```prisma
model User {
  fullName String @map("name") // code says fullName; the column is still "name"
}
```

For a model, use `@@map("old_table_name")` (every model here already maps its table name).

1. Rename the field and add `@map("<old column name>")`. Update every use in code, and any raw SQL.
2. `pnpm db:migrate rename_user_full_name` — the generator should report **no changes**. If it produced a `DROP COLUMN` + `ADD COLUMN`, the `@map` is wrong; fix it and delete that generated folder.
3. Commit.

## Recipe 4 — Physical rename

**Don't.** Use `@map` / `@@map` (Recipe 3). A physical `RENAME COLUMN`, table rename, enum rename or enum value rename breaks the release that is still running, so the generator refuses the renames it can see and CI check 5 fails the rest. There is no override ([schema-migrations.md § No in-place breaking changes](./schema-migrations.md#no-in-place-breaking-changes)). If the database name truly must change, stop and ask the owner.

## Recipe 5 — Backfill or change a type

Data changes go **in the migration**, next to the schema change, so every environment gets them in the same order.

**Add a required column to a table with rows:**

```sql
ALTER TABLE "pool" ADD COLUMN "label" TEXT;
UPDATE "pool" SET "label" = "name" WHERE "label" IS NULL;
ALTER TABLE "pool" ALTER COLUMN "label" SET NOT NULL;
```

Steps: edit the schema → `pnpm db:migrate <name>` → add the backfill after the `-- wmp:history-capture` block and before the `-- wmp:commit-marker` block (leave every wrapper line exactly as generated) → `pnpm db:migrate:apply` → add rows that exercise the change to a fixture in `packages/db/prisma/fixtures/` (CI check 4) → commit. `SET NOT NULL` is reported, and it means the previous release can no longer be rolled back to.

Most tables carry graph-write fence triggers from the hardening: an `UPDATE`/`DELETE` backfill on them needs `SELECT set_config('wsmp.fences', ',*,', true);` earlier in the same transaction (the hardening does the same).

**Change a column's type: two PRs.** An in-place `ALTER COLUMN … TYPE` breaks the running release, so CI check 5 fails it and the deploy refuses it:

1. **PR 1.** Add a new field with a new database name, nullable, and backfill it from the old column in the same migration (`UPDATE … WHERE "new" IS NULL`). The app writes both fields and still reads the old one. Merge and deploy.
2. **PR 2.** A catch-up `UPDATE … WHERE "new" IS NULL`; optionally `SET NOT NULL`; switch reads to the new field; remove the old field from the schema. `pnpm db:migrate` relaxes the old column and schedules its deletion.

Three widenings are safe in place: `varchar(n)` → `varchar(m)` with m ≥ n, `varchar(n)` → `text`, and `numeric(p,s)` → `numeric(p',s)` with p' ≥ p (no `USING`, not arrays). `int` → `bigint` is not: it rewrites the table.

**Unique constraints and upserts.** Dropping a unique index on a column you keep takes two PRs when code upserts by that field: remove every `upsert` / `connectOrCreate` / `findUnique` keyed on it first, then drop the constraint.

Rules of thumb:

- Make backfills safe to read twice: `WHERE "x" IS NULL`, not a blanket `UPDATE`.
- A backfill over millions of rows can exceed the 60-second statement timeout. Ask before writing one.

## Other changes

- **Drop a column / remove tables.** One PR: stop reading and writing the field (or the models) and remove it from the schema, then `pnpm db:migrate <name>`. `migration.sql` gets only the relax step (`-- wmp:relax`), `contract.sql` the `DROP`. Grep for the name in `$queryRaw` / `$executeRaw`, SQL strings and `schema-hardening.sql` first. Within the waiting period, `pnpm db:migrate <name> --recover 'table.old=new'` gets the data back under a new name. A deleted name is never reused.
- **Remove an enum value.** Ask which value existing rows become, then `pnpm db:migrate <name> --remap 'Enum.OLD=NEW'`. One enum per migration; adding values to the same enum in the same migration is refused.
- **Table rename, enum rename.** Use `@@map` / `@map`.
- **Primary-key change.** Unsupported in place: a new table via expand and contract.
- **Tighten nullable → `NOT NULL`.** Backfill in the same migration, or add a `@default(...)`.
- **Add a unique constraint where duplicates may exist.** Decide with the user which row wins, de-duplicate in the same migration, then add the index.
- **Index on a big table.** `CREATE INDEX CONCURRENTLY` cannot run in a transaction: its own migration, without the wrapper and without `-- wmp:transactional`.
- **Change the hardening.** Edit `schema-hardening.sql`; the newest migration with a `-- section hardening` block must equal it ([schema-migrations.md § The hardening](./schema-migrations.md#the-hardening)). Before 1.0.0 ships, run `node scripts/db/generate-initial-migrations.mjs`.

## Destructive patterns to watch for

Read every generated `migration.sql`. Stop and think when you see:

- **A `DROP COLUMN` / `DROP TABLE` in `contract.sql`** you did not intend — usually a rename Prisma read as drop + add. Use `@map`.
- **`ALTER COLUMN … TYPE`** — fails CI check 5 unless it is a safe widening.
- **`SET NOT NULL`** or **`ADD COLUMN … NOT NULL`** without a default — fails on a table with rows.
- **`CREATE UNIQUE INDEX`** on a column that may have duplicates — fails at deploy.
- **`DROP CONSTRAINT … FOREIGN KEY`** with no matching `ADD CONSTRAINT` — a relation was removed.

When in doubt, don't commit. Delete the generated folder, fix the schema, and generate again.

## What CI checks

The PR job `migrations` runs `pnpm db:check-migrations --base origin/<base>` against a throwaway PostgreSQL 17. Locally: `CHECK_DATABASE_URL=<disposable superuser URL> pnpm db:check-migrations --base <ref>`.

**Blocking:**

1. **Consistency** — the schema must match the database reached two ways: all migrations then all `contract.sql` files, and the base branch's then this PR's.
2. **Ordering** — every migration the PR adds sorts after the base branch's latest, with a unique timestamp. Fix with `pnpm db:migrate:rebase`.
3. **Immutability** — no file in a migration folder a release tag (`vX.Y.Z`) holds was modified, renamed, deleted or added. Needs the tags (`git fetch --tags`). Unreleased folders on the base branch change only at the release cut ([schema-migrations.md](schema-migrations.md) rule 1). A folder a release squashes keeps a byte-identical `replaced/` copy of what the base branch had, listed in the release's `replaces.json`; a release PR removes the previous release's `replaced/` and `replaces.json` ([schema-migrations.md § Releases](schema-migrations.md#releases)).
4. **Applies with data** — base migrations with their fixtures, then the PR's; rows survive and every `fixtures/*.check.sql` returns no rows.
5. **Safe for the running release** — fails an in-place drop, rename or type change in `migration.sql`, SQL the analyzer cannot read without `-- wmp:reviewed <reason>`, an unknown template version, a broken wrapper, a reused deleted name, or a drop + add without `-- intentional: drop and recreate`. The two one-time migrations (`0_init` and `20261112000000_upgrade_to_1_0_0`, which carry the hardening) are reported instead ("One-time migration …"), since they run only on a new database or right after a 0.4.3 database is adopted.
6. **Release squash** (only when the PR adds a release folder) — `replaces.json` and the `replaced/` copies agree; the release folder is the replaced SQL verbatim and in order; and a database built from every prefix of the replaced chain, reconciled as the deploy runner does, ends with the fresh database's exact schema. A release PR also runs `pnpm db:check-release` against the last release tag (Guards A and B, [schema-migrations.md § Releases](schema-migrations.md#releases)).

**Report-only:** per migration, what changes now, what is deleted later, what was reviewed by hand, and whether a rollback stays possible. **Before merge the agent shows that summary to the user.**

`pnpm db:validate` (the `prisma-validate` job) also checks that `schema-hardening.sql` matches its migration and exercises the hardening against PostgreSQL.

## Common mistakes

**"CI check 1 failed: schema and migrations differ."** You edited the schema but did not generate (or commit) the migration.

**"CI check 2 failed after I rebased."** Run `pnpm db:migrate:rebase`, then `pnpm db:migrate:apply`, push.

**"I need to fix a migration I already merged."** You can't edit it. Write a new migration that corrects it.

**"My local database has no migration history / is out of sync."** `pnpm db:reset:local`.

**"db:reset:local says my database is not marked as disposable."** It was created before the mark existed (or by something other than `pnpm db:worktree` / a fresh `pnpm dev:services` volume), or the URL reaches another server through a tunnel. Nothing was dropped. If it really is this checkout's own local database, the user runs `pnpm db:worktree --adopt` once at a terminal; agents hand that command to the user.

**"db:migrate:apply says another session holds a migration lock."** A deploy runner, a restore, or another `prisma migrate deploy` is working on that database. Nothing was changed; wait and re-run.

**"Production refuses to start after my merge."** Read the log line: it names the state. Follow [schema-migrations.md § Recovery runbook](./schema-migrations.md#recovery-runbook).

## See also

- [schema-migrations.md](./schema-migrations.md) — commands, markers, deploy states, the 0.4.x upgrade, recovery
- [backup-and-restore.md](./backup-and-restore.md) — backups before risky migrations, and restore
- AGENTS.md, Data and Schema

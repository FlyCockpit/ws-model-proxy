# Backup and Restore

> The backup taken right before migrations, optional daily backups, restoring, and the restore drill. Mechanics of migrations: [schema-migrations.md](./schema-migrations.md).

Automatic backups are **off by default** (`BACKUP_ENABLED=false`,
`BACKUP_SCHEDULE=off`). A new deployment needs no backup storage or sidecar;
migrations and readiness work without them. Startup logs one notice explaining
how to opt in. To enable automatic pre-migration/pre-drop backups, set
`BACKUP_ENABLED=true` on the app and any `migrate` job, and mount a writable
`/backups` volume and/or configure S3 below. For local storage plus daily backups,
use `compose.yaml` with `compose.backups.yaml` (see the README); it passes the
`BACKUP_S3_*` settings below from the env file to the app and the backup service
(an unset or empty `BACKUP_S3_PREFIX` becomes the default `database`). Manual `backup`,
restore, and restore-drill commands are explicit owner actions and work regardless
of `BACKUP_ENABLED`. Provider snapshots and point-in-time recovery remain options.

Back up `BETTER_AUTH_SECRET` separately from the database and retain the keys needed by older backups. Password hashes in a restored backup need the corresponding secret; see [Password pepper](./production-hardening.md#password-pepper).

## Where backups go

The scripts in `scripts/backup/` write `pg_dump` custom-format archives:

- **`/backups` (supported).** A writable **mounted volume** at `/backups` in the app container. The image creates an empty `/backups` owned by the runtime user so a fresh named volume inherits writable ownership; the empty directory alone, without a mount, does not count as configured.
- **S3 (optional, recommended off-site copy).** Set `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY` (plus `BACKUP_S3_REGION` for AWS, or `BACKUP_S3_ENDPOINT` for R2, MinIO, RustFS and other S3-compatible storage; optional `BACKUP_S3_PREFIX` (default `database`), `BACKUP_S3_FORCE_PATH_STYLE=true` for path-style endpoints such as MinIO, and `BACKUP_S3_SSE=AES256` on AWS) and every backup is also uploaded to `<bucket>/<prefix>/<file name>`. The image bundles `@aws-sdk/client-s3`. With a writable `/backups` mount as well, the dump is kept in both places; without one, S3 alone counts as configured. Use a **dedicated backup key** that can `GetObject`, `GetObjectVersion`, `PutObject` and `AbortMultipartUpload` but not delete, never an app or admin key ([§ Bucket retention](#bucket-retention-versioning-and-incomplete-uploads)). Bad or missing `BACKUP_S3_*` settings are reported when a backup runs (and then stop that backup, and with a pre-migration backup the migration). With `BACKUP_ENABLED=true` a migrating start also checks them once (see below); with backups off they never stop the app. The writer key (`BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`) is held only by the entrypoint while the migration runner and its backups run, and by the one-shot `backup`, `backup-schedule`, `restore` and `restore-drill` commands: the entrypoint runs as PID 1 during startup, unsets every `BACKUP_S3_*` variable, then `exec tini -- <CMD>`. tini becomes PID 1, forwards signals, reaps orphaned children and returns the server's exit status. Neither the server's environment nor `/proc/1/environ` carries the writer keys. Custom entrypoint overrides must preserve this ordering: startup with backup credentials, unset `BACKUP_S3_*`, then exec tini with the server command.

A backup that lives only on the server is lost with the server.

## Pre-migration backup (optional, encouraged)

When `BACKUP_ENABLED=true` and a deploy has migrations to apply, the migration runner first calls `scripts/backup/pre-migrate.sh`. This is the safety net for "the migration did something we didn't want", and for the one-time 0.4.3 → 1.0 upgrade.

- **Disabled (`BACKUP_ENABLED=false` or unset)** → migrations proceed without calling the backup hook, even if backup storage is present; a migrating start then logs a warning that the configured destination is unused.
- **Enabled but not configured** (no writable `/backups` mount and no `BACKUP_S3_BUCKET`) → the start stops with `no backup destination`, on a brand-new database too and even when nothing is pending: every container that migrates (`MIGRATE_ON_START=true`, or the `migrate` command) checks the destination (and the `BACKUP_S3_*` settings) once before the runner starts, so a missing destination shows up on the first start, not at the first upgrade. A container that only waits (`MIGRATE_ON_START=false`) does not check. The runner calls the hook with `--required`: `BACKUP_ENABLED=true` means "do not migrate without a backup". Configure a destination, or set `BACKUP_ENABLED=false` to migrate without one.
- **Configured and it fails** → the migration does **not** run and the start stops. Fix the backup (disk full, unwritable volume, bad S3 key or endpoint) and start again.

It writes `pre-migrate-<time>.dump` into `/backups` and/or uploads it to S3 (the log prints the exact `restore s3://… --etag …` command for the uploaded object), keeps the newest 5 pre-migration dumps and deletes older ones, plus any hidden `.pre-migrate-*.dump.partial` left by a dump killed more than 120 minutes ago. It runs while the migration runner holds its lock, so a second migrating container waits for it; the 300-second wait must cover backup plus migration time, or that container exits and restarts (expected).

The same hook runs before a scheduled deletion (`contract.sql`), labelled `pre-drop`, also with `--required`: when it fails or has no destination, that run skips the scheduled deletions (the app still starts) and retries them on the next start. In 1.0 scheduled deletions never become due ([schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract)).

### S3 uploads

Uploads never overwrite: each one is conditional (`If-None-Match: *`), and the app never deletes anything in the bucket. If an upload reports that its destination already exists (HTTP 412), the app checks that the stored object has the same size **and the same contents**; an identical backup counts as uploaded (for example on a retry), and a different one stops the backup with "a different object occupies" the destination. Endpoints that do not honour conditional writes (HTTP 400/405/501 on `If-None-Match`) are refused rather than risk an overwrite. Dumps over 5 GB use multipart uploads.

Uploads and restore downloads have a **two-hour total limit**, including retries and the identity check. A connection has 30 seconds to open, and one with no data moving for five minutes fails. A timed-out upload is a failed backup. These limits are `S3_CONNECTION_TIMEOUT_MS`, `S3_IDLE_TIMEOUT_MS` and `S3_TRANSFER_DEADLINE_MS` in `scripts/backup/s3.mjs`.

## Taking a backup now

Run the image's `backup` command as a one-off container with the app's `DATABASE_URL` and the same `/backups` volume, on the database's network:

```bash
docker run --rm --network <db-network> -v <backups-volume>:/backups \
  -e DATABASE_URL=… <image> backup             # manual-<time>.dump, verified
```

Add the `BACKUP_S3_*` variables (`-e …`) to upload it too; without a `/backups` volume, S3 alone is enough. `backup --keep <n>` also prunes older `manual-*` dumps in `/backups` (never in the bucket). Like the automatic backups with `BACKUP_ENABLED=true`, it fails when no destination is configured. Take one before every upgrade, and before the 1.0 upgrade in particular.

## Daily backups (optional)

The image command `backup-schedule` (`scripts/backup/schedule.mjs`) is a long-running loop for a **separate service** of the same image, with the app's `DATABASE_URL` and the same `/backups` volume. It is off unless `BACKUP_SCHEDULE=daily`. These scheduling variables are read only by that service, not by the app, and are not in `.env.example`. `BACKUP_ENABLED` controls migration/pre-drop backups independently; it does not disable an explicitly requested daily service:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_SCHEDULE` | `off` | `daily` turns it on. |
| `BACKUP_HOUR_UTC` | `3` | Hour (0-23, UTC) of the daily run. |
| `BACKUP_KEEP` | `14` | Days of daily dumps kept in `/backups` (one per UTC day). |

With `BACKUP_S3_*` set it uploads each dump too, and a backup counts as done only once it is uploaded; a retry after a failed upload re-uploads the same file instead of taking another. It writes a verified `daily-<time>.dump` a few minutes after it starts when the last one is missing or a day old, then every day at `BACKUP_HOUR_UTC`. It waits while a migration runner holds its lock, skips a database whose migration failed, and retries a failed run every hour. `node scripts/backup/schedule.mjs health` exits non-zero when the last run failed, the last success is more than 26 hours old, no backup has succeeded yet an hour after the service started, the schedule settings are invalid, or its status file is missing or invalid (the loop writes that file before anything else, so a missing one means the scheduler is not running or cannot write it). With `BACKUP_SCHEDULE=off` it is always healthy. `compose.backups.yaml` uses it as the service's healthcheck (every 60 seconds, after a 10-minute start period); unhealthy only reports a missed backup (Docker Compose does not restart an unhealthy container).

## Restore

Restore is a command in the app image: `restore <source> [options]`. It runs **inside the target network** as a one-off container with that environment's `DATABASE_URL` (and the `/backups` volume). Agents prepare the exact command; **the owner runs it**.

```text
restore <source> [--confirm RESTORE:<target-database>] [options]
restore --list                    list the backups in /backups, newest first

<source>   latest                 the newest backup in /backups (daily, manual or
                                  pre-migration; never a pre-restore snapshot)
           /backups/<file>        a file inside the container (raw pg_dump -Fc/-Ft,
                                  or gzip-wrapped)
           s3://<bucket>/<key>    an object in BACKUP_S3_BUCKET (needs BACKUP_S3_*)

--etag <etag>                S3 only, required: the exact object ETag (printed by the upload)
--version-id <id>            S3 only: pin an object version (versioned buckets)
--confirm RESTORE:<db>       required to change anything; <db> is the database named
                             in DATABASE_URL. Without it: verify the source and preview only.
--replace                    allow restoring over a non-empty database (snapshot first,
                             then drop app schemas and restore, in one transaction)
--allow-active-connections   proceed although other sessions are connected
--skip-snapshot              with --replace: skip the pre-restore snapshot
                             (only when a provider snapshot exists)
--guided                     after the preview, ask and fill in --confirm / --replace
                             (needs docker run -it)
```

What it does for you: verifies the archive before touching anything, checks the target (reachable, a primary, a `pg_restore` client at least as new as the server), refuses while other sessions are connected (stop the app first), snapshots the current database (to `/backups` and/or S3, so one must be configured) before replacing it, and holds the same locks as migrations (Prisma's and the migration runner's), so no deploy can migrate halfway through a restore. It replaces the data in one transaction: a refusal, a cancel or an interruption before `COMMIT` leaves the target as it was. It counts the restore as committed only once the session confirms the `COMMIT`. It reports **ROLLED BACK** (exit 4, the target unchanged) only when that is provable: `COMMIT` was never sent, `psql` stopped on an SQL error (`ON_ERROR_STOP`) before confirming it, or PostgreSQL reports the restore transaction aborted (`pg_xact_status`, PostgreSQL 13 or newer). If it fails after `COMMIT` was sent but before that confirmation and the server cannot settle it either (it waits up to 15 s for the server's answer), or a signal interrupts it then, it cannot tell whether the commit happened and says the outcome is uncertain (exit 1; 129/130/143 on a signal). If the session confirmed the `COMMIT` and then failed, it says the database is restored but the session did not end cleanly (exit 1). In these cases keep the app stopped and inspect the database.

Always preview first: run it **without** `--confirm`, read the preview, then run it with `--confirm` (or use `--guided`). Afterwards, start an image that contains every migration the restored database has applied (the same or a newer release); it applies any newer migrations as it starts.

**Going back to 0.4.3 after a failed upgrade:** restore the backup taken before the upgrade, then start the 0.4.3 image again. The 0.4.3 image cannot run against a database the 1.0 upgrade changed.

**Restores and scheduled deletions.** The `restore` command writes a 7-day hold on scheduled deletions, and the runner detects any `pg_restore --clean`, point-in-time recovery, or dump into another server or database at the next start. A restore it cannot detect (a storage snapshot, `pg_restore --data-only`) needs the `hold-deletions` command before the app starts ([schema-migrations.md § Holding deletions by hand](./schema-migrations.md#holding-deletions-by-hand)).

### The Compose helper (app-db.sh)

`scripts/backup/host.sh` (in the image at `/app/scripts/backup/host.sh`) wraps `list`, `backup`, `restore`, `drill` and `hold-deletions` for a Docker Compose project whose app service is named `app` and whose database service is named `postgres`, as in the shipped `compose.yaml` (with or without `compose.backups.yaml`, which mounts the backups volume at `/backups`). Elsewhere it refuses ("no app found"); use the image commands above directly. The chosen project must have exactly one `app` container and exactly one `postgres` container (running or stopped): with none, or with several (a scaled-up replica, a leftover `docker compose run` container), every command stops with exit 1 before touching anything and lists them; remove the extra ones (`docker rm -f <name>`; never the database's volume) and re-run. It runs on Linux only (the deployment server: bash, GNU coreutils, docker).

`restore` first asks "Stop the app and continue?". Answering no, Ctrl-D, or Ctrl-C while it waits (or a TERM or HUP signal then) exits **3** with `Cancelled. Nothing was changed; the app was not stopped.`: nothing is stopped or changed. Otherwise it stops every app container of the project (not `postgres`), runs the guided restore in a one-off container, and then:

- **restore completed (exit 0)** → starts the app again; it applies any pending migrations as it starts;
- **cancelled or refused before anything changed (exit 3)**, including Ctrl-C at a prompt or during the checks, a preview, or a failed check → starts the app again: nothing was changed;
- **failed and rolled back (exit 4)** → starts the app again: the restore transaction provably did not commit, so the database is unchanged (`Restore failed and was rolled back; the database is unchanged`); the restore output says why it failed;
- **any other exit** (the outcome is uncertain, or the restore committed and a later step failed) → the app **stays stopped**; the restore output says which. Inspect the database, then start the app with the `docker start` command it prints.

A Ctrl-C, TERM or HUP after "Stop the app and continue?" is not that cancel: the helper exits `130`, `143` or `129`. Before the restore was invoked (while it stops the app) it first starts the app again (`Restore was not invoked; nothing was changed.`); once the restore was invoked, the helper's own signal exit counts as "any other exit" above: the app stays stopped.

Before it does anything, the helper checks that the app container's image (its image ID, never the tag) is still on the machine. A redeploy that rebuilt an identical image can retag the name and drop the old image while the running app still points at it; the helper then stops with exit 1 and prints the fix, `cd <the compose's directory> && docker compose -p <project> --env-file <file> -f compose.yaml -f compose.backups.yaml up -d --no-build --force-recreate app`, which restarts the app on the current image. It takes the `-f` and `--env-file` lists from the app container's Compose labels (`com.docker.compose.project.config_files`, `…environment_file`), so the backups overlay is kept; add any `--profile` flags the deploy uses. Re-run the command afterwards.

It needs a terminal on stdin; its output may go to a pipe, so `bash app-db.sh restore | tee restore.log` works, and the app is still started again when `tee` is killed by Ctrl-C. Messages printed after the restore go to stderr. Under `| tee` the pipeline reports `tee`'s status: use `set -o pipefail` or `${PIPESTATUS[0]}` to see the helper's. Ctrl-C in the terminal also stops `tee` (its last lines, such as the cancel message, may not reach the log), so `pipefail` then reports `tee`'s `130`: read `${PIPESTATUS[0]}`, or log with `tee -i`, which ignores Ctrl-C.

The `restore` command's own exit statuses:

| Exit | Meaning | Target |
| --- | --- | --- |
| 0 | Restored. Also when a signal arrives once the restore session has confirmed the `COMMIT`, even before the session has exited (`Restore completed; then interrupted by <signal>`). | restored |
| 3 | Refused before changing anything: a usage error, preview only, cancelled, a failed check or pre-restore snapshot, or a stop signal before the restore transaction started. | unchanged |
| 4 | **ROLLED BACK**: the restore transaction started and provably did not commit. `COMMIT` was never sent (a failure or a stop signal before it), `psql` stopped on an SQL error (`ON_ERROR_STOP`) before confirming it, or the server reports the transaction aborted. | unchanged |
| 1 | Failed with the outcome uncertain (`COMMIT` was sent, never confirmed, and the server could not say), or the restore committed and a later step failed (the session confirmed the `COMMIT` and then exited with an error: the output says the database is restored but the session did not end cleanly). | inspect it |
| 129/130/143 | A signal after `COMMIT` was sent but before it was confirmed: uncertain. | inspect it |

Treat 0, 3 and 4 as definite; anything else means "inspect the target before trusting it". Exit 4 and the `pg_xact_status` check need PostgreSQL 13 or newer (the supported server is 17).

## Restore drill

A backup you have never restored is a hope. After any change to backups, and regularly, run the image's `restore-drill <source>` command as a one-off container with `DATABASE_URL` pointing at a **new, empty database named `restore_drill`** on the same server (never production), then delete that database:

```bash
docker run --rm --network <db-network> -v <backups-volume>:/backups \
  -e DATABASE_URL=postgresql://…/restore_drill <image> restore-drill latest
```

It restores the backup with the app's own `restore` command, checks that every table in the backup came back and that the migration history is complete, prints each table's row count and the backup's age, then **DRILL PASSED** or **DRILL FAILED**. It refuses any database not named `restore_drill` and accepts no option that widens the restore.

## Bucket retention, versioning, and incomplete uploads

The app only ever adds objects to the bucket; it never deletes them. That is safety, not retention. Configure on the bucket:

1. **Retention.** A lifecycle expiration rule on the backup prefix, long enough to cover the longest time a bad change could go unnoticed.
2. **Versioning, on.** The backup key can write objects, so without versioning anything holding it could overwrite the newest dump. Versioning keeps the old version and lets `restore` pin `--version-id`. Add a noncurrent-version expiration alongside the retention rule.
3. **Incomplete multipart uploads.** A lifecycle rule that aborts them (7 days is a good start); a killed upload can otherwise leave parts that are billed forever.
4. **Object Lock** is optional and irreversible; enable it only once retention and legal requirements are decided.

## Postgres client version

`pg_dump` can dump a database **older** than itself, never a newer one. The image installs Debian 13's `postgresql-client`, which is PostgreSQL 17, the supported server major. Against a newer server `pg_dump` fails, which stops a configured pre-migration backup — and with it the migration. Upgrading the server to a newer major needs a newer client in the `Dockerfile` first.

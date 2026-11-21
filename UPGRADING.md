# Upgrading from 0.4.x to 1.0.0

Upgrade the server and every `wsmp` together. Release 1.0 uses relay protocol 4.0
(`ws-model-proxy.relay.v4`) only. A 1.0 server refuses a 0.4.x CLI with HTTP 426 and an
upgrade message before its WebSocket connects, so the Nodes page cannot push the update to it.
`wsmp update` run on the node still works, because it downloads the release over plain HTTPS
from the server, not over the relay. A 1.0 wsmp against a 0.4.x server is refused with
"upgrade the server".

1. Schedule a maintenance window and upgrade the server to 1.0.0.
2. Upgrade wsmp on every node. For a node installed with the server's `install.sh`, the
   simplest way is to run this on the node:

   ```sh
   wsmp update
   ```

   It fetches the 1.0 release that the upgraded server offers, verifies it, swaps the binary,
   restarts the installed service and confirms once the relay is healthy (`wsmp update status`
   shows the result). You can also reinstall with the server's installer. Replace `<server>`
   with your server's hostname:

   ```sh
   curl -fsSL https://<server>/install.sh | sh
   ```

   On Windows, run the server's PowerShell installer:

   ```powershell
   irm https://<server>/install.ps1 | iex
   ```

   For a Homebrew installation, use Homebrew instead of the script:

   ```sh
   brew update
   brew upgrade wsmp
   ```

3. Restart each node's service with `wsmp service restart`. On Linux, the equivalent for the
   default user service is `systemctl --user restart wsmp.service`. For a foreground relay,
   stop it and start `wsmp run` again. Confirm every node reconnects on the Nodes page.

See the [CLI README](apps/cli/README.md#run-the-relay) for service management and
[release notes](docs/release-notes/1.0.0.md) for the changes. Building from source requires
Rust 1.89 or newer. The default development branch is now `main`.

Linux nodes stay on the glibc build they run, as in 0.4.x; `/install.sh` picks it for every
machine with glibc 2.34 or newer, so mDNS `*.local` server and model URLs keep working. New
in 1.0: on Alpine and on glibc older than 2.34, `/install.sh` installs a static musl build
instead of building from source; that build cannot resolve `*.local` names (use an
`/etc/hosts` entry or an IP address there).

Windows nodes: the relay's scheduled task is now named after your account SID
(`wsmp-relay-<SID>`), not your user name. `wsmp service install` with 1.0 (run it after
the PowerShell installer), or a later `wsmp update` from 1.0, replaces your 0.4.x task
`wsmp-relay-<username>`; until then the node keeps running from the old task and every
`wsmp service` command finds it. To return to 0.4.x, run `wsmp service uninstall` with 1.0
first.

## Linux nodes: lingering and the service PATH

Run `wsmp service install` once more on each Linux node after upgrading. It turns on systemd
lingering for your account if it is off (or prints the `sudo loginctl enable-linger <user>`
command when logind will not let you), so the node no longer goes offline at logout or waits for
a login after boot. It also rewrites the unit's `PATH` without directories that only lived as long
as the installing shell, such as `/run/user/<uid>/fnm_multishells/<id>/bin`; with fnm, set a
default first (`fnm default <version>`) so the service finds Node. `wsmp status` warns while
lingering is off.

wsmp no longer installs its service as root (it failed there anyway): run it under an ordinary
account (see the CLI README, "Linux: root or an ordinary account"). A node that already runs a
root user service keeps running, and `wsmp update` and dashboard updates still restart it, but
`wsmp service install` as root now refuses; move such a node to an ordinary account when
convenient.

## Unified node memory

Unified nodes now show OS physical RAM separately from GPU-addressable memory. GPU-side
memory includes both VRAM on unified GPUs and `{kind: "unified", memoryGb}` model entries:
both must fit the usable RAM budget and the shared accelerator budget. CPU entries and a
discrete entry's `ramGb` use RAM only. On detected AMD APUs, RAM-only memory cannot use the
BIOS VRAM carve-out; GPU memory uses the carve-out first, then system RAM through GTT.
Apple's RAM figure now shows physical memory, while its wired limit still caps GPU-side
memory. GB10's detected totals already match.

Existing hardware declarations still override node config and detection. On a unified node,
GPU-side memory is now capped by the effective `acceleratorMemoryGb`, not by a declared
`memoryGb`: a `memoryGb` declared to raise or lower what models may use (on GB10, Apple or an
AMD APU) no longer does that, so declare `acceleratorMemoryGb` instead; one declared earlier,
display-only until now, becomes a real cap. Review overrides made to work around halved RAM
figures. A declared `memoryGb` is an operator
budget: no carve-out is inferred or deducted from it. `wsmp hardware` shows both totals and how
to raise AMD's GTT/TTM limit with `ttm.pages_limit` / `ttm.page_pool_size` (4 KiB pages); recent
kernels have deprecated `amdgpu.gttsize`. See [hardware guidance](apps/cli/README.md#run-the-relay).
No protocol or database change is needed for this fix.

## Database

**Changed deployment default:** automatic pre-migration and pre-drop backups now
require `BACKUP_ENABLED=true`. If you relied on backups being taken whenever a
`/backups` volume was mounted or S3 was configured, set this flag on the server
and on any one-shot `migrate` job. Storage alone no longer enables them. Without
it migrations, including the 0.4.3 adoption and 1.0 upgrade, proceed without a
backup; startup logs one notice. With `BACKUP_ENABLED=true` but no writable `/backups`
mount and no `BACKUP_S3_BUCKET`, the migration refuses to run (`no backup destination`)
instead of warning and migrating: configure a destination or set `BACKUP_ENABLED=false`. Daily backups remain separately opt-in through
`BACKUP_SCHEDULE=daily` on the optional backup service. Explicit `backup`,
`restore`, and restore-drill commands keep working regardless of the flag. With
`BACKUP_ENABLED=true`, every container that migrates checks the destination (and the
`BACKUP_S3_*` settings) once at start and refuses to start without one, even when no
migration is pending; a container with `MIGRATE_ON_START=false` does not check. The server
process no longer receives `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` (the
entrypoint drops them after migrating); nothing in the server used them.

If you script around the new `restore` command or `app-db.sh restore`: 0 means restored, 3
means refused or cancelled with nothing changed, and 4 means the restore started, failed and
provably rolled back (`ROLLED BACK`, the database unchanged; the helper starts the app again).
Answering no at the helper's "Stop the app and continue?", or Ctrl-C (or a TERM or HUP signal)
while it waits, also gives 3. Once the restore was invoked, any other status means its outcome
is uncertain (or it committed and a later step failed), and the helper then leaves the app
stopped; start it again after checking the database
([backup-and-restore § The Compose helper](docs/backup-and-restore.md#the-compose-helper-app-dbsh)).
Before that (a failed `docker stop`, or a signal while the app is being stopped: 129/130/143)
the helper starts the app again; nothing was changed. Treat 0, 3 and 4 as definite. If every
`app-db.sh` command stops with "the app container's image … is no longer on this machine",
a redeploy dropped the image the running app uses: recreate the app with the
`docker compose … up -d --no-build --force-recreate app` command it prints, then re-run.
If it stops with "… has N app containers; this helper needs exactly one" (or "N postgres
containers"), nothing was changed: remove the extra containers it lists
(`docker rm -f <name>`; never the database's volume), then re-run.

1.0 applies the schema with committed migrations instead of `prisma db push`. Before you
upgrade:

1. **Take a backup** of the database (your provider's snapshot, or `pg_dump -Fc`). Or mount
   a writable volume at `/backups` in the 1.0 container and/or set `BACKUP_S3_*`,
   and set `BACKUP_ENABLED=true`: the
   migration runner then takes a verified `pg_dump` there before it changes anything
   ([backup-and-restore](docs/backup-and-restore.md)).
2. **Be on 0.4.3.** The automatic adoption below recognizes the 0.4.3 schema only. From
   0.4.2 or earlier, deploy the 0.4.3 image once with `APPLY_SCHEMA=safe`, then continue.
3. **Replace `APPLY_SCHEMA` with `MIGRATE_ON_START`.** Remove `APPLY_SCHEMA` from the server's
   environment; the server migrates on start by default (`MIGRATE_ON_START=true`). During 1.x
   the old variable still works, with a warning at every start:

   | `APPLY_SCHEMA` | Means | Note |
   | --- | --- | --- |
   | `safe` | `MIGRATE_ON_START=true` | Same as leaving both unset. |
   | `off` | `MIGRATE_ON_START=false` | This container does **not** migrate. It waits up to 300 s for another runner (the `migrate` command), then refuses to start. Remove it. |
   | `dangerous` | refused | Migrations never drop data implicitly. Remove it. |

   Setting both to conflicting values is refused. On a container platform that runs a
   one-shot job before rollout, run the image with the command `migrate` there and set
   `MIGRATE_ON_START=false` on the app.

On the first 1.0 start the runner finds tables but no migration history. Under its advisory
lock it builds the released 0.4.3 schema (migration `0_init`) in a temporary schema inside a
transaction that is always rolled back, and compares it with your database: tables, columns,
constraints (including the hardening's checks), indexes, triggers, functions, enums and
sequences.

- **They match:** it records `0_init` as applied (`prisma migrate resolve --applied 0_init`),
  takes the pre-migration backup if `BACKUP_ENABLED=true` (refusing to continue when no storage is configured), and applies
  `20261112000000_upgrade_to_1_0_0`. The log says `adopted a v0.4.3 database`. After that,
  every start applies only what is new.
- **They differ:** the server does not start, prints `NOT ADOPTED` with up to 25 differences
  per side, and changes nothing. Check that `DATABASE_URL` names this app's database. If the
  database predates 0.4.3, run the 0.4.3 image once with `APPLY_SCHEMA=safe`. If someone
  changed the schema by hand, undo those changes (or restore your backup) and start again.
  Do not create `_prisma_migrations` by hand.

The comparison needs the database role to be allowed to create a schema in the database
(`CREATE` on the database; the owner has it), only inside the rolled-back transaction.

The upgrade migration runs these idempotent data steps, which find nothing to do on a new
database:

- **Runtime runs.** Instances created by 0.4.1 or 0.4.2 that were never restarted can
  still have `runGeneration = 0`. 0.4.x worked out their run number from their steps at read
  time, and 1.0 no longer does. The backfill writes that same number into the column, then
  sets the default to 1 and adds a `CHECK ("runGeneration" >= 1)` constraint.
- **Model capabilities.** The retired `completions` and `surfaces.openaiCompletions` keys
  are stripped from stored provider-model capability JSON. 0.4.x ignored them; 1.0 rejects
  them.
- **Pool sidecars.** A sidecar whose owner can no longer use its target pool (the share that
  allowed it lost `canUse`) is deleted.
- The 0.4.x hardening's bookkeeping function `wmp_schema_hardening_state()` is dropped.

Stop the 0.4.x server before the 1.0 server migrates if you can; 0.4.x nodes cannot connect
to 1.0 anyway. If the old server keeps serving during the upgrade, the migration waits for a
moment when no table it changes is in use (it retries for about 30 s, and the runner retries a
failed attempt once; a restart tries again). PostgreSQL 17 is still the supported version.
Details: [schema-migrations](docs/schema-migrations.md#upgrading-a-04x-database).

Nodes that are refused because they still run a 0.4.x `wsmp` are shown on the Nodes page
as needing a newer wsmp. Reinstall wsmp on them as described above.

## Agent access

The migration converts existing agent tokens and OAuth grants automatically:
`READ` becomes `read`; `FULL` becomes all seven scopes. Both retain access to all
nodes the user owns, including future nodes. There is nothing to do. People can
then narrow or expand scopes and choose owned nodes in Access → Agents. OAuth
choices stay within the connection's approved OAuth scopes: `mcp:read` is
required, and `mcp:pools`, `mcp:runtimes`, `mcp:nodes:manage`, `mcp:commands`,
`mcp:files` and `mcp:models:test` permit their matching permissions.

`mcp:write` was removed. The migration converts stored client scopes, consents,
access and refresh token scope rows, resource scopes and pending authorization
codes carrying it to `mcp:read` plus all six fine scopes, preserving other
scopes such as `offline_access`. Existing grants retain the same effective
access: token scopes intersected with the person's grant. Already-issued JWTs
cannot be rewritten: a live token carrying the removed scope gets HTTP 401
`invalid_token` with “This token predates wsmp 1.0 scopes; refresh it or sign in
again.” A client refreshes once using its existing refresh token and continues
with the same access; sign in again if refresh is unavailable.

A client hard-coding `mcp:write` in new authorizations gets `invalid_scope` and
must request `mcp:read` plus the fine scopes it needs. Token requests explicitly
naming the removed scope, dynamic registration and CIMD metadata naming it are
also refused. DCR registers exactly the scopes a client asks for; a client that
registers without `scope` gets every scope, and consent still decides access.

Agents act only on their own user's nodes. Sharing a pool or runtime definition
does not grant access to another user's nodes, including for `model_test`. A
model test is refused if any candidate placement is unowned or disallowed.
With a selected node list, counts and traffic exclude the caller's own
disallowed nodes. An instance bound to one, or with any rank or reservation
there, does not count, and neither do the requests it served (pool traffic,
member latency and shares, request metrics, `requests_list`).
Removing a member backed by the caller's runtime, withdrawing a contribution,
or deleting its pool is refused if that runtime is bound to or running on a
disallowed node. Runtime deletion also requires its nodes to be allowed.
Narrowing aborts every in-flight MCP call, including reads, and cancels node
command and file work that the new access no longer permits. Already started
runtime operations are not undone. See [MCP scopes](docs/mcp.md#scopes).

`WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS` limits expiry for new agent tokens (default
90 days, integer 1–3650). Existing tokens keep their expiry. No-expiry creation
is still allowed by default through `WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY=true`.

**If you run with `WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY=false`, existing no-expiry
agent tokens stop working after the upgrade.** In 0.4.x the flag only blocked
creating them; in 1.0 it also refuses every existing agent token without an
expiry, on MCP (HTTP 401, `error_description="mcp_pat_no_expiry_blocked"`) and
for node commands and file work. Running commands such a token
started are ended. The tokens are not revoked or deleted: Access → Agents lists
them as **Blocked by policy**, and setting the flag back to `true` restores them.
Before upgrading, find the affected tokens (no expiry shown in Access → Agents)
and give their agents dated replacements, or keep the flag on. Dated tokens,
API keys and OAuth connections are unaffected.

## Agent host access

Agent host access (commands and files) lets the agent do whatever the wsmp
daemon's OS user can do, including reading that account's node credential and
identity key, editing wsmp's settings, and starting processes that survive
cancellation. It is off until a person enables Full control at the node. Full
control can only be raised locally; a person can lower it from the dashboard
at any time. File tools' forbidden paths and output masking are guard rails,
not a sandbox. No isolation mode exists. Narrowing or revoking credentials
does not remove software an agent already left running.

## Configuration

- **Container PID 1 is now tini.** Keep the image's `docker-entrypoint.sh` entrypoint: it runs
  startup checks and migrations, unsets every `BACKUP_S3_*` variable, then execs
  `tini -- <CMD>`. If you override the entrypoint, keep that order; starting tini first would
  leave the backup writer keys in its environment. The server is now a child of tini rather
  than PID 1, and custom server commands no longer inherit the backup location settings.
  One-shot backup and restore commands still receive the backup credentials.
- **Restore exit codes for automation.** 0 means restored, including a signal once the restore
  session has confirmed the commit, even before it has exited (`Restore completed; then
  interrupted by <signal>`); 3 means refused or
  cancelled before the restore transaction started, including usage errors; 4 means the
  restore started and provably rolled back (`ROLLED BACK`: COMMIT was never sent, also after a
  signal, `psql` stopped on an SQL error before confirming it, or the server reports the
  transaction aborted), so the database is unchanged; 1 is a failure whose outcome is uncertain,
  or a restore that committed in a session that then failed (the output says which). A signal
  after COMMIT was sent but before it was confirmed exits 129/130/143: uncertain.
- **Shipped compose files.** If you move to the new `compose.yaml`, put the optional `SMTP_*`
  settings and `WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS` in its `--env-file`; it passes them to
  the app. `compose.backups.yaml` passes `BACKUP_S3_*` to the app and the backup service,
  including `BACKUP_S3_PREFIX` (unset or empty means the default `database`).
- **Server environment.** `APPLY_SCHEMA` is replaced by `MIGRATE_ON_START` (see
  [Database](#database)); no other variable was renamed or removed. 1.0 no longer warns about
  the `RATE_LIMIT_*` variables, which were replaced in 0.4.0 and have been ignored since.
  It also no longer warns about a leftover `apps/server/.env`. Delete both if you still
  have them; use `WMP_RATE_LIMIT_SCALE` for rate-limit tuning.
- **Node configuration (`wsmp`).** 1.0 reads only the current config format.
  - It rejects a config file that has removed keys, or a `version` newer than it knows:
    `cliTokenEnv`, `mcpCommandMode`, `allowMcpCommands`, `mcpFileRead`, `endpoints`, and the
    `completions` / `surfaces.openaiCompletions` capability keys.
  - The error names the key and the file. Delete that key from the file; `wsmp login`
    cannot run while the file is invalid.
  - Files written by 0.4.x contain none of these keys, so most nodes need no change.
  - Config files that still carry the `"version": 1` or `2` stamp of an older enrollment
    load as long as their keys are current, and are saved as version 3.
- **File-tool recovery journals.** Journals written by pre-release builds (format 2) are
  no longer replayed. Let any in-flight file operation finish before upgrading a node.
- **Release branch.** The default branch is now `main`. Update any clone or CI that tracks
  `master`.

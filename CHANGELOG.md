# Changelog

Notable changes are recorded here in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style. See [release notes](docs/release-notes/) for the 0.4.x history.

## [1.0.0] - Unreleased

### Breaking

- `WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY=false` now also refuses existing agent tokens without an
  expiry, not only new ones. An operator who runs with the flag off loses those tokens' access
  on upgrade: `/mcp` answers 401 with `mcp_pat_no_expiry_blocked`, node command and file
  access stops, and running commands they started are ended. The tokens are kept, listed
  as **Blocked by policy** in Access → Agents, and work again when the flag is turned back on.
  Dated tokens, API keys and OAuth connections are unaffected. See
  [UPGRADING.md](UPGRADING.md#agent-access).
- Automatic migration/pre-drop backups now default off (`BACKUP_ENABLED=false`).
  Existing deployments relying on a mounted `/backups` volume or S3 settings must
  set `BACKUP_ENABLED=true` on the app and migration jobs to retain that behavior.
  Migrations and readiness work without backups; startup logs how to opt in.
  With `BACKUP_ENABLED=true`, a missing destination (no writable `/backups` mount and
  no `BACKUP_S3_BUCKET`) now stops the migration (`no backup destination`) instead of
  warning and migrating; a scheduled deletion is skipped for that run. Every container
  that migrates (`MIGRATE_ON_START=true` or the `migrate` command) checks this once at
  start, so a missing destination or invalid `BACKUP_S3_*` settings stop the start even
  when nothing is pending; `BACKUP_ENABLED` accepts only `true` or `false`. With backups
  off but a destination configured, the start logs a warning.
  `compose.yaml` needs only the app and Postgres; `compose.backups.yaml` adds
  backup storage and the optional daily service (`BACKUP_SCHEDULE=daily`).

- Server and wsmp use relay protocol 4.0 / `ws-model-proxy.relay.v4` only. 0.4.x CLIs are
  refused with an upgrade message; all compatibility paths for 0.4.x and earlier are removed.
  Upgrade the server, then each node with `wsmp update` (or Homebrew / the installer); see
  [UPGRADING.md](UPGRADING.md).
- A released 0.4.x CLI now actually receives the HTTP 426 upgrade body (it was dropped by the
  websocket adapter before), so it prints its upgrade message and stops with exit code 5.
- Building wsmp requires Rust 1.89 or newer.
- The default branch is `main`.
- The schema ships as committed Prisma migrations applied by the container's migration runner
  (`MIGRATE_ON_START`, default true for the server; image command `migrate`). `prisma db push`,
  `pnpm db:push` / `db:push:dangerous` and the directly applied `schema-hardening.sql` are
  removed. `APPLY_SCHEMA` is a deprecated alias during 1.x (`off` → false, `safe` → true,
  `dangerous` refused). A 0.4.3 database is adopted automatically when its schema matches
  0.4.3 exactly; see [UPGRADING.md](UPGRADING.md#database).
- `mcp:write` was removed. New authorization, token and registration requests
  naming it get `invalid_scope`; request `mcp:read` plus the needed fine scopes.
  Stored client, consent, token, resource and pending-authorization scopes are
  converted to read plus all six fine scopes; grants retain their effective
  access. Live pre-upgrade JWTs carrying it get 401 `invalid_token` and must
  refresh once (or sign in again) to continue with the same access.

### Security

- The backup writer key (`BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`) is held
  only while the migration runner and its backups run: the entrypoint unsets it before it
  `exec`s the server, so the server's environment and `/proc/1/environ` no longer carry it.
  The one-shot `backup`, `backup-schedule`, `restore` and `restore-drill` commands keep it.

- Agents act only on their own user's allowed nodes, including runtime placement and model
  tests through shared pools. Sharing a pool or runtime definition does not delegate nodes.
- Allowlisted agents' counts and traffic exclude their own disallowed nodes,
  including entire instances bound to one or with a rank or reservation there,
  and every request such an instance served. Removing or
  withdrawing a member backed by the caller's runtime, or deleting its pool,
  is refused when that runtime is bound to or running on a disallowed node.
  Runtime deletion also requires its nodes to be allowed.
- Agent host access (commands and files) has the wsmp daemon OS user's
  permissions, including reading its node credential and identity key, editing
  wsmp settings, and starting processes that survive cancellation. It is off
  until a person enables Full control locally; people can lower trust from the
  dashboard at any time. File forbidden paths and output masking are guard
  rails, not a sandbox. No isolation mode exists.
- Narrowing scopes or allowed nodes aborts all in-flight MCP calls, including reads, and
  cancels command and file work that is no longer allowed.
- `wsmp service install` warns about each directory on the pinned service `PATH` that another
  account can write (group-writable or owned by another account), with the reason and how to
  tighten it; such directories stay on the `PATH` so engines are still found. World-writable
  directories are still left off.
- Update Better Auth to 1.7.18 for GHSA-fvxx-76fc-893x and GHSA-9hm7-xhfp-cx58.
- Update Hono to 4.13.18 for GHSA-39q9-qp46-w8xg (`bodyLimit()` memory exhaustion on chunked bodies) and apply dependency overrides for vulnerable transitive packages.
- Update Vite to 8.3.8 (Rolldown 1.2.18) for GHSA-p4f5-76q4-ffq7, which affects the network-exposed dev server only.
- The app image is pinned to Node.js 26.13.1 (the 2026-11 security release) by digest.
- Forced two-factor enrollment now also applies to media upload and signing and to the pool member test.
- A sign-in racing an account ban or archival can no longer keep a session.
- The relay refuses redirects that leave the server's host or downgrade TLS, so the node credential is never sent elsewhere, and connecting has a deadline.

### Added

- Agent scopes (`read`, `pools`, `runtimes`, `nodes:manage`, `commands`, `files`,
  `models:test`) and owned-node allowlists, editable for tokens and OAuth connections in
  Access → Agents. OAuth requires `mcp:read` and accepts matching fine
  `mcp:<scope>` permissions. Discovery and the `/mcp` challenge list read plus
  all six fine scopes; DCR registers exactly the requested scopes (all of them when
  `scope` is omitted).
- `WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS` caps newly minted expiring agent tokens (default 90,
  integer 1–3650). No-expiry tokens remain allowed by default; existing tokens are unchanged.
- Live node updates through a dashboard event stream.
- Declared tool and reasoning capabilities for served models and pool routing.
- Shell and execution mode in node command results (`ranWith`).
- Homebrew version checks before installing, with an explicit "Install anyway" choice.
- Terminal touch scrolling, tab and node rearrangement, and public contribution templates.
- Migration tooling from the template: `pnpm db:migrate` / `db:migrate:apply` /
  `db:migrate:rebase` / `db:reset:local` / `db:worktree`, the CI migration checks
  (`pnpm db:check-migrations`), and the `backup`, `restore`, `restore-drill`,
  `backup-schedule` and `hold-deletions` image commands with a pre-migration `pg_dump` into
  a `/backups` volume and/or an S3-compatible bucket (`BACKUP_S3_*`, `@aws-sdk/client-s3`
  bundled in the image).
- `restore` exit statuses for automation:
  - **0**: the restore committed. A signal that arrives once the restore session has confirmed
    the COMMIT still gives 0, with `Restore completed; then interrupted by <signal>`, even
    before the session has exited.
  - **3**: it refused or was cancelled before changing anything. That covers a usage error, a
    preview, a failed check or pre-restore snapshot, Ctrl-C or Ctrl-D at its prompt, and a stop
    signal before the restore transaction started. It also covers an archive with large objects
    (BLOB entries), which pg_restore would commit in their own transaction, and a `psql` that
    cannot be started.
  - **4**: `ROLLED BACK`. The restore transaction started and provably did not commit, so the
    target is unchanged: COMMIT was never sent (a failure, or a stop signal, before it), `psql`
    stopped on an SQL error (`ON_ERROR_STOP`) before confirming it, or the server reports the
    transaction aborted (`pg_xact_status`, PostgreSQL 13 or newer).
  - **1, or 129/130/143 on a signal after COMMIT was sent**: the outcome is uncertain (COMMIT
    was sent, not confirmed, and the server could not say). A session that confirmed the COMMIT
    and then exited with an error also gives 1, and says the database is restored but the
    session did not end cleanly; keep the app stopped and check it, as after any other 1.
    Treat 0, 3 and 4 as definite.
- The Compose helper (`scripts/backup/host.sh`, copied out as `app-db.sh`) wraps `list`,
  `backup`, `restore`, `drill` and `hold-deletions`.
  - `restore` asks "Stop the app and continue?" first. Answering no, Ctrl-D, or Ctrl-C (or a
    TERM or HUP signal) while it waits exits 3 with nothing stopped, also under `| tee`. A signal
    after that prompt exits 129/130/143 and starts the app again if the restore was not invoked.
  - It prompts as long as stdin is a terminal, so `restore | tee restore.log` works.
  - It starts the app again after exit 0, 3 or 4 (rolled back, database unchanged), even if
    `tee` was killed by Ctrl-C.
  - After any other exit of the invoked restore it keeps the app stopped and prints the
    `docker start` command; a failure or signal before the restore was invoked starts it again.
  - It finds the app as the Compose service `app` of the shipped `compose.yaml` (with or
    without `compose.backups.yaml`).
  - It needs exactly one `app` container and exactly one `postgres` container (running or
    stopped) in the project. With none, or with several (a scaled-up replica, a leftover
    `docker compose run` container), every command stops with exit 1 before touching anything,
    lists the extra ones, and asks you to remove them.
  - It runs the app container's exact image (its image ID, never the tag). When a redeploy
    has dropped that image while the app still runs it, every command stops with exit 1
    before touching anything and prints the fix:
    `cd <dir> && docker compose -p <project> [--env-file <file>] -f <file>… up -d --no-build --force-recreate app`,
    with the `-f` and `--env-file` files the deploy used (from the container's Compose labels).
- The daily `backup` service's healthcheck (`node scripts/backup/schedule.mjs health`, used by
  `compose.backups.yaml`): with `BACKUP_SCHEDULE=daily` it is unhealthy when the last run
  failed, the last success is more than 26 hours old, nothing has succeeded an hour after the
  service started, the schedule settings are invalid, or its status file is missing or
  invalid (the scheduler is not running or cannot write it). With backups off it is always
  healthy.
- `compose.yaml` passes the optional `SMTP_*` settings and
  `WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS` from the env file to the app, and
  `compose.backups.yaml` passes `BACKUP_S3_*` to the app and the backup service. An empty
  value counts as unset (email needs `SMTP_HOST`, the S3 copy `BACKUP_S3_BUCKET`); an unset or
  empty `BACKUP_S3_PREFIX` becomes the default `database`.
- `GET /ready` reports the build's `commit`: `BUILD_VERSION` when it is a full 40-hex git SHA,
  otherwise `null`.
- `TEST_CONTAINER_PREFIX` (or `--container-prefix <name>`) names every container, network and
  image of the Docker test harnesses (`test:pg`, `backup:test`, `db:test-migrations`,
  `db:test-adopt-released`); an invalid prefix is an error. See [CONTRIBUTING.md](CONTRIBUTING.md#docker-test-harnesses).

### Fixed

- Linux: `wsmp service install` turns on systemd lingering for your account when it is off
  (`loginctl enable-linger`, as you, no password prompt), so the node starts at boot and keeps
  running after logout; if logind refuses, it prints the exact `sudo loginctl enable-linger
  <user>` command. `wsmp status` (text, and a `service` object in `--json`) and `wsmp service
  status` warn while an installed user service has lingering off.
- The service unit (and the macOS wrapper) no longer pins `PATH` directories that end with the
  installing shell or login session: `/run/user/<uid>/...` (including fnm's
  `fnm_multishells/<id>`), `/tmp`, `/var/tmp` and macOS's per-user `$TMPDIR`. fnm's per-shell
  directory is replaced by fnm's default version when it has one.
- Linux: `wsmp service install` run as root refuses before writing anything, instead of failing
  with `Failed to connect to user scope bus`, and prints the commands that set wsmp up under an
  ordinary account (`useradd`, `loginctl enable-linger`, `su -`, then the installer and `wsmp
  login`). `wsmp login` as root refuses the same way before it enrolls when it would install or
  offer the service (`--service`, `--yes`, or a terminal); with `--no-service` root may still
  enroll for a foreground `wsmp run`. An existing root service keeps running and
  updating. A user install whose `systemctl --user` reaches no user manager now refuses before the
  unit is written, with the `sudo loginctl enable-linger <user>` fix; a shell from `su -` or
  `sudo -iu` (no `XDG_RUNTIME_DIR`) now reaches the user manager at `/run/user/<uid>`.

- Unified nodes report OS total RAM separately from GPU-addressable memory, fixing AMD APUs
  showing about half their RAM. Placement caps unified-GPU VRAM and `unified` model entries
  by both RAM and shared accelerator memory; RAM-only claims cannot use a detected AMD APU's
  BIOS carve-out. Restarts, reservations and profile preview/apply use the same budgets.
  Apple's RAM figure shows physical memory while its wired limit caps GPU-side memory.
  On unified nodes GPU-side memory is capped by the effective `acceleratorMemoryGb`, not a
  declared `memoryGb`; an `acceleratorMemoryGb` declared earlier (display-only before) is now a
  real cap. `wsmp hardware` shows both totals and AMD TTM tuning guidance.

- An unusable command working directory returns `bad_cwd` (`BAD_REQUEST`),
  with directory guidance, instead of `node_offline`.
- Windows: the relay and update dead-man scheduled tasks are named after the account SID
  (`wsmp-relay-<SID>`, `wsmp-update-deadman-<SID>`) instead of `USERNAME`, so two accounts with
  the same user name in different domains no longer collide. `wsmp service install`,
  `wsmp update` and `wsmp service uninstall` replace or remove the account's own 0.4.x task;
  another account's task with the old name is never touched.
- Reconnecting a node after lowering its trust to Relay only.
- MCP refusal text, transport error codes, schema digests and command timestamps.
- Update rollback, recovery, confirmation, service restart and command timeout handling.
- Forcing an update waiting for idle now preserves the requested build.
- Nodes left marked online after a server crash now show as offline once their heartbeat is
  stale, and agents can delete them.
- wsmp notices a silently dead relay connection (no frames for about a minute, or no
  `hello.ok` within 60 s) and reconnects; update confirmation and the update-ack lock no
  longer block the relay loop; large command output no longer starves control frames.
- Admins can stop impersonating again (the admin gate refused the target's session).
- `/v1/audio/translations`, `/v1/audio/speech` and `/v1/responses/count_tokens` respect
  the instance's configured concurrency like the other endpoints; waiting requests no
  longer wake each other in a loop.
- A failed background database query can no longer stop the server (capacity maintenance
  and node disconnect handling).
- Overlapping or stale node sessions no longer drop or requeue the current session's work;
  a command whose final status failed to save is recovered instead of staying "running".
- Media uploads racing expiry keep their bytes, failed deletions are retried instead of
  orphaning files, and failed uploads no longer leave temporary files behind.
- Large provider and local error responses are read within their size limits.
- wsmp: Windows `secret set` hides input, the Windows config lock works, service install
  reports a failed restart, `service restart` on macOS recovers an unloaded agent, and huge
  directories no longer exhaust memory when listed.
- Web: signed-out pages no longer overflow on phones, the account menu no longer reopens
  after switching accounts, a dropped file no longer navigates away, and pages get a
  localized 404, a skip link and 44px touch targets.
- A browser that left while its live-update stream was being admitted no longer holds a
  stream slot; terminal open and attach re-check the force-2FA policy; reordering terminals
  before the saved layout loads no longer wipes the saved order.
- Dialog and sheet close buttons have a 44px touch target and a translated label.
- A missing file under `/assets/` (a chunk from an older build, a typo) is now a plain,
  uncached `404 Not Found`. It used to redirect to `/<locale>/assets/…` and render the app's
  HTML 404 page, which browsers reported as a MIME-type error.
- A restore that cannot start `psql` for its lock session now names the cause in its refusal
  (`could not open the lock session: spawn psql ENOENT`) instead of "no reply from the
  database". `app-db.sh` with no arguments prints its help when sourced too, and a one-line
  usage when piped into `bash -s` (it used to print a `sed` error there).

### Changed

- The container now runs [tini](https://github.com/krallin/tini) as PID 1. The entrypoint stays
  PID 1 through backup checks and migrations, then unsets every `BACKUP_S3_*` variable and execs
  `tini -- <CMD>`, so neither `/proc/1/environ` nor the server's environment holds the backup
  writer keys. tini forwards signals, reaps orphaned processes and passes the server's exit
  status through. The one-shot `backup`, `backup-schedule`, `restore` and `restore-drill`
  commands also run under tini and keep their backup credentials; `migrate` stays supervised by
  the entrypoint. A custom entrypoint override must keep this order (see
  [UPGRADING.md](UPGRADING.md#configuration)).
- A stop signal (`docker stop`, Ctrl-C or HUP) during the backup startup check or migrations
  ends that step, also when it lands while the step is starting: the entrypoint repeats TERM to
  the step until it is gone, never starts the CMD, and exits with the signal's status (143, 130
  or 129).
- Existing agent credentials migrate automatically: `READ` becomes `read`, `FULL` becomes
  every scope, and both retain all-owned-node access. No user action is needed.
- Node.js 26.13.1, pnpm 12.18.0, cargo-dist 0.34.0 and refreshed dependencies and action pins.
- Linux releases add static musl builds. `/install.sh` still installs the glibc build on glibc 2.34 or newer (it resolves mDNS `*.local` names; static musl cannot) and the musl build on Alpine and older glibc, which previously built from source. Updates keep each node on its flavour. The release and CLI CI check the glibc builds' 2.34 floor.
- OCI image metadata identifies the MIT license and FlyCockpit LLC.
- Public documentation replaces internal contracts and field reports.
- The iOS home-screen icon (Apple touch icon) is the new FlyCockpit app tile.

See the [1.0.0 release notes](docs/release-notes/1.0.0.md) for details and deployment notes.

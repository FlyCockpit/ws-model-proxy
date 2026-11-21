#!/bin/sh
# Docker entrypoint — PID 1 of the image; runs before the container CMD.
#
# Backup writer keys stay out of the server: this script holds BACKUP_S3_*
# only while the migration runner and its backups run as children, then unsets
# every BACKUP_S3_* variable and execs tini with the CMD. tini becomes PID 1
# with the cleaned environment: neither /proc/1/environ nor the server's
# environment carries the writer keys. One-shot backup/restore commands keep
# them because writing backups is their job.
#
# Image commands:
#   migrate              run the migration runner once and exit with its status
#                        (container platforms: a one-shot job before rollout).
#   restore <args...>    exec scripts/backup/restore.sh (one-shot restore job).
#   backup [--keep <n>]  take a verified pg_dump now (label `manual`).
#   backup-schedule      the optional daily-backup service (scripts/backup/schedule.mjs).
#   restore-drill <src>  restore into a throwaway empty database and verify it.
#   hold-deletions [days|--clear]
#                        pause scheduled deletions for `days` (default 7,
#                        1..90) with the owner hold, or remove it (one-shot;
#                        after a restore the runner cannot detect).
#   anything else        the normal CMD (the server), after:
#     1. required env validation;
#     2. migrations — MIGRATE_ON_START=true (default for the server command):
#        `node scripts/db/migrate-runtime.mjs apply` (classify the database,
#        adopt a released 0.4.3 database that has no migration history, refuse
#        failed / foreign schemas / in-place breaking changes on a served
#        database, the pre-migration backup when BACKUP_ENABLED=true (a
#        missing destination refuses the start: pre-migrate.sh
#        --startup-notice), `prisma migrate deploy`, then
#        the scheduled deletions phase). Concurrent leaders serialize on the
#        runner's advisory lock; the second normally finds nothing to do.
#        MIGRATE_ON_START=false (default for every other command):
#        `migrate-runtime.mjs wait` — read-only wait (fixed 300 s) for the
#        database to be up to date (a `migrate` job or another container
#        migrates it).
#        Both register this process in the instance registry under a fresh
#        WMP_INSTANCE_ID (exported here). The one-shot commands (`migrate`,
#        `restore`, `hold-deletions`, `backup*`, `restore-drill`) get no id (an
#        inherited WMP_INSTANCE_ID is unset first) and register nothing;
#     3. drop BACKUP_S3_* and exec tini with the CMD.
#
# APPLY_SCHEMA (0.4.x) is a deprecated alias, accepted during 1.x with a
# warning: off → MIGRATE_ON_START=false, safe → MIGRATE_ON_START=true.
# APPLY_SCHEMA=dangerous is refused: migrations never accept data loss.
#
# See docs/schema-migrations.md.

# Install handlers before validation or any child launch (the startup check,
# the `node -p` that mints the instance id, the runner), so there is no gap
# between steps where a `docker stop` is dropped (a shell running as PID 1
# ignores TERM unless it traps it) and the runner or the CMD starts anyway.
# They stay through `exec` (exec resets caught signals itself). (Before the
# first trap and between `exec` and tini installing its own handlers, a TERM
# to PID 1 is dropped; sh cannot close those windows.)
#
# A supervised child gets TERM for every stop signal: this non-interactive
# shell starts background children with SIGINT ignored, and bash keeps that,
# so a forwarded INT could not stop it. The entrypoint still exits with the
# signal's own status (143 TERM, 130 INT, 129 HUP).
child_pid=""
child_start=""
launching_child=false
stop_signal=""
stopping=false
have_proc=false
if [ -r /proc/self/stat ]; then have_proc=true; fi
# With a supervised child, the handler itself repeats the TERM until the child
# is gone (stop_child): a signal that lands just before supervise's `wait` runs
# the handler and then lets `wait` block, so nothing after it could repeat a
# TERM the child missed. During the launch the child is not identified yet:
# the handler only records the signal, and supervise forwards it. A signal
# that lands while a stop is already under way only records itself: a nested
# handler that drove the child to gone (letting dash reap it and free its PID)
# would make the interrupted check-then-kill outside it signal a stale PID.
# Without /proc nothing repeats the TERM, so there every signal sends one, as
# before.
stop_startup() {
  stop_signal="$1"
  [ "$stopping" = false ] || [ "$have_proc" = false ] || return 0
  if [ -n "$child_pid" ]; then
    stopping=true
    stop_child
  elif [ "$launching_child" = false ]; then
    exit "$2"
  fi
}
trap 'stop_startup TERM 143' TERM
trap 'stop_startup INT 130' INT
trap 'stop_startup HUP 129' HUP
set -e

# The pause between repeated TERMs: 0.2 s where sleep takes fractions, else
# 1 s. Decided once, here: in dash a trap that runs during another trap leaves
# $? at the outer trap's status, so the loop cannot branch on sleep's status.
stop_pause=1
if sleep 0.01 2>/dev/null; then stop_pause=0.2; fi

# proc_start <pid>: sets proc_start_value to the start time of a live (not
# zombie) process, field 22 of /proc/<pid>/stat, or to "" for a process that is
# gone or a zombie. It tells the supervised child apart from a later process
# that reuses its PID once it has been reaped (dash reaps a background child
# while it waits for any foreground command, such as `sleep`). Builtins only,
# no fork: the trap handler runs it, and a container at its pids limit cannot
# fork, so the first TERM always gets out. (stop_child's pause does fork
# `sleep`: at a full pids limit dash exits 2 there, after that TERM, and the
# container's teardown ends the child.) The stop guard keeps two calls from
# interleaving.
proc_start() {
  proc_start_value=""
  stat_line=""
  read -r stat_line 2>/dev/null <"/proc/$1/stat" || [ -n "$stat_line" ] || return 0
  # Field 2 (comm) is in parentheses and may contain spaces: drop through ") ".
  # shellcheck disable=SC2086
  set -- ${stat_line##*) }
  [ $# -ge 20 ] || return 0
  [ "$1" != Z ] || return 0
  shift 19
  proc_start_value=$1
}

# child_alive: the supervised child still runs (same start time as at launch;
# without /proc, `kill -0`).
child_alive() {
  if [ "$have_proc" = true ]; then
    [ -n "$child_start" ] || return 1
    proc_start "$child_pid"
    [ "$proc_start_value" = "$child_start" ]
  else
    kill -0 "$child_pid" 2>/dev/null
  fi
}

# term_child: TERM the supervised child, checked right before the kill, so a
# reaped child's reused PID is not signalled (a gap of microseconds remains
# between the check and the kill builtin; it matters only if the PID space
# wraps around within it).
term_child() {
  [ -n "$child_pid" ] || return 0
  if [ "$have_proc" = false ] || child_alive; then
    kill -TERM "$child_pid" 2>/dev/null || :
  fi
}

# stop_child: TERM the child every 0.2 s until it is gone (where /proc
# identifies it; elsewhere, once). One TERM is not enough: one that lands in
# the instant after the fork, before the forked shell has reset the traps it
# inherited from this one, is swallowed there, and the command would run to
# its end. Both supervised children (the bash startup check and the migration
# runner) have no TERM handler, so repeating it is harmless.
stop_child() {
  term_child
  # Without /proc a reaped child's PID could be reused: one TERM only, which
  # the fork window can swallow. The image always has /proc; only a local run
  # of this script elsewhere (not Linux) takes this path.
  [ "$have_proc" = true ] || return 0
  # (The pause forks `sleep`; the TERM itself never needs a fork.)
  while child_alive; do
    sleep "$stop_pause" 2>/dev/null || :
    term_child
  done
}

# supervise <command...>: run one startup child (the backup startup check, the
# migration runner) in the background so a stop signal reaches it — this
# shell is PID 1, and a trapped signal only runs between commands — then wait
# for the child's own exit (status in child_status). After a stop signal the
# CMD never starts: the child gets TERM until it is gone, then the entrypoint
# exits with the signal's status.
supervise() {
  launching_child=true
  "$@" &
  child_pid=$!
  # Its identity for every later TERM, read with builtins only, so dash cannot
  # reap the child (and free its PID) before the read. A child that already
  # exited reads as gone and is never signalled. Until
  # launching_child is false, a signal is only recorded (term_child skips a
  # child it cannot identify yet) and handled just below.
  if [ "$have_proc" = true ]; then
    proc_start "$child_pid"
    child_start=$proc_start_value
  fi
  launching_child=false
  set +e
  if [ -z "$stop_signal" ]; then
    wait "$child_pid"
    child_status=$?
  fi
  # A stop signal recorded during the launch (the handler has already stopped
  # the child for any later one): TERM the child until it is gone, then
  # collect it.
  if [ -n "$stop_signal" ]; then
    stopping=true
    stop_child
    wait "$child_pid" 2>/dev/null
    # Without /proc: a further signal interrupts that wait; wait again while
    # the child still runs.
    while [ "$have_proc" = false ] && kill -0 "$child_pid" 2>/dev/null; do
      wait "$child_pid" 2>/dev/null
    done
  fi
  set -e
  child_pid=""
  child_start=""
  case "$stop_signal" in
    TERM) exit 143 ;;
    INT) exit 130 ;;
    HUP) exit 129 ;;
  esac
}

# The production entrypoint is installed in /usr/local/bin while the app lives
# under /app. APP_ROOT stays overridable for scripts/test-docker-entrypoint-schema.sh.
APP_ROOT="${APP_ROOT:-/app}"
RUNNER="$APP_ROOT/scripts/db/migrate-runtime.mjs"
BACKUP_HOOK="$APP_ROOT/scripts/backup/pre-migrate.sh"

# --- Strict switches ---
case "${BACKUP_ENABLED:-}" in
  "" | true | false) ;;
  *)
    echo "FATAL: BACKUP_ENABLED must be true or false (got \"$BACKUP_ENABLED\")." >&2
    exit 1
    ;;
esac

# One-shot jobs never inherit a running application instance registration:
# only the runner and the CMD below get a fresh WMP_INSTANCE_ID.
unset WMP_INSTANCE_ID

# --- One-shot image commands ---
case "${1:-}" in
  migrate)
    if [ -z "$DATABASE_URL" ]; then
      echo "FATAL: Missing required environment variable(s): DATABASE_URL" >&2
      exit 1
    fi
    # Once per migrating start, even with nothing pending: BACKUP_ENABLED=true
    # without a usable destination fails here, not at the first real migration.
    supervise bash "$BACKUP_HOOK" --startup-notice
    [ "$child_status" -eq 0 ] || exit "$child_status"
    supervise node "$RUNNER" apply
    exit "$child_status"
    ;;
  restore)
    shift
    exec tini -- bash "$APP_ROOT/scripts/backup/restore.sh" "$@"
    ;;
  hold-deletions)
    shift
    if [ -z "$DATABASE_URL" ]; then
      echo "FATAL: Missing required environment variable(s): DATABASE_URL" >&2
      exit 1
    fi
    exec tini -- node "$RUNNER" hold "$@"
    ;;
  backup)
    # Back up now: the same pg_dump archive as the pre-migration backup.
    shift
    exec tini -- bash "$APP_ROOT/scripts/backup/pre-migrate.sh" --label manual --required "$@"
    ;;
  backup-schedule)
    # The optional daily-backup service (BACKUP_SCHEDULE=daily; idles when off).
    exec tini -- node "$APP_ROOT/scripts/backup/schedule.mjs" run
    ;;
  restore-drill)
    # Restore into a THROWAWAY empty database and check it.
    shift
    exec tini -- node "$APP_ROOT/scripts/backup/drill.mjs" "$@"
    ;;
esac

# --- 1. Required env vars ---
missing=""
required_vars="DATABASE_URL"
is_server=false
case " $* " in
  *" apps/server/dist/index.mjs"*|*" apps/server/"*|*"/apps/server/dist/index.mjs"*)
    required_vars="$required_vars BETTER_AUTH_SECRET"
    is_server=true
    ;;
esac

for var in $required_vars; do
  eval val=\$$var
  if [ -z "$val" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "FATAL: Missing required environment variable(s):$missing" >&2
  echo "       Set them in your orchestrator (Dokploy, Azure Container Apps, etc.)." >&2
  exit 1
fi

# --- 2. Migrations ---
# Deprecated 0.4.x alias. Never silently: the operator sees what it maps to.
if [ -n "${APPLY_SCHEMA:-}" ]; then
  case "$APPLY_SCHEMA" in
    off) alias_value=false ;;
    safe) alias_value=true ;;
    dangerous)
      echo "FATAL: APPLY_SCHEMA=dangerous is no longer supported. Schema changes now ship as reviewed" >&2
      echo "       migrations and never drop data implicitly. Remove APPLY_SCHEMA; the server migrates" >&2
      echo "       on start (MIGRATE_ON_START, default true). See docs/schema-migrations.md." >&2
      exit 1
      ;;
    *)
      echo "FATAL: APPLY_SCHEMA=$APPLY_SCHEMA is invalid (deprecated; use MIGRATE_ON_START=true|false)." >&2
      exit 1
      ;;
  esac
  if [ -n "${MIGRATE_ON_START:-}" ] && [ "$MIGRATE_ON_START" != "$alias_value" ]; then
    echo "FATAL: APPLY_SCHEMA=$APPLY_SCHEMA (deprecated, means MIGRATE_ON_START=$alias_value) conflicts with" >&2
    echo "       MIGRATE_ON_START=$MIGRATE_ON_START. Remove APPLY_SCHEMA." >&2
    exit 1
  fi
  echo "WARNING: APPLY_SCHEMA is deprecated and will be removed; it now means MIGRATE_ON_START=$alias_value." >&2
  if [ "$alias_value" = false ]; then
    echo "         This container will NOT apply migrations: it waits for another runner (the \`migrate\`" >&2
    echo "         command) to bring the database up to date. Remove APPLY_SCHEMA to migrate on start." >&2
  else
    echo "         Replace it with MIGRATE_ON_START=true, or remove both (true is the server default)." >&2
  fi
  MIGRATE_ON_START="$alias_value"
fi

if [ "$is_server" = true ]; then
  MIGRATE_ON_START="${MIGRATE_ON_START:-true}"
  role=server
else
  MIGRATE_ON_START="${MIGRATE_ON_START:-false}"
  role=worker
fi
case "$MIGRATE_ON_START" in
  true) runner_mode=apply ;;
  false) runner_mode=wait ;;
  *)
    echo "FATAL: MIGRATE_ON_START must be true or false (got \"$MIGRATE_ON_START\")." >&2
    exit 1
    ;;
esac

# A container that migrates refuses to start when BACKUP_ENABLED=true has no
# usable destination (and warns when backups are off but a destination is
# configured). One that only waits needs no destination.
if [ "$runner_mode" = apply ]; then
  supervise bash "$BACKUP_HOOK" --startup-notice
  [ "$child_status" -eq 0 ] || exit "$child_status"
fi

# One id per container start, never reused: scheduled deletions wait for every
# registered instance of an older release (scripts/db/lib/contracts.mjs).
# A short foreground child: a stop signal during it is acted on (exit, no
# runner, no CMD) as soon as it returns.
WMP_INSTANCE_ID="$(node -p 'require("node:crypto").randomUUID()')"
export WMP_INSTANCE_ID

# The runner runs in the background so a stop signal reaches it: this shell is
# PID 1, which ignores TERM unless it traps it. A stop during migrations ends
# the runner (an interrupted wrapped migration rolls back; the next start
# recovers it) and never starts the CMD.
supervise node "$RUNNER" "$runner_mode" --role "$role"
runner_status=$child_status
if [ "$runner_status" -ne 0 ]; then
  if [ "$is_server" = true ] && [ "${APPLY_SCHEMA:-}" = off ]; then
    echo "FATAL: Migration wait failed or timed out: APPLY_SCHEMA=off set MIGRATE_ON_START=false." >&2
    echo "       Remove APPLY_SCHEMA (the server migrates by default), or replace it with MIGRATE_ON_START=true." >&2
  fi
  exit "$runner_status"
fi

# --- 3. Drop backup settings and hand off to the container CMD ---
# tini replaces this shell as PID 1 with the cleaned environment. The server
# has no use for the non-secret backup location settings either.
for name in $(env | sed -n 's/^\(BACKUP_S3_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
# The writer key pair goes even if that listing failed (the substitution's
# status is not checked): fail closed for the secrets.
unset BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
exec tini -- "$@"

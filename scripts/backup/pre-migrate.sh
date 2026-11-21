#!/usr/bin/env bash
# Pre-migration backup — called by the migration runner (--required, only when
# BACKUP_ENABLED=true) when migrations are pending or before a scheduled
# deletion (--label pre-drop), by restore.mjs (--label pre-restore --required)
# to snapshot a target before replacing it, and by the `backup` command and
# the daily backup-schedule service (both --required).
#
# Linux only: it runs inside the app image (Debian) on the deployment server
# and uses GNU find/mktemp/mountpoint. Its tests run in a Linux container
# where Docker exists (scripts/backup/pre-migrate.test.mjs).
#
# Destinations (either, both, or neither):
#   /backups          — used when it is a mounted volume and writable (the
#                       image creates an empty placeholder that does not count). The newest
#                       5 pre-migrate dumps are kept.
#   BACKUP_S3_BUCKET  — when set, the dump is also uploaded with BACKUP_S3_*.
#
# Exit status (the runner's contract):
#   0  backup written and verified, OR (without --required) no destination
#      configured (silent).
#   1  a configured backup failed, or --required found no destination — the
#      runner must not migrate.
#   3  the dump is written and verified in /backups, but the S3 upload failed
#      (still a failure for the runner; schedule.mjs re-uploads that file
#      instead of dumping again).
#
# Usage: pre-migrate.sh [--label <name>] [--required] [--keep <n>] | --startup-notice
#   --startup-notice  never dumps (the entrypoint calls it once per migrating
#               start). BACKUP_ENABLED unset/false: warn when a destination is
#               configured anyway, exit 0. BACKUP_ENABLED=true: exit 1
#               unless a usable destination is configured (and BACKUP_S3_*
#               settings are valid), so a deploy that asked for backups fails
#               clearly at startup instead of at its first migration.
#   --label     file-name prefix (default pre-migrate; [a-z0-9-] only)
#   --required  fail when no destination is configured
#   --keep      local dumps of this label to keep (default 5 for pre-migrate,
#               0 = never prune, the default for every other label)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="/backups"
label="pre-migrate"
required=0
startup_notice=0
keep=""

fatal() {
  echo "FATAL: [backup] $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label)
      [ $# -ge 2 ] || fatal "--label needs a value."
      label="$2"
      shift 2
      ;;
    --startup-notice)
      startup_notice=1
      shift
      ;;
    --required)
      required=1
      shift
      ;;
    --keep)
      [ $# -ge 2 ] || fatal "--keep needs a value."
      keep="$2"
      shift 2
      ;;
    *) fatal "unknown argument: $1" ;;
  esac
done
[[ "$label" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || fatal "--label must match [a-z0-9-]."
if [ -z "$keep" ]; then
  if [ "$label" = pre-migrate ]; then keep=5; else keep=0; fi
fi
[[ "$keep" =~ ^[0-9]+$ ]] || fatal "--keep must be a non-negative integer."

case "${BACKUP_ENABLED:-}" in
  "" | false) enabled=0 ;;
  true) enabled=1 ;;
  *) fatal "BACKUP_ENABLED must be true or false (got \"${BACKUP_ENABLED}\")." ;;
esac

# /backups counts as configured only when it is a real mount. The image
# pre-creates an empty /backups owned by the runtime user (so a fresh named
# volume inherits writable ownership); that bare directory is not a backup
# destination — writing there would vanish with the container.
is_mount() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "$1"
  else
    [ "$(stat -c %d "$1")" != "$(stat -c %d /)" ]
  fi
}

if [ "$startup_notice" = 1 ] && [ "$enabled" = 0 ]; then
  # An upgrade from 0.4.x (where a mounted /backups or BACKUP_S3_* alone turned
  # the pre-migration backup on) would otherwise lose its automatic dumps
  # quietly. The general backups-off notice is the server's own startup log
  # (apps/server/src/index.ts), so it is not repeated here.
  if [ -n "${BACKUP_S3_BUCKET:-}" ] || { [ -d "$LOCAL_DIR" ] && is_mount "$LOCAL_DIR"; }; then
    echo "WARNING: [backup] A backup destination is configured but BACKUP_ENABLED is not true, so NO automatic pre-migration or pre-drop backup is taken. Set BACKUP_ENABLED=true to turn them on (it defaults to false since 1.0; docs/backup-and-restore.md)." >&2
  fi
  exit 0
fi

use_local=0
if [ -d "$LOCAL_DIR" ] && ! is_mount "$LOCAL_DIR"; then
  : # image-created placeholder directory, not a mounted volume
elif [ -d "$LOCAL_DIR" ] && [ -w "$LOCAL_DIR" ]; then
  use_local=1
elif [ -d "$LOCAL_DIR" ]; then
  # A mounted volume the process cannot write is a configured backup that
  # cannot succeed — do not silently skip it (also at startup: BACKUP_ENABLED
  # is true here, so the deploy asked for backups).
  fatal "$LOCAL_DIR exists but is not writable by $(id -un) (uid $(id -u)). Fix the volume's ownership."
fi
use_s3=0
[ -z "${BACKUP_S3_BUCKET:-}" ] || use_s3=1

if [ "$use_local" = 0 ] && [ "$use_s3" = 0 ]; then
  if [ "$startup_notice" = 1 ]; then
    fatal "BACKUP_ENABLED=true but no backup destination is configured: mount a writable volume at $LOCAL_DIR and/or set BACKUP_S3_BUCKET with BACKUP_S3_*, or set BACKUP_ENABLED=false to run without backups (docs/backup-and-restore.md)."
  fi
  if [ "$required" = 1 ]; then
    fatal "no backup destination: mount a writable volume at $LOCAL_DIR or set BACKUP_S3_BUCKET and BACKUP_S3_*."
  fi
  exit 0
fi

if [ "$startup_notice" = 1 ]; then
  if [ "$use_s3" = 1 ]; then
    node "$HERE/s3.mjs" check || exit 1
  fi
  destinations=""
  [ "$use_local" = 0 ] || destinations="$LOCAL_DIR"
  [ "$use_s3" = 0 ] || destinations="${destinations:+$destinations and }BACKUP_S3_BUCKET"
  echo "[backup] Backups are ON (BACKUP_ENABLED=true): pre-migration and pre-drop dumps go to $destinations." >&2
  exit 0
fi

# Fail before connecting or dumping when the S3 SDK cannot load (a checkout
# without pnpm install; the image bundles it).
if [ "$use_s3" = 1 ]; then
  node "$HERE/s3.mjs" check || exit 1
fi

[ -n "${DATABASE_URL:-}" ] || fatal "DATABASE_URL is not set."

# The target is exactly DATABASE_URL: drop inherited libpq variables (PGHOSTADDR,
# PGSERVICE, …) that could redirect the connection, then export the settings
# parsed from the URL, NUL-delimited and verbatim (no eval), so the password
# never reaches argv.
while IFS= read -r inherited; do
  unset "$inherited"
done < <(compgen -e | grep '^PG' || true)
pg_env="$(mktemp)"
trap 'rm -f "$pg_env"' EXIT
node "$HERE/lib.mjs" pg-env >"$pg_env" || fatal "could not parse DATABASE_URL."
while IFS= read -r -d '' assignment; do
  export "${assignment?}"
done <"$pg_env"
rm -f "$pg_env"
[ -n "${PGDATABASE:-}" ] || fatal "DATABASE_URL does not name a database."
export PGCONNECT_TIMEOUT=10

# pg_dump can dump an older server, never a newer one. Say what to fix.
server_num="$(psql -X -A -t -q -c 'SHOW server_version_num' 2>&1)" ||
  fatal "cannot connect to $PGHOST:$PGPORT/$PGDATABASE: $server_num"
[[ "$server_num" =~ ^[0-9]+$ ]] || fatal "unexpected server_version_num '$server_num'."
server_major=$((server_num / 10000))
client_major="$(pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
if [ "$client_major" -lt "$server_major" ]; then
  fatal "pg_dump is version $client_major but the server is $server_major. Install postgresql-client-$server_major in the Dockerfile and rebuild."
fi

if [ "$use_local" = 1 ]; then
  out_dir="$LOCAL_DIR"
  # A dump killed mid-write (container stopped, OOM) leaves its hidden
  # .partial behind: the EXIT trap never ran. Older than 120 minutes, it
  # cannot belong to a dump that is still running; remove it so a full volume
  # does not fail every later backup.
  find "$LOCAL_DIR" -maxdepth 1 -type f -name ".$label-*.dump.partial" -mmin +120 \
    -printf '[backup] Removed stale partial dump %f\n' -delete ||
    echo "WARNING: [backup] could not remove every stale partial dump in $LOCAL_DIR." >&2
else
  out_dir="$(mktemp -d)"
  trap 'rm -rf "$out_dir"' EXIT
fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="$label-$stamp.dump"
[ ! -e "$out_dir/$name" ] || name="$label-$stamp-$$.dump"
final="$out_dir/$name"
# Unique staging file: two runs in the same second (a scheduled dump and a
# deploy's pre-migration dump, or two backup containers during a rollout) must
# never write into one file.
partial="$(mktemp --suffix=.dump.partial "$out_dir/.${name%.dump}-XXXXXX")" ||
  fatal "cannot create a staging file in $out_dir."
if [ "$use_local" = 1 ]; then
  trap 'rm -f "$partial"' EXIT
fi

echo "[backup] Dumping $PGDATABASE to $final ..."
umask 077
pg_dump -Fc --no-owner --no-privileges -f "$partial" ||
  fatal "pg_dump failed; nothing was migrated or changed."
pg_restore --list "$partial" >/dev/null ||
  fatal "pg_restore --list rejected the new dump (corrupt or empty)."
# Never replace another run's finished dump of the same second.
mv -n "$partial" "$final"
n=1
while [ -e "$partial" ] && [ "$n" -le 9 ]; do
  final="$out_dir/${name%.dump}-$n.dump"
  mv -n "$partial" "$final"
  n=$((n + 1))
done
[ ! -e "$partial" ] || fatal "cannot move the dump into place in $out_dir."
echo "[backup] Verified $final ($(wc -c <"$final" | tr -d ' ') bytes)."

# Prune before uploading: a failing upload must not stop old dumps from being
# removed, or every retry would add one and fill the disk.
if [ "$use_local" = 1 ] && [ "$keep" -gt 0 ]; then
  # Names embed a sortable UTC timestamp; keep the newest $keep of this label.
  mapfile -t dumps < <(find "$LOCAL_DIR" -maxdepth 1 -type f -name "$label-*.dump" -printf '%f\n' | LC_ALL=C sort -r)
  for old in "${dumps[@]:$keep}"; do
    rm -f -- "${LOCAL_DIR:?}/$old"
    echo "[backup] Pruned old dump $old"
  done
fi

if [ "$use_s3" = 1 ] && ! node "$HERE/s3.mjs" upload "$final"; then
  if [ "$use_local" = 1 ]; then
    echo "FATAL: [backup] S3 upload failed; the verified dump stays in $final." >&2
    exit 3
  fi
  fatal "S3 upload failed."
fi

if [ "$use_local" = 1 ]; then
  echo "[backup] To restore it: restore $final --confirm RESTORE:$PGDATABASE"
fi
echo "[backup] Done."

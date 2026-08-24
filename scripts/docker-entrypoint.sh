#!/bin/sh
# Docker entrypoint — runs before the container CMD.
#
# Responsibilities:
#   1. Validate required environment variables.
#   2. Gate schema sync on APPLY_SCHEMA. When sync is requested, run
#      `prisma db push` plus repository schema hardening under a Postgres
#      advisory lock so concurrent replicas (and any accidental cross-image
#      pushes) serialize.
#   3. exec the container CMD.
#
# APPLY_SCHEMA values:
#   off       — skip schema sync. Normal app boot. Default when unset.
#   safe      — run `prisma db push`. Prisma refuses destructive operations
#               (drop column, narrow type, etc.) and exits non-zero.
#   dangerous — run `prisma db push --accept-data-loss`. Destructive operations
#               are applied.

set -e

# The production entrypoint is installed in /usr/local/bin while the workspace
# lives under /app, so its own directory cannot be used to locate packages.
# APP_ROOT/DB_PACKAGE_DIR remain overridable for derivative images and the
# executable entrypoint tests.
APP_ROOT="${APP_ROOT:-/app}"
DB_PACKAGE_DIR="${DB_PACKAGE_DIR:-$APP_ROOT/packages/db}"

# --- 1. Required env vars ---
missing=""
required_vars="DATABASE_URL"
case " $* " in
  *" apps/server/dist/index.mjs"*|*" apps/server/"*)
    required_vars="$required_vars BETTER_AUTH_SECRET"
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

# --- 2. Schema sync ---
APPLY_SCHEMA="${APPLY_SCHEMA:-off}"
case "$APPLY_SCHEMA" in
  off)
    echo "APPLY_SCHEMA=off — skipping schema sync."
    ;;
  safe)
    echo "APPLY_SCHEMA=safe — applying non-destructive schema changes."
    # Prisma 7's `db push` does not run `generate` and rejects `--skip-generate`
    # ("unknown or unexpected option"). The client is already generated at
    # image-build time, so no flag is needed here.
    push_flags=""
    ;;
  dangerous)
    echo "APPLY_SCHEMA=dangerous — applying schema changes with --accept-data-loss."
    push_flags="--accept-data-loss"
    ;;
  *)
    echo "FATAL: APPLY_SCHEMA=$APPLY_SCHEMA is invalid. Use off, safe, or dangerous." >&2
    exit 1
    ;;
esac

if [ "$APPLY_SCHEMA" != "off" ]; then
  # Stable app-specific advisory lock ID for schema sync. `prisma db push` does NOT take an advisory lock on its own (unlike
  # `prisma migrate deploy`), so we wrap it ourselves to serialize replicas.
  LOCK_ID=1145389648
  STATUS_FILE=$(mktemp)
  echo 1 > "$STATUS_FILE"
  HARDEN_STATUS_FILE=$(mktemp)
  echo 0 > "$HARDEN_STATUS_FILE"
  SCHEMA_LAUNCH_DIR=$(mktemp -d)
  SCHEMA_LAUNCH_GATE="$SCHEMA_LAUNCH_DIR/start"
  : > "$SCHEMA_LAUNCH_GATE"

  schema_child_pid=""
  schema_signal_status=""
  schema_launch_phase="preparing"
  schema_pending_signal=""
  cleanup_schema_files() {
    rm -f "$STATUS_FILE" "$HARDEN_STATUS_FILE"
    rm -rf "$SCHEMA_LAUNCH_DIR"
  }
  handle_schema_signal() {
    signal_name=$1
    signal_status=$2
    schema_signal_status=$signal_status
    # Always retain the actual signal. In particular, a trap can run while the
    # FIFO writer is blocked even though the launch phase is already `running`.
    # The gate recovery path must not silently turn HUP or INT into TERM.
    schema_pending_signal=$signal_name
    case "$schema_launch_phase" in
      launching)
        # The background command has been requested but POSIX sh has not yet
        # executed the following `$!` assignment. Remember the signal so the
        # newly created process group is terminated as soon as its ID is known.
        ;;
      running)
        # psql is a session/process-group leader. Signal the whole group so a
        # live `\!` shell, Prisma, and schema-hardening process cannot outlive
        # the advisory-lock session and keep mutating the database.
        kill "-$signal_name" "-$schema_child_pid" 2>/dev/null || true
        ;;
      *)
        # Before launch there is no schema process to clean up. Do not swallow
        # the signal and continue into schema sync or application startup.
        exit "$signal_status"
        ;;
    esac
  }
  trap cleanup_schema_files EXIT
  trap 'handle_schema_signal HUP 129' HUP
  trap 'handle_schema_signal INT 130' INT
  trap 'handle_schema_signal TERM 143' TERM

  echo "Acquiring schema advisory lock ($LOCK_ID)..."
  # psql holds a session-level advisory lock across the `\!` shell call that
  # invokes `prisma db push`. When the heredoc closes, the session exits and
  # the lock is released.
  #
  # We call the prisma CLI by its copied path (node_modules/.bin/prisma)
  # rather than `npx prisma`: the binary is COPY'd into the image explicitly
  # by both Dockerfiles, and the global npm/npx is stripped from the runtime
  # image (it is never used at runtime and its vendored deps drag in CVEs).
  #
  # Connect psql via discrete libpq PG* env vars rather than passing
  # DATABASE_URL as a CLI argument. A CLI argument is visible in
  # /proc/<pid>/cmdline, so the password would leak to anything that can read
  # process listings inside the container during the push; PGPASSWORD does not.
  # We parse with node (already in the image — the HEALTHCHECK uses it too)
  # because POSIX sh has no URL parser. Forwarding only the libpq-understood
  # fields also avoids psql choking on Prisma-only query params (e.g. ?schema=).
  # prisma db push is unaffected: it reads the full DATABASE_URL from the
  # environment itself.
  pg_env="$(node -e '
    const u = new URL(process.env.DATABASE_URL);
    const SQ = String.fromCharCode(39);
    const q = (v) => SQ + String(v).split(SQ).join(SQ + "\\" + SQ + SQ) + SQ;
    const dec = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
    const out = [];
    out.push("export PGHOST=" + q(dec(u.hostname)));
    if (u.port) out.push("export PGPORT=" + q(u.port));
    if (u.username) out.push("export PGUSER=" + q(dec(u.username)));
    if (u.password) out.push("export PGPASSWORD=" + q(dec(u.password)));
    const db = dec(u.pathname.replace(/^\//, ""));
    if (db) out.push("export PGDATABASE=" + q(db));
    const sslmode = u.searchParams.get("sslmode");
    if (sslmode) out.push("export PGSSLMODE=" + q(sslmode));
    process.stdout.write(out.join("\n") + "\n");
  ')" || { echo "FATAL: could not parse DATABASE_URL for psql." >&2; exit 1; }
  eval "$pg_env"

  schema_launch_phase="launching"
  # `setsid` gives the complete schema-sync subtree a private process group.
  # The FIFO is a launch barrier: no database operation can start until this
  # parent has recorded `$!` as the group ID and handled any pending signal.
  setsid sh -c '
    launch_gate=$1
    shift
    if [ "${ENTRYPOINT_TEST_SCHEMA_EXIT_BEFORE_GATE:-0}" = 1 ]; then
      exit 125
    fi
    # Polling a regular file keeps the parent write non-blocking even if this
    # child dies before reaching the gate. Bound the handshake as a second
    # line of defence against a supervisor failure before gate release.
    gate_attempt=0
    launch_token=
    while [ "$gate_attempt" -lt 100 ]; do
      IFS= read -r launch_token < "$launch_gate" || true
      [ "$launch_token" = start ] && break
      gate_attempt=$((gate_attempt + 1))
      sleep 0.05
    done
    [ "$launch_token" = start ] || exit 125
    exec "$@"
  ' schema-launch "$SCHEMA_LAUNCH_GATE" psql -v ON_ERROR_STOP=1 <<EOF &
SET lock_timeout = '300s';
SELECT pg_advisory_lock($LOCK_ID);
\! cd "$DB_PACKAGE_DIR" && node_modules/.bin/prisma db push $push_flags; push_status=\$?; echo \$push_status > "$STATUS_FILE"; if [ "\$push_status" -eq 0 ]; then node scripts/apply-schema-hardening.mjs; echo \$? > "$HARDEN_STATUS_FILE"; fi
SELECT pg_advisory_unlock($LOCK_ID);
EOF
  # Executable tests use this narrow hook to deliver a signal in the otherwise
  # instruction-sized gap before `$!` is copied. It is intentionally limited
  # to signals (not arbitrary commands) and is unset in production.
  case "${ENTRYPOINT_TEST_SCHEMA_LAUNCH_SIGNAL:-}" in
    HUP|INT|TERM)
      if [ -n "${ENTRYPOINT_TEST_SCHEMA_LAUNCH_PID_FILE:-}" ]; then
        echo "$!" > "$ENTRYPOINT_TEST_SCHEMA_LAUNCH_PID_FILE"
      fi
      kill "-${ENTRYPOINT_TEST_SCHEMA_LAUNCH_SIGNAL}" "$$"
      ;;
    "") ;;
    *)
      echo "FATAL: invalid entrypoint launch test signal." >&2
      exit 2
      ;;
  esac
  schema_child_pid=$!
  if [ -n "${ENTRYPOINT_TEST_SCHEMA_LAUNCH_PID_FILE:-}" ]; then
    echo "$schema_child_pid" > "$ENTRYPOINT_TEST_SCHEMA_LAUNCH_PID_FILE"
  fi
  schema_launch_phase="running"
  if [ -n "$schema_pending_signal" ]; then
    kill "-$schema_pending_signal" "-$schema_child_pid" 2>/dev/null || true
  else
    # Keep `set -e` from bypassing signal handoff, then re-check trap state
    # before allowing the normal wait path to proceed.
    set +e
    echo start > "$SCHEMA_LAUNCH_GATE"
    launch_gate_status=$?
    set -e
    if [ -n "$schema_signal_status" ]; then
      kill "-$schema_pending_signal" "-$schema_child_pid" 2>/dev/null || true
    elif [ "$launch_gate_status" -ne 0 ]; then
      kill -TERM "-$schema_child_pid" 2>/dev/null || true
      wait "$schema_child_pid" 2>/dev/null || true
      echo "FATAL: could not release schema-sync launch gate." >&2
      exit "$launch_gate_status"
    fi
  fi
  set +e
  wait "$schema_child_pid"
  psql_status=$?
  if [ -n "$schema_signal_status" ]; then
    # Some shells interrupt wait as soon as the trap runs. Reap the forwarded
    # child before exiting so the lock session cannot outlive PID 1.
    wait "$schema_child_pid" 2>/dev/null

    # psql can exit before a `\!` descendant has handled the forwarded signal.
    # Wait briefly for the private group to drain, then force any remaining
    # schema-only descendants down. This never targets the entrypoint or app.
    drain_attempt=0
    while kill -0 "-$schema_child_pid" 2>/dev/null; do
      drain_attempt=$((drain_attempt + 1))
      if [ "$drain_attempt" -ge 50 ]; then
        kill -KILL "-$schema_child_pid" 2>/dev/null || true
        break
      fi
      sleep 0.1
    done

    # KILL is asynchronous. Do not let PID 1 exit (and potentially let the app
    # supervisor restart it) until the schema process group has actually gone.
    kill_attempt=0
    while kill -0 "-$schema_child_pid" 2>/dev/null; do
      kill_attempt=$((kill_attempt + 1))
      if [ "$kill_attempt" -ge 50 ]; then
        echo "FATAL: schema-sync process group $schema_child_pid survived SIGKILL." >&2
        break
      fi
      sleep 0.1
    done
  fi
  set -e
  schema_launch_phase="done"
  schema_child_pid=""
  trap - HUP INT TERM

  if [ -n "$schema_signal_status" ]; then
    exit "$schema_signal_status"
  fi

  if [ "$psql_status" != "0" ]; then
    echo "FATAL: schema sync psql session failed (exit $psql_status)." >&2
    exit "$psql_status"
  fi

  status=$(cat "$STATUS_FILE")
  harden_status=$(cat "$HARDEN_STATUS_FILE")
  cleanup_schema_files
  trap - EXIT
  if [ "$status" != "0" ]; then
    echo "FATAL: prisma db push failed (exit $status)." >&2
    if [ "$APPLY_SCHEMA" = "safe" ]; then
      echo "       This usually means the schema change includes a destructive" >&2
      echo "       operation (drop column, narrow type, etc.). Review the diff." >&2
      echo "       If the data loss is intentional, confirm the diff and backup" >&2
      echo "       before using APPLY_SCHEMA=dangerous." >&2
    fi
    exit "$status"
  fi
  if [ "$harden_status" != "0" ]; then
    echo "FATAL: schema hardening failed after lock/deadlock retries (exit $harden_status)." >&2
    exit "$harden_status"
  fi
  echo "Schema sync complete."
fi

# --- 3. Hand off to the container CMD ---
exec "$@"

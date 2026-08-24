#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d)
ENTRYPOINT_PID=""
WATCHDOG_PID=""
WATCHDOG_DONE="$TEST_ROOT/watchdog-done"
WATCHDOG_FIRED="$TEST_ROOT/watchdog-fired"
SCHEMA_PID_FILE="$TEST_ROOT/schema-group-pid"
cleanup() {
  if [ -s "$SCHEMA_PID_FILE" ]; then
    schema_pid=$(cat "$SCHEMA_PID_FILE")
    case "$schema_pid" in
      *[!0-9]*|'') ;;
      *)
        kill -TERM "-$schema_pid" 2>/dev/null || true
        cleanup_attempt=0
        while kill -0 "-$schema_pid" 2>/dev/null && [ "$cleanup_attempt" -lt 20 ]; do
          cleanup_attempt=$((cleanup_attempt + 1))
          sleep 0.05
        done
        kill -KILL "-$schema_pid" 2>/dev/null || true
        ;;
    esac
  fi
  if [ -n "$ENTRYPOINT_PID" ]; then
    kill -TERM "$ENTRYPOINT_PID" 2>/dev/null || true
    cleanup_attempt=0
    while kill -0 "$ENTRYPOINT_PID" 2>/dev/null && [ "$cleanup_attempt" -lt 20 ]; do
      cleanup_attempt=$((cleanup_attempt + 1))
      sleep 0.05
    done
    kill -KILL "$ENTRYPOINT_PID" 2>/dev/null || true
    wait "$ENTRYPOINT_PID" 2>/dev/null || true
  fi
  [ -z "$WATCHDOG_PID" ] || kill "$WATCHDOG_PID" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

# Install the script where the production image does. APP_ROOT points it at a
# fixture with the same /app/packages/db layout, proving resolution is not
# accidentally relative to /usr/local/bin.
mkdir -p "$TEST_ROOT/usr/local/bin" "$TEST_ROOT/app/packages/db/node_modules/.bin" \
  "$TEST_ROOT/app/packages/db/scripts" "$TEST_ROOT/bin"
cp "$REPO_ROOT/scripts/docker-entrypoint.sh" "$TEST_ROOT/usr/local/bin/docker-entrypoint.sh"

cat > "$TEST_ROOT/bin/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-e" ]; then
  if [ "${NODE_TERM_PARENT:-0}" = "1" ]; then
    echo node-term-parent >> "$ENTRYPOINT_TEST_EVENTS"
    kill -TERM "$PPID"
  fi
  exit 0
fi
echo harden >> "$ENTRYPOINT_TEST_EVENTS"
exit "${HARDEN_EXIT_STATUS:-0}"
EOF
cat > "$TEST_ROOT/app/packages/db/node_modules/.bin/prisma" <<'EOF'
#!/bin/sh
echo "push${*:+ $*}" >> "$ENTRYPOINT_TEST_EVENTS"
exit "${PUSH_EXIT_STATUS:-0}"
EOF
cat > "$TEST_ROOT/bin/psql" <<'EOF'
#!/bin/sh
echo psql >> "$ENTRYPOINT_TEST_EVENTS"
if [ "${PSQL_GRANDCHILD_WAIT:-0}" = "1" ]; then
  /bin/sh "$ENTRYPOINT_GRANDCHILD_SCRIPT" &
  grandchild_pid=$!
  echo "$grandchild_pid" > "$ENTRYPOINT_GRANDCHILD_PID_FILE"
  trap 'echo psql-term >> "$ENTRYPOINT_TEST_EVENTS"; exit 42' TERM
  echo psql-ready >> "$ENTRYPOINT_TEST_EVENTS"
  wait "$grandchild_pid"
  exit $?
fi
if [ "${PSQL_SIGNAL_WAIT:-0}" = "1" ]; then
  trap 'echo psql-term >> "$ENTRYPOINT_TEST_EVENTS"; exit 42' TERM
  echo psql-ready >> "$ENTRYPOINT_TEST_EVENTS"
  while :; do sleep 1; done
fi
if [ "${PSQL_EXIT_STATUS:-0}" != "0" ]; then exit "$PSQL_EXIT_STATUS"; fi
while IFS= read -r line; do
  case "$line" in
    *"pg_advisory_lock("*) echo lock >> "$ENTRYPOINT_TEST_EVENTS" ;;
    *"pg_advisory_unlock("*) echo unlock >> "$ENTRYPOINT_TEST_EVENTS" ;;
    "\\! "*) /bin/sh -c "${line#\\! }" ;;
  esac
done
EOF
cat > "$TEST_ROOT/bin/schema-grandchild" <<'EOF'
#!/bin/sh
trap '' HUP INT TERM
echo grandchild-ready >> "$ENTRYPOINT_TEST_EVENTS"
while :; do
  echo mutation >> "$ENTRYPOINT_MUTATIONS"
  sleep 0.05
done
EOF
cat > "$TEST_ROOT/bin/app-command" <<'EOF'
#!/bin/sh
echo exec >> "$ENTRYPOINT_TEST_EVENTS"
EOF

chmod +x "$TEST_ROOT/bin/node" "$TEST_ROOT/bin/psql" "$TEST_ROOT/bin/app-command" \
  "$TEST_ROOT/bin/schema-grandchild" \
  "$TEST_ROOT/app/packages/db/node_modules/.bin/prisma" \
  "$TEST_ROOT/usr/local/bin/docker-entrypoint.sh"

EVENTS="$TEST_ROOT/events"
OUTPUT="$TEST_ROOT/output"
export ENTRYPOINT_TEST_EVENTS="$EVENTS"
export DATABASE_URL='postgresql://test@example.invalid/test'
export APP_ROOT="$TEST_ROOT/app"
export PATH="$TEST_ROOT/bin:$PATH"
export ENTRYPOINT_TEST_SCHEMA_LAUNCH_PID_FILE="$SCHEMA_PID_FILE"

start_entrypoint() {
  rm -f "$WATCHDOG_DONE" "$WATCHDOG_FIRED" "$SCHEMA_PID_FILE"
  # Reset dispositions that POSIX shells may set to ignored for asynchronous
  # commands, so the HUP/INT/TERM scenarios exercise the entrypoint traps.
  sh -c 'trap - HUP INT TERM; exec "$@"' watchdog-launch \
    "$TEST_ROOT/usr/local/bin/docker-entrypoint.sh" app-command > "$OUTPUT" 2>&1 &
  ENTRYPOINT_PID=$!
  (
    watchdog_attempt=0
    while [ ! -e "$WATCHDOG_DONE" ] && [ "$watchdog_attempt" -lt 200 ]; do
      watchdog_attempt=$((watchdog_attempt + 1))
      sleep 0.05
    done
    if [ ! -e "$WATCHDOG_DONE" ]; then
      : > "$WATCHDOG_FIRED"
      kill -TERM "$ENTRYPOINT_PID" 2>/dev/null || true
      sleep 1
      kill -KILL "$ENTRYPOINT_PID" 2>/dev/null || true
    fi
  ) &
  WATCHDOG_PID=$!
}

wait_entrypoint() {
  set +e
  wait "$ENTRYPOINT_PID"
  RUN_STATUS=$?
  set -e
  ENTRYPOINT_PID=""
  : > "$WATCHDOG_DONE"
  wait "$WATCHDOG_PID" 2>/dev/null || true
  WATCHDOG_PID=""
  if [ -e "$WATCHDOG_FIRED" ]; then
    echo "Timed out waiting for docker entrypoint scenario" >&2
    cat "$OUTPUT" >&2
    exit 1
  fi
  rm -f "$SCHEMA_PID_FILE"
}

run_entrypoint() {
  : > "$EVENTS"
  start_entrypoint
  wait_entrypoint
}

# Run in the foreground when testing the instruction-sized launch signal hook.
# In particular, POSIX shells are allowed to start asynchronous commands with
# SIGINT ignored. The watchdog targets this harness only on timeout; its EXIT
# trap then performs bounded entrypoint/schema-group cleanup.
run_entrypoint_foreground() {
  : > "$EVENTS"
  rm -f "$WATCHDOG_DONE" "$WATCHDOG_FIRED" "$SCHEMA_PID_FILE"
  (
    watchdog_attempt=0
    while [ ! -e "$WATCHDOG_DONE" ] && [ "$watchdog_attempt" -lt 200 ]; do
      watchdog_attempt=$((watchdog_attempt + 1))
      sleep 0.05
    done
    if [ ! -e "$WATCHDOG_DONE" ]; then
      : > "$WATCHDOG_FIRED"
      kill -TERM "$$" 2>/dev/null || true
    fi
  ) &
  WATCHDOG_PID=$!
  set +e
  "$TEST_ROOT/usr/local/bin/docker-entrypoint.sh" app-command > "$OUTPUT" 2>&1
  RUN_STATUS=$?
  set -e
  : > "$WATCHDOG_DONE"
  wait "$WATCHDOG_PID" 2>/dev/null || true
  WATCHDOG_PID=""
  if [ -e "$WATCHDOG_FIRED" ]; then
    echo "Timed out waiting for foreground docker entrypoint scenario" >&2
    cat "$OUTPUT" >&2
    exit 1
  fi
}
assert_status() {
  if [ "$RUN_STATUS" -ne "$1" ]; then
    echo "Expected entrypoint exit $1, got $RUN_STATUS" >&2
    cat "$OUTPUT" >&2
    exit 1
  fi
}
assert_events() {
  if [ "$(cat "$EVENTS")" != "$1" ]; then
    echo "Entrypoint ran an unexpected sequence:" >&2
    cat "$EVENTS" >&2
    exit 1
  fi
}

# Push failures preserve status, unlock, never harden, and never start the app.
export APPLY_SCHEMA=safe PUSH_EXIT_STATUS=23 HARDEN_EXIT_STATUS=0 PSQL_EXIT_STATUS=0
run_entrypoint
assert_status 23
assert_events 'psql
lock
push db push
unlock'
grep -q 'prisma db push failed (exit 23)' "$OUTPUT"

# Hardening failures also release the lock and prevent application startup.
export PUSH_EXIT_STATUS=0 HARDEN_EXIT_STATUS=29
run_entrypoint
assert_status 29
assert_events 'psql
lock
push db push
harden
unlock'
grep -q 'schema hardening failed.*(exit 29)' "$OUTPUT"

# A failed psql session is fatal and its exact status is preserved.
export HARDEN_EXIT_STATUS=0 PSQL_EXIT_STATUS=31
run_entrypoint
assert_status 31
assert_events 'psql'
grep -q 'schema sync psql session failed (exit 31)' "$OUTPUT"

# Dangerous mode is the only mode that passes Prisma's data-loss flag.
export APPLY_SCHEMA=dangerous PSQL_EXIT_STATUS=0
run_entrypoint
assert_status 0
assert_events 'psql
lock
push db push --accept-data-loss
harden
unlock
exec'

# Off bypasses every schema tool and directly execs the application.
export APPLY_SCHEMA=off
run_entrypoint
assert_status 0
assert_events 'exec'

# Invalid modes fail closed before invoking psql or the application.
export APPLY_SCHEMA=typo
run_entrypoint
assert_status 1
assert_events ''
grep -q 'APPLY_SCHEMA=typo is invalid' "$OUTPUT"

# TERM received while preparing the connection environment (before a psql
# child exists) is fatal and cannot be swallowed into schema/app startup. The
# node fixture signals its parent synchronously, making the race deterministic.
export APPLY_SCHEMA=safe NODE_TERM_PARENT=1
run_entrypoint
assert_status 143
assert_events 'node-term-parent'
if grep -q '^psql$\|^exec$' "$EVENTS"; then
  echo "Schema or app started after pre-child interruption" >&2
  exit 1
fi
unset NODE_TERM_PARENT

# A schema child that exits before observing the launch gate cannot strand the
# parent in its gate write. This directly covers the former FIFO deadlock.
export APPLY_SCHEMA=safe ENTRYPOINT_TEST_SCHEMA_EXIT_BEFORE_GATE=1
run_entrypoint
assert_status 125
assert_events ''
grep -q 'schema sync psql session failed (exit 125)' "$OUTPUT"
unset ENTRYPOINT_TEST_SCHEMA_EXIT_BEFORE_GATE

# Every supported signal in the exact background-launch/$! assignment window
# is handed to the newly created group. The recorded group must disappear
# before the entrypoint exits, without psql or the application ever starting.
LAUNCH_PID_FILE="$SCHEMA_PID_FILE"
export ENTRYPOINT_TEST_SCHEMA_LAUNCH_PID_FILE="$LAUNCH_PID_FILE"
for launch_case in HUP:129 INT:130 TERM:143; do
  launch_signal=${launch_case%%:*}
  expected_status=${launch_case#*:}
  : > "$EVENTS"
  rm -f "$LAUNCH_PID_FILE"
  export ENTRYPOINT_TEST_SCHEMA_LAUNCH_SIGNAL="$launch_signal"
  run_entrypoint_foreground
  signal_status=$RUN_STATUS
  if [ "$signal_status" -ne "$expected_status" ]; then
    echo "Expected launch-window $launch_signal to produce exit $expected_status, got $signal_status" >&2
    cat "$OUTPUT" >&2
    exit 1
  fi
  launch_pid=$(cat "$LAUNCH_PID_FILE")
  if kill -0 "-$launch_pid" 2>/dev/null; then
    echo "Launch-window schema group $launch_pid survived $launch_signal handoff" >&2
    exit 1
  fi
  assert_events ''
  if grep -q '^exec$' "$EVENTS"; then echo "App started after launch-window interruption" >&2; exit 1; fi
done
unset ENTRYPOINT_TEST_SCHEMA_LAUNCH_SIGNAL

# The PID-1 shell forwards termination to the active psql lock session.
: > "$EVENTS"
export APPLY_SCHEMA=safe PSQL_SIGNAL_WAIT=1
start_entrypoint
attempt=0
while ! grep -q '^psql-ready$' "$EVENTS" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then echo "Timed out waiting for psql" >&2; exit 1; fi
  sleep 0.01
done
kill -TERM "$ENTRYPOINT_PID"
wait_entrypoint
signal_status=$RUN_STATUS
if [ "$signal_status" -ne 143 ]; then
  echo "Expected TERM to produce exit 143, got $signal_status" >&2
  exit 1
fi
attempt=0
while ! grep -q '^psql-term$' "$EVENTS" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then echo "TERM was not forwarded to psql" >&2; exit 1; fi
  sleep 0.01
done
if grep -q '^exec$' "$EVENTS"; then echo "App started after interruption" >&2; exit 1; fi
unset PSQL_SIGNAL_WAIT

# psql exits immediately when TERM arrives, while its live grandchild ignores
# TERM and keeps mutating. The entrypoint must observe the still-live group,
# force it down with KILL, and wait for disappearance before it exits.
: > "$EVENTS"
MUTATIONS="$TEST_ROOT/mutations"
GRANDCHILD_PID_FILE="$TEST_ROOT/grandchild-pid"
: > "$MUTATIONS"
rm -f "$GRANDCHILD_PID_FILE"
export PSQL_GRANDCHILD_WAIT=1
export ENTRYPOINT_GRANDCHILD_SCRIPT="$TEST_ROOT/bin/schema-grandchild"
export ENTRYPOINT_GRANDCHILD_PID_FILE="$GRANDCHILD_PID_FILE"
export ENTRYPOINT_MUTATIONS="$MUTATIONS"
start_entrypoint
attempt=0
while ! grep -q '^grandchild-ready$' "$EVENTS" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then echo "Timed out waiting for schema grandchild" >&2; exit 1; fi
  sleep 0.01
done
grandchild_pid=$(cat "$GRANDCHILD_PID_FILE")
kill -TERM "$ENTRYPOINT_PID"
wait_entrypoint
signal_status=$RUN_STATUS
if [ "$signal_status" -ne 143 ]; then
  echo "Expected grandchild TERM to produce exit 143, got $signal_status" >&2
  exit 1
fi
grep -q '^psql-term$' "$EVENTS"
if kill -0 "$grandchild_pid" 2>/dev/null; then
  echo "Schema grandchild $grandchild_pid lingered after entrypoint exit" >&2
  exit 1
fi
mutation_count=$(wc -l < "$MUTATIONS")
sleep 0.2
if [ "$(wc -l < "$MUTATIONS")" -ne "$mutation_count" ]; then
  echo "Schema mutation continued after entrypoint exit" >&2
  exit 1
fi
if grep -q '^exec$' "$EVENTS"; then echo "App started after grandchild interruption" >&2; exit 1; fi
unset PSQL_GRANDCHILD_WAIT ENTRYPOINT_GRANDCHILD_SCRIPT \
  ENTRYPOINT_GRANDCHILD_PID_FILE ENTRYPOINT_MUTATIONS

echo "Docker entrypoint schema control-flow validation complete."

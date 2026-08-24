#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d)
ENTRYPOINT_PID=""
cleanup() {
  if [ -n "$ENTRYPOINT_PID" ]; then
    kill -TERM "$ENTRYPOINT_PID" 2>/dev/null || true
    wait "$ENTRYPOINT_PID" 2>/dev/null || true
  fi
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
if [ "${1:-}" = "-e" ]; then exit 0; fi
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
cat > "$TEST_ROOT/bin/app-command" <<'EOF'
#!/bin/sh
echo exec >> "$ENTRYPOINT_TEST_EVENTS"
EOF

chmod +x "$TEST_ROOT/bin/node" "$TEST_ROOT/bin/psql" "$TEST_ROOT/bin/app-command" \
  "$TEST_ROOT/app/packages/db/node_modules/.bin/prisma" \
  "$TEST_ROOT/usr/local/bin/docker-entrypoint.sh"

EVENTS="$TEST_ROOT/events"
OUTPUT="$TEST_ROOT/output"
export ENTRYPOINT_TEST_EVENTS="$EVENTS"
export DATABASE_URL='postgresql://test@example.invalid/test'
export APP_ROOT="$TEST_ROOT/app"
export PATH="$TEST_ROOT/bin:$PATH"

run_entrypoint() {
  : > "$EVENTS"
  set +e
  "$TEST_ROOT/usr/local/bin/docker-entrypoint.sh" app-command > "$OUTPUT" 2>&1
  RUN_STATUS=$?
  set -e
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

# The PID-1 shell forwards termination to the active psql lock session.
: > "$EVENTS"
export APPLY_SCHEMA=safe PSQL_SIGNAL_WAIT=1
"$TEST_ROOT/usr/local/bin/docker-entrypoint.sh" app-command > "$OUTPUT" 2>&1 &
ENTRYPOINT_PID=$!
attempt=0
while ! grep -q '^psql-ready$' "$EVENTS" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then echo "Timed out waiting for psql" >&2; exit 1; fi
  sleep 0.01
done
kill -TERM "$ENTRYPOINT_PID"
set +e
wait "$ENTRYPOINT_PID"
signal_status=$?
set -e
ENTRYPOINT_PID=""
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

echo "Docker entrypoint schema control-flow validation complete."

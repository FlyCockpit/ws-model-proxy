#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

mkdir -p "$TEST_ROOT/repo/scripts" "$TEST_ROOT/repo/packages/db/node_modules/.bin" \
  "$TEST_ROOT/repo/packages/db/scripts" "$TEST_ROOT/bin"
cp "$REPO_ROOT/scripts/docker-entrypoint.sh" "$TEST_ROOT/repo/scripts/docker-entrypoint.sh"

cat > "$TEST_ROOT/bin/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-e" ]; then
  exit 0
fi
echo harden >> "$ENTRYPOINT_TEST_EVENTS"
exit "${HARDEN_EXIT_STATUS:-0}"
EOF

cat > "$TEST_ROOT/repo/packages/db/node_modules/.bin/prisma" <<'EOF'
#!/bin/sh
echo push >> "$ENTRYPOINT_TEST_EVENTS"
exit "${PUSH_EXIT_STATUS:-0}"
EOF

cat > "$TEST_ROOT/bin/psql" <<'EOF'
#!/bin/sh
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
  "$TEST_ROOT/repo/packages/db/node_modules/.bin/prisma" \
  "$TEST_ROOT/repo/scripts/docker-entrypoint.sh"

EVENTS="$TEST_ROOT/events"
export ENTRYPOINT_TEST_EVENTS="$EVENTS"
export DATABASE_URL='postgresql://test@example.invalid/test'
export APPLY_SCHEMA=safe
export PATH="$TEST_ROOT/bin:$PATH"

export PUSH_EXIT_STATUS=23
set +e
"$TEST_ROOT/repo/scripts/docker-entrypoint.sh" app-command > "$TEST_ROOT/failure.out" 2>&1
failure_status=$?
set -e
if [ "$failure_status" -ne 23 ]; then
  echo "Expected entrypoint to preserve prisma exit 23, got $failure_status" >&2
  cat "$TEST_ROOT/failure.out" >&2
  exit 1
fi
if grep -q '^harden$\|^exec$' "$EVENTS"; then
  echo "Expected entrypoint to fail when prisma db push fails" >&2
  exit 1
fi
expected_failure='lock
push
unlock'
if [ "$(cat "$EVENTS")" != "$expected_failure" ]; then
  echo "Push failure ran an unexpected sequence:" >&2
  cat "$EVENTS" >&2
  exit 1
fi
if ! grep -q 'prisma db push failed (exit 23)' "$TEST_ROOT/failure.out"; then
  echo "Entrypoint did not preserve the prisma failure status" >&2
  cat "$TEST_ROOT/failure.out" >&2
  exit 1
fi

: > "$EVENTS"
export PUSH_EXIT_STATUS=0
"$TEST_ROOT/repo/scripts/docker-entrypoint.sh" app-command > "$TEST_ROOT/success.out" 2>&1
expected_success='lock
push
harden
unlock
exec'
if [ "$(cat "$EVENTS")" != "$expected_success" ]; then
  echo "Successful schema sync ran an unexpected sequence:" >&2
  cat "$EVENTS" >&2
  exit 1
fi

echo "Docker entrypoint schema control-flow validation complete."

#!/bin/sh
# Executable tests for scripts/docker-entrypoint.sh (part of `pnpm check:ci`):
# the migration gate before the CMD, MIGRATE_ON_START defaults, the deprecated
# APPLY_SCHEMA alias, the one-shot image commands, and stop-signal handling.
#
# `node` is a stub that records how the entrypoint called the migration runner
# (it delegates `node -p` to the real node so WMP_INSTANCE_ID is a real UUID).
# The CMD is a stub that records that it ran. No database, no Docker.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REAL_NODE=$(command -v node)
# Fixture configuration: the entrypoint only checks that DATABASE_URL and the
# auth secret are set (the CMD is a stub), so the URL carries no credentials,
# and the auth secret's name sits in a variable: the committed-secret scan
# (pr-checks.yml, "Secret patterns") flags any literal assignment to it.
FIXTURE_DATABASE_URL=postgresql://db:5432/app
AUTH_SECRET_NAME=BETTER_AUTH_SECRET

# A shell cannot trap a signal that was ignored when it started, and every
# process it starts inherits the ignore: under `nohup` (HUP), a job started
# with `&` from a non-interactive shell (INT, QUIT) or any launcher that
# ignores TERM, the stop-signal cases would test the launcher, not the
# entrypoint. So when HUP, INT or TERM arrives ignored, run this script once
# more through node, whose children start with every signal at its default
# (libuv resets them), forwarding the stop signals to it. The variable is the
# loop guard; nothing else reads it.
signal_ignored() {
  # The braces keep the shell's own "Terminated"/"Hangup" report quiet too.
  [ "$({ /bin/sh -c "kill -$1 \$\$; echo ignored"; } 2>/dev/null)" = "ignored" ]
}
if [ -z "${ENTRYPOINT_TEST_SIGNALS_RESET:-}" ] &&
  { signal_ignored HUP || signal_ignored INT || signal_ignored TERM; }; then
  ENTRYPOINT_TEST_SIGNALS_RESET=1 exec "$REAL_NODE" -e '
    const { spawn } = require("node:child_process");
    const { constants } = require("node:os");
    const child = spawn("/bin/sh", process.argv.slice(1), { stdio: "inherit" });
    for (const name of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      process.on(name, () => child.kill(name));
    }
    child.on("exit", (code, signal) => {
      process.exit(code ?? 128 + constants.signals[signal]);
    });
  ' "$0" "$@"
fi
TEST_ROOT=$(mktemp -d)
ENTRYPOINT_PID=""
WATCHDOG_PID=""
# Every process a run starts (the entrypoint copy, its stubs and their
# descendants, the CMD) gets ENTRYPOINT_TEST_RUN=<this run's token> through
# `env -i` and inherits it; this script and its own helpers never carry it
# (it is not exported). test_processes lists exactly the processes whose
# environment (Linux /proc/<pid>/environ) holds that token, so nothing the run
# did not start is ever touched. Without /proc nothing is listed or reaped.
RUN_TOKEN="wmp-entrypoint-test-$$-${TEST_ROOT##*/}"
test_processes() {
  [ -n "$RUN_TOKEN" ] && [ -n "${TEST_ROOT##*/}" ] || return 0
  "$REAL_NODE" -e '
    const fs = require("node:fs");
    const want = `ENTRYPOINT_TEST_RUN=${process.argv[1]}`;
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(pid)) continue;
      let environ;
      try {
        environ = fs.readFileSync(`/proc/${pid}/environ`, "latin1");
      } catch {
        continue;
      }
      if (environ.split("\0").includes(want)) console.log(pid);
    }
  ' "$RUN_TOKEN" 2>/dev/null || true
}
reap_test_processes() {
  for pid in $(test_processes); do
    kill -KILL "$pid" 2>/dev/null || true
  done
}
cleanup() {
  if [ -n "$WATCHDOG_PID" ]; then
    : > "$TEST_ROOT/run-done"
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [ -n "$ENTRYPOINT_PID" ]; then
    kill -KILL "$ENTRYPOINT_PID" 2>/dev/null || true
    wait "$ENTRYPOINT_PID" 2>/dev/null || true
  fi
  reap_test_processes
  rm -rf "$TEST_ROOT"
}
# A stop signal ends the run (128 + its number) through the EXIT trap's cleanup.
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Bounded runs: a watchdog KILLs everything the run started if it has not
# finished within 20 s, so a regression (a signal that is never acted on)
# fails the suite instead of hanging it. stop_watchdog reaps leftovers either way.
start_watchdog() {
  rm -f "$TEST_ROOT/run-done" "$TEST_ROOT/timed-out"
  (
    i=0
    while [ "$i" -lt 200 ]; do
      if [ -f "$TEST_ROOT/run-done" ]; then exit 0; fi
      sleep 0.1
      i=$((i + 1))
    done
    : > "$TEST_ROOT/timed-out"
    reap_test_processes
  ) &
  WATCHDOG_PID=$!
}
stop_watchdog() {
  : > "$TEST_ROOT/run-done"
  wait "$WATCHDOG_PID" 2>/dev/null || true
  WATCHDOG_PID=""
  if [ -f "$TEST_ROOT/timed-out" ]; then
    fail "the run did not finish within 20 s (killed): $*"
  fi
  # The entrypoint has exited: it must not have left a child running (a
  # forwarded stop that never reached the child). Allow 1 s for exits that
  # are already under way, then fail, and only then reap.
  attempt=0
  survivors=$(test_processes)
  while [ -n "$survivors" ] && [ "$attempt" -lt 10 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
    survivors=$(test_processes)
  done
  if [ -n "$survivors" ]; then
    fail "processes left running after the entrypoint exited: $(echo $survivors) ($*)"
    reap_test_processes
  fi
}

mkdir -p "$TEST_ROOT/app/scripts/db" "$TEST_ROOT/app/scripts/backup" "$TEST_ROOT/bin"
cp "$REPO_ROOT/scripts/docker-entrypoint.sh" "$TEST_ROOT/docker-entrypoint.sh"
# The entrypoint repeats a stop's TERM only where /proc exists (have_proc);
# without it each signal sends one TERM, by design, since the image always has
# /proc. Cases of the repeat path therefore skip on hosts without /proc
# (macOS). ENTRYPOINT_TEST_ASSUME_NO_PROC=1, read only here, simulates such a
# host on Linux: those cases skip and the entrypoint copy runs with its /proc
# detection removed, so every other case exercises the no-/proc fallback.
PROC_DETECTION='if [ -r /proc/self/stat ]; then have_proc=true; fi'
grep -qxF "$PROC_DETECTION" "$TEST_ROOT/docker-entrypoint.sh" || {
  echo "FAIL: the /proc detection line of scripts/docker-entrypoint.sh was not found" >&2
  exit 1
}
HAVE_PROC=true
if [ "${ENTRYPOINT_TEST_ASSUME_NO_PROC:-}" = 1 ] || [ ! -r /proc/self/stat ]; then
  HAVE_PROC=false
  grep -vxF "$PROC_DETECTION" "$REPO_ROOT/scripts/docker-entrypoint.sh" > "$TEST_ROOT/docker-entrypoint.sh"
fi
skipped=0
# needs_proc <case>: succeeds where the /proc repeat path runs; otherwise
# prints why the case is skipped.
needs_proc() {
  [ "$HAVE_PROC" = true ] && return 0
  echo "skip: $1: needs /proc (Linux); the image always has it"
  skipped=$((skipped + 1))
  return 1
}
EVENTS="$TEST_ROOT/events"

# The image must ship what the entrypoint runs (pnpm docker:check-copy checks
# the whole import closure; this checks the entry points themselves).
for script in scripts/db/migrate-runtime.mjs scripts/backup/pre-migrate.sh \
  scripts/backup/restore.sh scripts/backup/schedule.mjs scripts/backup/drill.mjs; do
  grep -q "$script" "$REPO_ROOT/Dockerfile" || {
    echo "FAIL: the Dockerfile runner stage does not copy $script" >&2
    exit 1
  }
done

cat > "$TEST_ROOT/bin/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-p" ]; then
  if [ -n "${STUB_SIGNAL_EARLY:-}" ]; then kill -"$STUB_SIGNAL_EARLY" "$PPID"; fi
  exec "$ENTRYPOINT_TEST_REAL_NODE" "$@"
fi
if [ -n "${STUB_SIGNAL_AT_EXIT:-}" ]; then kill -"$STUB_SIGNAL_AT_EXIT" "$PPID"; fi
echo "node $* instance=${WMP_INSTANCE_ID:-none}" >> "$ENTRYPOINT_TEST_EVENTS"
echo "runner-writer-key=${BACKUP_S3_SECRET_ACCESS_KEY:-unset}" >> "$ENTRYPOINT_TEST_EVENTS"
if [ -n "${STUB_RUNNER_SLEEP:-}" ]; then
  trap 'echo runner-term >> "$ENTRYPOINT_TEST_EVENTS"; exit 143' TERM
  echo runner-started >> "$ENTRYPOINT_TEST_EVENTS"
  i=0
  while [ "$i" -lt "$STUB_RUNNER_SLEEP" ]; do sleep 0.1; i=$((i + 1)); done
fi
exit "${STUB_RUNNER_EXIT:-0}"
EOF
cat > "$TEST_ROOT/bin/tini" <<'EOF'
#!/bin/sh
echo "tini $*" >> "$ENTRYPOINT_TEST_EVENTS"
[ "$1" = -- ] || exit 99
shift
exec "$@"
EOF
cat > "$TEST_ROOT/bin/bash" <<'EOF'
#!/bin/sh
echo "bash $*" >> "$ENTRYPOINT_TEST_EVENTS"
echo "bash-instance=${WMP_INSTANCE_ID:-none}" >> "$ENTRYPOINT_TEST_EVENTS"
case "$*" in
  *--startup-notice*)
    if [ -n "${STUB_NOTICE_SLEEP:-}" ]; then
      # STUB_NOTICE_DRAIN=<s>: after TERM, take <s> seconds to exit (a check
      # that drains its own children), then log notice-drained.
      trap 'echo notice-term >> "$ENTRYPOINT_TEST_EVENTS"; if [ -n "${STUB_NOTICE_DRAIN:-}" ]; then sleep "$STUB_NOTICE_DRAIN"; echo notice-drained >> "$ENTRYPOINT_TEST_EVENTS"; fi; exit 143' TERM
      echo notice-started >> "$ENTRYPOINT_TEST_EVENTS"
      i=0
      while [ "$i" -lt "$STUB_NOTICE_SLEEP" ]; do sleep 0.1; i=$((i + 1)); done
      echo notice-done >> "$ENTRYPOINT_TEST_EVENTS"
    fi
    exit "${STUB_NOTICE_EXIT:-0}"
    ;;
esac
exit 0
EOF
# The CMD: path shaped like the production one so the entrypoint sees a server.
mkdir -p "$TEST_ROOT/apps/server/dist"
cat > "$TEST_ROOT/apps/server/dist/index.mjs" <<'EOF'
#!/bin/sh
echo "cmd ran instance=${WMP_INSTANCE_ID:-none}" >> "$ENTRYPOINT_TEST_EVENTS"
echo "cmd-writer-key=${BACKUP_S3_SECRET_ACCESS_KEY:-unset} cmd-writer-id=${BACKUP_S3_ACCESS_KEY_ID:-unset} cmd-bucket=${BACKUP_S3_BUCKET:-unset} cmd-future=${BACKUP_S3_FUTURE_KEY:-unset}" >> "$ENTRYPOINT_TEST_EVENTS"
EOF
chmod +x "$TEST_ROOT/bin/tini" "$TEST_ROOT/bin/node" "$TEST_ROOT/bin/bash" "$TEST_ROOT/apps/server/dist/index.mjs"
SERVER_CMD="$TEST_ROOT/apps/server/dist/index.mjs"

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# run <expected status> [VAR=value ...] -- <args...>
run() {
  expected=$1
  shift
  : > "$EVENTS"
  start_watchdog
  set +e
  env -i PATH="$TEST_ROOT/bin:/usr/bin:/bin" APP_ROOT="$TEST_ROOT/app" ENTRYPOINT_TEST_RUN="$RUN_TOKEN" \
    ENTRYPOINT_TEST_EVENTS="$EVENTS" ENTRYPOINT_TEST_REAL_NODE="$REAL_NODE" \
    DATABASE_URL="$FIXTURE_DATABASE_URL" "$AUTH_SECRET_NAME=fixture" \
    "$@" > "$TEST_ROOT/out" 2>&1
  status=$?
  set -e
  stop_watchdog "$@"
  if [ "$status" -ne "$expected" ]; then
    fail "expected exit $expected, got $status for: $*"
    sed 's/^/    /' "$TEST_ROOT/out" >&2
  fi
}
expect_event() {
  grep -q -- "$1" "$EVENTS" || {
    fail "missing event \"$1\"; events:"
    sed 's/^/    /' "$EVENTS" >&2
  }
}
expect_no_event() {
  if grep -q -- "$1" "$EVENTS"; then
    fail "unexpected event \"$1\"; events:"
    sed 's/^/    /' "$EVENTS" >&2
  fi
}
expect_output() {
  grep -q -- "$1" "$TEST_ROOT/out" || {
    fail "missing output \"$1\"; output:"
    sed 's/^/    /' "$TEST_ROOT/out" >&2
  }
}
EP="sh $TEST_ROOT/docker-entrypoint.sh"
UUID='[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}'

# The server migrates on start by default, under a fresh instance id, then runs the CMD.
run 0 $EP "$SERVER_CMD"
expect_event "migrate-runtime.mjs apply --role server instance=$UUID"
expect_event "cmd ran instance=$UUID"
expect_event "tini -- $SERVER_CMD"
[ "$(sed -n 's/^node .* instance=//p' "$EVENTS")" = "$(sed -n 's/^cmd ran instance=//p' "$EVENTS")" ] ||
  fail "the CMD does not keep the runner's WMP_INSTANCE_ID"

# A migrating start checks the backup switch once (pre-migrate.sh
# --startup-notice); BACKUP_ENABLED=true without a destination stops it there.
expect_event "bash $TEST_ROOT/app/scripts/backup/pre-migrate.sh --startup-notice"
run 1 STUB_NOTICE_EXIT=1 BACKUP_ENABLED=true $EP "$SERVER_CMD"
expect_no_event "migrate-runtime"
expect_no_event "cmd ran"
run 1 BACKUP_ENABLED=yes $EP "$SERVER_CMD"
expect_output 'BACKUP_ENABLED must be true or false'
expect_no_event "pre-migrate.sh"
expect_no_event "migrate-runtime"

# The runner keeps the backup writer keys; the CMD never sees them (the
# backup location settings are also removed).
run 0 BACKUP_S3_ACCESS_KEY_ID=writer-id BACKUP_S3_SECRET_ACCESS_KEY=writer-secret \
  BACKUP_S3_BUCKET=bucket BACKUP_S3_FUTURE_KEY=future-dummy $EP "$SERVER_CMD"
expect_event "runner-writer-key=writer-secret"
expect_event "cmd-writer-key=unset cmd-writer-id=unset cmd-bucket=unset cmd-future=unset"
# Fail closed: even when listing the environment fails (an `env` that exits
# non-zero and prints nothing), the writer key pair never reaches the CMD.
# Only the entrypoint's PATH holds this stub; run's own `env -i` is the real one.
printf '#!/bin/sh\nexit 1\n' > "$TEST_ROOT/bin/env"
chmod +x "$TEST_ROOT/bin/env"
run 0 BACKUP_S3_ACCESS_KEY_ID=writer-id BACKUP_S3_SECRET_ACCESS_KEY=writer-secret \
  BACKUP_S3_BUCKET=bucket $EP "$SERVER_CMD"
rm -f "$TEST_ROOT/bin/env"
expect_event "cmd-writer-key=unset cmd-writer-id=unset"

# MIGRATE_ON_START=false: read-only wait, then the CMD. A waiting container
# needs no backup destination, so it never runs the startup check.
run 0 MIGRATE_ON_START=false $EP "$SERVER_CMD"
expect_event "migrate-runtime.mjs wait --role server"
expect_event "cmd ran"
expect_no_event "startup-notice"

# Any other command waits by default.
run 0 $EP /bin/true
expect_event "migrate-runtime.mjs wait --role worker"

# A refused migration stops the start with the runner's status; the CMD never runs.
run 3 STUB_RUNNER_EXIT=3 $EP "$SERVER_CMD"
expect_event "migrate-runtime.mjs apply"
expect_no_event "cmd ran"

run 1 MIGRATE_ON_START=yes $EP "$SERVER_CMD"
expect_output 'MIGRATE_ON_START must be true or false'
expect_no_event "migrate-runtime"

# Required variables.
run 1 DATABASE_URL= $EP "$SERVER_CMD"
expect_output 'Missing required environment variable(s): DATABASE_URL'
run 1 "$AUTH_SECRET_NAME=" $EP "$SERVER_CMD"
expect_output 'Missing required environment variable(s): BETTER_AUTH_SECRET'
expect_no_event "migrate-runtime"

# Deprecated APPLY_SCHEMA alias.
run 0 APPLY_SCHEMA=safe $EP "$SERVER_CMD"
expect_event "migrate-runtime.mjs apply --role server"
expect_output 'APPLY_SCHEMA is deprecated'
expect_output 'MIGRATE_ON_START=true'
run 0 APPLY_SCHEMA=off $EP "$SERVER_CMD"
expect_event "migrate-runtime.mjs wait --role server"
expect_output 'will NOT apply migrations'
run 0 APPLY_SCHEMA=safe MIGRATE_ON_START=true $EP "$SERVER_CMD"
expect_event "migrate-runtime.mjs apply --role server"
run 1 APPLY_SCHEMA=dangerous $EP "$SERVER_CMD"
expect_output 'APPLY_SCHEMA=dangerous is no longer supported'
expect_no_event "migrate-runtime"
expect_no_event "cmd ran"
run 1 APPLY_SCHEMA=safe MIGRATE_ON_START=false $EP "$SERVER_CMD"
expect_output 'conflicts with'
expect_no_event "migrate-runtime"
run 1 APPLY_SCHEMA=sometimes $EP "$SERVER_CMD"
expect_output 'APPLY_SCHEMA=sometimes is invalid'

# A follower failure explains the historical off alias and the remedy.
run 1 APPLY_SCHEMA=off STUB_RUNNER_EXIT=1 $EP "$SERVER_CMD"
expect_output 'FATAL:.*APPLY_SCHEMA=off set MIGRATE_ON_START=false'
expect_output 'Remove APPLY_SCHEMA'
expect_output 'replace it with MIGRATE_ON_START=true'
expect_no_event 'cmd ran'

# The stop-signal cases need HUP, INT and TERM deliverable; the run through
# node at the top restored any that arrived ignored.
STOP_SIGNALS="TERM INT HUP"
for signal in HUP INT TERM; do
  if signal_ignored "$signal"; then
    echo "FAIL: SIG$signal is still ignored after the reset at the top; the stop-signal cases cannot run" >&2
    exit 1
  fi
done
signal_status_of() {
  case "$1" in TERM) echo 143 ;; INT) echo 130 ;; HUP) echo 129 ;; esac
}

# Signals before runner launch and at its completion must stop the CMD.
for signal in $STOP_SIGNALS; do
  signal_status=$(signal_status_of "$signal")
  run "$signal_status" STUB_SIGNAL_EARLY="$signal" $EP "$SERVER_CMD"
  expect_no_event 'migrate-runtime'
  expect_no_event 'cmd ran'
  run "$signal_status" STUB_SIGNAL_AT_EXIT="$signal" $EP "$SERVER_CMD"
  expect_no_event 'cmd ran'
done

# Inject signals into copies at the exact gaps, without production hooks.
#
# deaf_launch <n> <ready file>: a launch line whose child swallows the first
# <n> TERMs it gets (counting them in its trap), then execs the command,
# standing in for a TERM swallowed by the forked shell's inherited trap. The
# child marks <ready file> once its trap is in place; the stop is sent only
# after that, so the first TERM is always missed, however the processes are
# scheduled. It gives up after 10 s and execs the command anyway, so a
# regression fails a case (the stub logs notice-done) instead of hanging it
# where the watchdog cannot reap anything (no /proc).
deaf_launch() {
  printf '%s\n' "  ( n=0; deaf_i=0; trap 'n=\$((n + 1))' TERM; : > '$2'; while [ \"\$n\" -lt $1 ] && [ \"\$deaf_i\" -lt 200 ]; do sleep 0.05; deaf_i=\$((deaf_i + 1)); done; trap - TERM; exec \"\$@\" ) &"
}
# ready_spin <ready file>: the entrypoint copy's own wait for that mark: no
# fork, bounded by an iteration count (about 7 s in dash, 14 s in bash when
# the mark never appears; shells have no fork-free clock).
ready_spin() {
  printf '%s' "spin_i=0; while [ ! -e '$1' ] && [ \"\$spin_i\" -lt 2000000 ]; do spin_i=\$((spin_i + 1)); done"
}
# deaf_copy <copy> <signal> <ready file> <inject before>: the entrypoint copy
# with a deaf child that swallows one TERM, and the stop signal sent to the
# entrypoint itself (once the child is ready) just before the given line.
deaf_copy() {
  rm -f "$3"
  awk -v stop="$2" -v spin="$(ready_spin "$3")" -v before="$4" -v launch="$(deaf_launch 1 "$3")" '{
    line = $0; sub(/^[ \t]+/, "", line)
    if (line == "\"$@\" &") { print launch; next }
    if (line == before) print "  " spin "; kill -" stop " \"$$\""
    print
  }' "$TEST_ROOT/docker-entrypoint.sh" > "$1"
  grep -qF "trap 'n=\$((n + 1))' TERM; : > '$3'" "$1" || fail "$1: launch line not found"
  grep -qF "; kill -$2 \"\$\$\"" "$1" || fail "$1: injection point \"$4\" not found"
}
for signal in $STOP_SIGNALS; do
  signal_status=$(signal_status_of "$signal")
  awk -v stop="$signal" '{
    line = $0; sub(/^[ \t]+/, "", line)
    if (line == "child_pid=$!") print "kill -" stop " \"$$\""
    print
  }' "$TEST_ROOT/docker-entrypoint.sh" > "$TEST_ROOT/launch-gap.sh"
  grep -q "^kill -$signal" "$TEST_ROOT/launch-gap.sh" || fail "launch-gap copy: child_pid=\$! not found"
  run "$signal_status" sh "$TEST_ROOT/launch-gap.sh" "$SERVER_CMD"
  expect_no_event 'cmd ran'
  # The signal came after the fork, before the PID assignment: the forked
  # child (a hanging startup check) must still get TERM, not run to its end.
  # The TERM then reaches the child within microseconds of its fork, where a
  # single TERM is lost about half the time, so repeat the case.
  if needs_proc "$signal in the fork window stops a hanging startup check"; then
    for attempt in 1 2 3 4 5; do
      run "$signal_status" STUB_NOTICE_SLEEP=30 sh "$TEST_ROOT/launch-gap.sh" "$SERVER_CMD"
      expect_no_event 'notice-done'
      expect_no_event 'migrate-runtime'
      expect_no_event 'cmd ran'
    done
  fi
  # A child that misses the first TERM is still stopped: the entrypoint
  # repeats the TERM until it is gone.
  if needs_proc "$signal: a child that misses the first TERM is still stopped"; then
    deaf_copy "$TEST_ROOT/deaf-child.sh" "$signal" "$TEST_ROOT/deaf-ready-$signal" 'child_pid=$!'
    run "$signal_status" STUB_NOTICE_SLEEP=30 sh "$TEST_ROOT/deaf-child.sh" "$SERVER_CMD"
    expect_no_event 'notice-done'
    expect_no_event 'migrate-runtime'
    expect_no_event 'cmd ran'
  fi
  # The signal lands after supervise's "no stop pending" check, right before
  # `wait`: the handler runs first, then `wait` blocks. The handler must itself
  # repeat the TERM, or the deaf child runs to its end.
  if needs_proc "$signal just before supervise's wait stops a child that misses the first TERM"; then
    deaf_copy "$TEST_ROOT/wait-gap.sh" "$signal" "$TEST_ROOT/wait-gap-ready-$signal" 'wait "$child_pid"'
    run "$signal_status" STUB_NOTICE_SLEEP=30 sh "$TEST_ROOT/wait-gap.sh" "$SERVER_CMD"
    expect_no_event 'notice-done'
    expect_no_event 'migrate-runtime'
    expect_no_event 'cmd ran'
  fi
  awk -v stop="$signal" '{
    if ($0 == "exec tini -- \"$@\"") print "kill -" stop " \"$$\""
    print
  }' "$TEST_ROOT/docker-entrypoint.sh" > "$TEST_ROOT/exec-gap.sh"
  run "$signal_status" sh "$TEST_ROOT/exec-gap.sh" "$SERVER_CMD"
  expect_no_event 'cmd ran'
done

# One-shot commands: no instance id, no CMD.
run 0 $EP migrate
expect_event "migrate-runtime.mjs apply instance=none"
expect_event "pre-migrate.sh --startup-notice"
run 1 STUB_NOTICE_EXIT=1 $EP migrate
expect_no_event "migrate-runtime"
run 4 STUB_RUNNER_EXIT=4 $EP migrate
run 1 DATABASE_URL= $EP migrate
expect_output 'DATABASE_URL'
run 0 $EP hold-deletions 30
expect_event "tini -- node $TEST_ROOT/app/scripts/db/migrate-runtime.mjs hold 30"
expect_event "migrate-runtime.mjs hold 30 instance=none"
run 0 $EP restore --from x.dump
expect_event "tini -- bash $TEST_ROOT/app/scripts/backup/restore.sh --from x.dump"
run 0 $EP backup --keep 3
expect_event "tini -- bash $TEST_ROOT/app/scripts/backup/pre-migrate.sh --label manual --required --keep 3"
run 0 $EP backup-schedule
expect_event "tini -- node $TEST_ROOT/app/scripts/backup/schedule.mjs run"
run 0 $EP restore-drill /backups/x.dump
expect_event "tini -- node $TEST_ROOT/app/scripts/backup/drill.mjs /backups/x.dump"

# An inherited WMP_INSTANCE_ID (e.g. a one-off job started from the server's
# environment) never reaches a one-shot command, so none can register as, or
# be mistaken for, a running application instance.
for oneshot in "migrate" "hold-deletions 30" "restore --from x.dump" "backup" \
  "backup-schedule" "restore-drill /backups/x.dump"; do
  # shellcheck disable=SC2086 # split the command and its arguments
  run 0 WMP_INSTANCE_ID=inherited-instance-id $EP $oneshot
  expect_no_event "inherited-instance-id"
  # The node stub (runner, schedule.mjs, drill.mjs) and the bash stub
  # (restore.sh, pre-migrate.sh) both record the id they saw.
  expect_event "instance=none"
done
# The server start replaces an inherited id with a fresh one.
run 0 WMP_INSTANCE_ID=inherited-instance-id $EP "$SERVER_CMD"
expect_no_event "inherited-instance-id"
expect_event "cmd ran instance=$UUID"

# drive <copy> <command> <ready file> <event> <plan> [VAR=value ...]: run the
# copy (with <command> as its CMD) under a Node driver that owns it as a
# ChildProcess, so a signal is never sent after its exit has been seen (a
# reaped PID could have been reused). The driver waits at most 8 s for <ready
# file> and for <event> in the events file ("-" skips either); then it sends
# the plan's signals, "NAME@<ms before it>" separated by commas, skipping any
# left once the copy has exited. It copies the events file at the copy's exit
# to events-at-exit. The copy runs in its own process group: anything still in
# it 1 s after the copy's exit is reported (stragglers=1) and killed, which
# needs no /proc, and the whole group gets SIGKILL if the copy runs for 18 s.
# Sets drive_ready, drive_status, drive_elapsed (ms from the first signal to
# the exit) and drive_stragglers.
cat > "$TEST_ROOT/drive.mjs" <<'DRIVE'
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
const [copy, cmd, ready, event, plan] = process.argv.slice(2);
const events = process.env.ENTRYPOINT_TEST_EVENTS;
const child = spawn("sh", [copy, cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
let exited = false;
let exitedAt = 0;
let first = 0;
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const killGroup = () => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
};
const groupAlive = () => {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
const bound = setTimeout(killGroup, 18_000);
const done = new Promise((resolve) =>
  child.on("exit", (code, signal) => {
    exited = true;
    exitedAt = Date.now();
    try {
      copyFileSync(events, `${events}-at-exit`);
    } catch {}
    resolve(code ?? 128 + constants.signals[signal]);
  }),
);
const isReady = () =>
  (ready === "-" || existsSync(ready)) &&
  (event === "-" || readFileSync(events, "utf8").includes(event));
let readyNow = false;
for (const deadline = Date.now() + 8_000; !exited && Date.now() < deadline; await sleep(10)) {
  if (isReady()) {
    readyNow = true;
    break;
  }
}
if (readyNow) {
  for (const step of plan.split(",")) {
    const [name, ms] = step.split("@");
    await sleep(Number(ms));
    if (exited) break;
    if (!first) first = Date.now();
    child.kill(`SIG${name}`);
  }
}
const status = await done;
clearTimeout(bound);
for (const until = Date.now() + 1_000; groupAlive() && Date.now() < until; ) await sleep(50);
const stragglers = groupAlive() ? 1 : 0;
if (stragglers) killGroup();
// The output as far as it came (at most 1 s more for the pipes to close).
await Promise.race([new Promise((resolve) => child.stdout.once("close", resolve)), sleep(1_000)]);
if (process.env.DRIVE_OUT) writeFileSync(process.env.DRIVE_OUT, output);
const elapsed = first ? exitedAt - first : -1;
console.log(`ready=${readyNow ? 1 : 0} status=${status} elapsed=${elapsed} stragglers=${stragglers}`);
process.exit(0);
DRIVE
drive() {
  drive_copy=$1 drive_command=$2 drive_readyfile=$3 drive_event=$4 drive_plan=$5
  shift 5
  : > "$EVENTS"
  rm -f "$EVENTS-at-exit"
  start_watchdog
  drive_result=$(env -i PATH="$TEST_ROOT/bin:/usr/bin:/bin" APP_ROOT="$TEST_ROOT/app" ENTRYPOINT_TEST_RUN="$RUN_TOKEN" \
    ENTRYPOINT_TEST_EVENTS="$EVENTS" ENTRYPOINT_TEST_REAL_NODE="$REAL_NODE" DRIVE_OUT="$TEST_ROOT/out" \
    DATABASE_URL="$FIXTURE_DATABASE_URL" "$AUTH_SECRET_NAME=fixture" "$@" \
    "$REAL_NODE" "$TEST_ROOT/drive.mjs" "$drive_copy" "$drive_command" "$drive_readyfile" "$drive_event" "$drive_plan" 2>&1) || true
  stop_watchdog "driven: $drive_copy $drive_command $*"
  drive_ready=$(echo "$drive_result" | sed -n 's/.*ready=\([01]\).*/\1/p')
  drive_status=$(echo "$drive_result" | sed -n 's/.*status=\([0-9]*\).*/\1/p')
  drive_elapsed=$(echo "$drive_result" | sed -n 's/.*elapsed=\(-\{0,1\}[0-9]*\).*/\1/p')
  drive_stragglers=$(echo "$drive_result" | sed -n 's/.*stragglers=\([01]\).*/\1/p')
  if [ -z "$drive_status" ] || [ -z "$drive_stragglers" ]; then
    fail "the driver failed for $drive_copy: $drive_result"
    drive_status=-1 drive_ready=0 drive_elapsed=-1 drive_stragglers=0
  fi
  [ "$drive_stragglers" = 0 ] ||
    fail "processes left in the run's process group after the entrypoint exited ($drive_copy $drive_command $*)"
}

# A stop signal during migrations reaches the runner, in both a server start
# and the one-shot migrate job. The shell supervises both and never starts CMD.
for case_spec in "TERM $SERVER_CMD" "TERM migrate" "HUP $SERVER_CMD" "HUP migrate"; do
  signal=${case_spec%% *}
  startup_command=${case_spec#* }
  signal_status=$(signal_status_of "$signal")
  drive "$TEST_ROOT/docker-entrypoint.sh" "$startup_command" - runner-started "$signal@0" STUB_RUNNER_SLEEP=100
  [ "$drive_ready" = 1 ] || fail "the runner never started ($signal during migrations, $startup_command)"
  [ "$drive_status" -eq "$signal_status" ] ||
    fail "a $signal during migrations should exit $signal_status, got $drive_status"
  expect_event "runner-term"
  expect_no_event "cmd ran"
done

# A stop signal while the backup startup check hangs (a stalled /backups
# mount) reaches the check; neither the runner nor the CMD starts. (TERM and
# HUP here; the INT case follows.)
for signal in TERM HUP; do
  signal_status=$(signal_status_of "$signal")
  drive "$TEST_ROOT/docker-entrypoint.sh" "$SERVER_CMD" - notice-started "$signal@0" STUB_NOTICE_SLEEP=100
  [ "$drive_ready" = 1 ] || fail "the startup check never started ($signal)"
  [ "$drive_status" -eq "$signal_status" ] ||
    fail "a $signal during the startup check should exit $signal_status, got $drive_status"
  expect_event "notice-term"
  expect_no_event "migrate-runtime"
  expect_no_event "cmd ran"
done

# Repeated stop signals while the handler drains a child: TERM arrives while
# supervise waits (as from `docker stop`); the handler then repeats TERM until
# the child, which swallows the first three, is gone, and HUPs arrive during
# that drain. Each nested trap only records itself and must not stretch the
# 0.2 s pause: in dash a nested trap leaves $? at the outer trap's status (here
# the interrupted wait's), so the pause cannot branch on sleep's status. The
# last signal sets the status. (The /proc repeat path: without /proc nothing
# drains, and the case would only check signal timing.)
if needs_proc "repeated stop signals during the drain do not delay the exit; the last sets the status"; then
  ready="$TEST_ROOT/drain-ready"
  rm -f "$ready"
  awk -v launch="$(deaf_launch 3 "$ready")" '{
    line = $0; sub(/^[ \t]+/, "", line)
    if (line == "\"$@\" &") { print launch; next }
    print
  }' "$TEST_ROOT/docker-entrypoint.sh" > "$TEST_ROOT/drain-repeat.sh"
  grep -qF '"$n" -lt 3' "$TEST_ROOT/drain-repeat.sh" || fail "drain copy: launch line not found"
  # TERM 50 ms after the mark (supervise is in its wait by then), then one HUP
  # inside each 0.2 s pause of the drain.
  drive "$TEST_ROOT/drain-repeat.sh" "$SERVER_CMD" "$ready" - "TERM@50,HUP@60,HUP@200,HUP@200" STUB_NOTICE_SLEEP=50
  if [ "$drive_ready" != 1 ]; then
    fail "the drain case's child never became ready"
  else
    [ "$drive_status" -eq 129 ] ||
      fail "repeated stop signals during the drain should exit 129 (the last, HUP), got $drive_status"
    # About 0.6 s (three 0.2 s pauses); each stretched pause would add up to 1 s.
    [ "$drive_elapsed" -lt 1500 ] ||
      fail "the entrypoint took $drive_elapsed ms after the first stop signal (pauses stretched?)"
  fi
  expect_no_event "notice-done"
  expect_no_event "migrate-runtime"
  expect_no_event "cmd ran"
fi

# Without /proc (detection removed from a copy: the fallback outside Linux)
# nothing repeats the TERM, so the stop guard must not swallow a later signal's
# TERM. The first TERM (recorded during the launch) is swallowed by the child;
# the second stop signal, sent once the check has started (its own TERM trap is
# in place), must stop it. That signal interrupts supervise's wait, so the
# entrypoint must wait again until the child has drained (0.5 s) before it
# exits. Runs on every host.
ready="$TEST_ROOT/noproc-ready"
rm -f "$ready"
awk -v proc="$PROC_DETECTION" -v spin="$(ready_spin "$ready")" -v launch="$(deaf_launch 1 "$ready")" '{
  if ($0 == proc) next
  line = $0; sub(/^[ \t]+/, "", line)
  if (line == "\"$@\" &") { print launch; next }
  if (line == "child_pid=$!") print "  " spin "; kill -TERM \"$$\""
  print
}' "$TEST_ROOT/docker-entrypoint.sh" > "$TEST_ROOT/noproc.sh"
if grep -q 'have_proc=true' "$TEST_ROOT/noproc.sh"; then fail "noproc copy: /proc detection not removed"; fi
grep -qF "trap 'n=\$((n + 1))' TERM" "$TEST_ROOT/noproc.sh" || fail "noproc copy: launch line not found"
drive "$TEST_ROOT/noproc.sh" "$SERVER_CMD" "$ready" notice-started "HUP@0" STUB_NOTICE_SLEEP=50 STUB_NOTICE_DRAIN=0.5
[ "$drive_ready" = 1 ] || fail "the no-/proc case's check never started"
[ "$drive_status" -eq 129 ] || fail "a HUP after a swallowed TERM without /proc should exit 129, got $drive_status"
grep -q notice-drained "$EVENTS-at-exit" 2>/dev/null ||
  fail "without /proc the entrypoint exited before its child had drained"
expect_no_event "notice-done"
expect_no_event "migrate-runtime"
expect_no_event "cmd ran"

# INT while the check hangs: the child gets TERM (a background child of this
# shell has SIGINT ignored, and bash keeps that), the entrypoint exits 130.
# The INT comes 0.5 s after launch, from the copy itself (a test launching the
# entrypoint with & could not deliver INT: it would start with INT ignored).
awk '{
  print
  line = $0; sub(/^[ \t]+/, "", line)
  if (line == "child_pid=$!" && !done) { print "  (sleep 0.5; kill -INT \"$$\") &"; done = 1 }
}' "$TEST_ROOT/docker-entrypoint.sh" > "$TEST_ROOT/notice-int.sh"
run 130 STUB_NOTICE_SLEEP=100 sh "$TEST_ROOT/notice-int.sh" "$SERVER_CMD"
expect_event "notice-term"
expect_no_event "migrate-runtime"
expect_no_event "cmd ran"

if grep -q 'trap - .*TERM' "$TEST_ROOT/docker-entrypoint.sh"; then
  fail "startup traps must stay installed through exec"
fi

# The stop traps come first: before the BACKUP_ENABLED validation and before
# any child (the startup check, the instance id, the runner, the CMD).
first_line() { awk -v pattern="$1" '/^[[:space:]]*#/ { next } $0 ~ pattern { print NR; exit }' "$TEST_ROOT/docker-entrypoint.sh"; }
for signal in TERM INT HUP; do
  trap_line=$(first_line "^trap '.*' $signal\$")
  validation_line=$(first_line 'BACKUP_ENABLED:-')
  child_line=$(first_line 'supervise (bash|node)|node -p|exec tini')
  if [ -z "$trap_line" ] || [ -z "$validation_line" ] || [ -z "$child_line" ] ||
    [ "$trap_line" -ge "$validation_line" ] || [ "$trap_line" -ge "$child_line" ]; then
    fail "the $signal trap (line ${trap_line:-none}) must precede the BACKUP_ENABLED validation (${validation_line:-none}) and the first child (${child_line:-none})"
  fi
done

# Source pins (the real file). The handler itself repeats the TERM (stop_child),
# and records a signal only while a child is being launched or a stop is
# already under way (the guard applies only where /proc identifies the child);
# supervise forwards a signal recorded during the launch. The trap path
# (stop_startup -> stop_child's first term_child -> child_alive -> proc_start)
# never forks, so the first TERM gets out at a full pids limit, and the pause
# is decided once at startup.
SRC="$REPO_ROOT/scripts/docker-entrypoint.sh"
fn_body() {
  awk -v name="$1" '$0 == name "() {" { on = 1; next } on && $0 == "}" { exit } on && $0 !~ /^[[:space:]]*#/ { print }' "$SRC"
}
# Every command in those bodies must be a builtin (or one of these functions):
# no command substitution, no backticks, no external command.
for name in stop_startup term_child child_alive proc_start; do
  body=$(fn_body "$name")
  if [ -z "$body" ]; then
    fail "$name() not found in scripts/docker-entrypoint.sh"
    continue
  fi
  if printf '%s\n' "$body" | grep -qE '\$\(|`'; then
    fail "$name() must never fork (no \$(...) or backticks)"
  fi
  forking=$(printf '%s\n' "$body" | awk '
    BEGIN {
      split("read set shift kill return exit [ : true false stop_child term_child child_alive proc_start", list, " ")
      for (i in list) ok[list[i]] = 1
    }
    # Scans left to right: each quoted string becomes the letter Q and each
    # escaped character the letter E, inside the word they belong to. So a
    # command word built from quotes or escapes ("cat", \cat) reads as a word
    # that is not on the list, and operators inside quotes are gone.
    # A quote inside ${...} (its own quoting context) is not parsed: it is
    # reported as unsupported, so it cannot hide a command.
    function unquote(s,   out, i, c, st, depth) {
      out = ""
      st = ""
      depth = 0
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (st == "\047") { if (c == "\047") st = ""; continue }
        if (c == "\\") { i++; if (st == "") out = out "E"; continue }
        if (c == "$" && substr(s, i + 1, 1) == "{") { depth++; i++; out = out "P"; continue }
        if (depth > 0 && c == "}") { depth--; continue }
        if (depth > 0 && (c == "\"" || c == "\047")) { out = out " a-quote-inside-${...} ;"; continue }
        if (depth > 0) continue
        if (st == "\"") { if (c == "\"") st = ""; continue }
        if (c == "\"" || c == "\047") { st = c; out = out "Q"; continue }
        out = out c
      }
      return out
    }
    {
      line = unquote($0)
      # Redirections that duplicate a descriptor (2>&1) are not a background "&".
      gsub(/[0-9]*[<>]&[0-9-]+/, "", line)
      # A pipeline or a background job always forks.
      rest = line
      gsub(/\|\||&&/, "", rest)
      if (rest ~ /[|&]/) print "a-pipeline-or-&"
      gsub(/\|\||&&|;/, "\n", line)
      n = split(line, parts, "\n")
      for (i = 1; i <= n; i++) {
        part = parts[i]
        sub(/^[ \t]+/, "", part)
        while (part ~ /^(if|then|elif|else|fi|!|\{|\})([ \t]|$)/) { sub(/^[^ \t]+[ \t]*/, "", part) }
        nw = split(part, words, /[ \t]+/)
        # Leading assignments (FOO=1 cmd) prefix the command: check the command.
        w = 1
        while (w <= nw && words[w] ~ /^[A-Za-z_][A-Za-z_0-9]*=/) w++
        if (w > nw || words[w] == "") continue
        if (!(words[w] in ok)) print words[w]
      }
    }')
  [ -z "$forking" ] || fail "$name() must run builtins only (it runs in the trap handler, which must never fork); found: $(echo $forking)"
done
# stop_child itself forks for its pause, so it is not on that list; its first
# step must be the TERM, before anything that could fork.
[ "$(fn_body stop_child | sed -n 1p)" = "  term_child" ] ||
  fail "stop_child() must send the first TERM (term_child) before anything else"
expected_handler='  stop_signal="$1"
  [ "$stopping" = false ] || [ "$have_proc" = false ] || return 0
  if [ -n "$child_pid" ]; then
    stopping=true
    stop_child
  elif [ "$launching_child" = false ]; then
    exit "$2"
  fi'
[ "$(fn_body stop_startup)" = "$expected_handler" ] ||
  fail "stop_startup() must repeat the TERM itself (stop_child), behind the stop guard that applies only with /proc"
fn_body supervise | tr -s ' ' | tr '\n' '|' |
  grep -qF '| if [ -n "$stop_signal" ]; then| stopping=true| stop_child| wait "$child_pid" 2>/dev/null|' ||
  fail "supervise() must mark the stop under way before it forwards a recorded signal"
fn_body stop_child | grep -qxF '    sleep "$stop_pause" 2>/dev/null || :' ||
  fail "stop_child() must pause for the startup-decided stop_pause (never branch on sleep's status)"

if [ "$failures" -ne 0 ]; then
  echo "docker-entrypoint tests: $failures failure(s)." >&2
  exit 1
fi
if [ "$skipped" -ne 0 ]; then
  echo "docker-entrypoint tests passed; $skipped skipped (see the skip: lines above)."
else
  echo "docker-entrypoint tests passed."
fi

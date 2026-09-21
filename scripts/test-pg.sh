#!/usr/bin/env bash
# test-pg.sh — disposable-PostgreSQL runner for the MCP OAuth integration
# suite (MCP plan Phase 9b / Part K2).
#
# Spins up a THROWAWAY postgres:17 container (same image as
# docker-compose.dev.yml) under a UNIQUE name with a RANDOM loopback host
# port, waits for TCP readiness, pushes the schema non-destructively through
# the repo's OWN db:push package pipeline (so future pipeline additions are
# inherited automatically), runs the MCP integration suite with the
# disposable URL, and tears the container down — including its ANONYMOUS
# VOLUMES — on exit, on failure, and on interruption.
#
# SAFETY (container ownership — R119 F4 / R120 F1 protocol):
# - Every run carries a unique RUN_ID embedded in BOTH the container NAME
#   and a run-unique docker LABEL (wsmp.test-pg.run=<run-id>).
# - The cidfile lives in a directory this run allocates EXCLUSIVELY via
#   `mkdir` (atomic): a pre-existing cidfile can never be adopted, and an
#   allocation failure aborts before any trap could remove anything.
# - Teardown removes a container ONLY after `docker inspect` proves THIS
#   run's LABEL (fallback: this run's unique NAME when the label cannot be
#   read). A foreign container ID — from a collided cidfile or anywhere
#   else — is reported and NEVER removed: not the shared dev one, not
#   wsmp-review-loop-pg, not another run's container.
# - The label lookup also finds a container this run created even when the
#   cidfile was never written (interruption between the daemon creating the
#   container and the client writing the cidfile).
# - Cleanup is IDEMPOTENT and re-entrancy-safe: its completion flag is set
#   only AFTER every owned container is removed (or PROVEN absent) with all
#   ownership checks SUCCEEDED, AND the cidfile is deleted — an UNKNOWN
#   outcome (transient inspect/ps failure) or a failed enumeration keeps
#   the evidence alive so a signal delivered DURING cleanup makes the trap
#   re-run it and RETRY instead of silently declaring disposal complete.
# - `rm -f -v` also removes the anonymous postgres data volume the image
#   declares; the run creates NO named volume.
# - Binds postgres to 127.0.0.1 only, on an ephemeral port.
# - INT/TERM run cleanup and then TERMINATE the script (exit 130/143) — a
#   signal never resumes the remaining phases.
# - Reuses the committed DEV fixture password from docker-compose.dev.yml
#   for the DISPOSABLE container only; no production credentials involved.
#
# TIME BOUNDS: every blocking container-runtime call runs under
# `timeout --kill-after=<grace>` (a runtime that IGNORES SIGTERM is
# force-killed at <dur>+<grace>), and the readiness loop bounds each probe
# by the REMAINING deadline and enforces the deadline on the success path
# too (a probe completing after the deadline is a failure). Distinction
# (R124 F2): the readiness figure is an ACCEPTANCE deadline — a probe only
# COUNTS if it completed before it — while the TERMINATION bound for a
# stuck final probe can exceed it by <1 s of whole-second rounding plus
# the 5 s kill grace before cleanup runs.
#
# OPT-OUT (bring your own database): if SCHEMA_VALIDATION_DATABASE_URL is
# already exported when this script starts, provisioning is SKIPPED and the
# suite runs against that URL directly — no container is created or removed.
# The URL must already have the schema pushed (e.g. via `pnpm db:push` with
# DATABASE_URL set to it). REQUIRE_POSTGRES_INTEGRATION=1 is always set so a
# missing/unreachable URL fails loudly instead of silently skipping tests.
#
# Usage:
#   pnpm test:pg
#   SCHEMA_VALIDATION_DATABASE_URL=postgresql://... pnpm test:pg
#
# No sudo. Requires docker (or podman via CONTAINER_RUNTIME) to be available
# unless the opt-out URL is provided.

set -euo pipefail

SCRIPT_NAME="test-pg"
echo "[$SCRIPT_NAME] disposable-PostgreSQL MCP integration runner"

# ---------------------------------------------------------------------------
# Locate the repo root from this script's location (works from any cwd).
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Suite to run (kept in one place; the *.integration.test.ts convention skips
# itself when SCHEMA_VALIDATION_DATABASE_URL is unset in normal runs).
# ---------------------------------------------------------------------------
MCP_INTEGRATION_FILES=(
  "src/mcp/oauth-mcp.integration.test.ts"
)

# ---------------------------------------------------------------------------
# Time bounds (R118 S4; R119 F5 + R120 F2): attempts-bounded loops are ALSO
# elapsed-time bounded, and every blocking container-runtime call gets an
# explicit `timeout --kill-after=<grace>` so a runtime that IGNORES SIGTERM
# is force-killed at <dur>+<grace> and can never wedge the runner past its
# advertised deadline.
# ---------------------------------------------------------------------------
RUNTIME_CALL_TIMEOUT="30s"
RUNTIME_KILL_GRACE="5s"
RUN_START_TIMEOUT="120s"
# Millisecond-precision deadline budget for the readiness loop (GNU date
# `%s%3N`; this is a Linux-targeted repo script). Per-probe timeouts are
# bounded by the REMAINING deadline time (second granularity — GNU timeout
# takes no `ms` suffix; the ceil can overshoot the remaining budget by <1s,
# which the success-path deadline check below catches), never a fixed 10s
# that could overrun it, and a probe completing after the deadline is a
# FAILURE.
READY_DEADLINE_MS=60000
READY_PROBE_MS=10000

# ---------------------------------------------------------------------------
# Every container-runtime invocation goes through this wrapper: TERM at
# <dur>, hard KILL at <dur>+<grace>. Nothing else in this script calls the
# runtime directly.
# ---------------------------------------------------------------------------
runtime() {
  timeout --kill-after "$RUNTIME_KILL_GRACE" "$1" "${CONTAINER_RUNTIME:-docker}" "${@:2}"
}

# ---------------------------------------------------------------------------
# Teardown state (ownership protocol: see the SAFETY header).
#
# RUN_ID is embedded in the container NAME and the run-unique LABEL, so
# "did THIS run create it" stays decidable even when the cidfile is absent
# (signal during `docker run` after the daemon created the container) or
# only partially written.
# ---------------------------------------------------------------------------
CLEANED_UP=0
RUN_ID="t$(date +%s)r$$x$RANDOM$RANDOM"
RUN_LABEL="wsmp.test-pg.run=${RUN_ID}"
CONTAINER_NAME="wsmp-test-pg-${RUN_ID}"
# EXCLUSIVELY allocated below via `mkdir` (atomic): a stale cidfile can
# never exist inside a directory only this run could create.
RUN_DIR="${TMPDIR:-/tmp}/wsmp-test-pg.${RUN_ID}"
CID_FILE="${RUN_DIR}/cid"
# The container ID recorded by `docker run --cidfile` — adopted ONLY on
# cidfile evidence, and only used for calls that operate on this run's own
# container (port/readiness). Removal additionally requires the ownership
# proof below.
CREATED_CONTAINER_ID=""

# Candidate containers whose ownership must be verified before any removal.
# Sources: the cidfile content (read FIRST — never deleted before removal)
# and every container the run-unique LABEL selects (covers creation without
# a cidfile write). Deduplicated. If the LABEL LOOKUP ITSELF fails, the
# sentinel "!ENUM-FAILED!" is emitted: candidate discovery must never be
# indistinguishable from an empty result (R121 F1) — the caller treats that
# sentinel as "cleanup incomplete, retry on re-entry".
ENUM_FAILED_SENTINEL="!ENUM-FAILED!"
owned_container_candidates() {
  local ids=() id labeled ps_status
  if [ -f "$CID_FILE" ]; then
    id="$(cat "$CID_FILE" 2>/dev/null || true)"
    if [ -n "$id" ]; then ids+=("$id"); fi
  fi
  ps_status=0
  labeled="$(runtime "$RUNTIME_CALL_TIMEOUT" ps -aq --no-trunc --filter "label=$RUN_LABEL" 2>/dev/null)" || ps_status=$?
  if [ "$ps_status" -ne 0 ]; then
    # Enumeration FAILED (unreachable/hung runtime) — not the same as "no
    # matches": emit the sentinel so cleanup refuses to complete.
    printf '%s\n' "$ENUM_FAILED_SENTINEL"
  fi
  for id in $labeled; do
    local known=0 existing
    for existing in ${ids[@]+"${ids[@]}"}; do
      if [ "$existing" = "$id" ]; then known=1; break; fi
    done
    if [ "$known" -eq 0 ]; then ids+=("$id"); fi
  done
  if [ "${#ids[@]}" -gt 0 ]; then printf '%s\n' "${ids[@]}"; fi
}

# Classify one candidate id (R121 F1 — a failed ownership check must never
# be treated as completed cleanup; only a PROVEN removal or PROVEN absence
# may complete disposal). Echoes exactly one of:
#   owned    — this run's LABEL (or unique NAME when the label is unreadable)
#   foreign  — inspect succeeded and proved SOMEONE ELSE's container
#   absent   — inspect failed, but a SUCCESSFUL ps query proved it is gone
#   unknown  — evidence collection failed (transient runtime error): removal
#              is refused AND cleanup must NOT complete (retry on re-entry)
container_state() {
  local id="$1" inspected label name ps_status listed
  inspected="$(runtime "$RUNTIME_CALL_TIMEOUT" inspect --format '{{.Name}}|{{index .Config.Labels "wsmp.test-pg.run"}}' "$id" 2>/dev/null)" || inspected=""
  if [ -n "$inspected" ]; then
    name="${inspected%%|*}"
    label="${inspected#*|}"
    if [ "$label" = "$RUN_ID" ] || [ "$name" = "/$CONTAINER_NAME" ]; then
      echo owned
      return 0
    fi
    echo foreign
    return 0
  fi
  # Inspect failed: distinguish "already gone" (a SUCCESSFUL ps query with
  # no match) from "evidence collection failed" (ps also failed).
  ps_status=0
  listed="$(runtime "$RUNTIME_CALL_TIMEOUT" ps -aq --no-trunc --filter "id=$id" 2>/dev/null)" || ps_status=$?
  if [ "$ps_status" -eq 0 ] && [ -z "$listed" ]; then
    echo absent
    return 0
  fi
  echo unknown
}

# Cleanup — IDEMPOTENT and re-entrancy-safe (R120 F1c, R121 F1):
# - the completion flag is set ONLY after every owned container was removed
#   (or PROVEN absent) AND every ownership check SUCCEEDED (an UNKNOWN
#   outcome — transient inspect/ps failure — or a failed candidate
#   enumeration keeps the cidfile/run-dir alive so a re-entered cleanup
#   RETRIES instead of silently declaring disposal complete);
# - a signal delivered mid-cleanup therefore re-enters this function and
#   RETRIES the removal (idempotent) instead of skipping it;
# - when nothing was created, cleanup prints NO removal advice: a name
#   collision or an unreachable daemon means there is nothing of ours to
#   remove, and telling the user to remove a container by NAME could hit
#   one we do not own.
cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then return 0; fi
  local removal_failed=0 candidate state
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$candidate" = "$ENUM_FAILED_SENTINEL" ]; then
      echo "[$SCRIPT_NAME] WARNING: candidate enumeration failed; NOT marking cleanup complete (will retry on re-entry); manual hint: label $RUN_LABEL." >&2
      removal_failed=1
      continue
    fi
    state="$(container_state "$candidate")"
    case "$state" in
      owned)
        echo "[$SCRIPT_NAME] removing disposable container (and its anonymous volumes): ${candidate:0:12}"
        # Never fails the script from teardown; a genuinely stuck runtime is
        # reported (with the run LABEL as the manual-cleanup hint) and
        # retried on cleanup re-entry. `-v` removes the anonymous data
        # volume so "zero containers left" also means zero volumes left.
        if runtime "$RUNTIME_CALL_TIMEOUT" rm -f -v "$candidate" >/dev/null 2>&1; then
          if [ "$candidate" = "$CREATED_CONTAINER_ID" ]; then CREATED_CONTAINER_ID=""; fi
        else
          echo "[$SCRIPT_NAME] WARNING: failed to remove container $candidate (and its volumes); will retry on re-entry; manual hint: label $RUN_LABEL." >&2
          removal_failed=1
        fi
        ;;
      foreign)
        echo "[$SCRIPT_NAME] WARNING: candidate $candidate is NOT owned by this run; leaving it untouched." >&2
        ;;
      absent)
        # PROVEN gone (inspect failed but a successful ps query returned no
        # match): nothing to remove — disposal of this candidate is
        # complete.
        ;;
      unknown)
        echo "[$SCRIPT_NAME] WARNING: could not determine ownership or absence of $candidate; leaving it untouched and NOT marking cleanup complete (will retry on re-entry); manual hint: label $RUN_LABEL." >&2
        removal_failed=1
        ;;
    esac
  done < <(owned_container_candidates)
  if [ "$removal_failed" -eq 0 ]; then
    rm -f "$CID_FILE" 2>/dev/null || true
    rmdir "$RUN_DIR" 2>/dev/null || true
    CLEANED_UP=1
  fi
}

on_interrupt() {
  cleanup
  exit 130
}
on_terminate() {
  cleanup
  exit 143
}
# EXIT-path outcome propagation (R124 F1): a run whose suite SUCCEEDED must
# not exit 0 when disposal could not be PROVEN complete (an unknown
# ownership outcome, a failed enumeration, or a failed removal left
# evidence behind). Exit 90 marks "disposal unproven" — but only when the
# original status was 0: a schema/suite failure keeps ITS diagnostic code
# (still nonzero), and INT/TERM keep 130/143 (signal semantics win; the
# warnings above already report the residue).
on_exit() {
  local status=$?
  cleanup
  if [ "$status" -eq 0 ] && [ "$CLEANED_UP" -ne 1 ]; then
    echo "[$SCRIPT_NAME] error: disposal could not be proven complete; exiting 90 (evidence retained under $RUN_DIR; manual hint: label $RUN_LABEL)." >&2
    exit 90
  fi
  exit "$status"
}
# ---------------------------------------------------------------------------
# Opt-out: run against an externally provided URL.
# ---------------------------------------------------------------------------
if [ -n "${SCHEMA_VALIDATION_DATABASE_URL:-}" ]; then
  echo "[$SCRIPT_NAME] SCHEMA_VALIDATION_DATABASE_URL is set — skipping provisioning;"
  echo "[$SCRIPT_NAME] running the integration suite against the provided URL."
  cd "$REPO_ROOT"
  SUITE_STATUS=0
  REQUIRE_POSTGRES_INTEGRATION=1 \
    pnpm --filter server exec vitest run --maxWorkers=1 --no-file-parallelism \
    "${MCP_INTEGRATION_FILES[@]}" || SUITE_STATUS=$?
  exit "$SUITE_STATUS"
fi

# ---------------------------------------------------------------------------
# Container runtime detection (docker, podman, or CONTAINER_RUNTIME override
# — same convention as scripts/lib/dev-docker-runtime.sh).
# ---------------------------------------------------------------------------
if [ -n "${CONTAINER_RUNTIME:-}" ]; then
  if ! command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1; then
    echo "[$SCRIPT_NAME] error: CONTAINER_RUNTIME=$CONTAINER_RUNTIME not found in PATH" >&2
    exit 1
  fi
elif command -v docker >/dev/null 2>&1; then
  CONTAINER_RUNTIME="docker"
elif command -v podman >/dev/null 2>&1; then
  CONTAINER_RUNTIME="podman"
else
  echo "[$SCRIPT_NAME] error: neither docker nor podman found in PATH." >&2
  echo "[$SCRIPT_NAME]        install one, set CONTAINER_RUNTIME=<binary>," >&2
  echo "[$SCRIPT_NAME]        or export SCHEMA_VALIDATION_DATABASE_URL to use an existing database." >&2
  exit 1
fi
echo "[$SCRIPT_NAME] container runtime: $CONTAINER_RUNTIME"

# ---------------------------------------------------------------------------
# Disposable container: EXCLUSIVE cidfile allocation + unique name + unique
# run label + random loopback host port.
#
# OWNERSHIP (R119 F4 / R120 F1): `docker run --cidfile` refuses to write to
# an existing file, so the cidfile cannot itself be the exclusivity
# mechanism — instead it lives inside a directory this run creates with
# `mkdir` (ATOMIC and EXCLUSIVE). A pre-existing cidfile is therefore
# structurally impossible; if the directory already exists (pathological
# TMPDIR collision), the script aborts BEFORE any trap is installed, so no
# removal can ever run. Creation evidence survives interruption: a signal
# during `docker run` leaves the daemon-created container discoverable by
# the run-unique LABEL even when the cidfile was never written.
# ---------------------------------------------------------------------------
POSTGRES_DB="wsmp-test"
# DEV fixture password (docker-compose.dev.yml) — disposable container only.
POSTGRES_PASSWORD="********"

# EXCLUSIVE allocation (abort WITHOUT any removal on failure — the traps
# are not even installed yet, so no cleanup path can possibly run):
# `mkdir` is atomic and fails if the path exists. `docker run --cidfile`
# then creates the cidfile INSIDE this private directory.
if ! mkdir "$RUN_DIR" 2>/dev/null; then
  echo "[$SCRIPT_NAME] error: could not exclusively allocate $RUN_DIR" >&2
  echo "[$SCRIPT_NAME]        (the path already exists — a pathological TMPDIR collision)." >&2
  echo "[$SCRIPT_NAME]        Nothing was created or removed." >&2
  exit 1
fi

# Traps are installed only AFTER the exclusive allocation: nothing of ours
# existed before this point, so an abort above needs no teardown at all.
trap on_exit EXIT
trap on_interrupt INT
trap on_terminate TERM

echo "[$SCRIPT_NAME] starting disposable postgres:17 container: $CONTAINER_NAME (run $RUN_ID)"
RUN_STATUS=0
timeout --kill-after "$RUNTIME_KILL_GRACE" "$RUN_START_TIMEOUT" "$CONTAINER_RUNTIME" run -d \
  --name "$CONTAINER_NAME" \
  --label "$RUN_LABEL" \
  --cidfile "$CID_FILE" \
  -e "POSTGRES_DB=$POSTGRES_DB" \
  -e "POSTGRES_USER=postgres" \
  -e "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  -p "127.0.0.1::5432" \
  postgres:17 >/dev/null || RUN_STATUS=$?
# Adopt the created container ONLY on cidfile evidence of creation (the
# ownership PROOF for removal is separately established in cleanup via the
# run label/name; this id only targets this run's own port/readiness calls).
if [ -s "$CID_FILE" ]; then
  CREATED_CONTAINER_ID="$(cat "$CID_FILE")"
fi
if [ "$RUN_STATUS" -ne 0 ] || [ -z "$CREATED_CONTAINER_ID" ]; then
  echo "[$SCRIPT_NAME] error: could not start the disposable container" \
    "(run exit $RUN_STATUS, name $CONTAINER_NAME)." >&2
  echo "[$SCRIPT_NAME]        If the NAME collides with an existing container, this script" >&2
  echo "[$SCRIPT_NAME]        leaves it alone — only a container whose run label or unique" >&2
  echo "[$SCRIPT_NAME]        name proves THIS run created it is ever removed." >&2
  exit 1
fi
# Resolve the randomly assigned loopback host port (by OWNED id, hard-bounded
# so a TERM-ignoring runtime cannot wedge the runner).
HOST_PORT=""
HOST_PORT_RAW="$(runtime "$RUNTIME_CALL_TIMEOUT" port "$CREATED_CONTAINER_ID" 5432/tcp)" || HOST_PORT_RAW=""
HOST_PORT="$(printf '%s\n' "$HOST_PORT_RAW" | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
if [ -z "$HOST_PORT" ]; then
  echo "[$SCRIPT_NAME] error: could not resolve the published host port for $CONTAINER_NAME" >&2
  exit 1
fi
DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:$HOST_PORT/$POSTGRES_DB"
echo "[$SCRIPT_NAME] disposable database URL: ***********************************************/$POSTGRES_DB"

# ---------------------------------------------------------------------------
# Wait for readiness — a TCP check (R117/R118 S3).
#
# `pg_isready` WITHOUT -h connects to the unix socket, where the temporary
# initdb server answers "accepting connections" while the real TCP listener
# is not up yet (probe-verified by review). `-h 127.0.0.1 -p 5432` inside
# the container forces a real TCP connection to the final server.
#
# Deadline enforcement (R119 F5 + R120 F2): millisecond-precision absolute
# deadline; EACH probe's timeout is bounded by the REMAINING deadline time
# (never a fixed 10s that could start at deadline−1s and overrun); and the
# deadline is enforced on the SUCCESS path too — a probe that completes
# after the deadline is a FAILURE, not a readiness success.
# ---------------------------------------------------------------------------
echo "[$SCRIPT_NAME] waiting for postgres TCP readiness (max $((READY_DEADLINE_MS / 1000))s)..."
READY=0
READY_DEADLINE_AT_MS=$(( $(date +%s%3N) + READY_DEADLINE_MS ))
while :; do
  NOW_MS="$(date +%s%3N)"
  REMAINING_MS=$(( READY_DEADLINE_AT_MS - NOW_MS ))
  if [ "$REMAINING_MS" -le 0 ]; then break; fi
  if [ "$REMAINING_MS" -lt "$READY_PROBE_MS" ]; then
    PROBE_MS="$REMAINING_MS"
  else
    PROBE_MS="$READY_PROBE_MS"
  fi
  # GNU timeout takes no `ms` suffix: ceil to whole seconds (the <1s
  # overshoot is caught by the success-path deadline check below).
  PROBE_SECONDS=$(((PROBE_MS + 999) / 1000))
  if timeout --kill-after "$RUNTIME_KILL_GRACE" "${PROBE_SECONDS}s" "$CONTAINER_RUNTIME" exec "$CREATED_CONTAINER_ID" \
    pg_isready -h 127.0.0.1 -p 5432 -U postgres -d "$POSTGRES_DB" >/dev/null 2>&1; then
    # Success-path deadline enforcement: the probe result only counts if it
    # completed BEFORE the deadline.
    NOW_MS="$(date +%s%3N)"
    if [ "$NOW_MS" -lt "$READY_DEADLINE_AT_MS" ]; then READY=1; fi
    break
  fi
  NOW_MS="$(date +%s%3N)"
  REMAINING_MS=$(( READY_DEADLINE_AT_MS - NOW_MS ))
  if [ "$REMAINING_MS" -le 0 ]; then break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "[$SCRIPT_NAME] error: postgres did not become TCP-ready within $((READY_DEADLINE_MS / 1000))s" >&2
  exit 1
fi
echo "[$SCRIPT_NAME] postgres is ready (TCP)."

# ---------------------------------------------------------------------------
# Schema sync — the repo's OWN pipeline (R118 S6).
#
# `pnpm --filter @ws-model-proxy/db run db:push` IS what `pnpm db:push` runs
# (prisma db push && node scripts/apply-schema-hardening.mjs); invoking the
# package script instead of re-listing its commands means any future pipeline
# addition is inherited here automatically. DATABASE_URL is scoped to this
# invocation only (env-prefix form — never exported into the environment).
# Safe, non-destructive sync only; the AGENTS.md-prohibited commands are
# never used.
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"
echo "[$SCRIPT_NAME] pushing Prisma schema through the db:push package pipeline..."
PUSH_STATUS=0
DATABASE_URL="$DATABASE_URL" pnpm --filter @ws-model-proxy/db run db:push || PUSH_STATUS=$?
if [ "$PUSH_STATUS" -ne 0 ]; then
  echo "[$SCRIPT_NAME] error: db:push pipeline failed ($PUSH_STATUS)" >&2
  exit "$PUSH_STATUS"
fi

# ---------------------------------------------------------------------------
# Run the MCP integration suite against the disposable database.
# ---------------------------------------------------------------------------
echo "[$SCRIPT_NAME] running the MCP OAuth integration suite..."
SUITE_STATUS=0
SCHEMA_VALIDATION_DATABASE_URL="$DATABASE_URL" \
REQUIRE_POSTGRES_INTEGRATION=1 \
  pnpm --filter server exec vitest run --maxWorkers=1 --no-file-parallelism \
  "${MCP_INTEGRATION_FILES[@]}" || SUITE_STATUS=$?
echo "[$SCRIPT_NAME] suite finished with exit status $SUITE_STATUS."
exit "$SUITE_STATUS"

#!/usr/bin/env bash
# Real release adoption on disposable localhost Postgres (Docker required).
# Only scratch databases created by this harness are changed or removed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export DATABASE_URL="${CHECK_DATABASE_URL:-}"
bash "$ROOT/scripts/assert-local-database.sh" db:test-adopt-released
exec node "$ROOT/scripts/db/test-adopt-released.mjs" "$@"

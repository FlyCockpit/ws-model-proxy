#!/usr/bin/env bash
# Image command `restore <source> --confirm RESTORE:<database> [...]`.
# The app image entrypoint execs this script; all logic and safeguards live in
# restore.mjs (run `restore --help` for the options). Target: DATABASE_URL.
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/restore.mjs" "$@"

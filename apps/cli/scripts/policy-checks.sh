#!/usr/bin/env bash
# Project policy checks — grep-based guardrails for things the Rust compiler and
# clippy can't catch. Mirrors the "Agent safety rules" in AGENTS.md so they're
# enforced by CI, not just trusted.
#
# Run locally: bash scripts/policy-checks.sh
# Add a rule: append a `check` call. Keep each rule fast and false-positive-free.

set -euo pipefail

fail=0

# Where to look. We scan tracked source/config, not build output or git internals.
SCAN_DIRS=(src xtask/src tests scripts .github docs)

# The only place fake secret-shaped text may live (owner decision 2026-09-29);
# every secret scanner excludes it, including the root private-key grep in
# ../../.github/workflows/pr-checks.yml. Paths are relative to this directory.
SECRET_FIXTURE_DIRS=(tests/fixtures/masking)

# check <regex> <human message> [skip-secret-fixtures]
# Fails if the (extended) regex matches anywhere in SCAN_DIRS.
# With `skip-secret-fixtures` the hits under SECRET_FIXTURE_DIRS are dropped:
# the exclusion is a path PREFIX match, so a same-named directory elsewhere is
# still scanned (grep's --exclude-dir matches the basename anywhere). Only the
# secret checks pass it: the hook, dbg! and unsafe rules keep scanning fixtures.
check() {
  local pattern="$1" message="$2" skip_fixtures="${3:-}"
  # -I skips binary files; -n shows line numbers; || true so no-match isn't an error.
  local hits
  hits="$(grep -rInE \
    --include='*.rs' --include='*.sh' --include='*.yml' --include='*.toml' \
    --include='*.md' --include='*.json' \
    --exclude='policy-checks.sh' \
    -- "$pattern" "${SCAN_DIRS[@]}" 2>/dev/null || true)"
  if [[ -n "$hits" && "$skip_fixtures" == 'skip-secret-fixtures' ]]; then
    local prefixes=''
    local dir
    for dir in "${SECRET_FIXTURE_DIRS[@]}"; do
      prefixes="${prefixes:+$prefixes|}^${dir}/"
    done
    hits="$(printf '%s\n' "$hits" | grep -vE "$prefixes" || true)"
  fi
  if [[ -n "$hits" ]]; then
    echo "POLICY VIOLATION: $message"
    echo "$hits"
    echo
    fail=1
  fi
}

# 1. Never bypass git hooks.
check '--no-verify' 'do not bypass commit hooks (--no-verify). See AGENTS.md.'

# 2. No debugging macros left in the tree (clippy also catches dbg! in crate code;
#    this also covers scripts/workflows and is a fast belt-and-suspenders).
check 'dbg!\(' 'remove dbg!() before committing.'

# 3. No obvious committed secrets. Only these two checks skip the owner-approved
#    fake-secret fixture directory; a real key anywhere else still fails.
check 'BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY' 'a private key appears to be committed — remove and rotate it.' skip-secret-fixtures
check 'AKIA[0-9A-Z]{16}' 'an AWS access key id appears to be committed — remove and rotate it.' skip-secret-fixtures

# 4. Don't disable the unsafe ban without discussion.
check 'allow\(unsafe_code\)' 'unsafe is forbidden project-wide; do not allow it locally without sign-off.'

if [[ "$fail" -ne 0 ]]; then
  echo "policy checks failed."
  exit 1
fi
echo "policy checks passed."

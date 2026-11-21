# shellcheck shell=bash
# Shell twin of scripts/lib/test-container-prefix.mjs, for the bash test
# harnesses (test:pg). Same rules: `--container-prefix <name>` wins, then
# TEST_CONTAINER_PREFIX, then the harness's default; an empty or invalid
# value is an error, never a silent fallback. Test tooling only.
#
# Usage (after `source`):
#   prefix="$(test_container_prefix <default> "$@")" || exit 2
# Prints the prefix on stdout, or the reason on stderr and returns 2.

TEST_CONTAINER_PREFIX_MAX=24

test_container_prefix() {
  local fallback="$1" prefix="" source="" found=0
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --container-prefix ]; then
      found=1
      prefix="${2-}"
      source="--container-prefix"
      break
    fi
    shift
  done
  if [ "$found" -eq 0 ]; then
    if [ -z "${TEST_CONTAINER_PREFIX+set}" ]; then
      printf '%s\n' "$fallback"
      return 0
    fi
    prefix="$TEST_CONTAINER_PREFIX"
    source="TEST_CONTAINER_PREFIX"
  fi
  if [ -z "$prefix" ] || [ "${#prefix}" -gt "$TEST_CONTAINER_PREFIX_MAX" ] ||
    ! [[ "$prefix" =~ ^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*$ ]]; then
    echo "$source needs a Docker name prefix: lowercase letters and digits joined by \".\", \"_\", \"__\" or \"-\", at most $TEST_CONTAINER_PREFIX_MAX characters" >&2
    return 2
  fi
  printf '%s\n' "$prefix"
}
